"""Firewall: status, default policy and rules for ufw or firewalld.

ufw is preferred (Debian/Ubuntu); firewalld is used where it is the installed
one (Fedora/RHEL/openSUSE). Rules are kept in one shape for the page:

    {id, action, port, proto, source, comment, text}

`id` identifies the rule for deletion and is only ever matched against the
current rule list, never passed to a command as given by the browser.

Changes that could cut off the browser (turning the firewall on, a stricter
incoming policy, deleting a rule while active) are armed with the network
page's auto-rollback, and enabling ufw first adds allow rules for
ServiceCockpit's own port and SSH.

Other features open ports through `allow_port()` / `remove_rules()`.
"""

from __future__ import annotations

import ipaddress
import re
import shlex
import shutil

from flask import Blueprint, jsonify, request

from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob, install_commands, package_manager

from .http import require_sudo, result
from .rollback import schedule_revert
from .shell import read_text, sudo, unit_active

COCKPIT_PORT = 2137
ACTIONS = ('allow', 'deny', 'reject', 'limit')
PROTOS = ('tcp', 'udp', 'any')
POLICIES = ('allow', 'deny', 'reject')
PORT_RE = re.compile(r'^\d{1,5}(:\d{1,5})?$')
COMMENT_RE = re.compile(r'^[\w .,:/()+@-]{0,60}$')

PACKAGES = {
    'apt-get': ['ufw'], 'pacman': ['ufw'], 'apk': ['ufw'],
    'dnf': ['firewalld'], 'yum': ['firewalld'], 'zypper': ['firewalld'],
}

_job = BackgroundJob()

# Well-known services for the "quick add" buttons: (label, port, proto).
PRESETS = [
    ('ServiceCockpit', str(COCKPIT_PORT), 'tcp'), ('SSH', '22', 'tcp'), ('HTTP', '80', 'tcp'),
    ('HTTPS', '443', 'tcp'), ('NTP', '123', 'udp'), ('MQTT', '1883', 'tcp'), ('MQTT/TLS', '8883', 'tcp'),
    ('VNC', '5900', 'tcp'), ('DNS', '53', 'any'), ('mDNS', '5353', 'udp'),
]


# ------------------------------------------------------------------ detection

def backend() -> str | None:
    if shutil.which('ufw'):
        # Both installed: use whichever is running, ufw otherwise.
        if shutil.which('firewall-cmd') and unit_active('firewalld') and not _ufw_enabled():
            return 'firewalld'
        return 'ufw'
    if shutil.which('firewall-cmd'):
        return 'firewalld'
    return None


def _ufw_enabled() -> bool:
    return bool(re.search(r'^\s*ENABLED\s*=\s*yes', read_text('/etc/ufw/ufw.conf'), re.M))


def _ufw_policy(key: str) -> str | None:
    m = re.search(rf'^\s*{key}\s*=\s*"?(\w+)"?', read_text('/etc/default/ufw'), re.M)
    return {'DROP': 'deny', 'ACCEPT': 'allow', 'REJECT': 'reject'}.get(m.group(1).upper()) if m else None


def _valid_source(src: str) -> bool:
    if src in ('', 'any'):
        return True
    try:
        ipaddress.ip_network(src, strict=False)
        return True
    except ValueError:
        return False


def _valid_port(port: str) -> bool:
    if not port:
        return True
    if not PORT_RE.match(port):
        return False
    nums = [int(p) for p in port.split(':')]
    return all(1 <= n <= 65535 for n in nums) and (len(nums) == 1 or nums[0] < nums[1])


# ------------------------------------------------------------------ ufw

def _ufw_rules(password: str) -> tuple[bool, list[dict] | str]:
    ok, out = sudo(['ufw', 'show', 'added'], password, 20)
    if not ok:
        return False, out
    rules = []
    for line in out.splitlines():
        if not line.startswith('ufw '):
            continue
        try:
            args = shlex.split(line)[1:]
        except ValueError:
            continue
        rules.append(_ufw_parse(args, line))
    return True, rules


