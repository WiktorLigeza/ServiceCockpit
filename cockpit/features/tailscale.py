"""Tailscale page: install, log in, this device, tailnet devices and users, updates.

Everything is read from the local `tailscale` CLI, so it only shows what this
node can see (its peers and their owners), not the whole admin console.

Reads run unprivileged (`tailscale status --json` is allowed for any user).
Changes - install, update, login, up/down, `tailscale set` - run through sudo
with the session's password. Long operations (install, update, browser login)
run as a single background job whose log the page polls.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request

from flask import Blueprint, jsonify, render_template, request

from cockpit.core.auth import require_sudo, run_sudo
from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob, install_commands, package_manager
from cockpit.core.systemd import process_running

INSTALL_SCRIPT_URL = 'https://tailscale.com/install.sh'
PKGS_URL = 'https://pkgs.tailscale.com/{track}/?mode=json'
LATEST_CHECK_INTERVAL = 6 * 3600
HTTP_TIMEOUT = 8
LOGIN_URL_RE = re.compile(r'https://\S+/a/\S+')
# The install script needs curl or wget; minimal systems may have neither.
CURL_PACKAGES = {
    'apt-get': ['curl', 'ca-certificates'],
    'dnf': ['curl'], 'yum': ['curl'], 'zypper': ['curl'], 'pacman': ['curl'], 'apk': ['curl'],
}


# ------------------------------------------------------------------ CLI helpers

def _binary() -> str | None:
    # Not cached: the page can install Tailscale while the app is running.
    return shutil.which('tailscale')


def _run(args: list[str], timeout: float = 5.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return False, f'{args[0]} {args[1] if len(args) > 1 else ""} timed out'.strip()
    except FileNotFoundError:
        return False, f'{args[0]} is not installed'
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def _sudo(args: list[str], password: str, timeout: float = 30.0) -> tuple[bool, str]:
    try:
        proc = run_sudo(args, password, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f'{" ".join(args[:3])} timed out'
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def _status_json() -> tuple[dict | None, str]:
    binary = _binary()
    if not binary:
        return None, 'not installed'
    try:
        proc = subprocess.run([binary, 'status', '--json'], capture_output=True, text=True, timeout=5,
                              stdin=subprocess.DEVNULL)
    except Exception:
        return None, 'tailscaled is not responding'
    try:
        return json.loads(proc.stdout), ''
    except ValueError:
        return None, (proc.stderr or proc.stdout).strip() or 'tailscaled is not responding'


_version_cache: dict = {}


def _client_version() -> str | None:
    """`tailscale version` first line, cached until the binary changes."""
    binary = _binary()
    if not binary:
        return None
    try:
        key = (binary, os.stat(binary).st_mtime)
    except OSError:
        return None
    if _version_cache.get('key') != key:
        ok, out = _run([binary, 'version'], 4)
        _version_cache['key'] = key
        _version_cache['value'] = out.splitlines()[0].strip() if ok and out else None
    return _version_cache['value']


def _version_tuple(version: str | None) -> tuple[int, ...]:
    match = re.match(r'(\d+)\.(\d+)\.(\d+)', version or '')
    return tuple(int(x) for x in match.groups()) if match else ()


def _track(version: str | None) -> str:
    """Tailscale uses odd minor versions for the unstable track."""
    parts = _version_tuple(version)
    return 'unstable' if len(parts) == 3 and parts[1] % 2 else 'stable'


# -------------------------------------------------------------- latest version

_latest_lock = threading.Lock()
_latest = {'stable': None, 'unstable': None, 'checked': {}, 'error': None, 'running': False}


def _fetch_latest(track: str) -> None:
    try:
        req = urllib.request.Request(PKGS_URL.format(track=track), headers={'User-Agent': 'ServiceCockpit'})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.load(resp)
        version = data.get('TarballsVersion') or data.get('Version')
        with _latest_lock:
            _latest[track] = version
            _latest['error'] = None
    except Exception as e:
        with _latest_lock:
            _latest['error'] = f'Could not reach pkgs.tailscale.com: {e}'
    finally:
        with _latest_lock:
            _latest['checked'][track] = time.time()
            _latest['running'] = False


def _latest_version(track: str, force: bool = False) -> str | None:
    """Latest published version; refreshed in the background so callers never block
    (unless `force`, used by the page's "Check now" button)."""
    with _latest_lock:
        stale = time.time() - _latest['checked'].get(track, 0) > LATEST_CHECK_INTERVAL
        start = (force or stale) and not _latest['running']
        if start:
            _latest['running'] = True
    if start:
        if force:
            _fetch_latest(track)
        else:
            threading.Thread(target=_fetch_latest, args=(track,), daemon=True).start()
    with _latest_lock:
        return _latest[track]


def _update_info(status: dict | None, current: str | None, force: bool = False) -> dict:
    """Prefer the control server's own verdict (Status.ClientVersion), fall back
    to comparing against the public package index."""
    info = {
        'current': current,
        'latest': None,
        'available': False,
        'urgent': False,
        'source': None,
        'track': _track(current),
        'error': None,
    }
    client_version = (status or {}).get('ClientVersion')
    if client_version and not force:
        info['source'] = 'tailscale'
        info['available'] = not client_version.get('RunningLatest', True)
        info['latest'] = client_version.get('LatestVersion') or (current if not info['available'] else None)
        info['urgent'] = bool(client_version.get('UrgentSecurityUpdate'))
        if info['available'] or info['latest']:
            return info

    latest = _latest_version(info['track'], force=force)
    with _latest_lock:
        info['error'] = _latest['error']
    if latest and current:
        info['source'] = 'pkgs.tailscale.com'
        info['latest'] = latest
        info['available'] = _version_tuple(latest) > _version_tuple(current)
    return info


# ---------------------------------------------------------------- status views

def _daemon_state() -> str:
    # /proc instead of `systemctl is-active`, which can take seconds on a busy device.
    return 'active' if process_running('tailscaled') else 'inactive'


def _peer_view(node: dict, users: dict, exit_node_id: str | None) -> dict:
    user = users.get(str(node.get('UserID'))) or {}
    cur_addr = node.get('CurAddr') or ''
    relay = node.get('Relay') or ''
    return {
        'id': node.get('ID'),
        'public_key': node.get('PublicKey'),
        'hostname': node.get('HostName'),
        'dns_name': (node.get('DNSName') or '').rstrip('.'),
        'os': node.get('OS'),
        'ips': node.get('TailscaleIPs') or [],
        'online': bool(node.get('Online')),
        'active': bool(node.get('Active')),
        'last_seen': node.get('LastSeen'),
        'last_handshake': node.get('LastHandshake'),
        'created': node.get('Created'),
        'key_expiry': node.get('KeyExpiry'),
        'expired': bool(node.get('Expired')),
        'user_id': node.get('UserID'),
        'user': user.get('LoginName'),
        'user_name': user.get('DisplayName'),
        'tags': node.get('Tags') or [],
        'exit_node': bool(node.get('ExitNode')) or (exit_node_id is not None and node.get('ID') == exit_node_id),
        'exit_node_option': bool(node.get('ExitNodeOption')),
        'connection': 'direct' if cur_addr else ('relay' if relay else None),
        'cur_addr': cur_addr or None,
        'relay': relay or None,
        'rx_bytes': node.get('RxBytes') or 0,
        'tx_bytes': node.get('TxBytes') or 0,
        'shared': bool(node.get('ShareeNode')),
        'routes': node.get('PrimaryRoutes') or [],
        'ssh': bool(node.get('sshHostKeys')),
    }


def get_tailscale_summary() -> dict:
    """Small, cheap view for the header (polled by every page)."""
    if not _binary():
        return {'installed': False}
    status, _ = _status_json()
    current = _client_version()
    self_node = (status or {}).get('Self') or {}
    ips = self_node.get('TailscaleIPs') or []
    backend_state = (status or {}).get('BackendState')
    return {
        'installed': True,
        'version': current,
        'active': backend_state == 'Running',
        'backend_state': backend_state,
        'ip': ips[0] if ips else None,
        'hostname': (self_node.get('DNSName') or '').rstrip('.') or self_node.get('HostName'),
        'update': _update_info(status, current),
    }


def get_tailscale_status(force_update_check: bool = False) -> dict:
    binary = _binary()
    if not binary:
        return {'installed': False, 'job': _job_view(), 'package_manager': _package_manager()}

    status, error = _status_json()
    current = _client_version()
    result = {
        'installed': True,
        'binary': binary,
        # The CLI answering already proves the daemon runs; only look when it didn't.
        'daemon': 'active' if status is not None else _daemon_state(),
        'reachable': status is not None,
        'error': None if status is not None else error,
        'version': current,
        'update': _update_info(status, current, force=force_update_check),
        'job': _job_view(),
    }
    if status is None:
        return result

    users_raw = {str(k): v for k, v in (status.get('User') or {}).items()}
    exit_status = status.get('ExitNodeStatus') or {}
    exit_node_id = exit_status.get('ID')
    tailnet = status.get('CurrentTailnet') or {}
    self_node = status.get('Self') or {}
    peers = [_peer_view(p, users_raw, exit_node_id) for p in (status.get('Peer') or {}).values()]
    peers.sort(key=lambda p: (not p['online'], (p['hostname'] or '').lower()))
    me = _peer_view(self_node, users_raw, None)

    device_counts: dict = {}
    for node in [me, *peers]:
        if node['tags']:
            continue  # tagged devices belong to their tags, not to a person
        key = str(node['user_id'])
        counts = device_counts.setdefault(key, {'devices': 0, 'online': 0})
        counts['devices'] += 1
        counts['online'] += 1 if node['online'] else 0
    users = []
    for uid, user in users_raw.items():
        if user.get('LoginName') == 'tagged-devices':
            continue  # Tailscale's placeholder owner for tagged nodes, not a person
        users.append({
            'id': user.get('ID'),
            'login_name': user.get('LoginName'),
            'display_name': user.get('DisplayName'),
            'picture': user.get('ProfilePicURL') or None,
            'is_me': str(self_node.get('UserID')) == uid,
            **device_counts.get(uid, {'devices': 0, 'online': 0}),
        })
    users.sort(key=lambda u: (not u['is_me'], -u['devices'], (u['login_name'] or '').lower()))

    result.update({
        'backend_state': status.get('BackendState'),
        'auth_url': status.get('AuthURL') or None,
        'health': status.get('Health') or [],
        'daemon_version': status.get('Version'),
        'tun': status.get('TUN'),
        'magic_dns_suffix': status.get('MagicDNSSuffix') or None,
        'tailnet': {
            'name': tailnet.get('Name'),
            'magic_dns_enabled': tailnet.get('MagicDNSEnabled'),
            'magic_dns_suffix': tailnet.get('MagicDNSSuffix'),
        } if tailnet else None,
        'self': me,
        'exit_node': {
            'id': exit_node_id,
            'online': exit_status.get('Online'),
            'ips': exit_status.get('TailscaleIPs') or [],
        } if exit_node_id else None,
        'peers': peers,
        'users': users,
        'prefs': _prefs(),
    })
    return result


def _prefs(password: str | None = None) -> dict | None:
    """Current preferences (accept routes/DNS, SSH, exit node...). Readable without
    root on most installs; returns None if this tailscaled refuses."""
    binary = _binary()
    if not binary:
        return None
    ok, out = _run([binary, 'debug', 'prefs'], 4)
    if not ok and password:
        ok, out = _sudo([binary, 'debug', 'prefs'], password, 8)
    if not ok:
        return None
    try:
        prefs = json.loads(out[out.index('{'):])
    except ValueError:
        return None
    routes = prefs.get('AdvertiseRoutes') or []
    return {
        'want_running': prefs.get('WantRunning'),
        'accept_routes': prefs.get('RouteAll'),
        'accept_dns': prefs.get('CorpDNS'),
        'ssh': prefs.get('RunSSH'),
        'shields_up': prefs.get('ShieldsUp'),
        'advertise_exit_node': '0.0.0.0/0' in routes or '::/0' in routes,
        'advertise_routes': [r for r in routes if r not in ('0.0.0.0/0', '::/0')],
        'exit_node_id': prefs.get('ExitNodeID') or None,
        'exit_node_ip': prefs.get('ExitNodeIP') or None,
        'exit_node_allow_lan': prefs.get('ExitNodeAllowLANAccess'),
        'hostname': prefs.get('Hostname') or None,
        'operator': prefs.get('OperatorUser') or None,
        'control_url': prefs.get('ControlURL') or None,
    }


# ------------------------------------------------------------ background jobs

_job = BackgroundJob(link_pattern=LOGIN_URL_RE.pattern)


def _job_view() -> dict:
    return _job.view()


def _package_manager() -> str | None:
    return package_manager()


def _run_install_script(password: str) -> bool:
    # The official script fetches repo keys with curl or wget; minimal installs may have neither.
    if not shutil.which('curl') and not shutil.which('wget'):
        _job.log('curl/wget not found - installing curl first...')
        commands = install_commands(package_manager(), CURL_PACKAGES)
        if not commands:
            _job.log('No supported package manager found to install curl.')
            return False
        for cmd in commands:
            if not _job.stream(cmd, password, 600, env=NONINTERACTIVE, echo=True):
                _job.log('Could not install curl.')
                return False

    _job.log(f'Downloading {INSTALL_SCRIPT_URL} ...')
    try:
        req = urllib.request.Request(INSTALL_SCRIPT_URL, headers={'User-Agent': 'ServiceCockpit'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            script = resp.read()
    except Exception as e:
        _job.log(f'Download failed: {e}')
        _job.log('Check that this device can reach tailscale.com.')
        return False

    fd, path = tempfile.mkstemp(prefix='tailscale-install-', suffix='.sh')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(script)
        _job.log('Running the official Tailscale install script (this can take a few minutes)...')
        ok = _job.stream(['sh', path], password, 900, env=NONINTERACTIVE)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return ok


def _ensure_daemon(password: str) -> bool:
    if not shutil.which('systemctl'):
        return True
    return _job.stream(['systemctl', 'enable', '--now', 'tailscaled'], password, 60, echo=True)


def start_install(password: str) -> tuple[bool, str]:
    def steps():
        if not _run_install_script(password):
            return False
        if not _binary():
            _job.log('The install script finished but the tailscale command was not found.')
            return False
        _ensure_daemon(password)
        _job.log(f'Installed {_client_version() or "Tailscale"}. Next: log in to your tailnet.')
        return True
    return _job.start('install', steps)


def start_update(password: str) -> tuple[bool, str]:
    def steps():
        before = _client_version()
        binary = _binary()
        _job.log('$ tailscale update --yes')
        ok = _job.stream([binary, 'update', '--yes'], password, 900, env=NONINTERACTIVE)
        if not ok:
            _job.log('`tailscale update` did not work here; updating through the install script instead.')
            ok = _run_install_script(password)
        if ok:
            _ensure_daemon(password)
            after = _client_version()
            _job.log(f'Version: {before} -> {after}' if after != before else f'Version: {after}')
            # Re-check so the header badge clears straight away.
            _latest_version(_track(after), force=True)
        return ok
    return _job.start('update', steps)


def _supports(flag: str) -> bool:
    binary = _binary()
    ok, out = _run([binary, 'login', '--help'], 4) if binary else (False, '')
    return flag in out


def start_login(password: str, auth_key: str = '', hostname: str = '') -> tuple[bool, str]:
    binary = _binary()
    if not binary:
        return False, 'Tailscale is not installed.'
    args = [binary, 'login']
    if hostname:
        args.append(f'--hostname={hostname}')

    key_file = None
    if auth_key:
        # Keep the key out of the process list when this version supports "file:".
        flag = '--auth-key' if _supports('--auth-key') else '--authkey'
        if _supports('file:'):
            fd, key_file = tempfile.mkstemp(prefix='ts-key-')
            with os.fdopen(fd, 'w') as f:
                f.write(auth_key)
            args.append(f'{flag}=file:{key_file}')
        else:
            args.append(f'{flag}={auth_key}')

    def steps():
        try:
            _job.log('Logging in...' if auth_key else 'Starting browser login - open the link below to approve this device.')
            ok = _job.stream(args, password, 600)
            if ok:
                _job.log('Logged in.')
            return ok
        finally:
            if key_file:
                try:
                    os.unlink(key_file)
                except OSError:
                    pass
    return _job.start('login', steps)


def cancel_job() -> bool:
    return _job.cancel()


# ---------------------------------------------------------------- blueprint

SET_FLAGS = {
    'accept_routes': '--accept-routes',
    'accept_dns': '--accept-dns',
    'ssh': '--ssh',
    'shields_up': '--shields-up',
    'advertise_exit_node': '--advertise-exit-node',
    'exit_node_allow_lan': '--exit-node-allow-lan-access',
}


def _tailscale_up(binary: str, password: str) -> tuple[bool, str]:
    """Reconnect after `tailscale down`. A bare `up` keeps the current settings, but
    some versions refuse it once `tailscale set` changed something and print the
    full command to use instead - run that suggested command in that case."""
    ok, out = _sudo([binary, 'up'], password, 40)
    if ok or 'non-default flags' not in out:
        return ok, out
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('tailscale up '):
            try:
                suggested = shlex.split(line)
            except ValueError:
                break
            return _sudo([binary, *suggested[1:]], password, 40)
    return ok, out


def _reply(ok: bool, output: str = '', status: int = 400):
    body = {'success': ok, 'output': output}
    if not ok:
        body['error'] = output or 'Command failed'
    return jsonify(body), 200 if ok else status


def build_tailscale_blueprint() -> Blueprint:
    bp = Blueprint('tailscale', __name__)

    @bp.route('/tailscale')
    def tailscale_page():
        return render_template('tailscale.html')

    @bp.route('/api/tailscale/status')
    def api_status():
        return jsonify(get_tailscale_status(force_update_check=request.args.get('check_update') == '1'))

    @bp.route('/api/tailscale/job')
    def api_job():
        return jsonify(_job_view())

    @bp.route('/api/tailscale/job/cancel', methods=['POST'])
    def api_job_cancel():
        return _reply(cancel_job(), 'Cancelled', 409)

    @bp.route('/api/tailscale/install', methods=['POST'])
    def api_install():
        password, err = require_sudo()
        if err:
            return err
        if _binary():
            return _reply(False, 'Tailscale is already installed.', 409)
        ok, msg = start_install(password)
        return _reply(ok, msg, 409)

    @bp.route('/api/tailscale/update', methods=['POST'])
    def api_update():
        password, err = require_sudo()
        if err:
            return err
        if not _binary():
            return _reply(False, 'Tailscale is not installed.', 409)
        ok, msg = start_update(password)
        return _reply(ok, msg, 409)

    @bp.route('/api/tailscale/login', methods=['POST'])
    def api_login():
        password, err = require_sudo()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        hostname = (data.get('hostname') or '').strip()
        if hostname and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,62}', hostname):
            return _reply(False, 'Hostname may contain letters, digits and dashes only.')
        ok, msg = start_login(password, (data.get('auth_key') or '').strip(), hostname)
        return _reply(ok, msg, 409)

    @bp.route('/api/tailscale/daemon', methods=['POST'])
    def api_daemon():
        password, err = require_sudo()
        if err:
            return err
        action = (request.get_json(silent=True) or {}).get('action')
        if action not in ('start', 'restart'):
            return _reply(False, 'Unknown action')
        cmd = ['systemctl', 'enable', '--now', 'tailscaled'] if action == 'start' \
            else ['systemctl', 'restart', 'tailscaled']
        return _reply(*_sudo(cmd, password, 30))

    @bp.route('/api/tailscale/connection', methods=['POST'])
    def api_connection():
        password, err = require_sudo()
        if err:
            return err
        action = (request.get_json(silent=True) or {}).get('action')
        binary = _binary()
        if not binary:
            return _reply(False, 'Tailscale is not installed.', 409)
        if action == 'up':
            return _reply(*_tailscale_up(binary, password))
        if action == 'down':
            return _reply(*_sudo([binary, 'down'], password, 20))
        if action == 'logout':
            return _reply(*_sudo([binary, 'logout'], password, 30))
        return _reply(False, 'Unknown action')

    @bp.route('/api/tailscale/set', methods=['POST'])
    def api_set():
        password, err = require_sudo()
        if err:
            return err
        binary = _binary()
        if not binary:
            return _reply(False, 'Tailscale is not installed.', 409)
        data = request.get_json(silent=True) or {}
        args = [binary, 'set']
        for key, flag in SET_FLAGS.items():
            if key in data:
                args.append(f'{flag}={"true" if data[key] else "false"}')
        if 'exit_node' in data:
            node = (data.get('exit_node') or '').strip()
            if node and not re.fullmatch(r'[0-9A-Fa-f:.]+', node):
                return _reply(False, 'Exit node must be a Tailscale IP.')
            args.append(f'--exit-node={node}')
        if 'hostname' in data:
            hostname = (data.get('hostname') or '').strip()
            if hostname and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,62}', hostname):
                return _reply(False, 'Hostname may contain letters, digits and dashes only.')
            args.append(f'--hostname={hostname}')
        if len(args) == 2:
            return _reply(False, 'Nothing to change')
        ok, out = _sudo(args, password, 30)
        return _reply(ok, out)

    @bp.route('/api/tailscale/ping', methods=['POST'])
    def api_ping():
        binary = _binary()
        target = ((request.get_json(silent=True) or {}).get('target') or '').strip()
        if not binary or not re.fullmatch(r'[0-9A-Fa-f:.]+', target):
            return _reply(False, 'Invalid target')
        ok, out = _run([binary, 'ping', '-c', '3', '--timeout=5s', target], 20)
        return _reply(ok, out)

    return bp


__all__ = ['build_tailscale_blueprint', 'get_tailscale_summary', 'get_tailscale_status']
