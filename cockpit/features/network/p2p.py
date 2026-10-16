"""Wi-Fi Direct (P2P) for the Network page.

Everything goes through wpa_supplicant's control interface (`wpa_cli`):

* The P2P control interface is `p2p-dev-<wlan>` when the driver gives
  wpa_supplicant a dedicated P2P device (brcmfmac with
  `driver_param=p2p_device=6`), otherwise the wlan interface itself.
* Groups are separate interfaces (`p2p-<wlan>-<n>`) with their own sockets.
* NetworkManager's own wpa_supplicant does not expose P2P that way, so the
  setup hands the interface to a dedicated `wpa_supplicant@<wlan>` with P2P
  enabled (same layout tools like hostp2pd expect). It is reversible.
* A session manager such as hostp2pd may already drive the P2P interface; it
  is detected and shown, and the page keeps working next to it.

Groups we create can get an address and a small dnsmasq DHCP server so
clients that join actually get an IP.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import shutil
import time

from flask import Blueprint, jsonify, request, session

from cockpit.core.auth import SUDO_SESSION_KEY

from .http import result
from .inventory import iw_interfaces
from .profiles import list_connections
from .shell import (
    WPA_RUN_DIR, kv_lines, nm_running, read_text, run_json, run_out, sudo, sudo_all, unit_active, wpa_cli,
)

MAC_RE = re.compile(r'^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$')
NM_UNMANAGED_CONF = '/etc/NetworkManager/conf.d/99-cockpit-wifi-direct.conf'
NETWORKD_FILE = '/etc/systemd/network/80-cockpit-{iface}.network'
NETWORKD_MARKER = '# cockpit: enabled systemd-networkd'
DHCP_PID = '/run/cockpit-p2p-{iface}.pid'
DHCP_LEASES = '/run/cockpit-p2p-{iface}.leases'

_CONFIG_METHODS = 'virtual_push_button keypad display'


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------

def _wifi_ifaces() -> list[str]:
    try:
        return sorted(n for n in os.listdir('/sys/class/net') if os.path.isdir(f'/sys/class/net/{n}/wireless'))
    except Exception:
        return []


def _phy_of(iface: str) -> str:
    return os.path.basename(os.path.realpath(f'/sys/class/net/{iface}/phy80211'))


def hw_supports_p2p(iface: str) -> bool:
    out = run_out(['iw', 'phy', _phy_of(iface), 'info'], 5)
    m = re.search(r'Supported interface modes:\n((?:\t\t \* .*\n)+)', out)
    return bool(m and 'P2P-GO' in m.group(1))


def control_iface(wlan: str) -> str | None:
    """The wpa_supplicant interface that accepts p2p_* commands for wlan."""
    dedicated = f'p2p-dev-{wlan}'
    if os.path.exists(os.path.join(WPA_RUN_DIR, dedicated)):
        return dedicated
    if os.path.exists(os.path.join(WPA_RUN_DIR, wlan)):
        ok, out = wpa_cli(wlan, 'status')
        if ok and 'p2p_device_address=' in out:
            return wlan
    return None


def external_managers() -> list[dict]:
    """Processes known to drive Wi-Fi Direct on their own (hostp2pd)."""
    found = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as f:
                cmd = f.read().replace(b'\0', b' ').decode(errors='replace').strip()
        except Exception:
            continue
        if 'hostp2pd' in cmd and 'grep' not in cmd:
            iface = re.search(r'-i\s+(\S+)', cmd)
            key = iface.group(1) if iface else cmd
            found.setdefault(key, {'name': 'hostp2pd', 'pid': int(pid), 'interface': iface.group(1) if iface else '',
                                   'command': cmd[:300]})
    return list(found.values())


def _wpa_unit_conf(wlan: str) -> str:
    return f'/etc/wpa_supplicant/wpa_supplicant-{wlan}.conf'


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

def _peers(ctrl: str) -> list[dict]:
    ok, out = wpa_cli(ctrl, 'p2p_peers')
    peers = []
    for mac in (out.split() if ok else []):
        if not MAC_RE.match(mac):
            continue
        info = kv_lines(wpa_cli(ctrl, 'p2p_peer', mac)[1])
        group_capab = info.get('group_capab', '0x0')
        try:
            is_go = bool(int(group_capab, 16) & 0x1)
        except ValueError:
            is_go = False
        level = info.get('level', '')
        peers.append({
            'mac': mac,
            'name': info.get('device_name', ''),
            'type': info.get('pri_dev_type', ''),
            'config_methods': info.get('config_methods', ''),
            'level': int(level) if level.lstrip('-').isdigit() else None,
            'is_go': is_go,
            'in_group': info.get('member_in_go_dev', '00:00:00:00:00:00') != '00:00:00:00:00:00',
            'manufacturer': info.get('manufacturer', ''),
            'model': info.get('model_name', ''),
        })
    peers.sort(key=lambda p: (-(p['level'] or -200), p['name']))
    return peers


def _persistent(ctrl: str) -> list[dict]:
    ok, out = wpa_cli(ctrl, 'list_networks')
    groups = []
    for line in out.splitlines()[1:] if ok else []:
        parts = line.split('\t')
        if len(parts) >= 4 and 'P2P-PERSISTENT' in parts[3]:
            groups.append({'id': parts[0], 'ssid': parts[1], 'bssid': parts[2], 'current': 'CURRENT' in parts[3]})
    return groups


def _stations(group: str) -> list[dict]:
    stations, cur = [], None
    for line in run_out(['iw', 'dev', group, 'station', 'dump'], 4).splitlines():
        m = re.match(r'^Station ([0-9a-f:]{17})', line)
        if m:
            cur = {'mac': m.group(1), 'signal': '', 'tx_bitrate': '', 'connected_time': ''}
            stations.append(cur)
        elif cur and ':' in line:
            key, value = (s.strip() for s in line.split(':', 1))
            if key in ('signal', 'tx bitrate', 'connected time'):
                cur[key.replace(' ', '_')] = value
    neigh = {n.get('lladdr', '').lower(): n.get('dst') for n in (run_json(['ip', '-j', 'neigh', 'show', 'dev', group]) or [])}
    leases = {}
    for line in read_text(DHCP_LEASES.format(iface=group)).splitlines():
        parts = line.split()
        if len(parts) >= 4:
            leases[parts[1].lower()] = {'ip': parts[2], 'hostname': '' if parts[3] == '*' else parts[3]}
    for st in stations:
        lease = leases.get(st['mac'].lower(), {})
        st['ip'] = lease.get('ip') or neigh.get(st['mac'].lower(), '')
        st['hostname'] = lease.get('hostname', '')
    return stations


def _groups() -> list[dict]:
    groups = []
    addrs = {a['ifname']: a.get('addr_info', []) for a in (run_json(['ip', '-j', 'addr', 'show']) or [])}
    for name, info in iw_interfaces().items():
        if not info['type'].startswith('P2P-') or info['type'] == 'P2P-device':
            continue
        status = kv_lines(wpa_cli(name, 'status')[1])
        is_go = info['type'] == 'P2P-GO'
        ok, passphrase = wpa_cli(name, 'p2p_get_passphrase') if is_go else (False, '')
        groups.append({
            'interface': name,
            'role': 'Group owner' if is_go else 'Client',
            'is_go': is_go,
            'ssid': status.get('ssid') or info['ssid'],
            'freq': status.get('freq', ''),
            'channel': info['channel'],
            'bssid': status.get('bssid', ''),
            'key_mgmt': status.get('key_mgmt', ''),
            'passphrase': passphrase.strip() if ok else '',
            'ipv4': [f"{a['local']}/{a['prefixlen']}" for a in addrs.get(name, []) if a.get('family') == 'inet'],
            'stations': _stations(name) if is_go else [],
            'dhcp': os.path.exists(DHCP_PID.format(iface=name)),
            'persistent_id': status.get('id', ''),
        })
    return groups


def setup_plan(wlan: str) -> dict | None:
    """How Wi-Fi Direct can be enabled on wlan, if it isn't yet."""
    if not wlan or not hw_supports_p2p(wlan):
        return None
    if unit_active(f'wpa_supplicant@{wlan}'):
        return {
            'mode': 'patch',
            'interface': wlan,
            'title': f'Enable P2P in wpa_supplicant@{wlan}',
            'steps': [
                f'Back up {_wpa_unit_conf(wlan)}',
                'Add the Wi-Fi Direct settings (device name, P2P device, push-button / PIN methods)',
                f'Restart wpa_supplicant@{wlan} (Wi-Fi drops for a few seconds)',
            ],
        }
    if nm_running():
        wifi_profiles = [c['name'] for c in list_connections() if c['type'] == '802-11-wireless']
        return {
            'mode': 'handover',
            'interface': wlan,
            'title': f'Hand {wlan} from NetworkManager to wpa_supplicant',
            'steps': [
                f'Write {_wpa_unit_conf(wlan)} with Wi-Fi Direct enabled'
                + (f' and copy your saved Wi-Fi networks ({", ".join(wifi_profiles)})' if wifi_profiles else ''),
                f'Tell NetworkManager to leave {wlan} alone ({NM_UNMANAGED_CONF})',
                f'Get an IP on {wlan} via DHCP with systemd-networkd ({NETWORKD_FILE.format(iface=wlan)})',
                f'Enable wpa_supplicant@{wlan} and restart NetworkManager',
                f'Wi-Fi networks for {wlan} are then managed from the Wi-Fi tab (wpa_supplicant mode). '
                'Ethernet and everything else stays with NetworkManager. This can be undone here.',
            ],
        }
    return None


