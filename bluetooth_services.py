"""What you can *do* with a Bluetooth device, on top of pairing/connecting.

Each feature maps a remote profile to the local software that serves it:

* audio    - PipeWire + WirePlumber (user session): listen to a phone on the
             Pi (A2DP sink) or use headphones/speakers as output (A2DP source)
* internet - NetworkManager PAN client: use a phone's Bluetooth tethering
* files    - obexd (user session) via bt_dbus_helper.py: send / receive files
* serial   - SPP profile hosted by bt_dbus_helper.py, bridged to a pty

PipeWire and obexd live on the user's session bus, so they need a persistent
user manager (loginctl enable-linger) on a headless Pi. The "Set up" jobs
install and configure whatever is missing, streaming output to the page.
"""

from __future__ import annotations

import base64
import glob
import json
import math
import os
import pwd
import re
import shutil
import struct
import subprocess
import threading
import time
import uuid
import wave

from flask import Blueprint, jsonify, request, send_file, session

import bluetooth_feature as core
from auth import SUDO_SESSION_KEY

NAMESPACE = core.NAMESPACE
HELPER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bt_dbus_helper.py')
SYSTEM_PYTHON = '/usr/bin/python3'
OBEXD = '/usr/libexec/bluetooth/obexd'
RECEIVE_DIR = os.path.expanduser('~/Bluetooth')
CACHE_DIR = os.path.expanduser('~/.cache/servicecockpit/bluetooth')
OUTBOX_DIR = os.path.join(CACHE_DIR, 'outbox')

UUID_AUDIO_SOURCE = '0000110a-0000-1000-8000-00805f9b34fb'
UUID_AUDIO_SINK = '0000110b-0000-1000-8000-00805f9b34fb'

AUDIO_PACKAGES = ['pipewire', 'pipewire-pulse', 'pipewire-alsa', 'wireplumber', 'libspa-0.2-bluetooth']
FILES_PACKAGES = ['bluez-obexd']
SERIAL_PACKAGES = ['python3-dbus', 'python3-gi']

# WirePlumber only enables Bluetooth for a user with an *active seat* session
# (logind). A headless Pi's lingering user never has one, so turn that off.
# 0.4.x reads Lua fragments, 0.5+ reads .conf fragments - write both. A2DP
# audio received from a phone is routed to the default output like a player.
WIREPLUMBER_LUA = '''-- Written by ServiceCockpit (Bluetooth page)
bluez_monitor.properties["with-logind"] = false
bluez_monitor.properties["bluez5.a2dp-source-role"] = "playback"
'''
WIREPLUMBER_CONF = '''# Written by ServiceCockpit (Bluetooth page)
wireplumber.profiles = {
  main = {
    monitor.bluez.seat-monitoring = disabled
  }
}
monitor.bluez.properties = {
  bluez5.a2dp-source-role = playback
}
'''
OBEX_OVERRIDE = f'''# Written by ServiceCockpit (Bluetooth page): store received files in ~/Bluetooth
[Service]
ExecStart=
ExecStart={OBEXD} -r %h/Bluetooth
'''

_ERROR_HINTS = [
    ('profile-unavailable', "The Pi has nothing that can use this device's services yet - pick what you want to do with it under “What would you like to do?”."),
    ('Protocol not available', "The Pi's side of this service isn't running - set up the matching feature first."),
    ('page-timeout', "The device didn't answer. Make sure it's on, nearby and its Bluetooth is enabled."),
    ('Page Timeout', "The device didn't answer. Make sure it's on, nearby and its Bluetooth is enabled."),
    ('Host is down', "The device didn't answer. Make sure it's on, nearby and its Bluetooth is enabled."),
    ('abort-by-local', "The connection attempt was aborted - the device may be out of range."),
    ('connection-refused', "The device refused the connection. For internet, turn on Bluetooth tethering on the device first."),
    ('Connection refused', "The device refused the connection. For internet, turn on Bluetooth tethering on the device first."),
    ('key-missing', "The pairing keys don't match any more - remove the device and pair again."),
    ('AuthenticationFailed', "Authentication failed - the code didn't match or the device forgot the pairing. Remove it and pair again."),
    ('AuthenticationRejected', 'The device rejected the pairing.'),
    ('AuthenticationCanceled', 'Pairing was canceled.'),
    ('AuthenticationTimeout', 'Pairing timed out - confirm the request on the device a bit faster.'),
    ('ConnectionAttemptFailed', 'The connection attempt failed - the device may be busy or out of range.'),
    ('InProgress', 'Another operation is already running for this device - wait a moment and retry.'),
    ('In Progress', 'Another operation is already running for this device - wait a moment and retry.'),
    ('AlreadyExists', 'Already paired.'),
    ('Already Exists', 'Already paired.'),
    ('NotReady', 'The adapter is not ready - make sure Bluetooth is powered on.'),
    ('Not Ready', 'The adapter is not ready - make sure Bluetooth is powered on.'),
    ('Blocked', 'Bluetooth is blocked by rfkill - unblock the radio.'),
    ('DoesNotExist', 'The device is unknown - scan again.'),
    ('Does Not Exist', 'The device is unknown - scan again.'),
    ('Forbidden', 'The device does not allow this - check its Bluetooth settings.'),
    ('NAP', 'Turn on Bluetooth tethering on the device, then try again.'),
]


