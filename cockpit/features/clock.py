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
import subprocess
import time
from datetime import datetime

from flask import Blueprint, jsonify, request

from cockpit.core.auth import require_sudo, run_sudo

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