def p2p_status() -> dict:
    wifi = _wifi_ifaces()
    wlan = next((w for w in wifi if not w.startswith('p2p-')), '')
    ctrl = control_iface(wlan) if wlan else None
    state = {
        'wifi_interfaces': wifi,
        'interface': wlan,
        'hw_support': hw_supports_p2p(wlan) if wlan else False,
        'wpa_cli': shutil.which('wpa_cli') is not None,
        'dnsmasq': shutil.which('dnsmasq') is not None,
        'control': ctrl,
        'available': bool(ctrl),
        'managers': external_managers(),
        'handover_active': os.path.exists(NM_UNMANAGED_CONF),
    }
    if not ctrl:
        state['setup'] = setup_plan(wlan) if state['wpa_cli'] else None
        if not wlan:
            state['reason'] = 'No Wi-Fi interface found.'
        elif not state['hw_support']:
            state['reason'] = f'The Wi-Fi chip behind {wlan} does not support Wi-Fi Direct (no P2P-GO mode).'
        elif not state['wpa_cli']:
            state['reason'] = 'wpa_cli is not installed (sudo apt install wpasupplicant).'
        else:
            state['reason'] = f'wpa_supplicant is not running Wi-Fi Direct on {wlan} yet.'
        return state

    status = kv_lines(wpa_cli(ctrl, 'status')[1])

    def get(key):
        ok, out = wpa_cli(ctrl, 'get', key)
        return out.strip() if ok else ''
    state.update({
        'device_address': status.get('p2p_device_address', ''),
        'device_name': get('device_name'),
        'go_intent': get('p2p_go_intent'),
        'config_methods': get('config_methods'),
        'persistent_reconnect': get('persistent_reconnect') == '1',
        'groups': _groups(),
        'peers': _peers(ctrl),
        'persistent': _persistent(ctrl),
    })
    return state


