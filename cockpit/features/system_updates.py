"""Operating-system updates (sidebar "System updates"): list, refresh, upgrade.

Works with the distro's package manager: apt (Debian, Ubuntu, Raspberry Pi OS,
JetPack), dnf / yum (Fedora, RHEL), zypper (openSUSE), pacman (Arch), apk (Alpine).

Listing pending updates reads the local package database without root and is
cached (the sidebar asks on every page load); refreshing the package lists and
upgrading run through sudo as a background job with a live log. Upgrades cannot
be cancelled - killing a package manager halfway can leave the system broken.
"""

from __future__ import annotations

import glob
import os
import platform
import re
import subprocess
import threading
import time

from flask import Blueprint, jsonify, request

from cockpit.core.auth import require_sudo
from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob, package_manager

LIST_MAX_AGE = 15 * 60
_APT_OPTS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']

# Per package manager: commands for each action (None = not offered).
ACTIONS = {
    'apt-get': {
        'refresh': [['apt-get', 'update']],
        'upgrade': [['apt-get', '-y', *_APT_OPTS, 'upgrade']],
        'full-upgrade': [['apt-get', '-y', *_APT_OPTS, 'full-upgrade']],
        'autoremove': [['apt-get', '-y', 'autoremove']],
    },
    'dnf': {
        'refresh': [['dnf', '-y', 'makecache']],
        'upgrade': [['dnf', '-y', 'upgrade']],
        'full-upgrade': [['dnf', '-y', 'distro-sync']],
        'autoremove': [['dnf', '-y', 'autoremove']],
    },
    'yum': {
        'refresh': [['yum', '-y', 'makecache']],
        'upgrade': [['yum', '-y', 'update']],
        'full-upgrade': [['yum', '-y', 'distro-sync']],
        'autoremove': [['yum', '-y', 'autoremove']],
    },
    'zypper': {
        'refresh': [['zypper', '--non-interactive', 'refresh']],
        'upgrade': [['zypper', '--non-interactive', 'update']],
        'full-upgrade': [['zypper', '--non-interactive', 'dist-upgrade']],
        'autoremove': None,
    },
    'pacman': {
        # Arch only supports full upgrades; refreshing alone would invite partial upgrades.
        'refresh': None,
        'upgrade': [['pacman', '-Syu', '--noconfirm']],
        'full-upgrade': None,
        'autoremove': None,
    },
    'apk': {
        'refresh': [['apk', 'update']],
        'upgrade': [['apk', 'upgrade']],
        'full-upgrade': [['apk', 'upgrade', '--available']],
        'autoremove': None,
    },
}

ACTION_LABELS = {
    'refresh': 'Check for updates',
    'upgrade': 'Upgrade',
    'full-upgrade': 'Full upgrade',
    'autoremove': 'Remove unused packages',
}

_job = BackgroundJob()
_lock = threading.Lock()
_cache: dict = {'time': 0.0, 'key': None, 'packages': [], 'error': None, 'refreshing': False}


def _run(args: list[str], timeout: float = 120) -> tuple[int, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
                              env={**os.environ, 'LC_ALL': 'C'})
    except FileNotFoundError:
        return 127, f'{args[0]} is not installed'
    except subprocess.TimeoutExpired:
        return 124, f'{args[0]} timed out'
    return proc.returncode, proc.stdout


# ---------------------------------------------------------------- listing

def _parse_apt(out: str) -> list[dict]:
    # "openssl/trixie-security 3.5.1-1+deb13u1 amd64 [upgradable from: 3.5.1-1]"
    packages = []
    for line in out.splitlines():
        match = re.match(r'^(\S+?)/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]', line)
        if match:
            name, origin, new, arch, old = match.groups()
            packages.append({'name': name, 'current': old, 'available': new, 'arch': arch, 'origin': origin,
                             'security': '-security' in origin or 'security' in origin.split(',')[0]})
    return packages


def _parse_dnf(out: str) -> list[dict]:
    packages = []
    for line in out.splitlines():
        if not line.strip() or line.startswith((' ', 'Obsoleting', 'Last metadata', 'Security:')):
            continue
        parts = line.split()
        if len(parts) == 3 and '.' in parts[0]:
            name, arch = parts[0].rsplit('.', 1)
            packages.append({'name': name, 'current': None, 'available': parts[1], 'arch': arch,
                             'origin': parts[2], 'security': False})
    return packages


