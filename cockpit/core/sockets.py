"""Open TCP/UDP sockets and the processes that own them (`ss -tuanp`).

Without root, `ss` only names the owning process for this user's own sockets,
so callers pass the session's sudo password to see every process. Results are
cached for a few seconds: both the Network "Ports" tab and the Processes page
poll this, and every sudo call is written to the auth log.
"""

from __future__ import annotations

import re
import subprocess
import threading
import time

from cockpit.core.auth import run_sudo

CACHE_SECONDS = 3.0
_PROC_RE = re.compile(r'\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=(\d+)\)')

_lock = threading.Lock()
_cache: dict = {'time': 0.0, 'privileged': None, 'sockets': []}


def _split_endpoint(text: str) -> tuple[str, str | None, int | None]:
    """'192.168.1.5%eth0:68' / '[::]:22' / '*:5353' -> (address, interface, port)."""
    if ':' not in text:
        return text, None, None
    addr, port = text.rsplit(':', 1)
    iface = None
    if '%' in addr:  # ss prints both '[fe80::1]%eth0' and '[fe80::1%eth0]'
        addr, iface = addr.split('%', 1)
        iface = iface.strip('[]')
    addr = addr.strip('[]')
    try:
        port_num = int(port)
    except ValueError:
        port_num = None
    return addr, iface, port_num


def parse_ss(output: str) -> list[dict]:
    sockets = []
    for line in output.splitlines():
        parts = line.split(None, 6)
        if len(parts) < 6:
            continue
        proto, state, _, _, local, peer = parts[:6]
        process_field = parts[6] if len(parts) > 6 else ''
        local_addr, iface, local_port = _split_endpoint(local)
        peer_addr, _, peer_port = _split_endpoint(peer)
        listening = state == 'LISTEN' or (proto == 'udp' and state == 'UNCONN' and peer_port is None)
        sockets.append({
            'proto': proto,
            'state': state,
            'listening': listening,
            'local_addr': local_addr,
            'local_port': local_port,
            'iface': iface,
            'peer_addr': None if peer_port is None else peer_addr,
            'peer_port': peer_port,
            'processes': [{'name': m.group(1), 'pid': int(m.group(2))}
                          for m in _PROC_RE.finditer(process_field)],
        })
    return sockets


def list_sockets(password: str | None = None) -> tuple[list[dict], bool]:
    """(sockets, privileged). `privileged` is False when owners of other users'
    sockets could not be resolved (no sudo password, or sudo failed)."""
    with _lock:
        if time.time() - _cache['time'] < CACHE_SECONDS and (_cache['privileged'] or not password):
            return _cache['sockets'], _cache['privileged']

    out, privileged = '', False
    if password:
        try:
            proc = run_sudo(['ss', '-H', '-tuanp'], password, check=False, timeout=10)
            if proc.returncode == 0:
                out, privileged = proc.stdout, True
        except Exception:
            pass
    if not privileged:
        try:
            out = subprocess.run(['ss', '-H', '-tuanp'], capture_output=True, text=True, timeout=10,
                                 stdin=subprocess.DEVNULL).stdout
        except Exception:
            out = ''

    sockets = parse_ss(out)
    with _lock:
        _cache.update({'time': time.time(), 'privileged': privileged, 'sockets': sockets})
    return sockets, privileged


def sockets_for_pid(pid: int, password: str | None = None) -> tuple[list[dict], bool]:
    sockets, privileged = list_sockets(password)
    return [s for s in sockets if any(p['pid'] == pid for p in s['processes'])], privileged


__all__ = ['list_sockets', 'parse_ss', 'sockets_for_pid']
