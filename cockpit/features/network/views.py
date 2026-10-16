"""HTTP API + page for the Network feature (Wi-Fi Direct lives in p2p.py)."""

from __future__ import annotations

import os
import re
import time

from flask import Blueprint, jsonify, render_template, request, session

from cockpit.core.auth import SUDO_SESSION_KEY

from .http import require_sudo, result
from .inventory import (
    DUPLEX, ethtool_features, ethtool_link, ethtool_rings, get_overview, get_routes, interface_details,
    forget_link_cache, list_interfaces,
)
from .profiles import MTU_KEYS, connection_details, connection_settings, list_connections, validate_ipv4_form
from .rollback import resolve_revert, schedule_revert
from .shell import nm_running, read_text, run, sudo, sudo_all
from .wifi import wifi_backend, wifi_saved_wpa, wifi_state, wpa_add_network, wpa_cli

IFNAME_RE = re.compile(r'^[A-Za-z0-9_.:@-]{1,15}$')
UUID_RE = re.compile(r'^[0-9a-fA-F-]{36}$')
HOSTNAME_RE = re.compile(r'^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$')
HOST_RE = re.compile(r'^[A-Za-z0-9.:_-]{1,253}$')


def _remote_ip() -> str | None:
    return request.remote_addr


def _iface_or_error(name: str):
    if not IFNAME_RE.match(name or '') or not os.path.exists(f'/sys/class/net/{name}'):
        return None, result(False, 'Unknown interface', 404)
    iface = next((i for i in list_interfaces(_remote_ip()) if i['name'] == name), None)
    if not iface:
        return None, result(False, 'Unknown interface', 404)
    return iface, None


def apply_change(password: str, iface: dict | None, apply_cmds: list[list[str]], revert_cmds: list[list[str]],
                 description: str, timeout: float = 30.0, force_revert: bool = False):
    """Run apply_cmds; when the change touches the browser's interface keep
    revert_cmds armed until the browser confirms."""
    guarded = bool(revert_cmds) and (force_revert or bool(iface and iface.get('is_client')))
    ok, out = sudo_all(apply_cmds, password, timeout)
    if not ok:
        if revert_cmds:
            sudo_all(revert_cmds, password, timeout)
        return result(False, out)
    if guarded:
        return result(True, out, revert=schedule_revert(description, revert_cmds, password))
    return result(True, out)


