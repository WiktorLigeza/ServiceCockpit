"""Bluetooth management page.

Everything goes through BlueZ's `bluetoothctl`:

* Read-only queries and simple actions (power, trust, remove, ...) run as
  one-shot `bluetoothctl <cmd>` invocations with a timeout - bluetoothctl
  blocks forever if bluetoothd isn't running, so nothing is called before the
  availability check says the service is up.
* One long-lived interactive `bluetoothctl` runs in a pty (BluetoothSession).
  It is registered as the default pairing agent, so PIN / passkey / confirm
  prompts - for pairing we start *and* for devices pairing with us while we're
  discoverable - are parsed out of its output and forwarded to the browser.
  Scanning and pair/connect also go through it: discovery is owned by the
  D-Bus client that started it, and pairing prompts are routed to the
  requesting client's agent.
"""

from __future__ import annotations

import os
import pty
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid

from flask import Blueprint, jsonify, render_template, request, session

from auth import SUDO_SESSION_KEY, is_authenticated, run_sudo

NAMESPACE = '/bluetooth'

MAC_RE = re.compile(r'^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$')
ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|[\x01\x02\x07]')
SHELL_PROMPT_RE = re.compile(r'^(?:\[[^\]\n]*\][#>]\s?)+')
DEVICE_LINE_RE = re.compile(r'^Device ([0-9A-Fa-f:]{17})(?: (.*))?$')
EVENT_RE = re.compile(r'^\[(NEW|DEL|CHG)\] (Device|Controller) ([0-9A-Fa-f:]{17})\s?(.*)$')

# Device properties whose change should make the UI re-read the device list.
# Everything else (ManufacturerData, TxPower, AdvertisingFlags, ...) is noise
# that arrives many times a second while scanning.
_RELEVANT_DEVICE_FIELDS = {
    'Name', 'Alias', 'Paired', 'Bonded', 'Trusted', 'Blocked', 'Connected',
    'ServicesResolved', 'Icon', 'Class', 'Battery Percentage',
}

_AGENT_PROMPTS = [
    (re.compile(r'\[agent\] Enter PIN code:\s*$'), 'pin'),
    (re.compile(r'\[agent\] Enter passkey \(number in 0-999999\):\s*$'), 'passkey'),
    (re.compile(r'\[agent\] Confirm passkey (\d+) \(yes/no\):\s*$'), 'confirm'),
    (re.compile(r'\[agent\] Accept pairing \(yes/no\):\s*$'), 'authorize'),
    (re.compile(r'\[agent\] Authorize service (\S+) \(yes/no\):\s*$'), 'service'),
    # Anything else that is clearly a question. Kept narrow so a display line
    # read mid-way ("[agent] Passkey:" before its digits arrive) isn't taken
    # for a prompt.
    (re.compile(r'\[agent\] ((?:Enter .*|.*\(yes/no\))):\s*$'), 'generic'),
]
_AGENT_DISPLAY_RE = re.compile(r'\[agent\] (PIN code|Passkey): (\S+)')

_NOTICE_PATTERNS = [
    (re.compile(r'^(Pairing successful|Connection successful|Successful disconnected)'), 'success'),
    (re.compile(r'^(Failed to .*)$'), 'error'),
    (re.compile(r'^(Attempting to (?:pair|connect) with .*|Attempting to connect to .*)$'), 'info'),
    (re.compile(r'^(Request canceled)$'), 'info'),
]


# --------------------------------------------------------------------------
# Availability / diagnostics
# --------------------------------------------------------------------------

def _read(path: str) -> str:
    try:
        with open(path, 'r') as f:
            return f.read().strip()
    except Exception:
        return ''


