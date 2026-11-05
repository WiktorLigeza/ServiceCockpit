"""LAN scanner: find devices on a local IPv4 subnet and ping them.

No root and no extra tools needed:
  1. ping sweep (`ping -c1`), concurrently
  2. the kernel neighbour table (`ip -j neigh`) for MAC addresses - this also
     finds devices that ignore ping but answered ARP
  3. names from reverse DNS, mDNS (Apple/Linux/printers/ESP...) and NetBIOS
     (Windows/Samba), each queried directly with a short timeout
  4. a quick TCP probe of a few well-known ports
  5. vendor from the MAC prefix, using Wireshark's `manuf` list (downloaded once
     into .cache/) or a system copy of the IEEE list if one is installed
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import struct
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from cockpit.core.config_store import note_devices_seen
from cockpit.paths import PROJECT_ROOT

MAX_HOSTS = 1024            # /22
PING_WORKERS = 64
PORTS = {
    21: 'FTP', 22: 'SSH', 23: 'Telnet', 80: 'HTTP', 443: 'HTTPS', 445: 'SMB', 502: 'Modbus',
    554: 'RTSP', 1883: 'MQTT', 2137: 'Cockpit', 3389: 'RDP', 5900: 'VNC', 8080: 'HTTP-alt',
    8123: 'Home Assistant', 9100: 'Printer',
}
CACHE_DIR = os.path.join(PROJECT_ROOT, '.cache')
MANUF_FILE = os.path.join(CACHE_DIR, 'manuf')
MANUF_URL = 'https://www.wireshark.org/download/automated/data/manuf'
MANUF_MAX_AGE = 30 * 86400
SYSTEM_OUI_FILES = ('/usr/share/ieee-data/oui.txt', '/usr/share/misc/oui.txt',
                    '/usr/share/nmap/nmap-mac-prefixes', '/usr/share/arp-scan/ieee-oui.txt')


def _run_out(args: list[str], timeout: float = 5.0) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL).stdout
    except Exception:
        return ''


# ---------------------------------------------------------------- subnets

def local_subnets() -> list[dict]:
    """IPv4 subnets of this machine's interfaces that are worth scanning."""
    try:
        data = json.loads(_run_out(['ip', '-j', '-4', 'addr', 'show']) or '[]')
    except ValueError:
        data = []
    gateway = default_gateway()
    subnets = []
    for iface in data:
        name = iface.get('ifname', '')
        if name == 'lo' or 'UP' not in (iface.get('flags') or []):
            continue
        for addr in iface.get('addr_info', []):
            prefix = addr.get('prefixlen', 32)
            if addr.get('family') != 'inet' or prefix >= 31:
                continue  # /32 (e.g. tailscale0) and /31 point-to-point: nothing to scan
            net = ipaddress.ip_network(f"{addr['local']}/{prefix}", strict=False)
            subnets.append({
                'iface': name,
                'address': addr['local'],
                'cidr': str(net),
                'hosts': net.num_addresses - 2,
                'default': bool(gateway and ipaddress.ip_address(gateway) in net),
            })
    subnets.sort(key=lambda s: (not s['default'], s['iface']))
    return subnets


def default_gateway() -> str | None:
    try:
        routes = json.loads(_run_out(['ip', '-j', '-4', 'route', 'show', 'default']) or '[]')
        return routes[0].get('gateway') if routes else None
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------- vendors

_vendor_lock = threading.Lock()
_vendors: dict | None = None      # {prefix_bits: {int_prefix: name}}


