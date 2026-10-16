"""Detects platform characteristics that change how stats are gathered:
NVIDIA Jetson boards report GPU/network info differently than a regular
Linux box, and Tailscale (if installed) exposes its own IP/status.
"""

import functools
import json
import os
import re
import shutil
import subprocess


def _read_file(path: str) -> str:
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read().strip('\x00\n \t')
    except Exception:
        return ''


@functools.lru_cache(maxsize=1)
def get_jetson_info() -> dict:
    model = _read_file('/proc/device-tree/model')
    release = _read_file('/etc/nv_tegra_release')
    is_jetson = 'jetson' in model.lower() or bool(release)

    l4t_version = None
    if release:
        match = re.search(r'R(\d+) \(release\), REVISION: ([\d.]+)', release)
        if match:
            l4t_version = f'R{match.group(1)}.{match.group(2)}'

    return {
        'is_jetson': is_jetson,
        'model': model or None,
        'l4t_version': l4t_version,
    }


@functools.lru_cache(maxsize=1)
def _tailscale_binary() -> str | None:
    return shutil.which('tailscale')


@functools.lru_cache(maxsize=1)
def _tailscale_version() -> str | None:
    binary = _tailscale_binary()
    if not binary:
        return None
    try:
        result = subprocess.run([binary, 'version'], capture_output=True, text=True, timeout=3)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split('\n')[0]
    except Exception:
        pass
    return None


def get_tailscale_info() -> dict:
    binary = _tailscale_binary()
    if not binary:
        return {'installed': False}

    info = {
        'installed': True,
        'version': _tailscale_version(),
        'active': False,
        'backend_state': None,
        'ip': None,
        'hostname': None,
    }

    try:
        result = subprocess.run([binary, 'status', '--json'], capture_output=True, text=True, timeout=3)
        data = json.loads(result.stdout)
        backend_state = data.get('BackendState')
        info['backend_state'] = backend_state
        info['active'] = backend_state == 'Running'

        self_node = data.get('Self') or {}
        ips = self_node.get('TailscaleIPs') or []
        info['ip'] = ips[0] if ips else None
        dns_name = (self_node.get('DNSName') or '').rstrip('.')
        info['hostname'] = dns_name or self_node.get('HostName')
    except Exception:
        pass

    return info


def get_platform_info() -> dict:
    return {
        'jetson': get_jetson_info(),
        'tailscale': get_tailscale_info(),
    }


__all__ = ['get_jetson_info', 'get_tailscale_info', 'get_platform_info']