def _ufw_parse(args: list[str], text: str) -> dict:
    """Best-effort fields from `ufw show added` args, for display and matching."""
    rule = {'id': text, 'action': args[0] if args else '', 'port': '', 'proto': 'any', 'source': 'any',
            'comment': '', 'direction': 'in', 'text': text[4:], 'args': args}
    i = 1
    while i < len(args):
        word = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else ''
        if word in ('in', 'out'):
            rule['direction'] = word
        elif word == 'from':
            rule['source'] = nxt
            i += 1
        elif word == 'port' and i >= 2 and args[i - 2] == 'to':  # "to any port N" (not the source port)
            rule['port'] = nxt
            i += 1
        elif word == 'proto':
            rule['proto'] = nxt
            i += 1
        elif word == 'comment':
            rule['comment'] = nxt
            i += 1
        elif i == 1 and re.match(r'^[\d:,]+(/(tcp|udp))?$', word):
            # Short form: "ufw allow 22/tcp"
            port, _, proto = word.partition('/')
            rule['port'], rule['proto'] = port, proto or 'any'
        elif i == 1 and word not in ('to', 'on', 'log', 'log-all'):
            rule['port'] = word  # application profile name, e.g. "OpenSSH"
        i += 1
    return rule


def _ufw_add_args(action: str, port: str, proto: str, source: str, comment: str) -> list[str]:
    args = [action, 'in']
    if proto != 'any':
        args += ['proto', proto]
    args += ['from', source or 'any', 'to', 'any']
    if port:
        args += ['port', port]
    if comment:
        args += ['comment', comment]
    return args


def _ufw_delete_args(rule: dict) -> list[str]:
    args = list(rule['args'])
    if 'comment' in args:
        i = args.index('comment')
        del args[i:i + 2]
    return ['ufw', '--force', 'delete', *args]


# ------------------------------------------------------------------ firewalld

def _fwd(password: str, *args: str) -> tuple[bool, str]:
    return sudo(['firewall-cmd', *args], password, 30)


def _fwd_both(password: str, *args: str) -> tuple[bool, str]:
    """Apply to the running config and the permanent one."""
    ok, out = _fwd(password, *args)
    if not ok:
        return ok, out
    return _fwd(password, '--permanent', *args)


def _fwd_rich(action: str, port: str, proto: str, source: str) -> list[str]:
    family = ''
    if source and source != 'any':
        family = f'family="{"ipv6" if ":" in source else "ipv4"}" source address="{source}" '
    target = {'allow': 'accept', 'deny': 'drop', 'reject': 'reject'}[action]
    protos = ['tcp', 'udp'] if proto == 'any' else [proto]
    if not port:
        return [f'rule {family}{target}'.replace('  ', ' ')]
    port = port.replace(':', '-')
    return [f'rule {family}port port="{port}" protocol="{p}" {target}' for p in protos]


def _fwd_rules(password: str) -> tuple[bool, list[dict] | str]:
    rules = []
    ok, out = _fwd(password, '--list-services')
    if not ok:
        return False, out
    for svc in out.split():
        rules.append({'id': f'service:{svc}', 'action': 'allow', 'port': svc, 'proto': 'any', 'source': 'any',
                      'comment': 'firewalld service', 'text': f'service {svc}'})
    _, out = _fwd(password, '--list-ports')
    for item in out.split():
        port, _, proto = item.partition('/')
        rules.append({'id': f'port:{item}', 'action': 'allow', 'port': port.replace('-', ':'), 'proto': proto,
                      'source': 'any', 'comment': '', 'text': item})
    _, out = _fwd(password, '--list-rich-rules')
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        src = re.search(r'source address="([^"]+)"', line)
        port = re.search(r'port port="([^"]+)" protocol="(\w+)"', line)
        action = 'allow' if line.endswith('accept') else 'reject' if 'reject' in line else 'deny'
        rules.append({'id': f'rich:{line}', 'action': action, 'port': port.group(1).replace('-', ':') if port else '',
                      'proto': port.group(2) if port else 'any', 'source': src.group(1) if src else 'any',
                      'comment': '', 'text': line})
    return True, rules


