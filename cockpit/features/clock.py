"""Device clock: the time shown in the header and the time-zone / NTP dialog.

`get_clock()` is part of every metrics update, so it only reads cheap sources
(the system clock and the /etc/localtime symlink). `timedatectl`, which goes
through D-Bus to systemd and can take seconds on a busy device, is only used
when the dialog opens or a setting changes.
"""

from __future__ import annotations

import functools
import os
import re
import shutil
import socket
import struct
import subprocess
import time
from datetime import datetime

from flask import Blueprint, jsonify, request

from cockpit.core.auth import require_sudo, run_sudo
from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob, install_commands, package_manager

ZONEINFO = '/usr/share/zoneinfo'
TZ_RE = re.compile(r'^[A-Za-z0-9_+\-]+(/[A-Za-z0-9_+\-]+){0,2}$')


def _timezone_name() -> str | None:
    try:
        target = os.path.realpath('/etc/localtime')
    except OSError:
        return None
    marker = '/zoneinfo/'
    if marker in target:
        return target.split(marker, 1)[1]
    try:
        with open('/etc/timezone') as f:
            return f.read().strip() or None
    except OSError:
        return None


def get_clock() -> dict:
    """Device time for the header: epoch (ms), zone name, abbreviation, UTC offset."""
    now = time.time()
    local = time.localtime(now)
    return {
        'epoch_ms': int(now * 1000),
        'timezone': _timezone_name(),
        'abbrev': local.tm_zone,
        'utc_offset_min': local.tm_gmtoff // 60,
    }


def _run(args: list[str], timeout: float = 10) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        return False, f'{args[0]} is not installed'
    except subprocess.TimeoutExpired:
        return False, f'{args[0]} timed out'
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


@functools.lru_cache(maxsize=1)
def list_timezones() -> tuple[str, ...]:
    ok, out = _run(['timedatectl', 'list-timezones'])
    if ok and out:
        return tuple(out.split())
    # No systemd: walk the zoneinfo tree instead.
    zones = []
    for root, _, files in os.walk(ZONEINFO):
        rel = os.path.relpath(root, ZONEINFO)
        if rel.split('/')[0] in ('posix', 'right', 'Etc') and rel != 'Etc':
            continue
        for name in files:
            zone = name if rel == '.' else f'{rel}/{name}'
            if TZ_RE.match(zone) and name[0].isupper():
                zones.append(zone)
    return tuple(sorted(zones))


# ------------------------------------------------------------------ NTP servers
#
# The device's NTP client is either systemd-timesyncd or chrony. Custom servers
# (e.g. a chrony server on the LAN) are written to a file/block owned by
# ServiceCockpit so the distribution's own config stays untouched:
#   timesyncd: a drop-in in /etc/systemd/timesyncd.conf.d/
#   chrony:    a marked block in chrony.conf; with "only these servers" the
#              other pool/server lines are commented out with a marker so they
#              can be restored later.
#
# NTP *server* mode (other devices sync from this one) needs chrony: the same
# block then also holds `allow <network>` lines and optionally `local stratum`,
# and UDP 123 is opened in the firewall (cockpit/features/network/firewall.py).

TIMESYNCD_DROPIN_DIR = '/etc/systemd/timesyncd.conf.d'
TIMESYNCD_DROPIN = f'{TIMESYNCD_DROPIN_DIR}/50-servicecockpit.conf'
CHRONY_CONFS = ('/etc/chrony/chrony.conf', '/etc/chrony.conf')
CHRONY_BEGIN = '# BEGIN ServiceCockpit NTP'
CHRONY_END = '# END ServiceCockpit NTP'
CHRONY_OFF = '#servicecockpit-off# '
HOST_RE = re.compile(r'^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$')
NTP_EPOCH_DELTA = 2208988800  # 1900-01-01 -> 1970-01-01


def _valid_server(host: str) -> bool:
    import ipaddress
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return bool(HOST_RE.match(host))


def _service_active(unit: str) -> bool:
    ok, out = _run(['systemctl', 'is-active', unit], timeout=5)
    return ok and out.strip() == 'active'


