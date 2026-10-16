"""What the machine's network looks like: interfaces, link capabilities,
Wi-Fi hardware, routes and DNS. Read-only - nothing here needs sudo."""

from __future__ import annotations

import ipaddress
import os
import re
import shutil
import time

from .shell import kv_lines, nm_running, nmcli_rows, read_text, run_json, run_out, unit_active

# ethtool duplex values the UI may send.
DUPLEX = {'half', 'full'}


# --------------------------------------------------------------------------
# System overview
# --------------------------------------------------------------------------

def network_manager_name() -> str:
    if nm_running():
        return 'NetworkManager'
    if unit_active('dhcpcd'):
        return 'dhcpcd'
    if unit_active('systemd-networkd'):
        return 'systemd-networkd'
    return 'unknown'


def rfkill_wlan() -> list[dict]:
    entries = []
    base = '/sys/class/rfkill'
    try:
        names = sorted(os.listdir(base))
    except Exception:
        return entries
    for name in names:
        path = os.path.join(base, name)
        if read_text(os.path.join(path, 'type')) != 'wlan':
            continue
        entries.append({
            'id': name,
            'name': read_text(os.path.join(path, 'name')),
            'soft_blocked': read_text(os.path.join(path, 'soft')) == '1',
            'hard_blocked': read_text(os.path.join(path, 'hard')) == '1',
        })
    return entries


def get_dns() -> dict:
    """Upstream DNS per link (systemd-resolved) or resolv.conf nameservers."""
    links = []
    out = run_out(['resolvectl', 'dns'], 4) if shutil.which('resolvectl') else ''
    for line in out.splitlines():
        m = re.match(r'^(Global|Link \d+ \(([^)]+)\)):\s*(.*)$', line.strip())
        if m and m.group(3).strip():
            links.append({'link': m.group(2) or 'global', 'servers': m.group(3).split()})
    resolv = read_text('/etc/resolv.conf')
    return {
        'resolved': bool(out),
        'links': links,
        'nameservers': re.findall(r'^nameserver\s+(\S+)', resolv, re.M),
        'search': ' '.join(re.findall(r'^search\s+(.*)$', resolv, re.M)),
    }


def get_overview() -> dict:
    manager = network_manager_name()
    nm = {}
    if manager == 'NetworkManager':
        rows = nmcli_rows(['general'], ['STATE', 'CONNECTIVITY', 'WIFI-HW', 'WIFI', 'NETWORKING'])
        nm = rows[0] if rows else {}
    routes = run_json(['ip', '-j', 'route', 'show', 'default']) or []
    routes6 = run_json(['ip', '-j', '-6', 'route', 'show', 'default']) or []
    has_wifi = any(os.path.isdir(f'/sys/class/net/{n}/wireless') for n in _list_ifnames())
    rfkill = rfkill_wlan()
    return {
        'hostname': read_text('/proc/sys/kernel/hostname'),
        'manager': manager,
        'nm': {
            'state': nm.get('STATE', ''),
            'connectivity': nm.get('CONNECTIVITY', ''),
            'networking': nm.get('NETWORKING', '') == 'enabled',
        } if nm else None,
        'gateways': [
            {'gateway': r.get('gateway', ''), 'dev': r.get('dev', ''), 'metric': r.get('metric'), 'family': 4}
            for r in routes
        ] + [
            {'gateway': r.get('gateway', ''), 'dev': r.get('dev', ''), 'metric': r.get('metric'), 'family': 6}
            for r in routes6
        ],
        'dns': get_dns(),
        'wifi': {
            'present': has_wifi,
            'enabled': (nm.get('WIFI') == 'enabled') if nm else not any(r['soft_blocked'] for r in rfkill),
            'hw_enabled': not any(r['hard_blocked'] for r in rfkill),
        },
        'tools': {name: shutil.which(name) is not None
                  for name in ('nmcli', 'ethtool', 'iw', 'wpa_cli', 'ping', 'dnsmasq')},
    }


# --------------------------------------------------------------------------
# Interfaces
# --------------------------------------------------------------------------

def _list_ifnames() -> list[str]:
    try:
        return sorted(os.listdir('/sys/class/net'))
    except Exception:
        return []


def iw_interfaces() -> dict[str, dict]:
    """{ifname: {type, ssid, channel, phy}} from `iw dev`."""
    result: dict[str, dict] = {}
    phy, cur = '', None
    for line in run_out(['iw', 'dev'], 4).splitlines() if shutil.which('iw') else []:
        s = line.strip()
        if s.startswith('phy#'):
            phy = 'phy' + s[4:]
        elif s.startswith('Interface '):
            cur = {'phy': phy, 'type': '', 'ssid': '', 'channel': ''}
            result[s.split(None, 1)[1]] = cur
        elif s.startswith('Unnamed/non-netdev'):
            cur = None
        elif cur is not None:
            if s.startswith('type '):
                cur['type'] = s[5:]
            elif s.startswith('ssid '):
                cur['ssid'] = s[5:]
            elif s.startswith('channel '):
                cur['channel'] = s[8:]
    return result