def _parse_zypper(out: str) -> list[dict]:
    packages = []
    for line in out.splitlines():
        cols = [c.strip() for c in line.split('|')]
        if len(cols) >= 6 and cols[0] == 'v':
            packages.append({'name': cols[2], 'current': cols[3], 'available': cols[4], 'arch': cols[5],
                             'origin': cols[1], 'security': False})
    return packages


def _parse_pacman(out: str) -> list[dict]:
    packages = []
    for line in out.splitlines():
        match = re.match(r'^(\S+) (\S+) -> (\S+)', line)
        if match:
            packages.append({'name': match.group(1), 'current': match.group(2), 'available': match.group(3),
                             'arch': None, 'origin': None, 'security': False})
    return packages


def _parse_apk(out: str) -> list[dict]:
    # "busybox-1.36.1-r20 x86_64 {busybox} (GPL-2.0-only) [upgradable from: busybox-1.36.1-r19]"
    packages = []
    for line in out.splitlines():
        match = re.match(r'^(\S+)-(\d\S*-r\d+)\s+(\S+)\s+\{([^}]*)\}.*\[upgradable from: \S+?-(\d\S*-r\d+)\]', line)
        if match:
            packages.append({'name': match.group(1), 'available': match.group(2), 'arch': match.group(3),
                             'origin': match.group(4), 'current': match.group(5), 'security': False})
    return packages


def _list_updates(manager: str) -> tuple[list[dict], str | None]:
    if manager == 'apt-get':
        code, out = _run(['apt', 'list', '--upgradable'])
        return (_parse_apt(out), None) if code == 0 else ([], out.strip() or 'apt list failed')
    if manager in ('dnf', 'yum'):
        # -C: cached metadata only, so this never downloads as an unprivileged user.
        code, out = _run([manager, '-q', '-C', 'check-update'])
        return (_parse_dnf(out), None) if code in (0, 100) else ([], out.strip() or 'check-update failed')
    if manager == 'zypper':
        code, out = _run(['zypper', '--non-interactive', '--no-refresh', 'list-updates'])
        return (_parse_zypper(out), None) if code == 0 else ([], out.strip() or 'zypper failed')
    if manager == 'pacman':
        code, out = _run(['pacman', '-Qu'])
        return (_parse_pacman(out), None) if code in (0, 1) else ([], out.strip() or 'pacman failed')
    if manager == 'apk':
        code, out = _run(['apk', 'list', '-u'])
        return (_parse_apk(out), None) if code == 0 else ([], out.strip() or 'apk failed')
    return [], 'No supported package manager found.'


def _lists_updated(manager: str | None) -> float | None:
    """When the package lists were last downloaded (approximate)."""
    patterns = {
        'apt-get': ['/var/lib/apt/lists/*Release', '/var/lib/apt/lists/*InRelease'],
        'dnf': ['/var/cache/dnf/*.solv', '/var/cache/libdnf5/*/repodata/*'],
        'yum': ['/var/cache/yum/*/*/*/repomd.xml'],
        'zypper': ['/var/cache/zypp/raw/*/repodata/repomd.xml'],
        'pacman': ['/var/lib/pacman/sync/*.db'],
        'apk': ['/var/cache/apk/APKINDEX.*'],
    }.get(manager or '', [])
    times = [os.path.getmtime(f) for pattern in patterns for f in glob.glob(pattern)]
    return max(times) if times else None


def _refresh_cache(manager: str) -> None:
    packages, error = _list_updates(manager)
    with _lock:
        _cache.update({'time': time.time(), 'key': _lists_updated(manager), 'packages': packages,
                       'error': error, 'refreshing': False})


def _cached_updates(manager: str | None, force: bool = False, wait: bool = False):
    if not manager:
        return [], 'No supported package manager found.', None
    with _lock:
        stale = (force or time.time() - _cache['time'] > LIST_MAX_AGE
                 or _cache['key'] != _lists_updated(manager))
        start = stale and not _cache['refreshing']
        if start:
            _cache['refreshing'] = True
    if start:
        if wait or not _cache['time']:
            _refresh_cache(manager)      # first call / after an upgrade: answer with real data
        else:
            threading.Thread(target=_refresh_cache, args=(manager,), daemon=True).start()
    with _lock:
        return list(_cache['packages']), _cache['error'], _cache['time'] or None


# ---------------------------------------------------------------- reboot / OS