def _chrony_conf() -> str | None:
    return next((p for p in CHRONY_CONFS if os.path.isfile(p)), None)


def _ntp_backend() -> str | None:
    if _chrony_conf() and (_service_active('chrony') or _service_active('chronyd')):
        return 'chrony'
    if os.path.exists('/lib/systemd/systemd-timesyncd') or os.path.exists('/usr/lib/systemd/systemd-timesyncd'):
        return 'timesyncd'
    if _chrony_conf():
        return 'chrony'
    return None


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ''


def _timesyncd_config() -> tuple[list[str], bool]:
    servers, exclusive = [], False
    for line in _read(TIMESYNCD_DROPIN).splitlines():
        key, _, value = line.partition('=')
        if key.strip() == 'NTP':
            servers = value.split()
        elif key.strip() == 'FallbackNTP' and not value.strip():
            exclusive = True
    return servers, exclusive


def parse_chrony(text: str) -> dict:
    """What our managed block in chrony.conf says."""
    cfg = {'servers': [], 'exclusive': CHRONY_OFF in text, 'allow': [], 'local': False}
    inside = False
    for line in text.splitlines():
        words = line.split()
        if line.strip() == CHRONY_BEGIN:
            inside = True
        elif line.strip() == CHRONY_END:
            inside = False
        elif inside and words[:1] == ['server'] and len(words) > 1:
            cfg['servers'].append(words[1])
        elif inside and words[:1] == ['allow']:
            cfg['allow'].append(words[1] if len(words) > 1 else 'all')
        elif inside and words[:1] == ['local']:
            cfg['local'] = True
    return cfg


def render_chrony(text: str, cfg: dict) -> str:
    """chrony.conf `text` with our block rewritten for `cfg` (servers, exclusive, allow, local)."""
    servers, allow = cfg.get('servers') or [], cfg.get('allow') or []
    out_lines, inside, after_block = [], False, False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == CHRONY_BEGIN:
            inside = True
            continue
        if stripped == CHRONY_END:
            inside, after_block = False, True
            continue
        if inside:
            continue
        if after_block:
            after_block = False
            if not stripped:
                continue  # the blank separator line written after our block
        if line.startswith(CHRONY_OFF):
            line = line[len(CHRONY_OFF):]
        if servers and cfg.get('exclusive') and line.split()[:1] in (['pool'], ['server'], ['peer']):
            line = CHRONY_OFF + line
        out_lines.append(line)
    block = [f'server {s} iburst prefer' for s in servers]
    if allow:
        block += ['# Serve time to these networks (NTP server mode)']
        block += ['allow' if a == 'all' else f'allow {a}' for a in allow]
        if cfg.get('local'):
            block += ['# Keep serving time even with no upstream source reachable', 'local stratum 10']
    if block:
        out_lines = [CHRONY_BEGIN, '# Managed by ServiceCockpit (clock dialog)', *block, CHRONY_END, ''] + out_lines
    return '\n'.join(out_lines).rstrip('\n') + '\n'


def _chrony_config() -> tuple[list[str], bool]:
    cfg = parse_chrony(_read(_chrony_conf() or ''))
    return cfg['servers'], cfg['exclusive']


def _timesyncd_status() -> dict:
    ok, out = _run(['timedatectl', 'show-timesync'])
    props = dict(line.split('=', 1) for line in out.splitlines() if '=' in line) if ok else {}
    msg = props.get('NTPMessage', '')
    stratum = re.search(r'Stratum=(\d+)', msg)
    current = props.get('ServerName') or ''
    if props.get('ServerAddress') and props.get('ServerAddress') != current:
        current = f"{current} ({props['ServerAddress']})" if current else props['ServerAddress']
    return {
        'current': current or None,
        'stratum': int(stratum.group(1)) if stratum else None,
        'sources': [],
        'default_servers': (props.get('FallbackNTPServers') or '').split(),
        'link_servers': (props.get('LinkNTPServers') or '').split(),
    }


