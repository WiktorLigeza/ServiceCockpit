"""Wi-Fi client side, through whoever owns the interface.

NetworkManager when it manages the interface, otherwise a standalone
wpa_supplicant via wpa_cli (the layout Wi-Fi Direct needs, see p2p.py).
Wi-Fi Direct persistent groups share wpa_supplicant's network list; they are
hidden here and never disabled (no select_network).
"""

from __future__ import annotations

import hashlib
import os
import time

from .inventory import wifi_link, nm_devices
from .profiles import list_connections
from .shell import WPA_RUN_DIR, kv_lines, nmcli_rows, sudo, wpa_cli


def wifi_backend(name: str) -> str:
    nm = nm_devices().get(name)
    if nm and nm['state'] not in ('unavailable', 'unmanaged'):
        return 'nm'
    if os.path.exists(os.path.join(WPA_RUN_DIR, name)):
        return 'wpa'
    return 'none'


def _signal_pct(dbm: int) -> int:
    return max(0, min(100, 2 * (dbm + 100)))


def wifi_scan_nm(name: str, rescan: bool, password: str | None) -> tuple[list[dict], str]:
    note = ''
    if rescan:
        if password:
            sudo(['nmcli', 'device', 'wifi', 'rescan', 'ifname', name], password, 15)
            time.sleep(2.5)
        else:
            note = 'Showing cached results - a fresh scan needs the sudo password.'
    rows = nmcli_rows(['device', 'wifi', 'list', 'ifname', name, '--rescan', 'no'],
                      ['IN-USE', 'BSSID', 'SSID', 'MODE', 'CHAN', 'FREQ', 'RATE', 'SIGNAL', 'SECURITY'], 15)
    nets = [{
        'in_use': r['IN-USE'].strip() == '*', 'bssid': r['BSSID'], 'ssid': r['SSID'],
        'channel': r['CHAN'], 'freq': r['FREQ'], 'rate': r['RATE'],
        'signal': int(r['SIGNAL']) if r['SIGNAL'].isdigit() else None,
        'security': r['SECURITY'] if r['SECURITY'] not in ('', '--') else '',
    } for r in rows]
    return nets, note


def wifi_scan_wpa(name: str, rescan: bool) -> tuple[list[dict], str]:
    if rescan:
        wpa_cli(name, 'scan')
        time.sleep(4)
    ok, out = wpa_cli(name, 'scan_results')
    status = kv_lines(wpa_cli(name, 'status')[1])
    nets = []
    for line in out.splitlines()[1:] if ok else []:
        parts = line.split('\t')
        if len(parts) < 4:
            continue
        bssid, freq, level, flags = parts[:4]
        ssid = parts[4] if len(parts) > 4 else ''
        if '[P2P]' in flags:
            continue
        freq_i = int(freq) if freq.isdigit() else 0
        security = ' '.join(sorted({s for s in ('WPA3' if 'SAE' in flags else '', 'WPA2' if 'RSN' in flags or 'WPA2' in flags else '',
                                                'WPA1' if '[WPA-' in flags else '', 'WEP' if 'WEP' in flags else '') if s}))
        nets.append({
            'in_use': bssid == status.get('bssid') and status.get('wpa_state') == 'COMPLETED',
            'bssid': bssid, 'ssid': ssid,
            'channel': str((freq_i - 2407) // 5 if freq_i < 3000 else (freq_i - 5000) // 5) if freq_i else '',
            'freq': f'{freq} MHz', 'rate': '',
            'signal': _signal_pct(int(level)) if level.lstrip('-').isdigit() else None,
            'security': security,
            'sae_only': 'SAE' in flags and 'PSK' not in flags,
        })
    return nets, ''


def wifi_saved_wpa(name: str) -> list[dict]:
    ok, out = wpa_cli(name, 'list_networks')
    nets = []
    for line in out.splitlines()[1:] if ok else []:
        parts = line.split('\t')
        if len(parts) < 4 or 'P2P-PERSISTENT' in parts[3]:
            # Wi-Fi Direct persistent groups live in the same list - they
            # belong to the Wi-Fi Direct tab and must not be touched here.
            continue
        nets.append({'id': parts[0], 'ssid': parts[1], 'disabled': 'DISABLED' in parts[3], 'current': 'CURRENT' in parts[3]})
    return nets


def wifi_state(name: str, rescan: bool = False, password: str | None = None) -> dict:
    backend = wifi_backend(name)
    state: dict = {'backend': backend, 'interface': name, 'link': wifi_link(name)}
    if backend == 'nm':
        state['networks'], state['note'] = wifi_scan_nm(name, rescan, password)
        state['saved'] = [
            {'id': c['uuid'], 'ssid': c['name'], 'current': c['active'], 'autoconnect': c['autoconnect']}
            for c in list_connections() if c['type'] == '802-11-wireless'
        ]
    elif backend == 'wpa':
        state['networks'], state['note'] = wifi_scan_wpa(name, rescan)
        state['saved'] = wifi_saved_wpa(name)
        state['status'] = kv_lines(wpa_cli(name, 'status')[1])
    else:
        state['networks'], state['saved'] = [], []
        state['note'] = ('Neither NetworkManager nor a wpa_supplicant control socket manages this interface.')
    return state


def wpa_add_network(name: str, ssid: str, psk: str, hidden: bool) -> tuple[bool, str]:
    ok, net_id = wpa_cli(name, 'add_network')
    net_id = net_id.strip().splitlines()[-1] if ok else ''
    if not net_id.isdigit():
        return False, net_id or 'add_network failed'
    steps = [('ssid', ssid.encode().hex())]
    if psk:
        # Pre-computed PSK: keeps the passphrase out of argv and needs no quoting.
        raw = hashlib.pbkdf2_hmac('sha1', psk.encode(), ssid.encode(), 4096, 32).hex()
        steps += [('key_mgmt', 'WPA-PSK'), ('psk', raw)]
    else:
        steps += [('key_mgmt', 'NONE')]
    if hidden:
        steps.append(('scan_ssid', '1'))
    for key, value in steps:
        ok, out = wpa_cli(name, 'set_network', net_id, key, value)
        if not ok:
            wpa_cli(name, 'remove_network', net_id)
            return False, f'set_network {key} failed: {out}'
    # enable_network (not select_network): select would disable every other
    # network, including Wi-Fi Direct persistent groups in the same config.
    wpa_cli(name, 'enable_network', net_id)
    wpa_cli(name, 'save_config')
    wpa_cli(name, 'reassociate')
    return True, f'Added network {ssid}'