def explain_error(text: str | None) -> str:
    text = text or ''
    for key, hint in _ERROR_HINTS:
        if key.lower() in text.lower():
            return hint
    return ''


# --------------------------------------------------------------------------
# User session (PipeWire / obexd run there)
# --------------------------------------------------------------------------

def _user() -> str:
    return pwd.getpwuid(os.getuid()).pw_name


def user_env() -> dict:
    env = dict(os.environ)
    runtime = f'/run/user/{os.getuid()}'
    env['XDG_RUNTIME_DIR'] = runtime
    env['DBUS_SESSION_BUS_ADDRESS'] = f'unix:path={runtime}/bus'
    return env


def _user_bus_ready() -> bool:
    return os.path.exists(f'/run/user/{os.getuid()}/bus')


def _linger_enabled() -> bool:
    return os.path.exists(f'/var/lib/systemd/linger/{_user()}')


def _run(args: list[str], timeout: float = 10, user_session: bool = False) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              env=user_env() if user_session else None, stdin=subprocess.DEVNULL)
        return proc.returncode == 0, (proc.stdout + proc.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, f'{args[0]} timed out'
    except Exception as e:
        return False, str(e)


def _sudo(args: list[str], timeout: float = 60) -> tuple[bool, str]:
    password = session.get(SUDO_SESSION_KEY)
    if not password:
        return False, 'sudo_required'
    try:
        proc = subprocess.run(['sudo', '-S', '-p', '', *args], input=password + '\n', capture_output=True,
                              text=True, timeout=timeout)
        return proc.returncode == 0, (proc.stdout + proc.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, f'{args[0]} timed out'


def _user_unit_active(unit: str) -> bool:
    if not _user_bus_ready():
        return False
    ok, out = _run(['systemctl', '--user', 'is-active', unit], timeout=5, user_session=True)
    return out.strip() == 'active'


_system_python_ok: bool | None = None


def _system_python_has_dbus() -> bool:
    global _system_python_ok
    if not _system_python_ok:
        ok, _ = _run([SYSTEM_PYTHON, '-c', 'import dbus, dbus.mainloop.glib; from gi.repository import GLib'], timeout=10)
        _system_python_ok = ok
    return bool(_system_python_ok)


def feature_status() -> dict:
    user_session_ok = _linger_enabled() and _user_bus_ready()
    features = {}

    # ---- audio
    installed = bool(shutil.which('wpctl') and shutil.which('pw-dump')
                     and glob.glob('/usr/lib/*/spa-0.2/bluez5/libspa-bluez5.so'))
    running = installed and _user_unit_active('pipewire') and _user_unit_active('wireplumber')
    wp_fixed = os.path.exists(os.path.expanduser('~/.config/wireplumber/bluetooth.lua.d/80-servicecockpit.lua'))
    issues = []
    if not installed:
        issues.append('PipeWire Bluetooth audio is not installed')
    if not _linger_enabled():
        issues.append('No persistent user session (linger) - audio would stop when you log out')
    if installed and not running:
        issues.append('PipeWire / WirePlumber is not running')
    if installed and not wp_fixed:
        issues.append('WirePlumber is not configured for a headless Pi')
    features['audio'] = {
        'title': 'Audio', 'icon': 'fa-headphones',
        'description': 'Play phone audio on the Pi, or use Bluetooth headphones / speakers',
        'ready': installed and running and wp_fixed and _linger_enabled(),
        'issues': issues, 'can_setup': True,
        'setup_summary': 'Installs ' + ', '.join(AUDIO_PACKAGES) + '; enables a persistent user session (linger); '
                         'configures WirePlumber for headless use and starts PipeWire.',
    }

    # ---- files
    installed = os.path.exists(OBEXD)
    issues = []
    if not installed:
        issues.append('OBEX (bluez-obexd) is not installed')
    if not user_session_ok:
        issues.append('No persistent user session (linger)')
    if installed and user_session_ok and not helper.files_ready:
        issues.append(helper.files_error or 'File transfer service not connected')
    features['files'] = {
        'title': 'File transfer', 'icon': 'fa-file-export',
        'description': 'Send files to phones / computers and receive files into ~/Bluetooth',
        'ready': installed and user_session_ok and helper.files_ready,
        'issues': issues, 'can_setup': True,
        'setup_summary': 'Installs bluez-obexd; enables a persistent user session (linger); stores received files in ~/Bluetooth.',
    }

    # ---- internet
    nm = shutil.which('nmcli') is not None and core._systemd_unit_state('NetworkManager')['active']
    features['internet'] = {
        'title': 'Internet', 'icon': 'fa-globe',
        'description': "Use a phone's Bluetooth tethering (PAN) for internet",
        'ready': nm,
        'issues': [] if nm else ['NetworkManager is not running - it manages Bluetooth network connections'],
        'can_setup': False,
        'setup_summary': '',
    }

    # ---- serial
    py = _system_python_has_dbus()
    issues = []
    if not py:
        issues.append('python3-dbus / python3-gi missing for the Bluetooth helper')
    elif not helper.serial_ready:
        issues.append(helper.serial_error or 'Serial profile not registered yet')
    features['serial'] = {
        'title': 'Serial port', 'icon': 'fa-terminal',
        'description': 'Serial (SPP) terminal to microcontrollers / HC-05 / phone apps, exposed as a pty',
        'ready': py and helper.serial_ready,
        'issues': issues, 'can_setup': not py,
        'setup_summary': 'Installs python3-dbus and python3-gi.',
    }
    return features


# --------------------------------------------------------------------------
# D-Bus helper process
# --------------------------------------------------------------------------

class HelperProcess:
    def __init__(self):
        self.socketio = None
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.serial_ready = False
        self.serial_error = ''
        self.files_ready = False
        self.files_error = ''
        self.links: dict[str, dict] = {}
        self.serial_buffers: dict[str, bytearray] = {}
        self.transfers: dict[str, dict] = {}
        self.requests: dict[str, dict] = {}
        self.outbox_jobs: dict[str, str] = {}

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def ensure_started(self):
        with self.lock:
            if self.running or not os.path.exists(SYSTEM_PYTHON) or not _system_python_has_dbus():
                return
            env = user_env() if _user_bus_ready() else dict(os.environ)
            env['PYTHONUNBUFFERED'] = '1'
            self.proc = subprocess.Popen(
                [SYSTEM_PYTHON, HELPER_SCRIPT], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=env, text=True, bufsize=1,
            )
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
            threading.Thread(target=self._stderr, args=(self.proc,), daemon=True).start()

    def stop(self):
        with self.lock:
            proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()
                proc.wait(timeout=3)
            except Exception:
                proc.kill()

    def restart(self):
        self.stop()
        self.ensure_started()

    def send(self, **cmd) -> bool:
        with self.lock:
            if not self.running:
                return False
            try:
                self.proc.stdin.write(json.dumps(cmd) + '\n')
                self.proc.stdin.flush()
                return True
            except Exception:
                return False

    def _emit(self, event, data):
        if self.socketio:
            self.socketio.emit(event, data, namespace=NAMESPACE)

    def _stderr(self, proc):
        for line in proc.stderr:
            line = line.rstrip()
            if line:
                self._emit('bt_log', {'line': f'[helper] {line}', 'ts': time.time()})

    def _reader(self, proc):
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            try:
                self._dispatch(msg)
            except Exception as e:
                self._emit('bt_log', {'line': f'[helper] dispatch error: {e}', 'ts': time.time()})
        with self.lock:
            if self.proc is proc:
                self.proc = None
        self.serial_ready = self.files_ready = False
        for mac in list(self.links):
            self.links.pop(mac, None)
        self._emit('bt_serial_links', {'links': list(self.links.values())})
        self._emit('bt_features_changed', {})

    def _dispatch(self, msg: dict):
        event = msg.pop('event', '')
        if event == 'status':
            if msg['feature'] == 'serial':
                self.serial_ready, self.serial_error = bool(msg['ready']), msg.get('error') or ''
            elif msg['feature'] == 'files':
                self.files_ready, self.files_error = bool(msg['ready']), msg.get('error') or ''
            self._emit('bt_features_changed', {})
        elif event == 'serial_opened':
            self.links[msg['mac']] = msg
            self.serial_buffers.setdefault(msg['mac'], bytearray())
            self._emit('bt_serial_links', {'links': list(self.links.values())})
            self._emit('bt_notice', {'level': 'success', 'message': f"Serial link {'opened' if msg['direction'] == 'outgoing' else 'from'} {msg['mac']} ({msg['pty']})"})
        elif event == 'serial_closed':
            self.links.pop(msg['mac'], None)
            self._emit('bt_serial_links', {'links': list(self.links.values())})
            self._emit('bt_notice', {'level': 'info', 'message': f"Serial link {msg['mac']} closed. {msg.get('reason', '')}".strip()})
        elif event == 'serial_failed':
            self._emit('bt_notice', {'level': 'error', 'message': f"Serial connection to {msg['mac']} failed: {msg['error']}",
                                     'hint': explain_error(msg['error'])})
        elif event == 'serial_data':
            buf = self.serial_buffers.setdefault(msg['mac'], bytearray())
            buf.extend(base64.b64decode(msg['data']))
            del buf[:-65536]
            self._emit('bt_serial_data', msg)
        elif event == 'obex_authorize':
            self.requests[msg['id']] = msg
            self._emit('bt_file_request', msg)
        elif event == 'obex_request_closed':
            self.requests.pop(msg['id'], None)
            self._emit('bt_file_request_closed', msg)
        elif event == 'obex_progress':
            key = msg['transfer']
            if not key.startswith('pending:'):
                self.transfers.pop(f"pending:{msg.get('job')}", None)
            self.transfers[key] = {**msg, 'updated': time.time()}
            self._emit('bt_transfer', msg)
            if msg.get('status') in ('complete', 'error'):
                self._finish_transfer(key, msg)
        elif event == 'obex_send_failed':
            self.transfers.pop(f"pending:{msg['id']}", None)
            self._cleanup_outbox(msg['id'])
            self._emit('bt_transfer', {'transfer': f"pending:{msg['id']}", 'job': msg['id'], 'status': 'error',
                                       'error': msg['error'], 'direction': 'outgoing'})
            self._emit('bt_notice', {'level': 'error', 'message': f"Sending failed: {msg['error']}",
                                     'hint': explain_error(msg['error'])})
        elif event == 'error':
            self._emit('bt_log', {'line': f"[helper] {msg.get('message')}", 'ts': time.time()})

    def _finish_transfer(self, key, msg):
        name = msg.get('name') or 'file'
        if msg['status'] == 'complete':
            text = f'Received {name}' if msg.get('direction') == 'incoming' else f'Sent {name}'
            self._emit('bt_notice', {'level': 'success', 'message': text})
        else:
            self._emit('bt_notice', {'level': 'error', 'message': f'Transfer of {name} failed',
                                     'hint': 'The other device canceled or declined it, or the connection dropped.'})
        if msg.get('job'):
            self._cleanup_outbox(msg['job'])
        # Keep finished transfers visible for a while, then forget them.
        threading.Timer(120, lambda: self.transfers.pop(key, None)).start()

    def _cleanup_outbox(self, job_id):
        path = self.outbox_jobs.pop(job_id, None)
        if path and path.startswith(OUTBOX_DIR):
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)


helper = HelperProcess()


# --------------------------------------------------------------------------
# Setup jobs
# --------------------------------------------------------------------------

class SetupJob:
    def __init__(self):
        self.lock = threading.Lock()
        self.feature: str | None = None
        self.state = 'idle'
        self.lines: list[str] = []
        self.socketio = None

    def snapshot(self) -> dict:
        return {'feature': self.feature, 'state': self.state, 'lines': self.lines[-200:]}

    def start(self, feature: str, password: str) -> tuple[bool, str]:
        steps = {'audio': self._audio_steps, 'files': self._files_steps, 'serial': self._serial_steps}.get(feature)
        if not steps:
            return False, 'This feature has nothing to set up automatically'
        with self.lock:
            if self.state == 'running':
                return False, f'Setup of {self.feature} is already running'
            self.feature, self.state, self.lines = feature, 'running', []
        threading.Thread(target=self._run, args=(steps(), password), daemon=True).start()
        return True, ''

    def _log(self, line: str):
        self.lines.append(line)
        del self.lines[:-500]
        if self.socketio:
            self.socketio.emit('bt_setup', {'feature': self.feature, 'state': self.state, 'line': line}, namespace=NAMESPACE)

    def _run(self, steps, password):
        try:
            for label, fn in steps:
                self._log(f'==> {label}')
                fn(password)
            self.state = 'done'
            self._log('Setup finished.')
        except Exception as e:
            self.state = 'failed'
            self._log(f'Setup failed: {e}')
        helper.restart()
        if self.socketio:
            self.socketio.emit('bt_setup', {'feature': self.feature, 'state': self.state}, namespace=NAMESPACE)
            self.socketio.emit('bt_features_changed', {}, namespace=NAMESPACE)

    def _stream(self, args: list[str], password: str | None = None, user_session: bool = False, timeout: float = 1800):
        cmd = ['sudo', '-S', '-p', '', *args] if password else args
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=user_env() if user_session else None)
        if password:
            proc.stdin.write(password + '\n')
        proc.stdin.close()
        start = time.time()
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                self._log(line)
            if time.time() - start > timeout:
                proc.kill()
                raise RuntimeError(f'{args[0]} timed out')
        if proc.wait() != 0:
            raise RuntimeError(f'`{" ".join(args)}` exited with {proc.returncode}')

    def _apt(self, packages):
        def step(password):
            env = ['env', 'DEBIAN_FRONTEND=noninteractive']
            self._stream(env + ['apt-get', 'update'], password)
            self._stream(env + ['apt-get', 'install', '-y', '--no-install-recommends',
                                '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold',
                                *packages], password)
        return step

    def _user_session(self, password):
        if not _linger_enabled():
            self._stream(['loginctl', 'enable-linger', _user()], password)
        if not _user_bus_ready():
            self._stream(['systemctl', 'start', f'user@{os.getuid()}.service'], password)
        for _ in range(30):
            if _user_bus_ready():
                self._log('User session bus is up.')
                return
            time.sleep(0.5)
        raise RuntimeError('The user session bus did not come up (is dbus-user-session installed?)')

    def _write_file(self, path, content):
        path = os.path.expanduser(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(content)
        self._log(f'Wrote {path}')

    def _audio_steps(self):
        # dbus-user-session provides the per-user bus PipeWire needs; a no-op if present.
        packages = AUDIO_PACKAGES + ['dbus-user-session']

        def configure(_):
            self._write_file('~/.config/wireplumber/bluetooth.lua.d/80-servicecockpit.lua', WIREPLUMBER_LUA)
            self._write_file('~/.config/wireplumber/wireplumber.conf.d/80-servicecockpit.conf', WIREPLUMBER_CONF)

        def start(_):
            self._stream(['systemctl', '--user', 'daemon-reload'], user_session=True)
            self._stream(['systemctl', '--user', 'enable', '--now', 'pipewire.socket', 'pipewire-pulse.socket',
                          'wireplumber.service'], user_session=True)
            self._stream(['systemctl', '--user', 'restart', 'pipewire.service', 'wireplumber.service'], user_session=True)

        return [
            ('Installing PipeWire Bluetooth audio', self._apt(packages)),
            ('Enabling persistent user session', self._user_session),
            ('Configuring WirePlumber for headless use', configure),
            ('Starting PipeWire + WirePlumber', start),
        ]

    def _files_steps(self):
        def configure(_):
            os.makedirs(RECEIVE_DIR, exist_ok=True)
            self._write_file('~/.config/systemd/user/obex.service.d/servicecockpit.conf', OBEX_OVERRIDE)

        def start(_):
            self._stream(['systemctl', '--user', 'daemon-reload'], user_session=True)
            # Creates the dbus-org.bluez.obex.service alias D-Bus activation uses.
            self._stream(['systemctl', '--user', 'enable', 'obex.service'], user_session=True)
            self._stream(['systemctl', '--user', 'restart', 'obex.service'], user_session=True)

        return [
            ('Installing OBEX file transfer (bluez-obexd)', self._apt(FILES_PACKAGES + ['dbus-user-session'])),
            ('Enabling persistent user session', self._user_session),
            ('Configuring receive folder ~/Bluetooth', configure),
            ('Starting obexd', start),
        ]

    def _serial_steps(self):
        def reset(_):
            global _system_python_ok
            _system_python_ok = None
        return [('Installing python3-dbus / python3-gi', self._apt(SERIAL_PACKAGES)), ('Re-checking', reset)]


setup_job = SetupJob()


# --------------------------------------------------------------------------
# Audio (PipeWire)
# --------------------------------------------------------------------------

def _pw_dump() -> list:
    ok, out = _run(['pw-dump'], timeout=6, user_session=True)
    if not ok:
        return []
    try:
        return json.loads(out)
    except ValueError:
        return []


def _volume(node_id: int) -> tuple[float | None, bool]:
    ok, out = _run(['wpctl', 'get-volume', str(node_id)], timeout=3, user_session=True)
    m = re.search(r'Volume:\s*([\d.]+)', out) if ok else None
    return (float(m.group(1)) if m else None), '[MUTED]' in out


def audio_state() -> dict:
    if not shutil.which('pw-dump') or not _user_bus_ready():
        return {'available': False, 'outputs': [], 'inputs': []}
    dump = _pw_dump()
    defaults = {}
    for obj in dump:
        if obj.get('type') == 'PipeWire:Interface:Metadata' and (obj.get('props') or {}).get('metadata.name') == 'default':
            for entry in obj.get('metadata') or []:
                value = entry.get('value')
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        value = {}
                if isinstance(value, dict):
                    defaults[entry.get('key')] = value.get('name')

    outputs, inputs = [], []
    for obj in dump:
        if obj.get('type') != 'PipeWire:Interface:Node':
            continue
        props = (obj.get('info') or {}).get('props') or {}
        media_class = props.get('media.class', '')
        if media_class not in ('Audio/Sink', 'Audio/Source', 'Stream/Output/Audio') or props.get('node.name', '').endswith('.monitor'):
            continue
        mac = props.get('api.bluez5.address', '')
        if media_class == 'Stream/Output/Audio' and not mac:
            continue  # ordinary app playback streams
        volume, muted = _volume(obj['id'])
        node = {
            'id': obj['id'],
            'name': props.get('node.name', ''),
            'description': props.get('node.description') or props.get('node.nick') or props.get('node.name', ''),
            'bluetooth': bool(mac),
            'mac': mac.upper(),
            'codec': props.get('api.bluez5.codec', ''),
            'volume': volume,
            'muted': muted,
        }
        if media_class == 'Audio/Sink':
            node['default'] = props.get('node.name') == defaults.get('default.audio.sink')
            outputs.append(node)
        else:
            node['default'] = props.get('node.name') == defaults.get('default.audio.source')
            node['stream'] = media_class == 'Stream/Output/Audio'
            inputs.append(node)
    return {'available': True, 'outputs': outputs, 'inputs': inputs}


def _test_tone_path() -> str:
    path = os.path.join(CACHE_DIR, 'test-tone.wav')
    if not os.path.exists(path):
        os.makedirs(CACHE_DIR, exist_ok=True)
        rate = 44100
        with wave.open(path, 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(rate)
            frames = bytearray()
            for i in range(int(rate * 1.2)):
                t = i / rate
                # Two short chimes, faded in/out to avoid clicks.
                freq = 660 if t < 0.6 else 880
                local = t % 0.6
                env = min(1.0, local / 0.02, (0.6 - local) / 0.1)
                sample = int(12000 * env * math.sin(2 * math.pi * freq * t))
                frames += struct.pack('<hh', sample, sample)
            w.writeframes(bytes(frames))
    return path


# --------------------------------------------------------------------------
# Profiles / internet
# --------------------------------------------------------------------------

def _connect_profile(mac: str, uuid_: str, connect: bool = True) -> tuple[bool, str]:
    path = core._device_object_path(mac)
    if not path:
        return False, 'Device not found'
    method = 'ConnectProfile' if connect else 'DisconnectProfile'
    ok, out = _run(['busctl', '--timeout=40', 'call', 'org.bluez', path, 'org.bluez.Device1', method, 's', uuid_], timeout=45)
    if not ok and 'already connected' in out.lower():
        return True, ''
    return ok, out


def _pan_connection_name(mac: str) -> str:
    return 'bt-pan-' + mac.upper().replace(':', '')


def internet_state(mac: str) -> dict:
    name = _pan_connection_name(mac)
    ok, out = _run(['nmcli', '-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active'], timeout=5)
    active = ok and any(line.split(':', 1)[0] == name for line in out.splitlines())
    ip = ''
    if active:
        _, ip = _run(['nmcli', '-g', 'IP4.ADDRESS', 'connection', 'show', name], timeout=5)
    return {'active': active, 'ip': ip.split('|')[0].strip()}


def internet_connect(mac: str) -> tuple[bool, str]:
    name = _pan_connection_name(mac)
    ok, out = _run(['nmcli', '-t', '-f', 'NAME', 'connection', 'show'], timeout=5)
    if name not in out.splitlines():
        ok, out = _sudo(['nmcli', 'connection', 'add', 'type', 'bluetooth', 'con-name', name,
                         'bluetooth.bdaddr', mac, 'bluetooth.type', 'panu', 'connection.autoconnect', 'no'])
        if not ok:
            return False, out
    return _sudo(['nmcli', '--wait', '45', 'connection', 'up', name], timeout=60)


# --------------------------------------------------------------------------
# Per-device "what would you like to do"
# --------------------------------------------------------------------------

def device_services(mac: str) -> dict | None:
    info = core.get_device_info(mac)
    if not info:
        return None
    short = {u['uuid'][:8].lower() for u in info['uuids']}
    features = feature_status()
    audio = audio_state() if features['audio']['ready'] else {'outputs': [], 'inputs': []}
    services = []

    def card(id_, feature, title, description, icon, active, detail, actions):
        services.append({
            'id': id_, 'feature': feature, 'title': title, 'description': description, 'icon': icon,
            'ready': features[feature]['ready'] if feature else True,
            'issues': features[feature]['issues'] if feature else [],
            'can_setup': features[feature]['can_setup'] if feature else False,
            'active': active, 'detail': detail, 'actions': actions,
        })

    if '0000110a' in short:
        node = next((n for n in audio['inputs'] if n['mac'] == mac), None)
        card('audio_in', 'audio', 'Play its audio on the Pi',
             "Music and sounds from the device come out of the Pi's audio output.", 'fa-music',
             bool(node), f"Streaming{' · ' + node['codec'] if node and node['codec'] else ''}" if node else '',
             ['disconnect'] if node else ['connect'])
    if short & {'0000110b', '0000111e', '00001108'}:
        node = next((n for n in audio['outputs'] if n['mac'] == mac), None)
        detail = ''
        actions = ['connect']
        if node:
            detail = 'Default output' if node['default'] else 'Connected (not the default output)'
            actions = ['disconnect'] + ([] if node['default'] else ['make_default'])
        card('audio_out', 'audio', 'Use as speaker / headphones',
             'Send the Pi\'s sound to this device.', 'fa-headphones', bool(node), detail, actions)
    if '00001116' in short:
        state = internet_state(mac)
        card('internet', 'internet', "Use its internet",
             'Connect through the device\'s Bluetooth tethering (turn tethering on there first).', 'fa-globe',
             state['active'], f"Connected · {state['ip']}" if state['active'] else '',
             ['disconnect'] if state['active'] else ['connect'])
    if '00001105' in short:
        card('files', 'files', 'Send files', 'Push files from the Pi or your browser to the device.',
             'fa-file-upload', False, '', ['send'])
    if '00001101' in short:
        link = helper.links.get(mac)
        card('serial', 'serial', 'Serial terminal',
             'Talk to the device over a Bluetooth serial port (SPP).', 'fa-terminal',
             bool(link), f"Open · {link['link'] or link['pty']}" if link else '',
             ['open_terminal', 'disconnect'] if link else ['connect'])
    if short & {'00001124', '00001812'}:
        card('input', None, 'Keyboard / mouse / controller', 'Use it as an input device on the Pi.',
             'fa-keyboard', info['connected'], 'Connected' if info['connected'] else '',
             ['disconnect'] if info['connected'] else ['connect'])
    return {'mac': mac, 'services': services}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _json_result(ok: bool, output: str = '', status: int = 200, **extra):
    if not ok and output == 'sudo_required':
        return jsonify({'success': False, 'error': 'sudo_required', 'message': 'Sudo password required.'}), 401
    body = {'success': ok, 'output': output, **extra}
    if not ok:
        body['error'] = output or 'Failed'
        body['hint'] = explain_error(output)
    return jsonify(body), status if ok else (status if status != 200 else 400)


def build_bluetooth_services_blueprint() -> Blueprint:
    bp = Blueprint('bluetooth_services', __name__)

    @bp.route('/api/bluetooth/features')
    def features():
        helper.ensure_started()
        return jsonify({'success': True, 'features': feature_status(), 'setup': setup_job.snapshot()})

    @bp.route('/api/bluetooth/features/<feature>/setup', methods=['POST'])
    def setup(feature):
        password = session.get(SUDO_SESSION_KEY)
        if not password:
            return _json_result(False, 'sudo_required')
        ok, err = setup_job.start(feature, password)
        return _json_result(ok, err, setup=setup_job.snapshot())

    @bp.route('/api/bluetooth/device/<mac>/services')
    def services(mac):
        if not core.MAC_RE.match(mac):
            return _json_result(False, 'Invalid MAC address')
        result = device_services(mac.upper())
        if result is None:
            return _json_result(False, 'Device not found', 404)
        return jsonify({'success': True, **result})

    @bp.route('/api/bluetooth/device/<mac>/service/<service>/<action>', methods=['POST'])
    def service_action(mac, service, action):
        if not core.MAC_RE.match(mac):
            return _json_result(False, 'Invalid MAC address')
        mac = mac.upper()
        ok, out = False, 'Unknown action'

        if service == 'audio_in' and action in ('connect', 'disconnect'):
            ok, out = _connect_profile(mac, UUID_AUDIO_SOURCE, action == 'connect')
        elif service == 'audio_out' and action in ('connect', 'disconnect', 'make_default'):
            if action != 'make_default':
                ok, out = _connect_profile(mac, UUID_AUDIO_SINK, action == 'connect')
            else:
                ok, out = True, ''
            if ok and action != 'disconnect':
                # The sink node shows up a moment after the profile connects.
                for _ in range(20):
                    node = next((n for n in audio_state()['outputs'] if n['mac'] == mac), None)
                    if node:
                        ok, out = _run(['wpctl', 'set-default', str(node['id'])], timeout=5, user_session=True)
                        break
                    time.sleep(0.5)
                else:
                    ok, out = False, 'Connected, but no audio output appeared - is PipeWire running?'
        elif service == 'internet' and action == 'connect':
            ok, out = internet_connect(mac)
        elif service == 'internet' and action == 'disconnect':
            ok, out = _sudo(['nmcli', 'connection', 'down', _pan_connection_name(mac)])
        elif service == 'serial' and action == 'connect':
            helper.ensure_started()
            ok = helper.send(cmd='serial_connect', mac=mac)
            out = 'Connecting…' if ok else 'Bluetooth helper is not running'
        elif service == 'serial' and action == 'disconnect':
            ok = helper.send(cmd='serial_disconnect', mac=mac)
            out = '' if ok else 'Bluetooth helper is not running'
        elif service == 'input' and action in ('connect', 'disconnect'):
            if action == 'connect':
                ok = bool(core.bt_session and core.bt_session.send_command(f'connect {mac}'))
                out = 'Connecting…' if ok else 'Could not start the bluetoothctl session'
            else:
                ok, out = core.btctl('disconnect', mac, timeout=15)

        if core.bt_session:
            core.bt_session.info_cache.pop(mac, None)
        return _json_result(ok, out)

    # ---- audio
    @bp.route('/api/bluetooth/audio')
    def audio():
        return jsonify({'success': True, **audio_state()})

    @bp.route('/api/bluetooth/audio/<int:node_id>/<action>', methods=['POST'])
    def audio_action(node_id, action):
        data = request.get_json(silent=True) or {}
        if action == 'default':
            ok, out = _run(['wpctl', 'set-default', str(node_id)], timeout=5, user_session=True)
        elif action == 'volume':
            try:
                volume = max(0.0, min(float(data.get('volume')), 1.5))
            except (TypeError, ValueError):
                return _json_result(False, 'Invalid volume')
            ok, out = _run(['wpctl', 'set-volume', str(node_id), f'{volume:.2f}'], timeout=5, user_session=True)
        elif action == 'mute':
            ok, out = _run(['wpctl', 'set-mute', str(node_id), 'toggle'], timeout=5, user_session=True)
        elif action == 'test':
            node = next((n for n in audio_state()['outputs'] if n['id'] == node_id), None)
            if not node:
                return _json_result(False, 'Output not found', 404)
            subprocess.Popen(['pw-play', f"--target={node['name']}", _test_tone_path()], env=user_env(),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            ok, out = True, ''
        else:
            return _json_result(False, 'Unknown action')
        return _json_result(ok, out)

    # ---- files
    @bp.route('/api/bluetooth/files')
    def files():
        received = []
        if os.path.isdir(RECEIVE_DIR):
            for name in os.listdir(RECEIVE_DIR):
                path = os.path.join(RECEIVE_DIR, name)
                if os.path.isfile(path):
                    st = os.stat(path)
                    received.append({'name': name, 'size': st.st_size, 'mtime': st.st_mtime})
        received.sort(key=lambda f: -f['mtime'])
        return jsonify({
            'success': True, 'folder': RECEIVE_DIR, 'received': received,
            'transfers': list(helper.transfers.values()), 'requests': list(helper.requests.values()),
        })

    def _received_path(name):
        path = os.path.realpath(os.path.join(RECEIVE_DIR, name))
        if os.path.dirname(path) != os.path.realpath(RECEIVE_DIR) or not os.path.isfile(path):
            return None
        return path

    @bp.route('/api/bluetooth/files/received/<path:name>')
    def download(name):
        path = _received_path(name)
        if not path:
            return _json_result(False, 'File not found', 404)
        return send_file(path, as_attachment=True)

    @bp.route('/api/bluetooth/files/received/<path:name>', methods=['DELETE'])
    def delete(name):
        path = _received_path(name)
        if not path:
            return _json_result(False, 'File not found', 404)
        os.remove(path)
        return _json_result(True)

    @bp.route('/api/bluetooth/device/<mac>/send', methods=['POST'])
    def send(mac):
        if not core.MAC_RE.match(mac):
            return _json_result(False, 'Invalid MAC address')
        if not helper.files_ready:
            return _json_result(False, helper.files_error or 'File transfer is not set up')
        job_id = uuid.uuid4().hex
        upload = request.files.get('file')
        if upload:
            name = os.path.basename(upload.filename or '') or 'file'
            folder = os.path.join(OUTBOX_DIR, job_id)
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, name)
            upload.save(path)
            helper.outbox_jobs[job_id] = path
        else:
            path = str((request.get_json(silent=True) or {}).get('path') or '')
            if not os.path.isabs(path) or not os.path.isfile(path):
                return _json_result(False, 'File not found on the Pi')
        if not helper.send(cmd='obex_send', id=job_id, mac=mac.upper(), path=path):
            helper._cleanup_outbox(job_id)
            return _json_result(False, 'Bluetooth helper is not running')
        return _json_result(True, 'Sending…', job=job_id)

    @bp.route('/api/bluetooth/transfer/cancel', methods=['POST'])
    def cancel_transfer():
        transfer = str((request.get_json(silent=True) or {}).get('transfer') or '')
        if not transfer.startswith('/'):
            return _json_result(False, 'Invalid transfer')
        return _json_result(helper.send(cmd='obex_cancel', transfer=transfer))

    # ---- serial
    @bp.route('/api/bluetooth/serial')
    def serial():
        return jsonify({
            'success': True,
            'links': list(helper.links.values()),
            'buffers': {mac: base64.b64encode(bytes(buf[-16384:])).decode() for mac, buf in helper.serial_buffers.items()},
        })

    return bp


def register_bluetooth_services_socket_handlers(socketio):
    helper.socketio = socketio
    setup_job.socketio = socketio
    core.session_start_hooks.append(helper.ensure_started)

    @socketio.on('bt_file_answer', namespace=NAMESPACE)
    def file_answer(data):
        data = data or {}
        ok = helper.send(cmd='obex_answer', id=str(data.get('id') or ''), accept=bool(data.get('accept')))
        return {'success': ok}

    @socketio.on('bt_serial_write', namespace=NAMESPACE)
    def serial_write(data):
        data = data or {}
        mac = str(data.get('mac') or '').upper()
        if mac not in helper.links:
            return {'success': False, 'error': 'Not connected'}
        text = str(data.get('text') or '')
        if data.get('hex'):
            try:
                payload = bytes.fromhex(re.sub(r'[\s,:]', '', text))
            except ValueError:
                return {'success': False, 'error': 'Invalid hex'}
        else:
            payload = text.encode('utf-8')
        payload += {'lf': b'\n', 'cr': b'\r', 'crlf': b'\r\n'}.get(data.get('eol'), b'')
        ok = helper.send(cmd='serial_write', mac=mac, data=base64.b64encode(payload).decode())
        return {'success': ok}


def bluetooth_services_cleanup():
    helper.stop()


__all__ = [
    'build_bluetooth_services_blueprint', 'register_bluetooth_services_socket_handlers',
    'bluetooth_services_cleanup', 'explain_error',
]