def _chrony_status() -> dict:
    ok, out = _run(['chronyc', '-n', '-c', 'sources'], timeout=5)
    sources, current, stratum = [], None, None
    for line in out.splitlines() if ok else []:
        f = line.split(',')
        if len(f) < 8:
            continue
        try:
            offset_ms = round(float(f[7]) * 1000, 3)
        except ValueError:
            offset_ms = None
        src = {'address': f[2], 'state': f[1], 'stratum': int(f[3]) if f[3].isdigit() else None,
               'reach': f[5], 'offset_ms': offset_ms}
        sources.append(src)
        if f[1] == '*':
            current, stratum = f[2], src['stratum']
    return {'current': current, 'stratum': stratum, 'sources': sources, 'default_servers': [], 'link_servers': []}


def get_ntp_servers() -> dict:
    backend = _ntp_backend()
    if backend == 'timesyncd':
        servers, exclusive = _timesyncd_config()
        status = _timesyncd_status()
    elif backend == 'chrony':
        servers, exclusive = _chrony_config()
        status = _chrony_status()
    else:
        servers, exclusive, status = [], False, {}
    return {'backend': backend, 'servers': servers, 'exclusive': exclusive, **status}


def _write_root_file(path: str, text: str, password: str) -> tuple[bool, str]:
    return _sudo_input(['sh', '-c', 'mkdir -p "$(dirname "$0")" && cat > "$0"', path], password, text)


def _apply_timesyncd(servers: list[str], exclusive: bool, password: str) -> tuple[bool, str]:
    if servers:
        text = '# Managed by ServiceCockpit (clock dialog)\n[Time]\nNTP=' + ' '.join(servers) + '\n'
        if exclusive:
            text += 'FallbackNTP=\n'
        ok, out = _write_root_file(TIMESYNCD_DROPIN, text, password)
    else:
        ok, out = _sudo(['rm', '-f', TIMESYNCD_DROPIN], password)
    if not ok:
        return ok, out
    # try-restart: if NTP is switched off the service stays stopped.
    return _sudo(['systemctl', 'try-restart', 'systemd-timesyncd'], password)


def _chrony_unit() -> str:
    """Debian/Ubuntu name the unit chrony.service, Fedora/RHEL/Arch chronyd.service."""
    for base in ('/lib/systemd/system', '/usr/lib/systemd/system', '/etc/systemd/system'):
        if os.path.exists(f'{base}/chrony.service'):
            return 'chrony'
    return 'chronyd'


def _write_chrony(changes: dict, password: str, restart: str = 'try-restart') -> tuple[bool, str]:
    """Merge `changes` into our chrony.conf block, write it and restart chrony."""
    conf = _chrony_conf()
    if not conf:
        return False, 'chrony.conf not found.'
    text = _read(conf)
    cfg = {**parse_chrony(text), **changes}
    ok, out = _write_root_file(conf, render_chrony(text, cfg), password)
    if not ok:
        return ok, out
    ok, out = _sudo(['systemctl', restart, _chrony_unit()], password)
    if ok:
        _sudo(['chronyc', 'makestep'], password)  # jump straight to the new source's time
    return ok, out


def _apply_chrony(servers: list[str], exclusive: bool, password: str) -> tuple[bool, str]:
    return _write_chrony({'servers': servers, 'exclusive': exclusive}, password)


# ------------------------------------------------------------------ NTP server mode

NTP_FW_COMMENT = 'ServiceCockpit NTP server'
_job = BackgroundJob()


def _chrony_installed() -> bool:
    return bool(shutil.which('chronyd') or os.path.exists('/usr/sbin/chronyd'))


def _udp_listening(port: int) -> bool:
    needle = f':{port:04X} '
    for path in ('/proc/net/udp', '/proc/net/udp6'):
        for line in _read(path).splitlines()[1:]:
            fields = line.split()
            if len(fields) > 2 and (fields[1] + ' ').endswith(needle) and fields[2].endswith(':0000'):
                return True
    return False


def _local_networks() -> list[str]:
    try:
        from cockpit.features.network.scanner import local_subnets
        return [s['cidr'] for s in local_subnets()]
    except Exception:
        return []