def _fwd_add_cmds(action: str, port: str, proto: str, source: str) -> list[list[str]]:
    if action == 'limit':
        raise ValueError('"limit" is only available with ufw.')
    if action == 'allow' and (not source or source == 'any') and port:
        protos = ['tcp', 'udp'] if proto == 'any' else [proto]
        return [[f'--add-port={port.replace(":", "-")}/{p}'] for p in protos]
    return [[f'--add-rich-rule={r}'] for r in _fwd_rich(action, port, proto, source)]


def _fwd_remove_arg(rule_id: str) -> str:
    kind, _, value = rule_id.partition(':')
    return {'service': '--remove-service=', 'port': '--remove-port=', 'rich': '--remove-rich-rule='}[kind] + value


# ------------------------------------------------------------------ status

def get_status(password: str) -> dict:
    kind = backend()
    status = {'backend': kind, 'active': False, 'rules': [], 'policy_in': None, 'policy_out': None,
              'zone': None, 'presets': PRESETS, 'cockpit_port': COCKPIT_PORT,
              'can_install': bool(install_commands(package_manager(), PACKAGES)), 'error': None}
    if kind == 'ufw':
        status['active'] = _ufw_enabled()
        status['policy_in'] = _ufw_policy('DEFAULT_INPUT_POLICY')
        status['policy_out'] = _ufw_policy('DEFAULT_OUTPUT_POLICY')
        ok, rules = _ufw_rules(password)
    elif kind == 'firewalld':
        status['active'] = unit_active('firewalld')
        if not status['active']:
            return status
        _, zone = _fwd(password, '--get-default-zone')
        status['zone'] = zone.strip() or None
        ok, rules = _fwd_rules(password)
    else:
        return status
    if ok:
        for r in rules:
            r.pop('args', None)
        status['rules'] = rules
    else:
        status['error'] = rules
    return status


def _find_rule(password: str, rule_id: str) -> dict | None:
    kind = backend()
    ok, rules = _ufw_rules(password) if kind == 'ufw' else _fwd_rules(password) if kind == 'firewalld' else (False, [])
    if not ok:
        return None
    return next((r for r in rules if r['id'] == rule_id), None)


# ------------------------------------------------------------------ changes

def add_rule(password: str, action: str, port: str, proto: str, source: str, comment: str = '') -> tuple[bool, str]:
    kind = backend()
    if kind == 'ufw':
        return sudo(['ufw', *_ufw_add_args(action, port, proto, source, comment)], password, 30)
    if kind == 'firewalld':
        if not unit_active('firewalld'):
            return False, 'firewalld is not running.'
        try:
            cmds = _fwd_add_cmds(action, port, proto, source)
        except ValueError as e:
            return False, str(e)
        outs = []
        for cmd in cmds:
            ok, out = _fwd_both(password, *cmd)
            outs.append(out)
            if not ok:
                return False, '\n'.join(outs)
        return True, '\n'.join(outs)
    return False, 'No firewall (ufw or firewalld) is installed.'


def _delete_cmds(rule: dict) -> list[list[str]]:
    if backend() == 'ufw':
        return [_ufw_delete_args(rule)]
    arg = _fwd_remove_arg(rule['id'])
    return [['firewall-cmd', arg], ['firewall-cmd', '--permanent', arg]]


def _readd_cmds(rule: dict) -> list[list[str]]:
    if backend() == 'ufw':
        return [['ufw', *rule['args']]]
    arg = _fwd_remove_arg(rule['id']).replace('--remove-', '--add-', 1)
    return [['firewall-cmd', arg], ['firewall-cmd', '--permanent', arg]]


def _run_all(cmds: list[list[str]], password: str) -> tuple[bool, str]:
    outs = []
    for cmd in cmds:
        ok, out = sudo(cmd, password, 30)
        if out:
            outs.append(out)
        if not ok:
            return False, '\n'.join(outs) or f'{cmd[0]} failed'
    return True, '\n'.join(outs)