def build_network_blueprint() -> Blueprint:
    bp = Blueprint('network', __name__)

    @bp.route('/network')
    def network_page():
        return render_template('network.html')

    @bp.route('/api/network/overview')
    def net_overview():
        return jsonify({'success': True, 'overview': get_overview()})

    @bp.route('/api/network/interfaces')
    def net_interfaces():
        return jsonify({'success': True, 'interfaces': list_interfaces(_remote_ip()), 'time': time.time()})

    @bp.route('/api/network/interface/<name>')
    def net_interface(name):
        if not IFNAME_RE.match(name):
            return result(False, 'Invalid interface name')
        details = interface_details(name, _remote_ip())
        if not details:
            return result(False, 'Unknown interface', 404)
        return jsonify({'success': True, **details})

    @bp.route('/api/network/interface/<name>/<action>', methods=['POST'])
    def net_interface_action(name, action):
        iface, error = _iface_or_error(name)
        if error:
            return error
        password, error = require_sudo()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        profile = (iface.get('nm') or {})
        persist_uuid = profile.get('uuid') if data.get('persist') and 'externally' not in profile.get('state', '') else None

        if action in ('up', 'down'):
            other = 'down' if action == 'up' else 'up'
            return apply_change(password, iface, [['ip', 'link', 'set', 'dev', name, action]],
                                [['ip', 'link', 'set', 'dev', name, other]] if action == 'down' else [],
                                f'{name} {action}')

        if action == 'mtu':
            try:
                mtu = int(data.get('mtu'))
            except (TypeError, ValueError):
                return result(False, 'Invalid MTU')
            lo, hi = iface.get('min_mtu') or 68, iface.get('max_mtu') or 65535
            if not lo <= mtu <= hi:
                return result(False, f'MTU must be between {lo} and {hi} for {name}')
            cmds = [['ip', 'link', 'set', 'dev', name, 'mtu', str(mtu)]]
            revert = [['ip', 'link', 'set', 'dev', name, 'mtu', str(iface['mtu'])]]
            con = connection_details(persist_uuid) if persist_uuid else None
            if con and MTU_KEYS.get(con['type']):
                key = MTU_KEYS[con['type']]
                cmds.append(['nmcli', 'connection', 'modify', 'uuid', persist_uuid, key, str(mtu)])
                revert.append(['nmcli', 'connection', 'modify', 'uuid', persist_uuid, key, con['mtu'] or 'auto'])
            return apply_change(password, iface, cmds, revert, f'MTU {iface["mtu"]} → {mtu} on {name}')

        if action == 'link':
            link = ethtool_link(name)
            if data.get('autoneg'):
                cmds = [['ethtool', '-s', name, 'autoneg', 'on']]
            else:
                speed = str(data.get('speed') or '')
                duplex = str(data.get('duplex') or 'full')
                valid_speeds = {str(int(m.group(1))) for mode in link['supported_modes'] if (m := re.match(r'^(\d+)base', mode))}
                if speed not in valid_speeds or duplex not in DUPLEX:
                    return result(False, 'Unsupported speed / duplex for this adapter')
                cmds = [['ethtool', '-s', name, 'speed', speed, 'duplex', duplex, 'autoneg', 'off']]
            if link['autoneg']:
                revert = [['ethtool', '-s', name, 'autoneg', 'on']]
            elif link['speed'] and link['duplex']:
                revert = [['ethtool', '-s', name, 'speed', str(link['speed']), 'duplex', link['duplex'], 'autoneg', 'off']]
            else:
                revert = [['ethtool', '-s', name, 'autoneg', 'on']]
            if persist_uuid:
                if data.get('autoneg'):
                    cmds.append(['nmcli', 'connection', 'modify', 'uuid', persist_uuid,
                                 '802-3-ethernet.auto-negotiate', 'yes', '802-3-ethernet.speed', '0', '802-3-ethernet.duplex', ''])
                else:
                    cmds.append(['nmcli', 'connection', 'modify', 'uuid', persist_uuid,
                                 '802-3-ethernet.auto-negotiate', 'no', '802-3-ethernet.speed', speed, '802-3-ethernet.duplex', duplex])
            forget_link_cache(name)
            # A forced speed the switch doesn't match takes the link down -
            # always guard it, even when the browser comes in another way.
            return apply_change(password, iface, cmds, revert, f'Link settings on {name}', force_revert=iface['is_client'])

        if action == 'feature':
            feature = str(data.get('feature') or '')
            features = {f['name']: f for f in ethtool_features(name)}
            if feature not in features or features[feature]['fixed']:
                return result(False, 'Unknown or fixed feature')
            onoff = 'on' if data.get('value') else 'off'
            previous = 'on' if features[feature]['active'] else 'off'
            return apply_change(password, iface, [['ethtool', '-K', name, feature, onoff]],
                                [['ethtool', '-K', name, feature, previous]], f'{feature} {onoff} on {name}')

        if action == 'rings':
            rings = ethtool_rings(name)
            if not rings:
                return result(False, 'This adapter does not expose ring parameters')
            args = []
            for key in ('rx', 'tx'):
                if data.get(key) in (None, ''):
                    continue
                try:
                    value = int(data[key])
                except (TypeError, ValueError):
                    return result(False, f'Invalid {key} ring size')
                if rings[f'{key}_max'] and not 1 <= value <= rings[f'{key}_max']:
                    return result(False, f'{key.upper()} ring must be 1-{rings[f"{key}_max"]}')
                args += [key, str(value)]
            if not args:
                return result(False, 'Nothing to change')
            revert = ['ethtool', '-G', name] + [x for k in ('rx', 'tx') if rings[k] for x in (k, str(rings[k]))]
            return apply_change(password, iface, [['ethtool', '-G', name, *args]], [revert], f'Ring sizes on {name}')

        if action == 'wol':
            mode = str(data.get('mode') or '')
            link = ethtool_link(name)
            if not mode or any(c not in link['wol_supported'] + 'd' for c in mode):
                return result(False, 'Unsupported Wake-on-LAN mode')
            return apply_change(password, None, [['ethtool', '-s', name, 'wol', mode]], [], 'Wake-on-LAN')

        if action == 'power_save':
            onoff = 'on' if data.get('value') else 'off'
            return apply_change(password, None, [['iw', 'dev', name, 'set', 'power_save', onoff]], [], 'Power save')

        return result(False, 'Unknown action')

    @bp.route('/api/network/revert/<token>', methods=['POST'])
    def net_revert(token):
        keep = bool((request.get_json(silent=True) or {}).get('keep'))
        ok, out = resolve_revert(token, keep)
        return result(ok, out)

    @bp.route('/api/network/system', methods=['POST'])
    def net_system_action():
        password, error = require_sudo()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        action = data.get('action')
        if action == 'wifi_radio':
            onoff = 'on' if data.get('value') else 'off'
            if nm_running():
                cmds = [['nmcli', 'radio', 'wifi', onoff]]
            else:
                cmds = [['rfkill', 'unblock' if data.get('value') else 'block', 'wlan']]
            client = next((i for i in list_interfaces(_remote_ip()) if i['is_client']), None)
            revert_cmds = []
            if not data.get('value') and client and client['kind'] in ('wifi', 'p2p'):
                revert_cmds = [[*cmds[0][:-1], 'on'] if nm_running() else ['rfkill', 'unblock', 'wlan']]
            return apply_change(password, client, cmds, revert_cmds, f'Wi-Fi radio {onoff}')
        if action == 'hostname':
            new = str(data.get('value') or '').strip()
            if not HOSTNAME_RE.match(new):
                return result(False, 'Hostname: letters, digits and hyphens, max 63 characters')
            old = read_text('/proc/sys/kernel/hostname')
            cmds = [['hostnamectl', 'set-hostname', new]]
            if old and HOSTNAME_RE.match(old):
                # Keep sudo / local name resolution working (Raspberry Pi OS maps it to 127.0.1.1).
                cmds.append(['sed', '-i', '-E', rf's/^(127\.0\.1\.1\s+){re.escape(old)}(\s|$)/\1{new}\2/', '/etc/hosts'])
            ok, out = sudo_all(cmds, password)
            return result(ok, out)
        if action == 'restart_nm':
            ok, out = sudo(['systemctl', 'restart', 'NetworkManager'], password, 30)
            return result(ok, out)
        return result(False, 'Unknown action')

    # ---- connection profiles -------------------------------------------

    @bp.route('/api/network/connections')
    def net_connections():
        return jsonify({'success': True, 'available': nm_running(), 'connections': list_connections()})

    @bp.route('/api/network/connection/<con_uuid>')
    def net_connection(con_uuid):
        if not UUID_RE.match(con_uuid):
            return result(False, 'Invalid UUID')
        details = connection_details(con_uuid)
        if not details:
            return result(False, 'Connection not found', 404)
        return jsonify({'success': True, 'connection': details})

    @bp.route('/api/network/connection/<con_uuid>/<action>', methods=['POST'])
    def net_connection_action(con_uuid, action):
        if not UUID_RE.match(con_uuid):
            return result(False, 'Invalid UUID')
        password, error = require_sudo()
        if error:
            return error
        con = connection_details(con_uuid)
        if not con:
            return result(False, 'Connection not found', 404)
        data = request.get_json(silent=True) or {}
        devices = [d for d in con['device'].split(',') if d]
        client = next((i for i in list_interfaces(_remote_ip()) if i['is_client']), None)
        on_client = bool(client and client['name'] in devices)

        if action == 'up':
            return apply_change(password, None, [['nmcli', 'connection', 'up', 'uuid', con_uuid]], [], 'Activate', 60)
        if action == 'down':
            return apply_change(password, client if on_client else None,
                                [['nmcli', 'connection', 'down', 'uuid', con_uuid]],
                                [['nmcli', 'connection', 'up', 'uuid', con_uuid]], f'Deactivate {con["name"]}', 60)
        if action == 'delete':
            if on_client:
                return result(False, 'This profile carries your current connection to the cockpit - deactivate it from another network first.')
            ok, out = sudo(['nmcli', 'connection', 'delete', 'uuid', con_uuid], password, 30)
            return result(ok, out)
        if action == 'autoconnect':
            ok, out = sudo(['nmcli', 'connection', 'modify', 'uuid', con_uuid,
                            'connection.autoconnect', 'yes' if data.get('value') else 'no'], password)
            return result(ok, out)
        if action == 'edit':
            values, err = validate_ipv4_form(data.get('ipv4') or {})
            if err:
                return result(False, err)
            name = str(data.get('name') or '').strip()
            if name and name != con['name']:
                if len(name) > 100 or not name.isprintable():
                    return result(False, 'Invalid profile name')
                values['connection.id'] = name
            mtu_key = MTU_KEYS.get(con['type'])
            if mtu_key and data.get('mtu') not in (None, ''):
                mtu = str(data['mtu']).strip()
                if mtu != 'auto' and not (mtu.isdigit() and 68 <= int(mtu) <= 65535):
                    return result(False, 'MTU must be "auto" or 68-65535')
                values[mtu_key] = mtu
            old = connection_settings(con_uuid)
            modify = ['nmcli', 'connection', 'modify', 'uuid', con_uuid]
            apply = [modify + [x for kv in values.items() for x in kv]]
            revert_values = {k: old.get(k, '') for k in values}
            # nmcli prints unset values as '--' in some versions.
            revert_values = {k: ('' if v == '--' else v) for k, v in revert_values.items()}
            revert = [modify + [x for kv in revert_values.items() for x in kv]]
            if con['state'] == 'activated' and data.get('apply', True):
                apply.append(['nmcli', 'connection', 'up', 'uuid', con_uuid])
                revert.append(['nmcli', 'connection', 'up', 'uuid', con_uuid])
                return apply_change(password, client if on_client else None, apply, revert,
                                    f'Settings of {con["name"]}', 60)
            ok, out = sudo_all(apply, password)
            return result(ok, out)
        return result(False, 'Unknown action')

    # ---- Wi-Fi ----------------------------------------------------------

    @bp.route('/api/network/wifi/<name>')
    def net_wifi(name):
        if not IFNAME_RE.match(name) or not os.path.isdir(f'/sys/class/net/{name}/wireless'):
            return result(False, 'Not a Wi-Fi interface', 404)
        rescan = request.args.get('rescan') == '1'
        return jsonify({'success': True, 'wifi': wifi_state(name, rescan, session.get(SUDO_SESSION_KEY))})

    @bp.route('/api/network/wifi/<name>/<action>', methods=['POST'])
    def net_wifi_action(name, action):
        if not IFNAME_RE.match(name) or not os.path.isdir(f'/sys/class/net/{name}/wireless'):
            return result(False, 'Not a Wi-Fi interface', 404)
        data = request.get_json(silent=True) or {}
        backend = wifi_backend(name)
        ssid = str(data.get('ssid') or '')
        psk = str(data.get('password') or '')
        if action in ('connect', 'hotspot'):
            if not 1 <= len(ssid.encode()) <= 32:
                return result(False, 'SSID must be 1-32 bytes')
            if psk and not 8 <= len(psk) <= 63:
                return result(False, 'Password must be 8-63 characters')

        if backend == 'wpa':
            # wpa_supplicant's socket is group-writable (netdev) - no sudo needed.
            net_id = str(data.get('id') or '')
            if action == 'connect':
                existing = next((n for n in wifi_saved_wpa(name) if n['ssid'] == ssid), None)
                if existing and not psk:
                    wpa_cli(name, 'enable_network', existing['id'])
                    ok, out = wpa_cli(name, 'reassociate')
                    return result(ok, out or f'Connecting to {ssid}')
                if existing:
                    wpa_cli(name, 'remove_network', existing['id'])
                ok, out = wpa_add_network(name, ssid, psk, bool(data.get('hidden')))
                return result(ok, out)
            if action in ('enable', 'disable', 'forget'):
                if not net_id.isdigit() or net_id not in {n['id'] for n in wifi_saved_wpa(name)}:
                    return result(False, 'Unknown network')
                cmd = {'enable': 'enable_network', 'disable': 'disable_network', 'forget': 'remove_network'}[action]
                ok, out = wpa_cli(name, cmd, net_id)
                if ok:
                    wpa_cli(name, 'save_config')
                    if action == 'enable':
                        wpa_cli(name, 'reassociate')
                return result(ok, out)
            if action in ('disconnect', 'reconnect'):
                ok, out = wpa_cli(name, action)
                return result(ok, out)
            return result(False, 'Not supported with wpa_supplicant')

        if backend != 'nm':
            return result(False, 'This Wi-Fi interface is not managed by NetworkManager or wpa_supplicant')
        password, error = require_sudo()
        if error:
            return error
        if action == 'connect':
            cmd = ['nmcli', 'device', 'wifi', 'connect', ssid, 'ifname', name]
            if psk:
                cmd += ['password', psk]
            if data.get('hidden'):
                cmd += ['hidden', 'yes']
            ok, out = sudo(cmd, password, 60)
            return result(ok, out)
        if action == 'disconnect':
            ok, out = sudo(['nmcli', 'device', 'disconnect', name], password, 20)
            return result(ok, out)
        if action == 'hotspot':
            if not psk:
                return result(False, 'A hotspot needs a password (8-63 characters)')
            band = data.get('band')
            cmd = ['nmcli', 'device', 'wifi', 'hotspot', 'ifname', name, 'ssid', ssid, 'password', psk]
            if band in ('a', 'bg'):
                cmd += ['band', band]
            ok, out = sudo(cmd, password, 40)
            return result(ok, out)
        return result(False, 'Unknown action')

    # ---- routes / diagnostics -------------------------------------------

    @bp.route('/api/network/routes')
    def net_routes():
        return jsonify({'success': True, **get_routes()})

    @bp.route('/api/network/ping', methods=['POST'])
    def net_ping():
        data = request.get_json(silent=True) or {}
        host = str(data.get('host') or '').strip()
        if not HOST_RE.match(host) or host.startswith('-'):
            return result(False, 'Invalid host')
        try:
            count = max(1, min(int(data.get('count', 4)), 20))
        except (TypeError, ValueError):
            count = 4
        cmd = ['ping', '-c', str(count), '-W', '2']
        size = data.get('size')
        if size not in (None, ''):
            try:
                size = int(size)
            except (TypeError, ValueError):
                return result(False, 'Invalid packet size')
            if not 0 <= size <= 65000:
                return result(False, 'Packet size must be 0-65000')
            # -M do: forbid fragmentation, so this tests jumbo frames end to end.
            cmd += ['-s', str(size), '-M', 'do']
        ok, out = run(cmd + [host], timeout=count * 3 + 5)
        return jsonify({'success': True, 'reachable': ok, 'output': out})

    return bp

