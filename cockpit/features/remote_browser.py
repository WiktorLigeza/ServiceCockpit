"""Remote Browser page: a web browser running on this device, shown in the cockpit.

A virtual screen (TigerVNC's Xvnc) runs the browser; the page draws it with
noVNC. Nothing runs while the feature is off - turning it on starts Xvnc and
the browser, turning it off stops both - and the on/off state is kept in
config.json, so it comes back after a cockpit restart.

Security: Xvnc listens on a Unix socket (mode 0600) in a private runtime
directory, not on a TCP port. The page reaches it through the
`/api/remote-browser/ws` WebSocket, which the cockpit's login guard protects;
that route only forwards bytes between the WebSocket and the socket.

The browser runs as the cockpit's own user (never root), with its own profile
so it does not collide with a browser on the device's desktop.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import threading
import time

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory

from cockpit.core.auth import require_sudo
from cockpit.core.config_store import get_remote_browser_settings, save_remote_browser_settings
from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob, install_commands, package_manager

RESOLUTIONS = ('1024x768', '1280x720', '1366x768', '1600x900', '1920x1080')
DEFAULT_RESOLUTION = '1280x720'

# The virtual screen. Xvnc = X server + VNC server in one process (lighter than Xvfb + x11vnc).
VNC_PACKAGES = {
    'apt-get': ['tigervnc-standalone-server', 'xauth'],
    'dnf': ['tigervnc-server-minimal', 'xauth'],
    'yum': ['tigervnc-server-minimal', 'xorg-x11-xauth'],
    'zypper': ['xorg-x11-Xvnc', 'xauth'],
    'pacman': ['tigervnc', 'xorg-xauth'],
    'apk': ['tigervnc', 'xauth'],
}
# Installed only when no browser is found. Debian / Raspberry Pi OS call it chromium,
# Ubuntu chromium-browser (a snap wrapper).
BROWSER_PACKAGES = {
    'apt-get': [['chromium'], ['chromium-browser'], ['firefox-esr']],
    'dnf': [['chromium']],
    'yum': [['chromium']],
    'zypper': [['chromium']],
    'pacman': [['chromium']],
    'apk': [['chromium']],
}

# (id, label, program names, kind)
BROWSERS = (
    ('chromium', 'Chromium', ('chromium', 'chromium-browser'), 'chromium'),
    ('chrome', 'Google Chrome', ('google-chrome', 'google-chrome-stable'), 'chromium'),
    ('firefox', 'Firefox', ('firefox', 'firefox-esr'), 'firefox'),
)

# noVNC (the in-page VNC client): a distro copy when installed, else the page loads it from a CDN.
NOVNC_DIRS = ('/usr/share/novnc', '/usr/share/webapps/novnc', '/usr/share/noVNC')

_job = BackgroundJob()
_lock = threading.RLock()
_state: dict = {'xvnc': None, 'browser': None, 'display': None, 'socket': None, 'xauth': None,
                'started': None, 'browser_restarts': 0, 'error': None, 'browser_id': None,
                'resolution': None}
_watchdog: threading.Thread | None = None
_viewers = 0


# ---------------------------------------------------------------- detection

def _which(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for folder in ('/usr/bin', '/usr/local/bin', '/snap/bin', '/usr/lib/chromium'):
        path = os.path.join(folder, name)
        if os.access(path, os.X_OK):
            return path
    return None


def _xvnc_binary() -> str | None:
    return _which('Xvnc') or _which('Xtigervnc')


def detect_browsers() -> list[dict]:
    found = []
    for browser_id, label, names, kind in BROWSERS:
        for name in names:
            # Ubuntu's /usr/bin/firefox and chromium-browser are wrappers that start the snap.
            snap = f'/snap/bin/{name}' if os.access(f'/snap/bin/{name}', os.X_OK) else None
            path = snap or _which(name)
            if path:
                found.append({'id': browser_id, 'label': label, 'path': path, 'kind': kind,
                              'snap': bool(snap), 'name': name})
                break
    return found


def _novnc_dir() -> str | None:
    for folder in NOVNC_DIRS:
        if os.path.isfile(os.path.join(folder, 'core', 'rfb.js')):
            return folder
    return None


def _alive(proc: subprocess.Popen | None) -> bool:
    return proc is not None and proc.poll() is None


def _rss_mb(pid: int) -> float:
    """Resident memory of a process and all its descendants, in MB (browsers fork a lot)."""
    try:
        import psutil
        root = psutil.Process(pid)
        total = root.memory_info().rss
        for child in root.children(recursive=True):
            try:
                total += child.memory_info().rss
            except psutil.Error:
                pass
        return round(total / 1048576, 1)
    except Exception:
        return 0.0


def get_status() -> dict:
    settings = get_remote_browser_settings()
    browsers = detect_browsers()
    with _lock:
        xvnc_up = _alive(_state['xvnc'])
        browser_up = _alive(_state['browser'])
        running = {
            'xvnc': xvnc_up,
            'browser': browser_up,
            'display': _state['display'] if xvnc_up else None,
            'started': _state['started'] if xvnc_up else None,
            'browser_id': _state['browser_id'] if xvnc_up else None,
            'resolution': _state['resolution'] if xvnc_up else None,
            'memory_mb': round((_rss_mb(_state['xvnc'].pid) if xvnc_up else 0)
                               + (_rss_mb(_state['browser'].pid) if browser_up else 0), 1),
            'error': _state['error'],
            'viewers': _viewers,
        }
    return {
        'installed': _xvnc_binary() is not None,
        'browsers': [{k: b[k] for k in ('id', 'label', 'snap')} for b in browsers],
        'settings': settings,
        'resolutions': RESOLUTIONS,
        'running': running,
        'novnc_local': _novnc_dir() is not None,
        'package_manager': package_manager(),
        'job': _job.view(),
    }


# ---------------------------------------------------------------- start / stop

def _runtime_dir() -> str:
    base = os.environ.get('XDG_RUNTIME_DIR')
    if not base or not os.access(base, os.W_OK):
        base = '/tmp'
    path = os.path.join(base, f'servicecockpit-browser-{os.getuid()}')
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _free_display() -> int:
    for n in range(20, 100):
        if not os.path.exists(f'/tmp/.X11-unix/X{n}') and not os.path.exists(f'/tmp/.X{n}-lock'):
            return n
    raise RuntimeError('No free X display number (:20-:99).')


def _profile_dir(browser: dict) -> str:
    home = os.path.expanduser('~')
    if browser['snap']:
        # Snaps cannot read hidden folders in $HOME; their own common/ folder is always allowed.
        path = os.path.join(home, 'snap', browser['name'], 'common', 'servicecockpit-profile')
    else:
        path = os.path.join(home, '.local', 'share', 'servicecockpit', f'browser-{browser["id"]}')
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _firefox_prefs(profile: str, home_url: str) -> None:
    prefs = {
        'browser.shell.checkDefaultBrowser': 'false',
        'browser.aboutwelcome.enabled': 'false',
        'datareporting.policy.dataSubmissionPolicyBypassNotification': 'true',
        'browser.startup.homepage_override.mstone': '"ignore"',
        'trailhead.firstrun.didSeeAboutWelcome': 'true',
        'browser.tabs.warnOnClose': 'false',
        'browser.sessionstore.resume_from_crash': 'false',
    }
    if home_url:
        prefs['browser.startup.homepage'] = '"' + home_url.replace('"', '') + '"'
    try:
        with open(os.path.join(profile, 'user.js'), 'w', encoding='utf-8') as f:
            for key, value in prefs.items():
                f.write(f'user_pref("{key}", {value});\n')
    except OSError:
        pass


def _browser_command(browser: dict, width: int, height: int, home_url: str) -> list[str]:
    profile = _profile_dir(browser)
    if browser['kind'] == 'firefox':
        _firefox_prefs(profile, home_url)
        cmd = [browser['path'], '--no-remote', '--profile', profile,
               '--width', str(width), '--height', str(height)]
    else:
        cmd = [browser['path'], f'--user-data-dir={profile}', '--no-first-run',
               '--no-default-browser-check', '--password-store=basic',
               '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
               f'--window-size={width},{height}', '--window-position=0,0', '--start-maximized']
    if home_url:
        cmd.append(home_url)
    return cmd


def _spawn(cmd: list[str], log_name: str, **kwargs) -> subprocess.Popen:
    """Start a process in its own session (so its whole group can be stopped), output to a log file."""
    with open(os.path.join(_runtime_dir(), f'{log_name}.log'), 'w', encoding='utf-8') as log:
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True, **kwargs)


def _tail(name: str, lines: int = 12) -> str:
    try:
        with open(os.path.join(_runtime_dir(), f'{name}.log'), encoding='utf-8', errors='replace') as f:
            return ''.join(f.readlines()[-lines:]).strip()
    except OSError:
        return ''


def _kill(proc: subprocess.Popen | None, timeout: float = 5) -> None:
    if not _alive(proc):
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except OSError:
        proc.terminate()
    try:
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()


def _launch_browser() -> None:
    """Start (or restart) the browser on the running virtual screen. Caller holds _lock."""
    settings = get_remote_browser_settings()
    browsers = detect_browsers()
    browser = next((b for b in browsers if b['id'] == settings.get('browser')), None) or \
        (browsers[0] if browsers else None)
    if not browser:
        raise RuntimeError('No web browser is installed (Chromium, Chrome or Firefox).')
    width, height = (int(v) for v in _state['resolution'].split('x'))
    env = {**os.environ, 'DISPLAY': f':{_state["display"]}'}
    if _state['xauth']:
        env['XAUTHORITY'] = _state['xauth']
    # A browser started from a service must not try the desktop's Wayland session.
    env.pop('WAYLAND_DISPLAY', None)
    env['MOZ_ENABLE_WAYLAND'] = '0'
    _state['browser'] = _spawn(_browser_command(browser, width, height, settings.get('home_url') or ''),
                               'browser', env=env, cwd=os.path.expanduser('~'))
    _state['browser_id'] = browser['id']


def _start_locked() -> None:
    if _alive(_state['xvnc']):
        return
    xvnc = _xvnc_binary()
    if not xvnc:
        raise RuntimeError('The virtual screen (TigerVNC Xvnc) is not installed.')
    settings = get_remote_browser_settings()
    resolution = settings.get('resolution') if settings.get('resolution') in RESOLUTIONS else DEFAULT_RESOLUTION
    runtime = _runtime_dir()
    display = _free_display()
    sock_path = os.path.join(runtime, 'vnc.sock')
    if os.path.exists(sock_path):
        os.unlink(sock_path)

    # X cookie, so other local users cannot open windows on (or read) this screen.
    xauth_file = None
    if shutil.which('xauth'):
        xauth_file = os.path.join(runtime, 'Xauthority')
        open(xauth_file, 'w').close()
        os.chmod(xauth_file, 0o600)
        subprocess.run(['xauth', '-f', xauth_file, 'add', f':{display}', '.', secrets.token_hex(16)],
                       capture_output=True, timeout=5)

    cmd = [xvnc, f':{display}', '-geometry', resolution, '-depth', '24',
           '-rfbunixpath', sock_path, '-localhost',  # socket mode defaults to 0600
           '-SecurityTypes', 'None', '-AlwaysShared', '-nolisten', 'tcp',
           '-desktop', 'ServiceCockpit browser']
    if xauth_file:
        cmd += ['-auth', xauth_file]
    _state.update({'display': display, 'socket': sock_path, 'xauth': xauth_file, 'error': None,
                   'resolution': resolution, 'browser_restarts': 0})
    _state['xvnc'] = _spawn(cmd, 'xvnc')
    deadline = time.time() + 10
    while not os.path.exists(sock_path):
        if not _alive(_state['xvnc']) or time.time() > deadline:
            _kill(_state['xvnc'])
            raise RuntimeError('The virtual screen did not start.\n' + _tail('xvnc'))
        time.sleep(0.1)
    _state['started'] = time.time()
    try:
        _launch_browser()
    except Exception:
        _kill(_state['xvnc'])
        raise
    _ensure_watchdog()


def _stop_locked() -> None:
    _kill(_state['browser'])
    _kill(_state['xvnc'])
    _state.update({'browser': None, 'xvnc': None, 'started': None})
    for path in (_state.get('socket'), _state.get('xauth')):
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass


def _ensure_watchdog() -> None:
    """Restart the browser when it is closed (last tab / crash) while the feature is on."""
    global _watchdog
    if _watchdog and _watchdog.is_alive():
        return

    def loop():
        while True:
            time.sleep(2)
            with _lock:
                if not _alive(_state['xvnc']):
                    if _state['xvnc'] is not None and get_remote_browser_settings().get('enabled'):
                        _state['error'] = 'The virtual screen stopped unexpectedly.\n' + _tail('xvnc')
                    if _state['xvnc'] is None or not get_remote_browser_settings().get('enabled'):
                        return
                    continue
                if _alive(_state['browser']):
                    continue
                if _state['browser_restarts'] >= 5:
                    _state['error'] = 'The browser keeps closing.\n' + _tail('browser')
                    continue
                _state['browser_restarts'] += 1
                try:
                    _launch_browser()
                except Exception as e:
                    _state['error'] = str(e)

    _watchdog = threading.Thread(target=loop, daemon=True, name='remote-browser-watchdog')
    _watchdog.start()


def set_enabled(enabled: bool) -> tuple[bool, str]:
    with _lock:
        save_remote_browser_settings({'enabled': enabled})
        if not enabled:
            _stop_locked()
            _state['error'] = None
            return True, ''
        try:
            _start_locked()
            return True, ''
        except Exception as e:
            _stop_locked()
            _state['error'] = str(e)
            save_remote_browser_settings({'enabled': False})
            return False, str(e)


def restart(browser_only: bool = False) -> tuple[bool, str]:
    with _lock:
        if not get_remote_browser_settings().get('enabled'):
            return False, 'The remote browser is turned off.'
        try:
            if browser_only and _alive(_state['xvnc']):
                _kill(_state['browser'])
                _state['browser_restarts'] = 0
                _state['error'] = None
                _launch_browser()
            else:
                _stop_locked()
                _start_locked()
            return True, ''
        except Exception as e:
            _state['error'] = str(e)
            return False, str(e)


def restore_on_startup() -> None:
    """Start the remote browser if it was left on (called once when the cockpit starts)."""
    if get_remote_browser_settings().get('enabled') and _xvnc_binary():
        def run():
            with _lock:
                try:
                    _start_locked()
                except Exception as e:
                    _state['error'] = str(e)
        threading.Thread(target=run, daemon=True).start()


def remote_browser_shutdown() -> None:
    with _lock:
        _stop_locked()


# ---------------------------------------------------------------- install

def start_install(password: str):
    def steps():
        manager = package_manager()
        commands = install_commands(manager, VNC_PACKAGES)
        if not commands:
            _job.log('No supported package manager found (apt, dnf, yum, zypper, pacman, apk).')
            return False
        _job.log(f'Installing the virtual screen (TigerVNC) with {manager}...')
        for cmd in commands:
            if not _job.stream(cmd, password, 900, env=NONINTERACTIVE, echo=True):
                return False
        if not _xvnc_binary():
            _job.log('The package installed but the Xvnc program was not found.')
            return False
        if detect_browsers():
            _job.log(f'Using the installed browser: {detect_browsers()[0]["label"]}.')
            return True
        _job.log('No web browser found - installing Chromium...')
        for packages in BROWSER_PACKAGES.get(manager, []):
            for cmd in install_commands(manager, {manager: packages}):
                if cmd[-1] == 'update':
                    continue
                if _job.stream(cmd, password, 1800, env=NONINTERACTIVE, echo=True) and detect_browsers():
                    _job.log(f'Installed {detect_browsers()[0]["label"]}.')
                    return True
        _job.log('Could not install a browser. Install Chromium or Firefox, then come back.')
        return False
    return _job.start('install', steps)


# ---------------------------------------------------------------- WebSocket bridge

def _bridge(ws, sock_path: str) -> None:
    """Pass RFB bytes between the page's WebSocket and Xvnc's Unix socket until either closes."""
    from simple_websocket import ConnectionClosed

    vnc = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    vnc.connect(sock_path)

    def from_vnc():
        try:
            while True:
                data = vnc.recv(65536)
                if not data:
                    break
                ws.send(data)
        except Exception:
            pass
        finally:
            try:
                ws.close()
            except Exception:
                pass

    threading.Thread(target=from_vnc, daemon=True).start()
    try:
        while True:
            data = ws.receive()
            if data is None:
                continue
            vnc.sendall(data.encode('latin-1') if isinstance(data, str) else data)
    except (ConnectionClosed, OSError):
        pass
    finally:
        try:
            vnc.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        vnc.close()


class _WebSocketDone(Response):
    """After a raw WebSocket session the server must not write an HTTP response (as flask-sock)."""

    def __init__(self, mode: str):
        super().__init__()
        self._mode = mode

    def __call__(self, *args, **kwargs):
        if self._mode == 'werkzeug':
            raise ConnectionError()
        if self._mode == 'gunicorn':
            raise StopIteration()
        return []


# ---------------------------------------------------------------- blueprint

def _reply(ok: bool, message: str = '', status: int = 400):
    body = {'success': ok}
    if not ok:
        body['error'] = message or 'Failed'
    return jsonify(body), 200 if ok else status


def build_remote_browser_blueprint() -> Blueprint:
    bp = Blueprint('remote_browser', __name__)

    @bp.route('/remote-browser')
    def remote_browser_page():
        return render_template('remote_browser.html')

    @bp.route('/remote-browser/screen')
    def remote_browser_screen():
        # The noVNC viewer, loaded in an iframe so the cockpit's page zoom does not skew the pointer.
        return render_template('remote_browser_screen.html')

    @bp.route('/api/remote-browser')
    def api_status():
        return jsonify(get_status())

    @bp.route('/api/remote-browser/enabled', methods=['POST'])
    def api_enabled():
        enabled = bool((request.get_json(silent=True) or {}).get('enabled'))
        if enabled and not _xvnc_binary():
            return _reply(False, 'Install the remote browser first.', 409)
        return _reply(*set_enabled(enabled), status=500)

    @bp.route('/api/remote-browser/settings', methods=['POST'])
    def api_settings():
        data = request.get_json(silent=True) or {}
        update = {}
        if 'resolution' in data:
            if data['resolution'] not in RESOLUTIONS:
                return _reply(False, 'Unknown resolution.')
            update['resolution'] = data['resolution']
        if 'browser' in data:
            if data['browser'] not in {b['id'] for b in detect_browsers()}:
                return _reply(False, 'That browser is not installed.')
            update['browser'] = data['browser']
        if 'home_url' in data:
            url = (data.get('home_url') or '').strip()
            if url and not re.match(r'^(https?://|about:)\S+$', url):
                return _reply(False, 'The start page must begin with http:// or https://')
            update['home_url'] = url
        save_remote_browser_settings(update)
        # Apply right away when running: a new resolution needs a new screen, a new browser only a relaunch.
        if get_remote_browser_settings().get('enabled') and ('resolution' in update or 'browser' in update):
            return _reply(*restart(browser_only='resolution' not in update), status=500)
        return _reply(True)

    @bp.route('/api/remote-browser/restart', methods=['POST'])
    def api_restart():
        browser_only = bool((request.get_json(silent=True) or {}).get('browser_only'))
        return _reply(*restart(browser_only), status=409)

    @bp.route('/api/remote-browser/install', methods=['POST'])
    def api_install():
        password, err = require_sudo()
        if err:
            return err
        return _reply(*start_install(password), status=409)

    @bp.route('/api/remote-browser/job')
    def api_job():
        return jsonify(_job.view())

    @bp.route('/api/remote-browser/job/cancel', methods=['POST'])
    def api_job_cancel():
        return _reply(_job.cancel(), 'Nothing to cancel', 409)

    @bp.route('/api/remote-browser/novnc/<path:filename>')
    def api_novnc(filename):
        folder = _novnc_dir()
        if not folder:
            return 'noVNC is not installed on the device', 404
        return send_from_directory(folder, filename)

    @bp.route('/api/remote-browser/ws', websocket=True)
    def api_ws():
        global _viewers
        from simple_websocket import Server

        with _lock:
            sock_path = _state['socket'] if _alive(_state['xvnc']) else None
        if not sock_path:
            return 'The remote browser is not running', 409
        ws = Server.accept(request.environ, subprotocols=['binary'])
        with _lock:
            _viewers += 1
        try:
            _bridge(ws, sock_path)
        except OSError:
            pass
        finally:
            with _lock:
                _viewers -= 1
            try:
                ws.close()
            except Exception:
                pass
        return _WebSocketDone(ws.mode)

    return bp


__all__ = ['build_remote_browser_blueprint', 'remote_browser_shutdown', 'restore_on_startup']