# --------------------------------------------------------------------------
# Setup / undo
# --------------------------------------------------------------------------

def _p2p_lines(wlan: str) -> list[str]:
    driver = os.path.basename(os.path.realpath(f'/sys/class/net/{wlan}/device/driver'))
    lines = []
    if driver == 'brcmfmac':
        # Raspberry Pi / Broadcom: needs a dedicated P2P device (p2p-dev-wlan0).
        lines.append('driver_param=p2p_device=6')
    name = re.sub(r'[^A-Za-z0-9 _-]', '', read_text('/proc/sys/kernel/hostname'))[:24] or 'raspberrypi'
    lines += [
        f'device_name={name}',
        'device_type=1-0050F204-1',
        f'config_methods={_CONFIG_METHODS}',
        'p2p_go_ht40=1',
        'persistent_reconnect=1',
    ]
    return lines


def _country() -> str:
    m = re.search(r'country (\w\w)', run_out(['iw', 'reg', 'get'], 4))
    return m.group(1) if m and m.group(1) != '00' else ''


def _write_root_file(path: str, content: str, password: str, mode: str = '644') -> tuple[bool, str]:
    ok, out = sudo(['tee', path], password, 10, input_text=content)
    if not ok:
        return False, out
    return sudo(['chmod', mode, path], password, 10)