def _kind(name: str, link: dict, iw: dict) -> str:
    info_kind = ((link.get('linkinfo') or {}).get('info_kind') or '').lower()
    if link.get('link_type') == 'loopback':
        return 'loopback'
    if name in iw and iw[name]['type'].startswith('P2P') or name.startswith('p2p-'):
        return 'p2p'
    if os.path.isdir(f'/sys/class/net/{name}/wireless') or os.path.exists(f'/sys/class/net/{name}/phy80211'):
        return 'wifi'
    if info_kind in ('bridge', 'bond', 'vlan'):
        return info_kind
    if info_kind in ('tun', 'wireguard') or name.startswith(('tailscale', 'tun', 'wg', 'zt')):
        return 'vpn'
    if name.startswith('bnep'):
        return 'bluetooth'
    if info_kind or not os.path.exists(f'/sys/class/net/{name}/device'):
        return 'virtual'
    return 'ethernet'


def _bus(name: str) -> str:
    try:
        target = os.path.realpath(f'/sys/class/net/{name}/device')
    except Exception:
        return ''
    if not os.path.exists(f'/sys/class/net/{name}/device'):
        return ''
    for bus in ('usb', 'pci', 'sdio', 'mmc', 'platform'):
        if f'/{bus}' in target:
            return bus
    return ''


def _driver(name: str) -> str:
    try:
        return os.path.basename(os.readlink(f'/sys/class/net/{name}/device/driver'))
    except Exception:
        return ''


def nm_devices() -> dict[str, dict]:
    if not nm_running():
        return {}
    return {
        r['DEVICE']: {'type': r['TYPE'], 'state': r['STATE'], 'connection': r['CONNECTION'], 'uuid': r['CON-UUID']}
        for r in nmcli_rows(['device', 'status'], ['DEVICE', 'TYPE', 'STATE', 'CONNECTION', 'CON-UUID'])
    }


_ethtool_cache: dict[str, tuple[float, dict]] = {}


def forget_link_cache(name: str):
    """Drop the cached ethtool data after link settings changed."""
    _ethtool_cache.pop(name, None)


def ethtool_link(name: str, max_age: float = 0.0) -> dict:
    """Parse `ethtool <if>`; cached for max_age seconds (the list view only
    needs the static supported modes)."""
    cached = _ethtool_cache.get(name)
    if cached and time.time() - cached[0] < max_age:
        return cached[1]
    fields: dict[str, str] = {}
    key = None
    for line in run_out(['ethtool', name], 5).splitlines() if shutil.which('ethtool') else []:
        m = re.match(r'^\t([^\t:][^:]*):\s*(.*)$', line)
        if m:
            key = m.group(1).strip()
            fields[key] = m.group(2).strip()
        elif key and line.startswith('\t') and line.strip():
            fields[key] += ' ' + line.strip()

    def modes(k):
        value = fields.get(k, '')
        return [] if value in ('', 'Not reported') else value.split()

    supported = modes('Supported link modes')
    speeds = [int(m.group(1)) for mode in supported if (m := re.match(r'^(\d+)base', mode))]
    speed_m = re.match(r'^(\d+)', fields.get('Speed', ''))
    wol = fields.get('Supports Wake-on', '')
    result = {
        'available': bool(fields),
        'supported_modes': supported,
        'advertised_modes': modes('Advertised link modes'),
        'partner_modes': modes('Link partner advertised link modes'),
        'max_speed': max(speeds) if speeds else None,
        'speed': int(speed_m.group(1)) if speed_m else None,
        'duplex': fields.get('Duplex', '').lower() if fields.get('Duplex', '').lower() in DUPLEX else '',
        'autoneg': fields.get('Auto-negotiation', '') == 'on',
        'autoneg_supported': fields.get('Supports auto-negotiation', '') == 'Yes',
        'port': fields.get('Port', ''),
        'link_detected': fields.get('Link detected', '') == 'yes',
        'pause': fields.get('Advertised pause frame use', ''),
        'partner_pause': fields.get('Link partner advertised pause frame use', ''),
        'wol_supported': '' if wol in ('', 'd') else wol,
        'wol': fields.get('Wake-on', ''),
    }
    _ethtool_cache[name] = (time.time(), result)
    return result


