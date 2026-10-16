"""NetworkManager connection profiles (read + form validation)."""

from __future__ import annotations

import ipaddress

from .shell import nm_running, nmcli_rows, run_out

# Per connection type, the profile key that stores the MTU.
MTU_KEYS = {
    '802-3-ethernet': '802-3-ethernet.mtu',
    '802-11-wireless': '802-11-wireless.mtu',
}


def list_connections() -> list[dict]:
    if not nm_running():
        return []
    rows = nmcli_rows(['connection', 'show'], ['NAME', 'UUID', 'TYPE', 'DEVICE', 'AUTOCONNECT', 'ACTIVE', 'STATE', 'TIMESTAMP-REAL'])
    return [{
        'name': r['NAME'], 'uuid': r['UUID'], 'type': r['TYPE'], 'device': r['DEVICE'],
        'autoconnect': r['AUTOCONNECT'] == 'yes', 'active': r['ACTIVE'] == 'yes',
        'state': r['STATE'], 'last_used': '' if r['TIMESTAMP-REAL'] == 'never' else r['TIMESTAMP-REAL'],
    } for r in rows]


def connection_settings(con_uuid: str) -> dict:
    out = run_out(['nmcli', '--escape', 'no', '-t', 'connection', 'show', 'uuid', con_uuid], 6)
    return {k: v for k, v in (line.split(':', 1) for line in out.splitlines() if ':' in line)}


def connection_details(con_uuid: str) -> dict | None:
    s = connection_settings(con_uuid)
    if not s.get('connection.uuid'):
        return None
    ctype = s.get('connection.type', '')
    mtu_key = MTU_KEYS.get(ctype)
    return {
        'uuid': con_uuid,
        'name': s.get('connection.id', ''),
        'type': ctype,
        'interface': s.get('connection.interface-name', ''),
        'autoconnect': s.get('connection.autoconnect') == 'yes',
        'priority': s.get('connection.autoconnect-priority', '0'),
        'device': s.get('GENERAL.DEVICES', ''),
        'state': s.get('GENERAL.STATE', ''),
        'filename': s.get('GENERAL.FILENAME', ''),
        'ipv4': {
            'method': s.get('ipv4.method', ''),
            'addresses': s.get('ipv4.addresses', ''),
            'gateway': s.get('ipv4.gateway', ''),
            'dns': s.get('ipv4.dns', ''),
            'ignore_auto_dns': s.get('ipv4.ignore-auto-dns') == 'yes',
        },
        'ipv6': {'method': s.get('ipv6.method', '')},
        'mtu': s.get(mtu_key, '') if mtu_key else None,
        'ssid': s.get('802-11-wireless.ssid', ''),
        'wifi_mode': s.get('802-11-wireless.mode', ''),
        'security': s.get('802-11-wireless-security.key-mgmt', ''),
        'active_ip4': [v for k, v in s.items() if k.startswith('IP4.ADDRESS')],
        'active_dns': [v for k, v in s.items() if k.startswith('IP4.DNS')],
        'active_gateway': s.get('IP4.GATEWAY', ''),
    }


def validate_ipv4_form(data: dict) -> tuple[dict, str]:
    """Turn the Connections-tab form into nmcli key/values."""
    method = data.get('method')
    if method not in ('auto', 'manual', 'shared', 'link-local', 'disabled'):
        return {}, 'Invalid IPv4 method'
    values = {'ipv4.method': method}
    if method == 'manual':
        addresses = [a.strip() for a in str(data.get('addresses') or '').replace(';', ',').split(',') if a.strip()]
        if not addresses:
            return {}, 'A manual configuration needs at least one address (e.g. 192.168.1.50/24)'
        for a in addresses:
            try:
                if '/' not in a:
                    return {}, f'{a}: add the prefix length, e.g. {a}/24'
                ipaddress.IPv4Interface(a)
            except ValueError:
                return {}, f'Invalid address: {a}'
        values['ipv4.addresses'] = ','.join(addresses)
        gateway = str(data.get('gateway') or '').strip()
        if gateway:
            try:
                ipaddress.IPv4Address(gateway)
            except ValueError:
                return {}, f'Invalid gateway: {gateway}'
        values['ipv4.gateway'] = gateway
    else:
        values['ipv4.addresses'] = ''
        values['ipv4.gateway'] = ''
    dns = [d.strip() for d in str(data.get('dns') or '').replace(';', ',').replace(' ', ',').split(',') if d.strip()]
    for d in dns:
        try:
            ipaddress.ip_address(d)
        except ValueError:
            return {}, f'Invalid DNS server: {d}'
    values['ipv4.dns'] = ','.join(dns)
    values['ipv4.ignore-auto-dns'] = 'yes' if data.get('ignore_auto_dns') else 'no'
    return values, ''