def _nm_wifi_networks(password: str) -> tuple[list[str], list[str]]:
    """network={} blocks for NetworkManager's saved WPA-PSK / open networks."""
    blocks, skipped = [], []
    for con in list_connections():
        if con['type'] != '802-11-wireless':
            continue
        ok, out = sudo(['nmcli', '-s', '-g', '802-11-wireless.ssid,802-11-wireless.mode,'
                        '802-11-wireless-security.key-mgmt,802-11-wireless-security.psk',
                        'connection', 'show', 'uuid', con['uuid']], password, 10)
        lines = out.splitlines() if ok else []
        if len(lines) < 4:
            skipped.append(con['name'])
            continue
        ssid, mode, key_mgmt, psk = lines[:4]
        if mode not in ('', 'infrastructure') or not ssid:
            continue
        block = [f'\tssid={ssid.encode().hex()}', '\tscan_ssid=1']
        if key_mgmt == 'wpa-psk' and psk:
            raw = psk if re.fullmatch(r'[0-9a-fA-F]{64}', psk) else \
                hashlib.pbkdf2_hmac('sha1', psk.encode(), ssid.encode(), 4096, 32).hex()
            block += ['\tkey_mgmt=WPA-PSK', f'\tpsk={raw}']
        elif key_mgmt in ('', 'none'):
            block += ['\tkey_mgmt=NONE']
        else:
            skipped.append(con['name'])
            continue
        blocks.append('network={\n' + '\n'.join(block) + '\n}\n')
    return blocks, skipped