def _systemd_unit_state(unit: str) -> dict:
    try:
        out = subprocess.run(
            ['systemctl', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState'],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return {'exists': False, 'active': False, 'enabled': False, 'state': 'unknown'}
    props = dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
    return {
        'exists': props.get('LoadState') == 'loaded',
        'active': props.get('ActiveState') == 'active',
        'enabled': props.get('UnitFileState') == 'enabled',
        'state': props.get('ActiveState') or 'unknown',
    }


def _kernel_adapters() -> list[str]:
    try:
        return sorted(n for n in os.listdir('/sys/class/bluetooth') if n.startswith('hci') and ':' not in n)
    except Exception:
        return []


def _rfkill_bluetooth() -> list[dict]:
    """Read rfkill state straight from sysfs (no rfkill binary needed)."""
    entries = []
    base = '/sys/class/rfkill'
    try:
        names = sorted(os.listdir(base))
    except Exception:
        return entries
    for name in names:
        path = os.path.join(base, name)
        if _read(os.path.join(path, 'type')) != 'bluetooth':
            continue
        entries.append({
            'id': name,
            'name': _read(os.path.join(path, 'name')),
            'soft_blocked': _read(os.path.join(path, 'soft')) == '1',
            'hard_blocked': _read(os.path.join(path, 'hard')) == '1',
        })
    return entries


def _firmware_bt_disabled() -> str | None:
    """Return the config.txt path if Raspberry Pi firmware has BT disabled."""
    for path in ('/boot/firmware/config.txt', '/boot/config.txt'):
        text = _read(path)
        if not text:
            continue
        for line in text.splitlines():
            line = line.split('#', 1)[0].strip().replace(' ', '')
            if line in ('dtoverlay=disable-bt', 'dtoverlay=pi3-disable-bt'):
                return path
        return None
    return None


def check_availability() -> dict:
    installed = shutil.which('bluetoothctl') is not None
    service = _systemd_unit_state('bluetooth')
    adapters = _kernel_adapters()
    rfkill = _rfkill_bluetooth()
    fw_disabled = _firmware_bt_disabled()

    checks = [
        {'label': 'BlueZ tools (bluetoothctl) installed', 'ok': installed},
        {'label': 'bluetooth.service present', 'ok': service['exists']},
        {'label': f"bluetooth.service running ({service['state']})", 'ok': service['active']},
        {'label': f"Bluetooth adapter detected ({', '.join(adapters) or 'none'})", 'ok': bool(adapters)},
        {'label': 'Radio not blocked (rfkill)', 'ok': not any(r['soft_blocked'] or r['hard_blocked'] for r in rfkill)},
    ]
    if fw_disabled:
        checks.append({'label': f'Firmware Bluetooth enabled ({fw_disabled})', 'ok': False})

    hints: list[str] = []
    fixes: list[dict] = []
    reason = ''

    if not installed:
        reason = 'BlueZ (bluetoothctl) is not installed.'
        hints.append('Install it with: sudo apt install bluez')
    elif not service['exists']:
        reason = 'bluetooth.service does not exist on this system.'
        hints.append('Reinstall BlueZ: sudo apt install --reinstall bluez')
    elif not adapters:
        reason = 'No Bluetooth adapter was found.'
        if fw_disabled:
            hints.append(
                f'Bluetooth is disabled in firmware by "dtoverlay=disable-bt" in {fw_disabled}. '
                'Remove or comment out that line and reboot.'
            )
        hints.append('For a USB dongle, check that it is plugged in (lsusb) and its driver loaded (dmesg | grep -i blue).')
        # No start_service fix here: bluetooth.service is conditioned on
        # /sys/class/bluetooth existing, so it would just be skipped again.
    elif not service['active']:
        reason = 'The Bluetooth service (bluetoothd) is not running.'
        fixes.append({'action': 'start_service', 'label': 'Start bluetooth.service'})
        if not service['enabled']:
            fixes.append({'action': 'enable_service', 'label': 'Enable + start at boot'})

    # rfkill doesn't make the page unavailable (the adapter shows up but won't
    # power on) - surface it as a fix either way.
    if any(r['soft_blocked'] for r in rfkill):
        fixes.append({'action': 'unblock', 'label': 'Unblock radio (rfkill)'})
    if any(r['hard_blocked'] for r in rfkill):
        hints.append('The radio is hard-blocked (hardware switch or firmware) - it cannot be unblocked from software.')

    return {
        'available': not reason,
        'reason': reason,
        'checks': checks,
        'hints': hints,
        'fixes': fixes,
        'service': service,
        'kernel_adapters': adapters,
        'rfkill': rfkill,
    }


# --------------------------------------------------------------------------
# One-shot bluetoothctl
# --------------------------------------------------------------------------

def _clean(text: str) -> str:
    return ANSI_RE.sub('', text or '').replace('\r', '')


def btctl(*args: str, timeout: float = 8.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            ['bluetoothctl', *args],
            capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return False, f'bluetoothctl {" ".join(args)} timed out'
    except Exception as e:
        return False, str(e)
    out = _clean(proc.stdout + proc.stderr).strip()
    failed = proc.returncode != 0 or bool(re.search(r'^(Failed|Invalid|Too many arguments|No default controller)', out, re.M))
    return not failed, out


def _parse_properties(text: str) -> dict:
    props: dict = {'UUIDs': []}
    for raw in text.splitlines():
        line = raw.strip()
        if ':' not in line:
            continue
        key, value = line.split(':', 1)
        key, value = key.strip(), value.strip()
        if key == 'UUID':
            m = re.match(r'(.*?)\s*\(([0-9a-fA-F-]+)\)$', value)
            props['UUIDs'].append({'name': m.group(1) if m else value, 'uuid': m.group(2) if m else value})
        elif key not in props:
            props[key] = value
    return props


def _yes(props: dict, key: str) -> bool:
    return (props.get(key) or '').lower() == 'yes'


def _paren_int(value: str | None) -> int | None:
    """'0xffffffc4 (-60)' -> -60, '-60' -> -60, '0x64 (100)' -> 100."""
    if not value:
        return None
    m = re.search(r'\((-?\d+)\)', value) or re.match(r'^(-?\d+)$', value.strip())
    return int(m.group(1)) if m else None


def get_controllers() -> list[dict]:
    ok, out = btctl('list', timeout=4)
    controllers = []
    if not ok:
        return controllers
    for line in out.splitlines():
        m = re.match(r'^Controller ([0-9A-Fa-f:]{17}) (.*?)(\s+\[default\])?$', line.strip())
        if m:
            controllers.append({'mac': m.group(1), 'name': m.group(2), 'default': bool(m.group(3))})
    return controllers


def get_adapter() -> dict | None:
    ok, out = btctl('show', timeout=4)
    if not ok:
        return None
    m = re.search(r'^Controller ([0-9A-Fa-f:]{17})', out, re.M)
    if not m:
        return None
    props = _parse_properties(out)
    timeout_raw = props.get('DiscoverableTimeout', '')
    try:
        discoverable_timeout = int(timeout_raw.split()[0], 16) if timeout_raw.startswith('0x') else int(timeout_raw or 0)
    except ValueError:
        discoverable_timeout = None
    return {
        'mac': m.group(1),
        'name': props.get('Name', ''),
        'alias': props.get('Alias', ''),
        'class': props.get('Class', ''),
        'powered': _yes(props, 'Powered'),
        'discoverable': _yes(props, 'Discoverable'),
        'discoverable_timeout': discoverable_timeout,
        'pairable': _yes(props, 'Pairable'),
        'discovering': _yes(props, 'Discovering'),
        'modalias': props.get('Modalias', ''),
        'uuids': props['UUIDs'],
    }


def _device_list(filter_name: str | None = None) -> dict[str, str] | None:
    """{mac: name}; None if this bluetoothctl doesn't support the filter."""
    args = ['devices'] + ([filter_name] if filter_name else [])
    ok, out = btctl(*args, timeout=5)
    if not ok and filter_name == 'Paired':
        ok, out = btctl('paired-devices', timeout=5)
    if not ok:
        return None
    devices = {}
    for line in out.splitlines():
        m = DEVICE_LINE_RE.match(line.strip())
        if m:
            devices[m.group(1).upper()] = m.group(2) or ''
    return devices


def get_device_info(mac: str) -> dict | None:
    ok, out = btctl('info', mac, timeout=5)
    if not ok or 'Device ' not in out:
        return None
    props = _parse_properties(out)
    return {
        'mac': mac.upper(),
        'name': props.get('Name', ''),
        'alias': props.get('Alias', ''),
        'address_type': (re.search(r'^Device \S+ \((\w+)\)', out, re.M) or [None, ''])[1],
        'icon': props.get('Icon', ''),
        'class': props.get('Class', ''),
        'appearance': props.get('Appearance', ''),
        'paired': _yes(props, 'Paired'),
        'bonded': _yes(props, 'Bonded'),
        'trusted': _yes(props, 'Trusted'),
        'blocked': _yes(props, 'Blocked'),
        'connected': _yes(props, 'Connected'),
        'legacy_pairing': _yes(props, 'LegacyPairing'),
        'services_resolved': _yes(props, 'ServicesResolved'),
        'rssi': _paren_int(props.get('RSSI')),
        'tx_power': _paren_int(props.get('TxPower')),
        'battery': _paren_int(props.get('Battery Percentage')),
        'modalias': props.get('Modalias', ''),
        'uuids': props['UUIDs'],
    }


def _device_object_path(mac: str) -> str | None:
    suffix = 'dev_' + mac.upper().replace(':', '_')
    try:
        out = subprocess.run(['busctl', 'tree', 'org.bluez', '--list'], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    for line in out.splitlines():
        line = line.strip()
        if line.endswith('/' + suffix):
            return line
    return None


# --------------------------------------------------------------------------
# Interactive session (agent + events + scanning)
# --------------------------------------------------------------------------

class BluetoothSession:
    SESSION_GRACE_SECONDS = 15

    def __init__(self, socketio):
        self.socketio = socketio
        self.lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.master_fd: int | None = None
        self.pending_prompt: dict | None = None
        self.last_device: str | None = None
        self.rssi: dict[str, tuple[int, float]] = {}
        self.seen: dict[str, float] = {}
        self.info_cache: dict[str, tuple[dict, float]] = {}
        self.scan_until: float | None = None
        self.scan_transport = 'all'
        self._scan_started_at = 0.0
        self._scan_timer: threading.Timer | None = None
        self._clients = 0
        self._stop_timer: threading.Timer | None = None
        self.log: list[str] = []

    # -- lifecycle -------------------------------------------------------

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def ensure_started(self) -> bool:
        with self.lock:
            if self.running:
                return True
            if not check_availability()['available']:
                return False
            master_fd, slave_fd = pty.openpty()
            try:
                import fcntl
                import struct
                import termios
                # Wide terminal so readline never wraps long event lines.
                fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 500, 0, 0))
            except Exception:
                pass
            env = dict(os.environ)
            env['TERM'] = 'dumb'
            self.proc = subprocess.Popen(
                ['bluetoothctl'],
                stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                env=env, preexec_fn=os.setsid, close_fds=True,
            )
            os.close(slave_fd)
            self.master_fd = master_fd
            self.pending_prompt = None
            threading.Thread(target=self._reader_loop, args=(self.proc, master_fd), daemon=True).start()
            # bluetoothctl auto-registers its agent on start; make it the
            # default so pairing initiated by remote devices lands here too.
            self._write('default-agent')
            self._emit('bt_session', {'running': True})
            return True

    def stop(self):
        with self.lock:
            self._cancel_scan_timer()
            self.scan_until = None
            proc, fd = self.proc, self.master_fd
            self.proc, self.master_fd = None, None
            self.pending_prompt = None
        if proc and proc.poll() is None:
            try:
                os.write(fd, b'quit\n')
                proc.wait(timeout=2)
            except Exception:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    pass
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def client_connected(self):
        with self.lock:
            self._clients += 1
            if self._stop_timer:
                self._stop_timer.cancel()
                self._stop_timer = None
        self.ensure_started()
        for hook in session_start_hooks:
            try:
                hook()
            except Exception:
                pass

    def client_disconnected(self):
        with self.lock:
            self._clients = max(0, self._clients - 1)
            if self._clients == 0 and self._stop_timer is None:
                # Grace period so a page reload doesn't drop a running scan.
                self._stop_timer = threading.Timer(self.SESSION_GRACE_SECONDS, self._stop_if_idle)
                self._stop_timer.daemon = True
                self._stop_timer.start()

    def _stop_if_idle(self):
        with self.lock:
            self._stop_timer = None
            if self._clients > 0:
                return
        self.stop()

    # -- io --------------------------------------------------------------

    def _write(self, line: str) -> bool:
        line = line.replace('\r', ' ').replace('\n', ' ')
        with self.lock:
            if not self.running or self.master_fd is None:
                return False
            try:
                os.write(self.master_fd, (line + '\n').encode())
                return True
            except OSError:
                return False

    def send_command(self, line: str) -> bool:
        return self.ensure_started() and self._write(line)

    def _emit(self, event: str, data: dict):
        self.socketio.emit(event, data, namespace=NAMESPACE)

    def _reader_loop(self, proc: subprocess.Popen, fd: int):
        buf = ''
        try:
            while True:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk.decode('utf-8', errors='replace')
                while '\n' in buf:
                    raw, buf = buf.split('\n', 1)
                    self._handle_line(self._normalize(raw))
                self._check_prompt(self._normalize(buf))
        finally:
            with self.lock:
                if self.proc is proc:
                    self.proc, self.master_fd = None, None
                    self.pending_prompt = None
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self._emit('bt_session', {'running': False})

    @staticmethod
    def _normalize(raw: str) -> str:
        # The pty turns \n into \r\n; beyond that, readline redraws the line
        # with \r, so the last segment is what's actually visible.
        text = ANSI_RE.sub('', raw).rstrip('\r').split('\r')[-1]
        return SHELL_PROMPT_RE.sub('', text).rstrip()

    # -- parsing ---------------------------------------------------------

    def _handle_line(self, line: str):
        if not line.strip():
            return
        self.log.append(line)
        del self.log[:-300]
        self._emit('bt_log', {'line': line, 'ts': time.time()})

        m = EVENT_RE.match(line)
        if m:
            self._handle_event(m.group(1), m.group(2), m.group(3).upper(), m.group(4))
            return

        mac = re.search(r'([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})', line)
        if mac and ('pair' in line.lower() or 'connect' in line.lower()):
            self.last_device = mac.group(1).upper()

        d = _AGENT_DISPLAY_RE.search(line)
        if d:
            self._emit('bt_auth_display', {
                'kind': d.group(1), 'code': d.group(2), 'device': self._device_label(self.last_device),
            })
            return

        if line.strip() == 'Request canceled':
            with self.lock:
                self.pending_prompt = None
            self._emit('bt_auth_cancel', {})

        for pattern, level in _NOTICE_PATTERNS:
            n = pattern.match(line.strip())
            if n:
                from bluetooth_services import explain_error
                self._emit('bt_notice', {'level': level, 'message': n.group(1),
                                         'hint': explain_error(n.group(1)) if level == 'error' else ''})
                if level != 'info':
                    self._emit('bt_devices_changed', {})
                break

    def _handle_event(self, kind: str, obj: str, mac: str, rest: str):
        if obj == 'Controller':
            # The late "Discovering: no" from the `scan off` that start_scan
            # sends when restarting a scan must not end the new scan.
            if (kind == 'CHG' and rest.startswith('Discovering:') and rest.endswith('no')
                    and time.time() - self._scan_started_at > 3):
                with self.lock:
                    self.scan_until = None
                    self._cancel_scan_timer()
            self._emit('bt_adapter_changed', {'detail': rest})
            return

        now = time.time()
        if kind == 'DEL':
            self.rssi.pop(mac, None)
            self.seen.pop(mac, None)
            self.info_cache.pop(mac, None)
            self._emit('bt_devices_changed', {})
            return

        self.seen[mac] = now
        if kind == 'NEW':
            self._emit('bt_devices_changed', {})
            return

        field, _, value = rest.partition(':')
        field, value = field.strip(), value.strip()
        if field == 'RSSI':
            rssi = _paren_int(value)
            if rssi is not None:
                self.rssi[mac] = (rssi, now)
                self._emit('bt_rssi', {'mac': mac, 'rssi': rssi})
        elif field in _RELEVANT_DEVICE_FIELDS:
            self.info_cache.pop(mac, None)
            if field in ('Paired', 'Connected'):
                self.last_device = mac
            self._emit('bt_devices_changed', {'mac': mac, 'field': field, 'value': value})

    def _check_prompt(self, partial: str):
        if '[agent]' not in partial:
            return
        for pattern, kind in _AGENT_PROMPTS:
            m = pattern.search(partial)
            if not m:
                continue
            with self.lock:
                if self.pending_prompt and self.pending_prompt['text'] == partial:
                    return
                prompt = {
                    'id': uuid.uuid4().hex,
                    'type': kind,
                    'text': partial,
                    'message': partial.split('[agent]', 1)[1].strip(),
                    'passkey': m.group(1) if kind == 'confirm' else None,
                    'uuid': m.group(1) if kind == 'service' else None,
                    'yes_no': '(yes/no)' in partial,
                    'device': self._device_label(self.last_device),
                }
                self.pending_prompt = prompt
            self._emit('bt_auth_request', prompt)
            return

    def answer_prompt(self, prompt_id: str, value) -> tuple[bool, str]:
        with self.lock:
            prompt = self.pending_prompt
            if not prompt or prompt['id'] != prompt_id:
                return False, 'This request is no longer pending.'
            self.pending_prompt = None
        if prompt['yes_no']:
            answer = 'yes' if value in (True, 'yes') else 'no'
        elif prompt['type'] == 'passkey':
            answer = str(value or '').strip()
            if not answer.isdigit() or int(answer) > 999999:
                return False, 'Passkey must be a number between 0 and 999999.'
        else:
            answer = str(value or '').strip()
            if not answer or len(answer) > 16 or not answer.isprintable():
                return False, 'PIN must be 1-16 printable characters.'
        self._write(answer)
        return True, ''

    def _device_label(self, mac: str | None) -> dict | None:
        if not mac:
            return None
        cached = self.info_cache.get(mac)
        name = cached[0].get('alias') if cached else ''
        return {'mac': mac, 'name': name}

    # -- scanning --------------------------------------------------------

    def _cancel_scan_timer(self):
        if self._scan_timer:
            self._scan_timer.cancel()
            self._scan_timer = None

    def start_scan(self, transport: str, duration: int) -> bool:
        transport = transport if transport in ('le', 'bredr') else 'all'
        with self.lock:
            if not self.ensure_started():
                return False
            self._cancel_scan_timer()
            if self.scan_until:
                self._write('scan off')
            self.scan_transport = transport
            self._scan_started_at = time.time()
            self._write('scan ' + ('on' if transport == 'all' else transport))
            self.scan_until = time.time() + duration if duration > 0 else float('inf')
            if duration > 0:
                self._scan_timer = threading.Timer(duration, self.stop_scan)
                self._scan_timer.daemon = True
                self._scan_timer.start()
        self._emit('bt_scan', self.scan_state())
        return True

    def stop_scan(self):
        with self.lock:
            self._cancel_scan_timer()
            self.scan_until = None
            if self.running:
                self._write('scan off')
        self._emit('bt_scan', self.scan_state())

    def scan_state(self) -> dict:
        until = self.scan_until
        return {
            'scanning': bool(until),
            'transport': self.scan_transport,
            'remaining': None if not until or until == float('inf') else max(0, int(until - time.time())),
        }

    # -- device cache ----------------------------------------------------

    def cached_info(self, mac: str, max_age: float = 30.0) -> dict | None:
        cached = self.info_cache.get(mac)
        if cached and time.time() - cached[1] < max_age:
            return cached[0]
        info = get_device_info(mac)
        if info:
            self.info_cache[mac] = (info, time.time())
        return info


bt_session: BluetoothSession | None = None

# Called (in a worker thread) whenever a page client connects - lets
# bluetooth_services start its D-Bus helper alongside the agent session.
session_start_hooks: list = []


def list_devices() -> list[dict]:
    all_devices = _device_list() or {}
    flag_sets = {}
    for flag in ('Paired', 'Trusted', 'Connected'):
        found = _device_list(flag)
        flag_sets[flag] = set(found) if found is not None else None

    devices = []
    now = time.time()
    for mac, name in all_devices.items():
        # Older bluetoothctl can't filter `devices`; fall back to `info`.
        needs_info = any(v is None for v in flag_sets.values())
        paired = mac in (flag_sets['Paired'] or set())
        connected = mac in (flag_sets['Connected'] or set())
        info = bt_session.cached_info(mac) if bt_session and (needs_info or paired or connected) else None
        if info is None and bt_session:
            cached = bt_session.info_cache.get(mac)
            info = cached[0] if cached else None
        rssi = bt_session.rssi.get(mac) if bt_session else None
        seen = bt_session.seen.get(mac) if bt_session else None
        devices.append({
            'mac': mac,
            'name': (info or {}).get('alias') or name,
            'has_name': bool(name) and name.replace('-', ':').upper() != mac,
            'icon': (info or {}).get('icon', ''),
            'paired': info['paired'] if info else paired,
            'trusted': info['trusted'] if info else mac in (flag_sets['Trusted'] or set()),
            'connected': info['connected'] if info else connected,
            'blocked': (info or {}).get('blocked', False),
            'battery': (info or {}).get('battery'),
            'rssi': rssi[0] if rssi and now - rssi[1] < 120 else (info or {}).get('rssi'),
            'last_seen': seen,
        })
    devices.sort(key=lambda d: (not d['connected'], not d['paired'], -(d['rssi'] if d['rssi'] is not None else -999), d['name'].lower()))
    return devices


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _require_sudo():
    password = session.get(SUDO_SESSION_KEY)
    if not password:
        return None, (jsonify({'success': False, 'error': 'sudo_required', 'message': 'Sudo password required.'}), 401)
    return password, None


def _result(ok: bool, output: str = '', status: int = 200, **extra):
    body = {'success': ok, 'output': output, **extra}
    if not ok:
        from bluetooth_services import explain_error
        body['error'] = output or 'Command failed'
        body['hint'] = explain_error(output)
    return jsonify(body), status if ok else (status if status != 200 else 400)


def _unavailable():
    return jsonify({'success': False, 'error': 'Bluetooth is not available', 'availability': check_availability()}), 503


def build_bluetooth_blueprint() -> Blueprint:
    bp = Blueprint('bluetooth', __name__)

    @bp.route('/bluetooth')
    def bluetooth_page():
        return render_template('bluetooth.html')

    @bp.route('/api/bluetooth/status')
    def bt_status():
        availability = check_availability()
        payload = {'success': True, 'availability': availability}
        if availability['available']:
            payload['adapter'] = get_adapter()
            payload['controllers'] = get_controllers()
            payload['session'] = {
                'running': bool(bt_session and bt_session.running),
                'pending_prompt': bt_session.pending_prompt if bt_session else None,
            }
            payload['scan'] = bt_session.scan_state() if bt_session else {'scanning': False}
            payload['log'] = bt_session.log[-150:] if bt_session else []
        return jsonify(payload)

    @bp.route('/api/bluetooth/devices')
    def bt_devices():
        if not check_availability()['available']:
            return _unavailable()
        return jsonify({'success': True, 'devices': list_devices()})

    @bp.route('/api/bluetooth/device/<mac>')
    def bt_device(mac):
        if not MAC_RE.match(mac):
            return _result(False, 'Invalid MAC address')
        info = get_device_info(mac)
        if not info:
            return _result(False, 'Device not found', 404)
        if bt_session:
            bt_session.info_cache[mac.upper()] = (info, time.time())
        return jsonify({'success': True, 'device': info})

    @bp.route('/api/bluetooth/adapter', methods=['POST'])
    def bt_adapter_action():
        if not check_availability()['available']:
            return _unavailable()
        data = request.get_json(silent=True) or {}
        action = data.get('action')
        value = data.get('value')
        onoff = 'on' if value else 'off'

        if action == 'power':
            ok, out = btctl('power', onoff)
            if not ok and 'Blocked' in out:
                out += '\nThe radio is blocked by rfkill - unblock it first.'
        elif action == 'discoverable':
            if value and data.get('timeout') is not None:
                try:
                    timeout = max(0, min(int(data['timeout']), 86400))
                except (TypeError, ValueError):
                    return _result(False, 'Invalid timeout')
                btctl('discoverable-timeout', str(timeout))
            if value:
                # Remote devices can only pair with us if pairable too.
                btctl('pairable', 'on')
            ok, out = btctl('discoverable', onoff)
        elif action == 'pairable':
            ok, out = btctl('pairable', onoff)
        elif action == 'alias':
            alias = str(value or '').strip()
            if not alias or len(alias) > 248 or not alias.isprintable():
                return _result(False, 'Name must be 1-248 printable characters')
            ok, out = btctl('system-alias', alias)
        elif action == 'reset_alias':
            ok, out = btctl('reset-alias')
        else:
            return _result(False, 'Unknown action')
        return _result(ok, out)

    @bp.route('/api/bluetooth/scan', methods=['POST'])
    def bt_scan():
        if not check_availability()['available']:
            return _unavailable()
        data = request.get_json(silent=True) or {}
        if not data.get('on'):
            if bt_session:
                bt_session.stop_scan()
            return _result(True, 'Scan stopped', scan={'scanning': False})
        try:
            duration = max(0, min(int(data.get('duration', 30)), 3600))
        except (TypeError, ValueError):
            duration = 30
        if not bt_session or not bt_session.start_scan(str(data.get('transport') or 'all'), duration):
            return _result(False, 'Could not start the bluetoothctl session')
        return _result(True, 'Scanning', scan=bt_session.scan_state())

    @bp.route('/api/bluetooth/device/<mac>/<action>', methods=['POST'])
    def bt_device_action(mac, action):
        if not MAC_RE.match(mac):
            return _result(False, 'Invalid MAC address')
        if not check_availability()['available']:
            return _unavailable()
        mac = mac.upper()

        # These can trigger an authentication prompt, so they must run in the
        # interactive session whose agent forwards prompts to the browser.
        if action in ('pair', 'connect'):
            if not bt_session or not bt_session.send_command(f'{action} {mac}'):
                return _result(False, 'Could not start the bluetoothctl session')
            bt_session.last_device = mac
            return _result(True, f'{action.capitalize()} requested', pending=True)

        if action == 'rename':
            name = str((request.get_json(silent=True) or {}).get('name') or '').strip()
            if len(name) > 248 or not name.isprintable():
                return _result(False, 'Name must be up to 248 printable characters')
            path = _device_object_path(mac)
            if not path:
                return _result(False, 'Device not found on D-Bus', 404)
            # An empty alias makes BlueZ fall back to the remote name.
            proc = subprocess.run(
                ['busctl', 'set-property', 'org.bluez', path, 'org.bluez.Device1', 'Alias', 's', name],
                capture_output=True, text=True, timeout=5,
            )
            ok, out = proc.returncode == 0, (proc.stderr or proc.stdout).strip()
        else:
            commands = {
                'disconnect': ['disconnect', mac],
                'trust': ['trust', mac],
                'untrust': ['untrust', mac],
                'block': ['block', mac],
                'unblock': ['unblock', mac],
                'remove': ['remove', mac],
                'cancel_pair': ['cancel-pairing', mac],
            }
            if action not in commands:
                return _result(False, 'Unknown action')
            ok, out = btctl(*commands[action], timeout=15)

        if bt_session:
            bt_session.info_cache.pop(mac, None)
        return _result(ok, out)

    @bp.route('/api/bluetooth/fix', methods=['POST'])
    def bt_fix():
        action = (request.get_json(silent=True) or {}).get('action')
        commands = {
            'start_service': [['systemctl', 'start', 'bluetooth']],
            'restart_service': [['systemctl', 'restart', 'bluetooth']],
            'enable_service': [['systemctl', 'enable', 'bluetooth'], ['systemctl', 'start', 'bluetooth']],
            'unblock': [['rfkill', 'unblock', 'bluetooth']],
        }
        if action not in commands:
            return _result(False, 'Unknown action')
        password, error = _require_sudo()
        if error:
            return error
        if action == 'restart_service' and bt_session:
            bt_session.stop()
        outputs = []
        for cmd in commands[action]:
            proc = run_sudo(cmd, password, check=False)
            outputs.append((proc.stdout + proc.stderr).strip())
            if proc.returncode != 0:
                return _result(False, '\n'.join(o for o in outputs if o) or f'{" ".join(cmd)} failed', 500)
        # Give bluetoothd a moment to register the adapter before re-checking.
        time.sleep(1.5)
        return _result(True, '\n'.join(o for o in outputs if o), availability=check_availability())

    return bp


# --------------------------------------------------------------------------
# Socket.IO
# --------------------------------------------------------------------------

def register_bluetooth_socket_handlers(socketio):
    global bt_session
    bt_session = BluetoothSession(socketio)

    @socketio.on('connect', namespace=NAMESPACE)
    def handle_connect():
        if not is_authenticated():
            return False
        threading.Thread(target=bt_session.client_connected, daemon=True).start()

    @socketio.on('disconnect', namespace=NAMESPACE)
    def handle_disconnect():
        bt_session.client_disconnected()

    @socketio.on('bt_auth_response', namespace=NAMESPACE)
    def handle_auth_response(data):
        data = data or {}
        ok, error = bt_session.answer_prompt(str(data.get('id') or ''), data.get('value'))
        return {'success': ok, 'error': error}

    @socketio.on('bt_raw_command', namespace=NAMESPACE)
    def handle_raw_command(data):
        command = str((data or {}).get('command') or '').strip()
        if not command:
            return {'success': False, 'error': 'Empty command'}
        if command.split()[0] in ('quit', 'exit'):
            return {'success': False, 'error': 'The session is managed by the page'}
        ok = bt_session.send_command(command)
        return {'success': ok, 'error': '' if ok else 'bluetoothctl session is not running'}


def bluetooth_cleanup_on_shutdown():
    if bt_session:
        bt_session.stop()


__all__ = ['build_bluetooth_blueprint', 'register_bluetooth_socket_handlers', 'bluetooth_cleanup_on_shutdown']