def get_ntp_server() -> dict:
    from cockpit.features.network.firewall import _ufw_enabled, backend as fw_backend
    from cockpit.features.network.shell import unit_active
    cfg = parse_chrony(_read(_chrony_conf() or '')) if _chrony_installed() else {'allow': [], 'local': False}
    fw = fw_backend()
    return {
        'chrony_installed': _chrony_installed(),
        'enabled': bool(cfg['allow']),
        'allow': cfg['allow'],
        'local_stratum': cfg['local'],
        'listening': _udp_listening(123),
        'suggested': _local_networks(),
        'firewall': fw,
        'firewall_active': (_ufw_enabled() if fw == 'ufw' else unit_active('firewalld')) if fw else False,
        'can_install': bool(install_commands(package_manager(), {m: ['chrony'] for m in ('apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk')})),
        'job': _job.view()['state'],
    }


def _parse_networks(raw) -> tuple[list[str], str]:
    import ipaddress
    if isinstance(raw, str):
        raw = re.split(r'[\s,;]+', raw)
    nets = []
    for item in raw or []:
        item = (item or '').strip()
        if not item:
            continue
        if item in ('all', 'any', '0.0.0.0/0'):
            nets.append('all')
            continue
        try:
            nets.append(str(ipaddress.ip_network(item, strict=False)))
        except ValueError:
            return [], f'Not a network or IP address: {item}'
    return list(dict.fromkeys(nets)), ''


def _server_job(password: str, enable: bool, allow: list[str], local: bool, open_fw: bool) -> bool:
    from cockpit.features.network import firewall
    job = _job

    if enable and not _chrony_installed():
        # Carry the client servers chosen for timesyncd over to chrony.
        servers, exclusive = _timesyncd_config()
        manager = package_manager()
        commands = install_commands(manager, {m: ['chrony'] for m in ('apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk')})
        if not commands:
            job.log('No supported package manager found - install chrony by hand.')
            return False
        job.log(f'Installing chrony with {manager} (it replaces systemd-timesyncd as the time client)...')
        for cmd in commands:
            if not job.stream(cmd, password, 900, env=NONINTERACTIVE, echo=True):
                return False
        if not _chrony_conf():
            job.log('chrony was installed but chrony.conf was not found.')
            return False
        if servers:
            job.log(f'Keeping your NTP servers: {" ".join(servers)}')
        changes = {'servers': servers, 'exclusive': exclusive}
        job.stream(['rm', '-f', TIMESYNCD_DROPIN], password, 20)
    else:
        changes = {}

    if enable:
        changes.update({'allow': allow, 'local': local})
        job.log('Allowing NTP clients from: ' + ', '.join('everyone' if a == 'all' else a for a in allow))
    else:
        old = parse_chrony(_read(_chrony_conf() or ''))['allow']
        changes.update({'allow': [], 'local': False})
        job.log('Turning the NTP server off.')

    conf = _chrony_conf()
    text = _read(conf)
    cfg = {**parse_chrony(text), **changes}
    if not job.stream(['sh', '-c', 'cat > "$0"', conf], password, 20, input_text=render_chrony(text, cfg)):
        job.log(f'Could not write {conf}.')
        return False
    job.log(f'Updated {conf}')
    unit = _chrony_unit()
    job.stream(['systemctl', 'enable', unit], password, 30, echo=True)
    if not job.stream(['systemctl', 'restart', unit], password, 60, echo=True):
        job.stream(['journalctl', '-u', unit, '-n', '25', '--no-pager'], password, 20)
        return False

    if enable and open_fw:
        sources = ['any' if a == 'all' else a for a in allow]
        job.log('Opening UDP port 123 in the firewall...')
        # Replace rules from an earlier setup so a narrowed network list takes effect.
        firewall.remove_rules(password, '123', 'udp', comment=NTP_FW_COMMENT)
        ok, out = firewall.allow_port(password, '123', 'udp', sources, NTP_FW_COMMENT)
        for line in out.splitlines():
            job.log(line)
        if not ok:
            return False
    elif not enable:
        ok, out = firewall.remove_rules(password, '123', 'udp', comment=NTP_FW_COMMENT,
                                        sources=None if firewall.backend() == 'ufw' else
                                        ['any' if a == 'all' else a for a in old])
        job.log('Removed the firewall rule for UDP 123.' if ok else f'Could not remove the firewall rule: {out}')

    if enable:
        for _ in range(20):
            if _udp_listening(123):
                break
            time.sleep(0.5)
        if not _udp_listening(123):
            job.log('chrony is not listening on UDP 123. Recent log:')
            job.stream(['journalctl', '-u', unit, '-n', '25', '--no-pager'], password, 20)
            return False
        job.log('chrony is serving time on UDP port 123.')
        job.log('Point other devices at this machine\'s IP address as their NTP server.')
    return True