def run_setup(password: str) -> tuple[bool, str]:
    state = p2p_status()
    plan = state.get('setup')
    if state['available']:
        return True, 'Wi-Fi Direct is already available'
    if not plan:
        return False, state.get('reason') or 'Wi-Fi Direct cannot be set up automatically on this system'
    wlan = plan['interface']
    conf = _wpa_unit_conf(wlan)
    log = []

    if plan['mode'] == 'patch':
        ok, current = sudo(['cat', conf], password, 10)
        if not ok:
            return False, f'Could not read {conf}: {current}'
        sudo(['cp', '-a', conf, f'{conf}.bak-{int(time.time())}'], password, 10)
        lines = [ln for ln in current.splitlines() if not re.match(r'^\s*p2p_disabled\s*=\s*1', ln)]
        header_keys = {ln.split('=', 1)[0].strip() for ln in lines if '=' in ln and not ln.startswith((' ', '\t'))}
        additions = [ln for ln in _p2p_lines(wlan) if ln.split('=', 1)[0] not in header_keys]
        if 'ctrl_interface' not in header_keys:
            additions.insert(0, 'ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev')
        if 'update_config' not in header_keys:
            additions.append('update_config=1')
        # Global settings must come before the first network={} block.
        first_net = next((i for i, ln in enumerate(lines) if ln.strip().startswith('network=')), len(lines))
        new = lines[:first_net] + additions + [''] + lines[first_net:]
        ok, out = _write_root_file(conf, '\n'.join(new).rstrip() + '\n', password, '600')
        if not ok:
            return False, out
        log.append(f'Updated {conf}: ' + (', '.join(a.split('=')[0] for a in additions) or 'nothing to add'))
        ok, out = sudo(['systemctl', 'restart', f'wpa_supplicant@{wlan}'], password, 30)
        if not ok:
            return False, out
        log.append(f'Restarted wpa_supplicant@{wlan}')

    elif plan['mode'] == 'handover':
        networks, skipped = _nm_wifi_networks(password)
        country = _country()
        content = '\n'.join(
            ['ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev', 'update_config=1']
            + ([f'country={country}'] if country else [])
            + _p2p_lines(wlan)
        ) + '\n\n' + '\n'.join(networks)
        if os.path.exists(conf):
            sudo(['cp', '-a', conf, f'{conf}.bak-{int(time.time())}'], password, 10)
        ok, out = _write_root_file(conf, content, password, '600')
        if not ok:
            return False, out
        log.append(f'Wrote {conf} ({len(networks)} Wi-Fi network(s) copied)')
        if skipped:
            log.append(f'Not copied (not WPA-PSK/open, add them again in the Wi-Fi tab): {", ".join(skipped)}')

        ok, out = _write_root_file(
            NM_UNMANAGED_CONF,
            f'# Written by ServiceCockpit: {wlan} is driven by wpa_supplicant@{wlan} for Wi-Fi Direct\n'
            f'[keyfile]\nunmanaged-devices=interface-name:{wlan};interface-name:p2p-dev-{wlan};interface-name:p2p-{wlan}-*\n',
            password)
        if not ok:
            return False, out
        networkd_enabled = unit_active('systemd-networkd')
        ok, out = _write_root_file(
            NETWORKD_FILE.format(iface=wlan),
            ('' if networkd_enabled else NETWORKD_MARKER + '\n')
            + f'# Written by ServiceCockpit: DHCP for {wlan} while it is not managed by NetworkManager\n'
            f'[Match]\nName={wlan}\n\n[Network]\nDHCP=yes\n',
            password)
        if not ok:
            return False, out
        log.append(f'{wlan} marked unmanaged in NetworkManager, DHCP via systemd-networkd')

        commands = [['systemctl', 'restart', 'NetworkManager'],
                    ['systemctl', 'enable', '--now', f'wpa_supplicant@{wlan}']]
        if not networkd_enabled:
            commands.append(['systemctl', 'enable', '--now', 'systemd-networkd'])
        else:
            commands.append(['networkctl', 'reload'])
        ok, out = sudo_all(commands, password, 40)
        if not ok:
            return False, '\n'.join(log + [out])
        log.append(f'wpa_supplicant@{wlan} enabled')

    # Give wpa_supplicant a moment to create the P2P device.
    for _ in range(10):
        time.sleep(1)
        if control_iface(wlan):
            return True, '\n'.join(log + ['Wi-Fi Direct is ready'])
    return False, '\n'.join(log + [
        'wpa_supplicant is running but no P2P control interface appeared. '
        f'Check: journalctl -u wpa_supplicant@{wlan}'])


def undo_handover(password: str) -> tuple[bool, str]:
    wlan = next((w for w in _wifi_ifaces() if not w.startswith('p2p-')), '')
    if not wlan or not os.path.exists(NM_UNMANAGED_CONF):
        return False, 'Nothing to undo'
    networkd_file = NETWORKD_FILE.format(iface=wlan)
    enabled_networkd = NETWORKD_MARKER in read_text(networkd_file)
    commands = [
        ['systemctl', 'disable', '--now', f'wpa_supplicant@{wlan}'],
        ['rm', '-f', NM_UNMANAGED_CONF, networkd_file],
    ]
    if enabled_networkd:
        commands.append(['systemctl', 'disable', '--now', 'systemd-networkd'])
    commands.append(['systemctl', 'restart', 'NetworkManager'])
    ok, out = sudo_all(commands, password, 40)
    return ok, out or f'{wlan} is managed by NetworkManager again'


# --------------------------------------------------------------------------
# Group addressing (DHCP for groups created here)
# --------------------------------------------------------------------------

def _free_subnet() -> ipaddress.IPv4Network:
    used = []
    for link in run_json(['ip', '-j', 'addr', 'show']) or []:
        for a in link.get('addr_info', []):
            if a.get('family') == 'inet':
                used.append(ipaddress.ip_interface(f"{a['local']}/{a['prefixlen']}").network)
    # 192.168.49.0/24 is what Android uses for Wi-Fi Direct groups.
    for third in [49] + list(range(50, 60)):
        net = ipaddress.ip_network(f'192.168.{third}.0/24')
        if not any(net.overlaps(u) for u in used):
            return net
    raise RuntimeError('No free 192.168.49-59.0/24 subnet')