def allow_port(password: str, port: str, proto: str, sources: list[str], comment: str) -> tuple[bool, str]:
    """Allow `port/proto` from each source (for other features). No-op without a firewall."""
    kind = backend()
    if not kind:
        return True, 'No firewall installed - nothing to open.'
    if kind == 'firewalld' and not unit_active('firewalld'):
        return True, 'firewalld is not running - nothing to open.'
    outs = []
    for src in sources or ['any']:
        ok, out = add_rule(password, 'allow', port, proto, src, comment)
        outs.append(out)
        if not ok:
            return False, '\n'.join(outs)
    state = 'active' if (_ufw_enabled() if kind == 'ufw' else True) else 'inactive (rules apply once it is turned on)'
    return True, '\n'.join(o for o in outs if o) + f'\nFirewall ({kind}) is {state}.'


def remove_rules(password: str, port: str, proto: str, sources: list[str] | None = None,
                 comment: str | None = None) -> tuple[bool, str]:
    """Delete allow rules for port/proto (optionally only those with `comment` / from `sources`)."""
    kind = backend()
    if not kind or (kind == 'firewalld' and not unit_active('firewalld')):
        return True, ''
    ok, rules = _ufw_rules(password) if kind == 'ufw' else _fwd_rules(password)
    if not ok:
        return False, rules
    outs = []
    for r in rules:
        if r['action'] != 'allow' or r['port'] != port or r['proto'] not in (proto, 'any'):
            continue
        if comment is not None and kind == 'ufw' and r['comment'] != comment:
            continue
        if sources is not None and r['source'] not in sources:
            continue
        ok, out = _run_all(_delete_cmds(r), password)
        outs.append(out)
    return True, '\n'.join(o for o in outs if o)


def _set_enabled(password: str, enabled: bool) -> tuple[bool, str, list[list[str]]]:
    """(ok, output, revert commands)"""
    kind = backend()
    if kind == 'ufw':
        if not enabled:
            return (*sudo(['ufw', 'disable'], password, 30), [])
        notes = []
        if _ufw_policy('DEFAULT_INPUT_POLICY') != 'allow':
            ok, rules = _ufw_rules(password)
            existing = rules if ok else []
            for label, port in (('ServiceCockpit', str(COCKPIT_PORT)), ('SSH', '22')):
                if any(r['action'] in ('allow', 'limit') and r['port'] == port and r['source'] == 'any'
                       and r['proto'] in ('tcp', 'any') for r in existing):
                    continue
                ok, out = sudo(['ufw', *_ufw_add_args('allow', port, 'tcp', 'any', label)], password, 30)
                notes.append(f'Added a rule allowing {label} (TCP {port}) so you are not locked out.')
        ok, out = sudo(['ufw', '--force', 'enable'], password, 30)
        return ok, '\n'.join(notes + [out]), [['ufw', 'disable']]
    if kind == 'firewalld':
        if enabled:
            ok, out = sudo(['systemctl', 'enable', '--now', 'firewalld'], password, 60)
            if ok:
                # firewalld's default zones allow SSH; also keep ServiceCockpit reachable.
                _fwd_both(password, f'--add-port={COCKPIT_PORT}/tcp')
            return ok, out, [['systemctl', 'disable', '--now', 'firewalld']]
        return (*sudo(['systemctl', 'disable', '--now', 'firewalld'], password, 60), [])
    return False, 'No firewall is installed.', []


# ------------------------------------------------------------------ API

def _guarded(ok: bool, out: str, revert: list[list[str]], password: str, description: str):
    if not ok:
        return result(False, out)
    if revert:
        revert_info = schedule_revert(description, revert, password)
        revert_info['message'] = '- done. If the firewall blocked this page you would not see this message.'
        return result(True, out, revert=revert_info)
    return result(True, out)