def ntp_query(host: str, timeout: float = 3.0) -> dict:
    """One SNTP request to `host` (no root, nothing changed): offset, delay, stratum."""
    infos = socket.getaddrinfo(host, 123, type=socket.SOCK_DGRAM)
    family, _, _, _, addr = infos[0]
    with socket.socket(family, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        t1 = time.time()
        sec = int(t1) + NTP_EPOCH_DELTA
        frac = int((t1 % 1) * 2**32)
        packet = b'\x23' + b'\0' * 39 + struct.pack('!II', sec, frac)  # LI=0 VN=4 Mode=3 (client)
        sock.sendto(packet, addr)
        data, _ = sock.recvfrom(512)
        t4 = time.time()
    if len(data) < 48:
        raise ValueError('Short reply from server')
    if data[24:32] != packet[40:48]:
        raise ValueError('Reply does not match the request')
    leap, stratum = data[0] >> 6, data[1]

    def ts(off):
        s, f = struct.unpack('!II', data[off:off + 8])
        return s - NTP_EPOCH_DELTA + f / 2**32

    t2, t3 = ts(32), ts(40)
    if stratum == 0 or leap == 3:
        raise ValueError('Server answered but is not synchronized itself (stratum 0 / alarm)')
    return {
        'address': addr[0],
        'stratum': stratum,
        'offset_ms': round(((t2 - t1) + (t3 - t4)) / 2 * 1000, 3),
        'delay_ms': round(((t4 - t1) - (t3 - t2)) * 1000, 3),
    }


def get_time_settings() -> dict:
    ok, out = _run(['timedatectl', 'show'])
    props = dict(line.split('=', 1) for line in out.splitlines() if '=' in line) if ok else {}
    return {
        **get_clock(),
        'timedatectl': ok,
        'can_ntp': props.get('CanNTP') == 'yes' if ok else False,
        'ntp_enabled': props.get('NTP') == 'yes' if ok else None,
        'ntp_synchronized': props.get('NTPSynchronized') == 'yes' if ok else None,
        'local_rtc': props.get('LocalRTC') == 'yes' if ok else None,
        'timezones': list(list_timezones()),
        'ntp_servers': get_ntp_servers(),
        'ntp_server': get_ntp_server(),
    }


def _reply(ok: bool, output: str = ''):
    if ok:
        return jsonify({'success': True, 'settings': get_time_settings()})
    return jsonify({'success': False, 'error': output or 'Command failed'}), 400


def _sudo(args: list[str], password: str) -> tuple[bool, str]:
    try:
        proc = run_sudo(args, password, check=False, timeout=30)
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def _sudo_input(args: list[str], password: str, text: str) -> tuple[bool, str]:
    try:
        proc = run_sudo(args, password, input_text=text, check=False, timeout=30)
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def build_clock_blueprint() -> Blueprint:
    bp = Blueprint('clock', __name__)

    @bp.route('/api/time')
    def api_time():
        return jsonify(get_time_settings())

    @bp.route('/api/time/timezone', methods=['POST'])
    def api_set_timezone():
        password, err = require_sudo()
        if err:
            return err
        zone = ((request.get_json(silent=True) or {}).get('timezone') or '').strip()
        if not TZ_RE.match(zone) or zone not in list_timezones():
            return _reply(False, 'Unknown time zone.')
        ok, out = _sudo(['timedatectl', 'set-timezone', zone], password)
        if ok:
            time.tzset()  # this process caches the zone; pick up the new one now
        return _reply(ok, out)

    @bp.route('/api/time/ntp', methods=['POST'])
    def api_set_ntp():
        password, err = require_sudo()
        if err:
            return err
        enabled = bool((request.get_json(silent=True) or {}).get('enabled'))
        return _reply(*_sudo(['timedatectl', 'set-ntp', 'true' if enabled else 'false'], password))

    @bp.route('/api/time/ntp-servers', methods=['POST'])
    def api_set_ntp_servers():
        password, err = require_sudo()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        raw = body.get('servers') or []
        if isinstance(raw, str):
            raw = re.split(r'[\s,;]+', raw)
        servers = list(dict.fromkeys(s.strip() for s in raw if s and s.strip()))
        bad = [s for s in servers if not _valid_server(s)]
        if bad:
            return _reply(False, f'Not a valid host name or IP address: {", ".join(bad)}')
        if len(servers) > 8:
            return _reply(False, 'At most 8 servers.')
        backend = _ntp_backend()
        exclusive = bool(body.get('exclusive'))
        if backend == 'timesyncd':
            return _reply(*_apply_timesyncd(servers, exclusive, password))
        if backend == 'chrony':
            return _reply(*_apply_chrony(servers, exclusive, password))
        return _reply(False, 'No supported NTP client (systemd-timesyncd or chrony) found.')

    @bp.route('/api/time/ntp-test', methods=['POST'])
    def api_test_ntp_server():
        host = ((request.get_json(silent=True) or {}).get('server') or '').strip()
        if not _valid_server(host):
            return jsonify({'success': False, 'error': 'Not a valid host name or IP address.'}), 400
        try:
            result = ntp_query(host)
        except socket.timeout:
            return jsonify({'success': False, 'error': f'No answer from {host} on UDP port 123 (check the server\'s "allow" rule and firewall).'}), 400
        except (OSError, ValueError) as e:
            return jsonify({'success': False, 'error': f'{host}: {e}'}), 400
        return jsonify({'success': True, 'server': host, **result})

    @bp.route('/api/time/ntp-server', methods=['POST'])
    def api_ntp_server():
        password, err = require_sudo()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        enable = bool(body.get('enabled'))
        allow, error = _parse_networks(body.get('allow'))
        if error:
            return _reply(False, error)
        if enable and not allow:
            return _reply(False, 'Enter at least one network allowed to use this server, e.g. 192.168.0.0/24.')
        if not enable and not _chrony_installed():
            return _reply(False, 'The NTP server is not set up.')
        ok, msg = _job.start('ntp-server' if enable else 'ntp-server-off',
                             lambda: _server_job(password, enable, allow, bool(body.get('local_stratum')),
                                                 body.get('open_firewall', True) is not False))
        if not ok:
            return jsonify({'success': False, 'error': msg}), 409
        return jsonify({'success': True})

    @bp.route('/api/time/job')
    def api_time_job():
        return jsonify(_job.view())

    @bp.route('/api/time/job/cancel', methods=['POST'])
    def api_time_job_cancel():
        ok = _job.cancel()
        return jsonify({'success': ok, **({} if ok else {'error': 'Nothing to cancel'})}), 200 if ok else 409

    @bp.route('/api/time/set', methods=['POST'])
    def api_set_time():
        password, err = require_sudo()
        if err:
            return err
        value = ((request.get_json(silent=True) or {}).get('time') or '').strip()
        try:
            parsed = datetime.strptime(value.replace('T', ' ')[:19], '%Y-%m-%d %H:%M:%S' if len(value) > 16 else '%Y-%m-%d %H:%M')
        except ValueError:
            return _reply(False, 'Use the format YYYY-MM-DD HH:MM.')
        return _reply(*_sudo(['timedatectl', 'set-time', parsed.strftime('%Y-%m-%d %H:%M:%S')], password))

    return bp


__all__ = ['build_clock_blueprint', 'get_clock', 'get_time_settings']