def start_group_dhcp(group: str, password: str) -> tuple[bool, str]:
    if not shutil.which('dnsmasq'):
        return False, 'dnsmasq is not installed - clients will need a static IP (sudo apt install dnsmasq-base)'
    try:
        net = _free_subnet()
    except RuntimeError as e:
        return False, str(e)
    hosts = list(net.hosts())
    gw = str(hosts[0])
    ok, out = sudo_all([
        ['ip', 'addr', 'add', f'{gw}/{net.prefixlen}', 'dev', group],
        ['dnsmasq', '--conf-file=/dev/null', f'--interface={group}', '--bind-interfaces', '--except-interface=lo',
         f'--listen-address={gw}', '--port=0', f'--dhcp-range={hosts[9]},{hosts[99]},{net.netmask},12h',
         f'--dhcp-option=3,{gw}', f'--pid-file={DHCP_PID.format(iface=group)}',
         f'--dhcp-leasefile={DHCP_LEASES.format(iface=group)}'],
    ], password, 15)
    return ok, out or f'{group}: {gw}/{net.prefixlen}, DHCP {hosts[9]}-{hosts[99]}'


def stop_group_dhcp(group: str, password: str):
    pid = read_text(DHCP_PID.format(iface=group))
    if pid.isdigit():
        sudo(['kill', pid], password, 10)
    sudo(['rm', '-f', DHCP_PID.format(iface=group), DHCP_LEASES.format(iface=group)], password, 10)