def client_interface(remote_ip: str | None, addrs: list) -> str | None:
    """Name of the interface whose subnet the browser is talking from."""
    if not remote_ip:
        return None
    try:
        ip = ipaddress.ip_address(remote_ip)
    except ValueError:
        return None
    if ip.is_loopback:
        return None
    for link in addrs:
        for a in link.get('addr_info', []):
            try:
                if ip in ipaddress.ip_interface(f"{a['local']}/{a['prefixlen']}").network:
                    return link['ifname']
            except (KeyError, ValueError):
                continue
    # Not on a local subnet: it arrives via the default route.
    routes = run_json(['ip', '-j', 'route', 'get', remote_ip]) or []
    return routes[0].get('dev') if routes else None


def list_interfaces(remote_ip: str | None = None) -> list[dict]:
    links = run_json(['ip', '-j', '-d', '-s', 'link', 'show']) or []
    addrs = run_json(['ip', '-j', 'addr', 'show']) or []
    addr_map = {a['ifname']: a.get('addr_info', []) for a in addrs}
    iw = iw_interfaces()
    nm = nm_devices()
    client_if = client_interface(remote_ip, addrs)

    result = []
    for link in links:
        name = link.get('ifname', '')
        kind = _kind(name, link, iw)
        flags = link.get('flags', [])
        stats = link.get('stats64') or {}
        rx, tx = stats.get('rx', {}), stats.get('tx', {})
        speed = read_text(f'/sys/class/net/{name}/speed')
        physical = os.path.exists(f'/sys/class/net/{name}/device')
        eth = ethtool_link(name, max_age=60) if kind == 'ethernet' else {}
        result.append({
            'name': name,
            'kind': kind,
            'physical': physical,
            'bus': _bus(name),
            'driver': _driver(name),
            'mac': link.get('address', '') if link.get('link_type') != 'none' else '',
            'perm_mac': link.get('permaddr', ''),
            'operstate': link.get('operstate', ''),
            'up': 'UP' in flags,
            'carrier': 'LOWER_UP' in flags,
            'mtu': link.get('mtu'),
            'min_mtu': link.get('min_mtu'),
            'max_mtu': link.get('max_mtu'),
            'speed': int(speed) if speed.lstrip('-').isdigit() and int(speed) > 0 else None,
            'max_speed': eth.get('max_speed'),
            'duplex': read_text(f'/sys/class/net/{name}/duplex') if physical else '',
            'ipv4': [f"{a['local']}/{a['prefixlen']}" for a in addr_map.get(name, []) if a.get('family') == 'inet'],
            'ipv6': [
                {'addr': f"{a['local']}/{a['prefixlen']}", 'scope': a.get('scope', '')}
                for a in addr_map.get(name, []) if a.get('family') == 'inet6'
            ],
            'stats': {
                'rx_bytes': rx.get('bytes', 0), 'tx_bytes': tx.get('bytes', 0),
                'rx_packets': rx.get('packets', 0), 'tx_packets': tx.get('packets', 0),
                'rx_errors': rx.get('errors', 0), 'tx_errors': tx.get('errors', 0),
                'rx_dropped': rx.get('dropped', 0), 'tx_dropped': tx.get('dropped', 0),
            },
            'wireless': iw.get(name),
            'nm': nm.get(name),
            'is_client': name == client_if,
        })
    order = {'ethernet': 0, 'wifi': 1, 'p2p': 2, 'bridge': 3, 'bond': 3, 'vlan': 4,
             'vpn': 5, 'bluetooth': 6, 'virtual': 7, 'loopback': 8}
    result.sort(key=lambda i: (order.get(i['kind'], 9), i['name']))
    return result


def ethtool_features(name: str) -> list[dict]:
    data = run_json(['ethtool', '--json', '-k', name], 5)
    if not data:
        return []
    features = []
    for key, value in data[0].items():
        if isinstance(value, dict) and 'active' in value:
            features.append({'name': key, 'active': value['active'], 'fixed': value.get('fixed', False)})
    return features


def ethtool_rings(name: str) -> dict | None:
    out = run_out(['ethtool', '-g', name], 5)
    if 'Pre-set maximums' not in out:
        return None
    maximum, current = out.split('Current hardware settings', 1) if 'Current hardware settings' in out else (out, '')

    def grab(text, key):
        m = re.search(rf'^{key}:\s+(\d+)', text, re.M)
        return int(m.group(1)) if m else None
    return {
        'rx': grab(current, 'RX'), 'tx': grab(current, 'TX'),
        'rx_max': grab(maximum, 'RX'), 'tx_max': grab(maximum, 'TX'),
    }


def ethtool_driver(name: str) -> dict:
    info = kv_lines(run_out(['ethtool', '-i', name], 5), ':')
    return {
        'driver': info.get('driver', ''),
        'version': info.get('version', ''),
        'firmware': info.get('firmware-version', ''),
        'bus_info': info.get('bus-info', ''),
    }