def build_network_firewall_blueprint() -> Blueprint:
    bp = Blueprint('network_firewall', __name__)

    @bp.route('/api/network/firewall')
    def fw_status():
        password, err = require_sudo()
        if err:
            return err
        return jsonify({'success': True, **get_status(password), 'job': _job.view()['state']})

    @bp.route('/api/network/firewall/enable', methods=['POST'])
    def fw_enable():
        password, err = require_sudo()
        if err:
            return err
        enabled = bool((request.get_json(silent=True) or {}).get('enabled'))
        ok, out, revert = _set_enabled(password, enabled)
        return _guarded(ok, out, revert, password, 'Turning the firewall on')

    @bp.route('/api/network/firewall/policy', methods=['POST'])
    def fw_policy():
        password, err = require_sudo()
        if err:
            return err
        if backend() != 'ufw':
            return result(False, 'Default policies can only be changed with ufw.')
        body = request.get_json(silent=True) or {}
        direction = body.get('direction')
        policy = body.get('policy')
        if direction not in ('incoming', 'outgoing') or policy not in POLICIES:
            return result(False, 'Invalid policy.')
        key = 'DEFAULT_INPUT_POLICY' if direction == 'incoming' else 'DEFAULT_OUTPUT_POLICY'
        before = _ufw_policy(key) or 'allow'
        ok, out = sudo(['ufw', 'default', policy, direction], password, 30)
        stricter = policy != 'allow' and before == 'allow'
        revert = [['ufw', 'default', before, direction]] if stricter and _ufw_enabled() else []
        return _guarded(ok, out, revert, password, f'Default {direction} policy "{policy}"')

    @bp.route('/api/network/firewall/rules', methods=['POST'])
    def fw_add():
        password, err = require_sudo()
        if err:
            return err
        body = request.get_json(silent=True) or {}
        action = body.get('action') or 'allow'
        proto = body.get('proto') or 'any'
        port = str(body.get('port') or '').strip().replace('-', ':')
        source = (body.get('source') or 'any').strip()
        comment = (body.get('comment') or '').strip()
        if action not in ACTIONS or proto not in PROTOS:
            return result(False, 'Invalid action or protocol.')
        if not _valid_port(port):
            return result(False, 'Port must be a number (1-65535) or a range like 6000:6010.')
        if ':' in port and proto == 'any':
            return result(False, 'A port range needs TCP or UDP.')
        if not _valid_source(source):
            return result(False, 'Source must be "any", an IP address or a network like 192.168.0.0/24.')
        if not port and source == 'any':
            return result(False, 'Give a port, a source address, or both.')
        if not COMMENT_RE.match(comment):
            return result(False, 'Comment: up to 60 letters, digits, spaces and . , : / ( ) + @ -')
        return result(*add_rule(password, action, port, proto, source, comment))

    @bp.route('/api/network/firewall/rules/delete', methods=['POST'])
    def fw_delete():
        password, err = require_sudo()
        if err:
            return err
        rule = _find_rule(password, (request.get_json(silent=True) or {}).get('id') or '')
        if not rule:
            return result(False, 'That rule no longer exists - refresh the list.', 404)
        ok, out = _run_all(_delete_cmds(rule), password)
        active = _ufw_enabled() if backend() == 'ufw' else unit_active('firewalld')
        revert = _readd_cmds(rule) if active and rule['action'] in ('allow', 'limit') else []
        return _guarded(ok, out, revert, password, f'Deleting rule "{rule["text"]}"')

    @bp.route('/api/network/firewall/install', methods=['POST'])
    def fw_install():
        password, err = require_sudo()
        if err:
            return err
        if backend():
            return result(False, 'A firewall is already installed.', 409)
        manager = package_manager()
        commands = install_commands(manager, PACKAGES)
        if not commands:
            return result(False, 'No supported package manager found.')

        def steps():
            _job.log(f'Installing {" ".join(PACKAGES[manager])} with {manager}...')
            for cmd in commands:
                if not _job.stream(cmd, password, 900, env=NONINTERACTIVE, echo=True):
                    return False
            _job.log('Installed. The firewall stays off until you turn it on.')
            return True

        ok, msg = _job.start('install', steps)
        return result(ok, msg, 409)

    @bp.route('/api/network/firewall/job')
    def fw_job():
        return jsonify(_job.view())

    @bp.route('/api/network/firewall/job/cancel', methods=['POST'])
    def fw_job_cancel():
        return result(_job.cancel(), 'Nothing to cancel', 409)

    return bp


__all__ = ['allow_port', 'backend', 'build_network_firewall_blueprint', 'get_status', 'remove_rules']
