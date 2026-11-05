"""Local MQTT broker (Mosquitto) for the MQTT Explorer page: detect, install, configure.

Detection is unprivileged: the mosquitto binary, its systemd unit, and whether
anything (Mosquitto or another broker) is listening on the MQTT ports, read from
/proc/net/tcp*. Install / configure / start run through sudo as a background
job whose log the page shows.

The wizard writes a single drop-in, /etc/mosquitto/conf.d/cockpit.conf, for one
of three access modes:
  local     listener on 127.0.0.1 only, anonymous (Mosquitto 2's own default)
  network   listener on all interfaces, anonymous
  password  listener on all interfaces, username + password required
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import time

from flask import Blueprint, jsonify, request

from cockpit.core.auth import require_sudo
from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob, install_commands, package_manager
from cockpit.core.systemd import process_running, unit_enabled

MQTT_PORT = 1883
MQTT_PORTS = (1883, 8883)
CONF_DIR = '/etc/mosquitto/conf.d'
MAIN_CONF = '/etc/mosquitto/mosquitto.conf'
COCKPIT_CONF = f'{CONF_DIR}/cockpit.conf'
PASSWORD_FILE = '/etc/mosquitto/cockpit_passwd'
MODES = ('local', 'network', 'password')

PACKAGES = {
    'apt-get': ['mosquitto', 'mosquitto-clients'],
    'dnf': ['mosquitto'],
    'yum': ['mosquitto'],
    'zypper': ['mosquitto', 'mosquitto-clients'],
    'pacman': ['mosquitto'],
    'apk': ['mosquitto', 'mosquitto-clients'],
}

_job = BackgroundJob()


# ---------------------------------------------------------------- detection

def _mosquitto_binary() -> str | None:
    # /usr/sbin is often not on a normal user's PATH.
    found = shutil.which('mosquitto')
    if found:
        return found
    for path in ('/usr/sbin/mosquitto', '/usr/local/sbin/mosquitto'):
        if os.access(path, os.X_OK):
            return path
    return None


def _run(args: list[str], timeout: float = 5.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def _version(binary: str) -> str | None:
    # `mosquitto -h` prints "mosquitto version 2.0.18" and exits non-zero.
    _, out = _run([binary, '-h'], 4)
    match = re.search(r'mosquitto version (\S+)', out)
    return match.group(1) if match else None


def _hex_to_ip(hex_addr: str) -> str:
    raw = bytes.fromhex(hex_addr)
    if len(raw) == 4:
        return socket.inet_ntop(socket.AF_INET, raw[::-1])
    # IPv6 in /proc is four little-endian 32-bit words.
    words = b''.join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
    return socket.inet_ntop(socket.AF_INET6, words)


def listening_sockets(ports=MQTT_PORTS) -> list[dict]:
    """TCP sockets in LISTEN state on the given ports (any process)."""
    found = []
    for path in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(path) as f:
                lines = f.readlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 4 or parts[3] != '0A':
                continue
            addr_hex, port_hex = parts[1].split(':')
            port = int(port_hex, 16)
            if port in ports:
                try:
                    found.append({'address': _hex_to_ip(addr_hex), 'port': port})
                except ValueError:
                    continue
    return found


def _is_loopback(address: str) -> bool:
    return address.startswith('127.') or address in ('::1', '::ffff:127.0.0.1')


def _cockpit_conf() -> dict:
    """Mode/user recorded in the drop-in the wizard wrote, if any."""
    info = {'mode': None, 'username': None}
    try:
        with open(COCKPIT_CONF) as f:
            for line in f:
                match = re.match(r'#\s*cockpit-(mode|username):\s*(\S+)', line)
                if match:
                    info[match.group(1)] = match.group(2)
    except OSError:
        pass
    return info


def get_broker_status() -> dict:
    binary = _mosquitto_binary()
    listeners = listening_sockets()
    mqtt_listeners = [s for s in listeners if s['port'] == MQTT_PORT]
    has_systemd = shutil.which('systemctl') is not None
    status = {
        'installed': binary is not None,
        'version': _version(binary) if binary else None,
        # /proc and unit symlinks, not systemctl: this endpoint is hit on every page load.
        'service': ('active' if process_running('mosquitto') else 'inactive') if binary else None,
        'enabled': unit_enabled('mosquitto.service') if binary and has_systemd else None,
        'listeners': listeners,
        'broker_running': bool(mqtt_listeners),
        'local_only': bool(mqtt_listeners) and all(_is_loopback(s['address']) for s in mqtt_listeners),
        'port': MQTT_PORT,
        'package_manager': package_manager(),
        'systemd': has_systemd,
        'job': _job.view(),
        **_cockpit_conf(),
    }
    # Something else (another broker, a container) may own the port.
    status['other_broker'] = status['broker_running'] and not (binary and status['service'] == 'active')
    return status


# ---------------------------------------------------------------- configure

def _conf_text(mode: str, username: str | None) -> str:
    header = ('# Written by ServiceCockpit (MQTT Explorer setup). Change the mode from the\n'
              '# MQTT Explorer page, or delete this file to fall back to the Mosquitto defaults.\n'
              f'# cockpit-mode: {mode}\n')
    if mode == 'password':
        header += f'# cockpit-username: {username}\n'
    body = {
        'local': f'listener {MQTT_PORT} 127.0.0.1\nallow_anonymous true\n',
        'network': f'listener {MQTT_PORT}\nallow_anonymous true\n',
        'password': f'listener {MQTT_PORT}\nallow_anonymous false\npassword_file {PASSWORD_FILE}\n',
    }[mode]
    return header + '\n' + body


def _main_conf_includes_dir() -> bool:
    try:
        with open(MAIN_CONF) as f:
            return any(re.match(rf'\s*include_dir\s+{re.escape(CONF_DIR)}\s*$', line) for line in f)
    except OSError:
        return False


def _wait_for_port(seconds: float = 10) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if any(s['port'] == MQTT_PORT for s in listening_sockets()):
            return True
        time.sleep(0.5)
    return False


def _apply_config(password: str, mode: str, username: str | None, user_password: str | None) -> bool:
    job = _job
    job.log(f'Configuring access: {_MODE_LABELS[mode]}')
    if not job.stream(['mkdir', '-p', CONF_DIR], password, 20):
        return False
    if not job.stream(['sh', '-c', 'cat > "$0"', COCKPIT_CONF], password, 20, input_text=_conf_text(mode, username)):
        job.log(f'Could not write {COCKPIT_CONF}.')
        return False
    job.log(f'Wrote {COCKPIT_CONF}')

    if not _main_conf_includes_dir():
        job.log(f'Adding "include_dir {CONF_DIR}" to {MAIN_CONF}')
        if not job.stream(['sh', '-c', 'cat >> "$0"', MAIN_CONF], password, 20,
                          input_text=f'\ninclude_dir {CONF_DIR}\n'):
            return False

    if mode == 'password':
        passwd = shutil.which('mosquitto_passwd') or '/usr/bin/mosquitto_passwd'
        job.log(f'Creating MQTT user "{username}"')
        # -b takes the password as an argument (it is visible to local `ps` for a moment);
        # mosquitto_passwd cannot read it from a pipe reliably.
        if not job.stream([passwd, '-c', '-b', PASSWORD_FILE, username, user_password], password, 20):
            job.log('Could not create the password file.')
            return False
        # Mosquitto 2 warns (and newer versions refuse) when others can read the file.
        job.stream(['sh', '-c', f'id mosquitto >/dev/null 2>&1 && chown mosquitto: {PASSWORD_FILE}; '
                                f'chmod 600 {PASSWORD_FILE}'], password, 20)

    if shutil.which('systemctl'):
        job.stream(['systemctl', 'enable', 'mosquitto'], password, 30, echo=True)
        if not job.stream(['systemctl', 'restart', 'mosquitto'], password, 60, echo=True):
            job.log('Mosquitto did not start. Recent log:')
            job.stream(['journalctl', '-u', 'mosquitto', '-n', '25', '--no-pager'], password, 20)
            return False

    if not _wait_for_port():
        job.log(f'Mosquitto is not listening on port {MQTT_PORT}. Recent log:')
        job.stream(['journalctl', '-u', 'mosquitto', '-n', '25', '--no-pager'], password, 20)
        return False
    job.log(f'Mosquitto is running on port {MQTT_PORT}.')
    return True


_MODE_LABELS = {
    'local': 'this device only',
    'network': 'local network, no password',
    'password': 'local network, username + password',
}


def _validate(data: dict) -> tuple[str | None, str, str | None, str | None]:
    """(error, mode, username, password)"""
    mode = data.get('mode') or 'local'
    if mode not in MODES:
        return 'Unknown access mode.', mode, None, None
    if mode != 'password':
        return None, mode, None, None
    username = (data.get('username') or '').strip()
    user_password = data.get('password') or ''
    if not re.fullmatch(r'[A-Za-z0-9_.@-]{1,64}', username):
        return 'Username may use letters, digits and . _ - @ only.', mode, None, None
    if len(user_password) < 6 or any(c in user_password for c in '\r\n:'):
        return 'Password must be at least 6 characters (no ":" or line breaks).', mode, None, None
    return None, mode, username, user_password


def start_install(password: str, mode: str, username: str | None, user_password: str | None):
    def steps():
        manager = package_manager()
        commands = install_commands(manager, PACKAGES)
        if not commands:
            _job.log('No supported package manager found (apt, dnf, yum, zypper, pacman, apk).')
            return False
        _job.log(f'Installing Mosquitto with {manager}...')
        for cmd in commands:
            if not _job.stream(cmd, password, 900, env=NONINTERACTIVE, echo=True):
                if manager in ('dnf', 'yum'):
                    _job.log('Tip: on RHEL / Rocky / Alma, Mosquitto is in EPEL (dnf install epel-release).')
                return False
        binary = _mosquitto_binary()
        if not binary:
            _job.log('The package installed but the mosquitto program was not found.')
            return False
        _job.log(f'Installed Mosquitto {_version(binary) or ""}'.strip())
        return _apply_config(password, mode, username, user_password)
    return _job.start('install', steps)


def start_configure(password: str, mode: str, username: str | None, user_password: str | None):
    return _job.start('configure', lambda: _apply_config(password, mode, username, user_password))


def start_service(password: str, action: str):
    def steps():
        if action == 'start':
            _job.stream(['systemctl', 'enable', 'mosquitto'], password, 30, echo=True)
        if not _job.stream(['systemctl', action, 'mosquitto'], password, 60, echo=True):
            _job.stream(['journalctl', '-u', 'mosquitto', '-n', '25', '--no-pager'], password, 20)
            return False
        if action == 'stop':
            return True
        ok = _wait_for_port()
        _job.log(f'Mosquitto is running on port {MQTT_PORT}.' if ok
                 else f'Mosquitto started but is not listening on port {MQTT_PORT}.')
        return ok
    return _job.start(action, steps)


# ---------------------------------------------------------------- blueprint

def _reply(ok: bool, message: str = '', status: int = 400):
    body = {'success': ok}
    if not ok:
        body['error'] = message or 'Failed'
    return jsonify(body), 200 if ok else status


def build_mqtt_broker_blueprint() -> Blueprint:
    bp = Blueprint('mqtt_broker', __name__)

    @bp.route('/api/mqtt/broker')
    def api_status():
        return jsonify(get_broker_status())

    @bp.route('/api/mqtt/broker/job')
    def api_job():
        return jsonify(_job.view())

    @bp.route('/api/mqtt/broker/job/cancel', methods=['POST'])
    def api_job_cancel():
        return _reply(_job.cancel(), 'Nothing to cancel', 409)

    @bp.route('/api/mqtt/broker/install', methods=['POST'])
    def api_install():
        password, err = require_sudo()
        if err:
            return err
        if _mosquitto_binary():
            return _reply(False, 'Mosquitto is already installed.', 409)
        error, mode, username, user_password = _validate(request.get_json(silent=True) or {})
        if error:
            return _reply(False, error)
        return _reply(*start_install(password, mode, username, user_password), status=409)

    @bp.route('/api/mqtt/broker/configure', methods=['POST'])
    def api_configure():
        password, err = require_sudo()
        if err:
            return err
        if not _mosquitto_binary():
            return _reply(False, 'Mosquitto is not installed.', 409)
        error, mode, username, user_password = _validate(request.get_json(silent=True) or {})
        if error:
            return _reply(False, error)
        return _reply(*start_configure(password, mode, username, user_password), status=409)

    @bp.route('/api/mqtt/broker/service', methods=['POST'])
    def api_service():
        password, err = require_sudo()
        if err:
            return err
        action = (request.get_json(silent=True) or {}).get('action')
        if action not in ('start', 'stop', 'restart'):
            return _reply(False, 'Unknown action')
        if not _mosquitto_binary():
            return _reply(False, 'Mosquitto is not installed.', 409)
        return _reply(*start_service(password, action), status=409)

    return bp


__all__ = ['build_mqtt_broker_blueprint', 'get_broker_status', 'listening_sockets']