def wifi_phy_info(phy: str) -> dict:
    """Bands, standards and a rough max PHY rate from `iw phy <phy> info`."""
    out = run_out(['iw', 'phy', phy, 'info'], 5)
    if not out:
        return {}
    bands = []
    for m in re.finditer(r'^\tBand (\d+):(.*?)(?=^\tBand \d+:|^\t[A-Z]|\Z)', out, re.M | re.S):
        body = m.group(2)
        freqs = [int(f) for f, rest in re.findall(r'\* (\d+)(?:\.\d+)? MHz \[\d+\](.*)', body) if 'disabled' not in rest]
        if not freqs:
            continue
        band = '2.4 GHz' if freqs[0] < 3000 else '5 GHz' if freqs[0] < 5900 else '6 GHz'
        mcs = re.search(r'HT TX/RX MCS rate indexes supported: 0-(\d+)', body)
        streams = (int(mcs.group(1)) + 1) // 8 if mcs else 1
        widths = ['20']
        if 'HT20/HT40' in body:
            widths.append('40')
        if 'VHT Capabilities' in body:
            widths.append('80')
            if re.search(r'Supported Channel Width: .*160', body) and 'neither 160' not in body:
                widths.append('160')
        standards = ['n'] if 'HT Capab' in body or mcs else []
        if 'VHT Capabilities' in body:
            standards.append('ac')
        if 'HE Iftypes' in body:
            standards.append('ax')
        # Max PHY rate per stream with short GI: HT20 72.2, HT40 150, VHT80 433.3, VHT160 866.7
        per_stream = {'20': 72.2, '40': 150, '80': 433.3, '160': 866.7}[widths[-1]]
        bands.append({
            'band': band,
            'channels': len(freqs),
            'widths': widths,
            'standards': standards,
            'streams': max(streams, 1),
            'max_rate': round(per_stream * max(streams, 1)),
        })
    modes = re.search(r'Supported interface modes:\n((?:\t\t \* .*\n)+)', out)
    return {
        'bands': bands,
        'modes': re.findall(r'\* (\S+)', modes.group(1)) if modes else [],
    }


def wifi_link(name: str) -> dict:
    out = run_out(['iw', 'dev', name, 'link'], 4)
    if not out or out.startswith('Not connected'):
        return {'connected': False}
    m = re.search(r'Connected to ([0-9a-f:]{17})', out)
    info = kv_lines(out, ':')
    return {
        'connected': True,
        'bssid': m.group(1) if m else '',
        'ssid': info.get('SSID', ''),
        'freq': info.get('freq', ''),
        'signal': info.get('signal', ''),
        'tx_bitrate': info.get('tx bitrate', ''),
        'rx_bitrate': info.get('rx bitrate', ''),
    }


def interface_details(name: str, remote_ip: str | None = None) -> dict | None:
    iface = next((i for i in list_interfaces(remote_ip) if i['name'] == name), None)
    if not iface:
        return None
    details = {'interface': iface}
    if iface['physical'] or iface['kind'] in ('wifi', 'p2p'):
        details['driver'] = ethtool_driver(name)
    if iface['kind'] == 'ethernet':
        details['link'] = ethtool_link(name)
        details['rings'] = ethtool_rings(name)
    if iface['kind'] in ('ethernet', 'wifi', 'bridge', 'bond', 'vlan'):
        details['features'] = ethtool_features(name)
    if iface['kind'] in ('wifi', 'p2p') and iface['wireless']:
        details['wifi'] = {
            'link': wifi_link(name) if iface['kind'] == 'wifi' else None,
            'phy': wifi_phy_info(iface['wireless']['phy']),
            'power_save': 'Power save: on' in run_out(['iw', 'dev', name, 'get', 'power_save'], 4),
            'txpower': (re.search(r'txpower ([\d.]+ dBm)', run_out(['iw', 'dev', name, 'info'], 4)) or [None, ''])[1],
            'regdomain': (re.search(r'country (\w+)', run_out(['iw', 'reg', 'get'], 4)) or [None, ''])[1],
        }
    nm = iface.get('nm')
    if nm and nm.get('uuid'):
        details['profile'] = {
            'uuid': nm['uuid'],
            'name': nm['connection'],
            'external': 'externally' in nm['state'],
        }
    return details


# --------------------------------------------------------------------------
# Routes / neighbours / ping
# --------------------------------------------------------------------------

def get_routes() -> dict:
    return {
        'ipv4': run_json(['ip', '-j', 'route', 'show']) or [],
        'ipv6': [r for r in (run_json(['ip', '-j', '-6', 'route', 'show']) or [])
                 if not str(r.get('dst', '')).startswith(('fe80', 'ff00', 'multicast'))],
        'neighbors': [n for n in (run_json(['ip', '-j', 'neigh', 'show']) or [])
                      if n.get('lladdr') and 'FAILED' not in n.get('state', [])],
        'dns': get_dns(),
    }