def _os_name() -> str:
    try:
        with open('/etc/os-release') as f:
            for line in f:
                if line.startswith('PRETTY_NAME='):
                    return line.split('=', 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.system()


def _version_key(text: str):
    return [int(p) if p.isdigit() else p for p in re.split(r'(\d+)', text)]


def reboot_required() -> dict:
    """Debian/Ubuntu's reboot-required marker, or a newer kernel installed than the one running."""
    reasons = []
    if os.path.exists('/var/run/reboot-required'):
        pkgs = []
        try:
            with open('/var/run/reboot-required.pkgs') as f:
                pkgs = sorted({line.strip() for line in f if line.strip()})
        except OSError:
            pass
        reasons.append('Updated packages need a restart' + (f': {", ".join(pkgs)}' if pkgs else ''))
    running = platform.release()
    try:
        installed = [d for d in os.listdir('/lib/modules') if os.path.isdir(f'/lib/modules/{d}/kernel')]
    except OSError:
        installed = []
    if installed and running not in installed:
        reasons.append(f'The running kernel ({running}) has been replaced')
    elif installed:
        # Only compare kernels of the same flavour (e.g. "-amd64", "-rpi-v8").
        flavour = re.sub(r'^[\d.\-+~]+', '', running)
        same = [k for k in installed if k.endswith(flavour)] if flavour else installed
        newest = max(same, key=_version_key)
        if _version_key(newest) > _version_key(running):
            reasons.append(f'A newer kernel is installed ({newest}; running {running})')
    return {'required': bool(reasons), 'reasons': reasons, 'kernel': running}


def get_status(force: bool = False, wait: bool = False) -> dict:
    manager = package_manager()
    packages, error, checked = _cached_updates(manager, force=force, wait=wait)
    actions = ACTIONS.get(manager or '', {})
    return {
        'os': _os_name(),
        'manager': manager,
        'packages': packages,
        'count': len(packages),
        'security': sum(1 for p in packages if p['security']),
        'error': error,
        'checked': checked,
        'lists_updated': _lists_updated(manager),
        'actions': {k: ACTION_LABELS[k] for k, v in actions.items() if v},
        'reboot': reboot_required(),
        'job': _job.view(),
    }


# ---------------------------------------------------------------- actions

def start_action(password: str, action: str) -> tuple[bool, str]:
    manager = package_manager()
    commands = (ACTIONS.get(manager or '') or {}).get(action)
    if not commands:
        return False, f'"{action}" is not available with {manager or "this system"}.'

    def steps():
        for cmd in commands:
            if not _job.stream(cmd, password, 3600, env=NONINTERACTIVE, echo=True):
                if 'Could not get lock' in '\n'.join(_job.view()['log'][-5:]):
                    _job.log('Another package manager is running (automatic updates?). Try again in a few minutes.')
                return False
        _cached_updates(manager, force=True, wait=True)
        status = get_status()
        _job.log(f'{status["count"]} update(s) still pending.')
        if status['reboot']['required']:
            _job.log('A reboot is recommended: ' + '; '.join(status['reboot']['reasons']))
        return True

    # Interrupting apt/dnf/... halfway can leave the package database broken.
    return _job.start(action, steps, cancellable=(action == 'refresh'))


def build_system_updates_blueprint() -> Blueprint:
    bp = Blueprint('system_updates', __name__)

    @bp.route('/api/system/updates')
    def api_status():
        return jsonify(get_status(force=request.args.get('fresh') == '1', wait=request.args.get('fresh') == '1'))

    @bp.route('/api/system/updates/job')
    def api_job():
        return jsonify(_job.view())

    @bp.route('/api/system/updates/job/cancel', methods=['POST'])
    def api_job_cancel():
        ok = _job.cancel()
        return jsonify({'success': ok, **({} if ok else {'error': 'This step cannot be cancelled safely.'})}), 200 if ok else 409

    @bp.route('/api/system/updates/run', methods=['POST'])
    def api_run():
        password, err = require_sudo()
        if err:
            return err
        action = (request.get_json(silent=True) or {}).get('action')
        if action not in ACTION_LABELS:
            return jsonify({'success': False, 'error': 'Unknown action'}), 400
        ok, message = start_action(password, action)
        return jsonify({'success': ok, **({} if ok else {'error': message})}), 200 if ok else 409

    return bp


__all__ = ['build_system_updates_blueprint', 'get_status']
