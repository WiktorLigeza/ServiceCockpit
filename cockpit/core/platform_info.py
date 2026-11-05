"""Detects platform characteristics that change how stats are gathered:
NVIDIA Jetson boards report GPU/network info differently than a regular
Linux box. (Tailscale state lives in cockpit.features.tailscale.)
"""

import functools
import re


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


def get_platform_info() -> dict:
    return {
        'jetson': get_jetson_info(),
    }


__all__ = ['get_jetson_info', 'get_platform_info']