def _load_vendor_db() -> dict:
    """Parse whichever MAC-prefix list is available into {bits: {prefix: vendor}}."""
    table: dict[int, dict[int, str]] = {}

    def add(hex_prefix: str, bits: int, name: str):
        try:
            value = int(hex_prefix.replace(':', '').replace('-', '')[:bits // 4], 16)
        except ValueError:
            return
        table.setdefault(bits, {})[value] = name.strip()

    if os.path.exists(MANUF_FILE):
        with open(MANUF_FILE, encoding='utf-8', errors='replace') as f:
            for line in f:
                if not line.strip() or line.startswith('#'):
                    continue
                parts = line.rstrip('\n').split('\t')
                if len(parts) < 2:
                    continue
                prefix = parts[0].strip()
                bits = 24
                if '/' in prefix:
                    prefix, bits_s = prefix.split('/')
                    bits = int(bits_s)
                name = parts[2] if len(parts) > 2 and parts[2].strip() else parts[1]
                add(prefix, bits, name)
        return table

    for path in SYSTEM_OUI_FILES:
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                # oui.txt: "DC-A6-32   (hex)		Raspberry Pi Trading Ltd"; nmap/arp-scan: "DCA632<ws>Name"
                match = (re.match(r'^([0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2})\s+\(hex\)\s+(.+)$', line)
                         or re.match(r'^([0-9A-Fa-f]{6})\s+(.+)$', line))
                if match:
                    add(match.group(1), 24, match.group(2))
        if table:
            break
    return table


def _refresh_manuf():
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        req = urllib.request.Request(MANUF_URL, headers={'User-Agent': 'ServiceCockpit'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        if b'\t' not in data[:20000]:
            return
        tmp = MANUF_FILE + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, MANUF_FILE)
    except Exception:
        pass


def vendor_db() -> dict:
    global _vendors
    with _vendor_lock:
        stale = (not os.path.exists(MANUF_FILE)
                 or time.time() - os.path.getmtime(MANUF_FILE) > MANUF_MAX_AGE)
        if stale:
            _refresh_manuf()  # once a month; the scan already needs a few seconds
            _vendors = None
        if _vendors is None:
            _vendors = _load_vendor_db()
        return _vendors


def mac_vendor(mac: str | None, table: dict) -> str | None:
    if not mac:
        return None
    value = int(mac.replace(':', ''), 16)
    if (value >> 40) & 0x02:
        return 'Private (randomized) MAC'
    for bits in (36, 28, 24):
        name = table.get(bits, {}).get(value >> (48 - bits))
        if name:
            return name
    return None


# ---------------------------------------------------------------- probes

def ping(ip: str, count: int = 1, timeout_s: int = 1) -> dict:
    args = ['ping', '-n', '-c', str(count), '-W', str(timeout_s)]
    if count > 1:
        args += ['-i', '0.2']
    out = _run_out(args + [ip], timeout=count * (timeout_s + 0.5) + 3)
    sent = received = 0
    match = re.search(r'(\d+) packets transmitted, (\d+) (?:packets )?received', out)
    if match:
        sent, received = int(match.group(1)), int(match.group(2))
    rtt = re.search(r'= ([\d.]+)/([\d.]+)/([\d.]+)', out)
    return {
        'ip': ip,
        'alive': received > 0,
        'sent': sent,
        'received': received,
        'loss': round(100 * (sent - received) / sent) if sent else 100,
        'min': float(rtt.group(1)) if rtt else None,
        'avg': float(rtt.group(2)) if rtt else None,
        'max': float(rtt.group(3)) if rtt else None,
    }


def neighbours() -> dict[str, str]:
    """IPv4 -> MAC from the kernel neighbour (ARP) table."""
    try:
        rows = json.loads(_run_out(['ip', '-j', '-4', 'neigh', 'show']) or '[]')
    except ValueError:
        return {}
    result = {}
    for row in rows:
        state = row.get('state') or []
        if row.get('lladdr') and not {'FAILED', 'INCOMPLETE'} & set(state):
            result[row['dst']] = row['lladdr'].lower()
    return result


def _own_macs() -> dict[str, str]:
    """This machine's IPv4 -> MAC."""
    try:
        data = json.loads(_run_out(['ip', '-j', '-4', 'addr', 'show']) or '[]')
    except ValueError:
        return {}
    result = {}
    for iface in data:
        mac = None
        try:
            with open(f"/sys/class/net/{iface['ifname']}/address") as f:
                mac = f.read().strip()
        except OSError:
            pass
        for addr in iface.get('addr_info', []):
            result[addr['local']] = mac
    return result


# systemd-resolved answers these for any address; they are not device names.
_PLACEHOLDER_NAMES = {'_gateway', '_outbound', 'localhost', 'localhost.localdomain'}


def _reverse_dns(ip: str) -> str | None:
    try:
        name = socket.gethostbyaddr(ip)[0]
    except Exception:
        return None
    return None if name == ip or name.lower() in _PLACEHOLDER_NAMES else name


def _dns_name(data: bytes, offset: int) -> tuple[str, int]:
    """Decode a (possibly compressed) DNS name; returns (name, offset after it)."""
    labels, jumped, end = [], False, offset
    for _ in range(64):
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            pointer = struct.unpack('!H', data[offset:offset + 2])[0] & 0x3FFF
            if not jumped:
                end = offset + 2
            jumped, offset = True, pointer
            continue
        labels.append(data[offset + 1:offset + 1 + length].decode('utf-8', 'replace'))
        offset += 1 + length
    return '.'.join(labels), (end if jumped else offset)


def _mdns_names(ips: list[str], wait: float = 1.5) -> dict[str, str]:
    """Ask each host's mDNS responder (unicast, port 5353) for its reverse name."""
    names: dict[str, str] = {}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.2)
    except OSError:
        return names
    try:
        for ip in ips:
            qname = b''.join(bytes([len(p)]) + p.encode() for p in reversed(ip.split('.'))) + b'\x07in-addr\x04arpa\x00'
            packet = struct.pack('!6H', 0, 0, 1, 0, 0, 0) + qname + struct.pack('!HH', 12, 0x8001)
            try:
                sock.sendto(packet, (ip, 5353))
            except OSError:
                continue
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                data, (src, _) = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                qd, an = struct.unpack('!HH', data[4:8])
                offset = 12
                for _ in range(qd):
                    _, offset = _dns_name(data, offset)
                    offset += 4
                for _ in range(an):
                    _, offset = _dns_name(data, offset)
                    rtype, _, _, rdlen = struct.unpack('!HHIH', data[offset:offset + 10])
                    offset += 10
                    if rtype == 12:
                        name, _ = _dns_name(data, offset)
                        if name:
                            names[src] = name.rstrip('.')
                            break
                    offset += rdlen
            except (IndexError, struct.error):
                continue
    finally:
        sock.close()
    return names


def _netbios_names(ips: list[str], wait: float = 1.5) -> dict[str, str]:
    """NetBIOS node status query (UDP 137) - Windows and Samba answer with their name."""
    names: dict[str, str] = {}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.2)
    except OSError:
        return names
    # Name "*" (wildcard), first-level encoded: 'CK' + 'AA' * 15.
    query = struct.pack('!6H', 0x4342, 0, 1, 0, 0, 0) + b'\x20' + b'CK' + b'AA' * 15 + b'\x00' + struct.pack('!HH', 0x21, 1)
    try:
        for ip in ips:
            try:
                sock.sendto(query, (ip, 137))
            except OSError:
                continue
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                data, (src, _) = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                offset = 12 + 34 + 10          # header, name, type/class/ttl/rdlength
                count = data[offset]
                offset += 1
                for i in range(count):
                    entry = data[offset + 18 * i: offset + 18 * (i + 1)]
                    name = entry[:15].decode('ascii', 'replace').strip()
                    suffix, flags = entry[15], struct.unpack('!H', entry[16:18])[0]
                    if suffix == 0x00 and not flags & 0x8000 and name:
                        names[src] = name
                        break
            except (IndexError, struct.error):
                continue
    finally:
        sock.close()
    return names


def _port_open(ip: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


# ---------------------------------------------------------------- scan state

class Scan:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {'id': 0, 'running': False, 'cidr': None, 'phase': None, 'done': 0, 'total': 0,
                      'started': None, 'finished': None, 'devices': [], 'error': None, 'vendors': False}
        self.cancel_flag = False

    def view(self) -> dict:
        with self.lock:
            return {**self.state, 'devices': [dict(d) for d in self.state['devices']]}

    def _set(self, **kw):
        with self.lock:
            self.state.update(kw)

    def start(self, cidr: str) -> tuple[bool, str]:
        try:
            net = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            return False, 'Not a valid subnet (example: 192.168.1.0/24).'
        if net.version != 4:
            return False, 'Only IPv4 subnets can be scanned.'
        if net.num_addresses - 2 > MAX_HOSTS:
            return False, f'{net} has {net.num_addresses - 2} addresses; scan a /22 or smaller.'
        if not (net.is_private or net.is_link_local or net.subnet_of(ipaddress.ip_network('100.64.0.0/10'))):
            return False, 'Only private (local) subnets can be scanned.'
        with self.lock:
            if self.state['running']:
                return False, 'A scan is already running.'
            self.cancel_flag = False
            self.state.update({'id': self.state['id'] + 1, 'running': True, 'cidr': str(net), 'phase': 'Pinging',
                               'done': 0, 'total': net.num_addresses - 2 if net.prefixlen < 31 else net.num_addresses,
                               'started': time.time(), 'finished': None, 'devices': [], 'error': None})
        threading.Thread(target=self._run, args=(net,), daemon=True).start()
        return True, ''

    def cancel(self):
        self.cancel_flag = True

    def _run(self, net):
        try:
            self._scan(net)
        except Exception as e:
            self._set(error=str(e))
        finally:
            self._set(running=False, phase=None, finished=time.time())

    def _scan(self, net):
        hosts = [str(h) for h in (net.hosts() if net.prefixlen < 31 else net)]
        own = _own_macs()
        gateway = default_gateway()
        alive: dict[str, float | None] = {}

        def sweep(ip):
            if self.cancel_flag:
                return
            result = ping(ip)
            with self.lock:
                self.state['done'] += 1
            if result['alive']:
                alive[ip] = result['avg']

        with ThreadPoolExecutor(PING_WORKERS) as pool:
            list(pool.map(sweep, hosts))
        if self.cancel_flag:
            self._set(error='Cancelled')
            return

        # Devices that answered ARP but not ping still show up in the neighbour table.
        neigh = {ip: mac for ip, mac in neighbours().items() if ipaddress.ip_address(ip) in net}
        found = sorted(set(alive) | set(neigh) | {ip for ip in own if ipaddress.ip_address(ip) in net},
                       key=lambda ip: ipaddress.ip_address(ip))
        devices = {ip: {
            'ip': ip,
            'mac': neigh.get(ip) or own.get(ip),
            'ping': alive.get(ip),
            'responds_to_ping': ip in alive or ip in own,
            'is_self': ip in own,
            'is_gateway': ip == gateway,
            'name': None,
            'name_source': None,
            'vendor': None,
            'ports': [],
        } for ip in found}
        self._set(devices=list(devices.values()), phase='Looking up names', done=0, total=len(found))

        if own:
            for ip in own:
                if ip in devices:
                    devices[ip]['name'], devices[ip]['name_source'] = socket.gethostname(), 'this device'

        # Names: reverse DNS (often the router's DHCP names), then mDNS, then NetBIOS.
        targets = [ip for ip in found if not devices[ip]['name']]
        with ThreadPoolExecutor(32) as pool:
            for ip, name in zip(targets, pool.map(_reverse_dns, targets)):
                if name:
                    devices[ip]['name'], devices[ip]['name_source'] = name, 'DNS'
        for source, lookup in (('mDNS', _mdns_names), ('NetBIOS', _netbios_names)):
            missing = [ip for ip in found if not devices[ip]['name']]
            if not missing or self.cancel_flag:
                break
            for ip, name in lookup(missing).items():
                if ip in devices and not devices[ip]['name']:
                    devices[ip]['name'], devices[ip]['name_source'] = name, source
        self._set(devices=[dict(d) for d in devices.values()], phase='Checking common ports')

        # Every (host, port) pair in parallel: filtered ports cost a full timeout each.
        pairs = [(ip, port) for ip in found for port in PORTS]

        def probe(pair):
            ip, port = pair
            if not self.cancel_flag and _port_open(ip, port):
                with self.lock:
                    devices[ip]['ports'].append({'port': port, 'service': PORTS[port]})
            with self.lock:
                self.state['done'] += 1

        self._set(done=0, total=len(pairs))
        with ThreadPoolExecutor(128) as pool:
            list(pool.map(probe, pairs))
        for device in devices.values():
            device['ports'].sort(key=lambda p: p['port'])

        self._set(phase='Looking up vendors')
        table = vendor_db()
        for device in devices.values():
            device['vendor'] = mac_vendor(device['mac'], table)
        self._set(devices=[dict(d) for d in devices.values()], vendors=bool(table))
        # Keep the last known IP of devices the user has named.
        note_devices_seen({d['mac']: d['ip'] for d in devices.values() if d['mac']}, time.time())


scan = Scan()


def ping_many(ips: list[str], count: int = 4) -> list[dict]:
    with ThreadPoolExecutor(min(32, max(1, len(ips)))) as pool:
        return list(pool.map(lambda ip: ping(ip, count), ips))


__all__ = ['scan', 'local_subnets', 'ping', 'ping_many']
