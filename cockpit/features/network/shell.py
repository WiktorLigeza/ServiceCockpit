"""Thin wrappers around the command-line tools the network feature drives.

Every call has a timeout (nmcli / wpa_cli can hang when their daemon is
stuck) and returns plain data instead of raising, so callers can show the
tool's own error text to the user.
"""

from __future__ import annotations

import json
import shutil
import subprocess

from cockpit.core.auth import run_sudo

WPA_RUN_DIR = '/run/wpa_supplicant'


def read_text(path: str) -> str:
    try:
        with open(path, 'r') as f:
            return f.read().strip()
    except Exception:
        return ''


def run(args: list[str], timeout: float = 8.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return False, f'{args[0]} timed out'
    except FileNotFoundError:
        return False, f'{args[0]} is not installed'
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def run_out(args: list[str], timeout: float = 8.0) -> str:
    """stdout only (stderr noise like ethtool's netlink warnings dropped)."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL).stdout
    except Exception:
        return ''


def run_json(args: list[str], timeout: float = 8.0):
    out = run_out(args, timeout)
    try:
        return json.loads(out) if out.strip() else None
    except ValueError:
        return None


def sudo(args: list[str], password: str, timeout: float = 30.0, input_text: str | None = None) -> tuple[bool, str]:
    try:
        proc = run_sudo(args, password, input_text=input_text, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f'{" ".join(args[:3])} timed out'
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def sudo_all(commands: list[list[str]], password: str, timeout: float = 30.0) -> tuple[bool, str]:
    outputs = []
    for cmd in commands:
        ok, out = sudo(cmd, password, timeout)
        if out:
            outputs.append(out)
        if not ok:
            return False, '\n'.join(outputs) or f'{" ".join(cmd)} failed'
    return True, '\n'.join(outputs)


def split_terse(line: str) -> list[str]:
    """Split one line of `nmcli -t` output (':' separated, '\\:' escaped)."""
    fields, cur, i = [], [], 0
    while i < len(line):
        c = line[i]
        if c == '\\' and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ':':
            fields.append(''.join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    fields.append(''.join(cur))
    return fields


def nmcli_rows(args: list[str], fields: list[str], timeout: float = 8.0) -> list[dict]:
    out = run_out(['nmcli', '-t', '-f', ','.join(fields), *args], timeout)
    rows = []
    for line in out.splitlines():
        if not line:
            continue
        values = split_terse(line)
        if len(values) == len(fields):
            rows.append(dict(zip(fields, values)))
    return rows


def wpa_cli(iface: str, *args: str, timeout: float = 6.0) -> tuple[bool, str]:
    ok, out = run(['wpa_cli', '-i', iface, *args], timeout)
    failed = (not ok or out.startswith('FAIL') or out.startswith('UNKNOWN COMMAND')
              or 'Failed to connect' in out)
    return not failed, out


def kv_lines(text: str, sep: str = '=') -> dict:
    result = {}
    for line in text.splitlines():
        if sep in line:
            key, value = line.split(sep, 1)
            result[key.strip()] = value.strip()
    return result


def unit_active(unit: str) -> bool:
    ok, out = run(['systemctl', 'is-active', unit], 4)
    return out.strip() == 'active'


def nm_running() -> bool:
    return shutil.which('nmcli') is not None and unit_active('NetworkManager')