def _wait_new_group(before: set[str], timeout: float = 15.0) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        now = {n for n, i in iw_interfaces().items() if i['type'] in ('P2P-GO', 'P2P-client')}
        new = now - before
        if new:
            return sorted(new)[0]
        time.sleep(0.5)
    return None


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def build_network_p2p_blueprint() -> Blueprint:
    bp = Blueprint('network_p2p', __name__)

    @bp.route('/api/network/p2p')
    def p2p_state():
        return jsonify({'success': True, 'p2p': p2p_status()})

    @bp.route('/api/network/p2p/<action>', methods=['POST'])
    def p2p_action(action):
        data = request.get_json(silent=True) or {}
        password = session.get(SUDO_SESSION_KEY)

        if action in ('setup', 'undo_setup'):
            if not password:
                return jsonify({'success': False, 'error': 'sudo_required', 'message': 'Sudo password required.'}), 401
            ok, out = run_setup(password) if action == 'setup' else undo_handover(password)
            return result(ok, out)

        wlan = next((w for w in _wifi_ifaces() if not w.startswith('p2p-')), '')
        ctrl = control_iface(wlan) if wlan else None
        if not ctrl:
            return result(False, 'Wi-Fi Direct is not available', 503)
        groups_before = {n for n, i in iw_interfaces().items() if i['type'] in ('P2P-GO', 'P2P-client')}

        if action == 'find':
            try:
                timeout = max(5, min(int(data.get('timeout', 30)), 300))
            except (TypeError, ValueError):
                timeout = 30
            ok, out = wpa_cli(ctrl, 'p2p_find', str(timeout))
            return result(ok, out, timeout=timeout)
        if action == 'stop_find':
            ok, out = wpa_cli(ctrl, 'p2p_stop_find')
            return result(ok, out)
        if action == 'flush':
            ok, out = wpa_cli(ctrl, 'p2p_flush')
            return result(ok, out)

        if action == 'device_name':
            name = str(data.get('value') or '').strip()
            if not 1 <= len(name) <= 32 or not re.fullmatch(r'[A-Za-z0-9 _.-]+', name):
                return result(False, 'Name: 1-32 letters, digits, spaces, _ . -')
            ok, out = wpa_cli(ctrl, 'set', 'device_name', name)
            if ok:
                wpa_cli(ctrl, 'save_config')
            return result(ok, out)
        if action == 'go_intent':
            value = str(data.get('value') or '')
            if not value.isdigit() or not 0 <= int(value) <= 15:
                return result(False, 'GO intent must be 0-15')
            ok, out = wpa_cli(ctrl, 'set', 'p2p_go_intent', value)
            if ok:
                wpa_cli(ctrl, 'save_config')
            return result(ok, out)

        if action == 'connect':
            mac = str(data.get('mac') or '')
            method = data.get('method', 'pbc')
            if not MAC_RE.match(mac):
                return result(False, 'Invalid peer address')
            args = ['p2p_connect', mac]
            if method == 'pbc':
                args.append('pbc')
            elif method == 'display':
                args.append('pin')                       # wpa_supplicant generates the PIN, we show it
            elif method == 'keypad':
                pin = str(data.get('pin') or '')
                if not re.fullmatch(r'\d{4}|\d{8}', pin):
                    return result(False, 'Enter the 4 or 8 digit PIN shown on the other device')
                args += [pin, 'keypad']
            else:
                return result(False, 'Unknown method')
            if data.get('join'):
                args.append('join')
            if data.get('persistent'):
                args.append('persistent')
            if str(data.get('go_intent', '')).isdigit() and not data.get('join'):
                args.append(f'go_intent={min(int(data["go_intent"]), 15)}')
            ok, out = wpa_cli(ctrl, *args, timeout=15)
            pin = out.strip() if ok and method == 'display' and out.strip().isdigit() else None
            return result(ok, out, pin=pin)
        if action == 'cancel':
            ok, out = wpa_cli(ctrl, 'p2p_cancel')
            return result(ok, out)

        if action == 'group_add':
            args = ['p2p_group_add']
            pid = str(data.get('persistent_id') or '')
            if pid:
                if pid not in {g['id'] for g in _persistent(ctrl)}:
                    return result(False, 'Unknown persistent group')
                args.append(f'persistent={pid}')
            elif data.get('persistent'):
                args.append('persistent')
            band = str(data.get('freq') or '')
            if band in ('2', '5'):
                args.append(f'freq={band}')
            if data.get('ht40', True):
                args.append('ht40')
            ok, out = wpa_cli(ctrl, *args, timeout=20)
            if not ok:
                return result(False, out or 'p2p_group_add failed')
            group = _wait_new_group(groups_before)
            msgs = [f'Group {group} started' if group else 'Group requested (interface not up yet)']
            if group and data.get('dhcp'):
                if not password:
                    msgs.append('Group is up, but assigning an IP / DHCP needs the sudo password')
                else:
                    dok, dout = start_group_dhcp(group, password)
                    msgs.append(dout if dok else f'DHCP not started: {dout}')
            return result(True, '\n'.join(msgs), group=group)
        if action == 'group_remove':
            group = str(data.get('interface') or '')
            if group not in {g['interface'] for g in _groups()}:
                return result(False, 'Unknown group')
            ok, out = wpa_cli(ctrl, 'p2p_group_remove', group, timeout=10)
            if ok and password and os.path.exists(DHCP_PID.format(iface=group)):
                stop_group_dhcp(group, password)
            return result(ok, out)
        if action == 'group_dhcp':
            group = str(data.get('interface') or '')
            if group not in {g['interface'] for g in _groups() if g['is_go']}:
                return result(False, 'Unknown group')
            if not password:
                return jsonify({'success': False, 'error': 'sudo_required', 'message': 'Sudo password required.'}), 401
            ok, out = start_group_dhcp(group, password)
            return result(ok, out)
        if action in ('wps_pbc', 'wps_pin'):
            group = str(data.get('interface') or '')
            if group not in {g['interface'] for g in _groups() if g['is_go']}:
                return result(False, 'Unknown group')
            if action == 'wps_pbc':
                ok, out = wpa_cli(group, 'wps_pbc')
            else:
                pin = str(data.get('pin') or '')
                if not re.fullmatch(r'\d{4}|\d{8}', pin):
                    return result(False, 'PIN must be 4 or 8 digits')
                ok, out = wpa_cli(group, 'wps_pin', 'any', pin)
            return result(ok, out)
        if action == 'persistent_remove':
            net_id = str(data.get('id') or '')
            if net_id not in {g['id'] for g in _persistent(ctrl)}:
                return result(False, 'Unknown persistent group')
            ok, out = wpa_cli(ctrl, 'remove_network', net_id)
            if ok:
                wpa_cli(ctrl, 'save_config')
            return result(ok, out)

        return result(False, 'Unknown action')

    return bp


__all__ = ['build_network_p2p_blueprint']
