"""NVIDIA GPU detection and live stats for the GPU page.

Detection reads sysfs only (no root, no `lspci` needed), so it is cheap enough
for the sidebar on every page load. Driver state is pieced together from what
any distro leaves behind, regardless of how the driver was installed:

  /sys/module/nvidia/version        kernel module loaded (and its version)
  /proc/driver/nvidia/version       "Open Kernel Module" for the open flavour
  libnvidia-ml.so.<version>         userspace driver installed (and its version)
  /sys/bus/pci/devices/*/driver     which driver each GPU is bound to (nouveau?)

Jetson boards are left alone - JetPack manages their GPU.
"""

from __future__ import annotations

import functools
import glob
import os
import re
import shutil
import subprocess
import time

from cockpit.core.platform_info import get_jetson_info

NVIDIA_VENDOR = '0x10de'
PCI_ROOT = '/sys/bus/pci/devices'
LIB_DIRS = ('/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib',
            '/usr/lib/nvidia', '/usr/local/lib')
EFI_SECURE_BOOT = '/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c'
MODPROBE_DIRS = ('/etc/modprobe.d', '/usr/lib/modprobe.d', '/lib/modprobe.d', '/run/modprobe.d')


def _read(path: str) -> str:
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read().strip()
    except OSError:
        return ''


# ---------------------------------------------------------------- hardware

def generation(device_id: int) -> dict:
    """Rough GPU family from the PCI device id - enough to pick the right driver flavour.

    NVIDIA hands out device ids roughly in order: Turing starts at 0x1e00 and is
    the first family the open kernel modules support; Blackwell (0x2b00+) works
    with the open modules only. Below Maxwell (0x1340) needs a legacy driver.
    """
    if device_id >= 0x2b00:
        return {'family': 'Blackwell or newer', 'open': 'required'}
    if device_id >= 0x2680:
        return {'family': 'Ada Lovelace / Hopper', 'open': 'recommended'}
    if device_id >= 0x2080:
        return {'family': 'Ampere', 'open': 'recommended'}
    if device_id >= 0x1e00:
        return {'family': 'Turing', 'open': 'recommended'}
    if device_id >= 0x1340:
        return {'family': 'Maxwell / Pascal / Volta', 'open': 'unsupported'}
    return {'family': 'Kepler or older', 'open': 'unsupported', 'legacy': True}


@functools.lru_cache(maxsize=1)
def _pci_names() -> dict[str, str]:
    """PCI address -> name from lspci, when installed (pci.ids may not know new cards)."""
    if not shutil.which('lspci'):
        return {}
    try:
        out = subprocess.run(['lspci', '-mm', '-d', '10de:'], capture_output=True, text=True,
                             timeout=4, stdin=subprocess.DEVNULL).stdout
    except Exception:
        return {}
    names = {}
    for line in out.splitlines():
        parts = re.findall(r'"([^"]*)"', line)
        addr = line.split(' ', 1)[0]
        if len(parts) >= 3:
            names[addr] = parts[2]
    return names


def _pci_gpus() -> list[dict]:
    gpus = []
    for path in sorted(glob.glob(f'{PCI_ROOT}/*')):
        if _read(f'{path}/vendor') != NVIDIA_VENDOR:
            continue
        cls = _read(f'{path}/class')
        if not cls.startswith('0x03'):   # 0x03xxxx = display controller (skips the HDMI audio function)
            continue
        address = os.path.basename(path)
        device = _read(f'{path}/device')
        device_id = int(device, 16) if device else 0
        driver_link = f'{path}/driver'
        driver = os.path.basename(os.readlink(driver_link)) if os.path.islink(driver_link) else None
        short = address[5:] if address.startswith('0000:') else address
        lspci_name = _pci_names().get(short, '')
        # Unknown ids show up as "Device 2c33" - not worth displaying.
        if not lspci_name or re.fullmatch(r'Device [0-9a-f]{4}', lspci_name):
            lspci_name = ''
        gpus.append({
            'address': address,
            'device_id': f'10de:{device[2:]}' if device else '10de:????',
            'subsystem': f'{_read(f"{path}/subsystem_vendor")[2:]}:{_read(f"{path}/subsystem_device")[2:]}',
            'name': lspci_name or None,
            'driver': driver,
            'vga': cls.startswith('0x0300'),
            'boot_vga': _read(f'{path}/boot_vga') == '1',
            **generation(device_id),
        })
    return gpus


@functools.lru_cache(maxsize=1)
def _has_nvidia_pci() -> bool:
    for path in glob.glob(f'{PCI_ROOT}/*'):
        if _read(f'{path}/vendor') == NVIDIA_VENDOR and _read(f'{path}/class').startswith('0x03'):
            return True
    return False


def applicable() -> bool:
    """A discrete NVIDIA GPU on a regular Linux box (not a Jetson)."""
    return _has_nvidia_pci() and not get_jetson_info()['is_jetson']


# ---------------------------------------------------------------- driver state

def _module_version() -> str | None:
    return _read('/sys/module/nvidia/version') or None


def _module_flavour() -> str | None:
    text = _read('/proc/driver/nvidia/version')
    if not text:
        return None
    return 'open' if 'Open Kernel Module' in text else 'proprietary'


def userspace_version() -> str | None:
    """Version of the installed NVIDIA userspace driver (libnvidia-ml), if any."""
    best = None
    for directory in LIB_DIRS:
        for lib in glob.glob(f'{directory}/libnvidia-ml.so.*.*'):
            match = re.search(r'libnvidia-ml\.so\.(\d+\.\d+(?:\.\d+)?)$', lib)
            if match:
                version = match.group(1)
                if best is None or _vtuple(version) > _vtuple(best):
                    best = version
    return best


def _vtuple(version: str | None) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r'\d+', version or ''))


def nouveau_blacklisted() -> bool:
    for directory in MODPROBE_DIRS:
        for conf in glob.glob(f'{directory}/*.conf'):
            if re.search(r'^\s*blacklist\s+nouveau\b', _read(conf), re.M):
                return True
    return 'modprobe.blacklist=nouveau' in _read('/proc/cmdline') or 'rd.driver.blacklist=nouveau' in _read('/proc/cmdline')


def secure_boot() -> bool | None:
    try:
        with open(EFI_SECURE_BOOT, 'rb') as f:
            data = f.read()
        return bool(data) and data[-1] == 1
    except PermissionError:
        pass
    except OSError:
        return None if not os.path.isdir('/sys/firmware/efi') else False
    if shutil.which('mokutil'):
        try:
            out = subprocess.run(['mokutil', '--sb-state'], capture_output=True, text=True, timeout=4).stdout
            return 'enabled' in out.lower()
        except Exception:
            pass
    return None


def _reboot_required() -> bool:
    return os.path.exists('/var/run/reboot-required') or os.path.exists('/run/reboot-required')


def needs_setup() -> bool:
    """Cheap check for the sidebar: GPU present but no NVIDIA driver installed or loaded."""
    return applicable() and not _module_version() and not userspace_version()


def driver_state() -> dict:
    module = _module_version()
    userspace = userspace_version()
    gpus = _pci_gpus()
    nouveau_bound = any(g['driver'] == 'nouveau' for g in gpus)

    if module and userspace and module != userspace:
        state, reason = 'reboot', f'Driver {userspace} is installed but {module} is still loaded - reboot to switch.'
    elif module:
        state, reason = 'active', ''
    elif userspace:
        reason = 'The NVIDIA driver is installed but not loaded yet - reboot to start using it.'
        if nouveau_bound:
            reason = 'The NVIDIA driver is installed, but the GPU is still using nouveau - reboot to switch.'
        state = 'reboot'
    else:
        state, reason = 'none', ''

    return {
        'state': state,
        'reason': reason,
        'module_version': module,
        'module_flavour': _module_flavour(),
        'userspace_version': userspace,
        'nouveau_loaded': os.path.isdir('/sys/module/nouveau'),
        'nouveau_bound': nouveau_bound,
        'nouveau_blacklisted': nouveau_blacklisted(),
        'nvidia_smi': shutil.which('nvidia-smi'),
        'reboot_required': _reboot_required(),
        'gpus': gpus,
    }


# ---------------------------------------------------------------- live stats (nvidia-smi)

_GPU_FIELDS = (
    'index', 'name', 'pci.bus_id', 'uuid', 'driver_version', 'vbios_version',
    'temperature.gpu', 'utilization.gpu', 'utilization.memory',
    'memory.used', 'memory.total', 'power.draw', 'power.limit', 'power.max_limit',
    'fan.speed', 'clocks.gr', 'clocks.max.gr', 'clocks.mem', 'clocks.max.mem',
    'pstate', 'persistence_mode', 'pcie.link.gen.current', 'pcie.link.gen.max',
    'pcie.link.width.current', 'pcie.link.width.max', 'display_active', 'compute_mode',
)
_NUMERIC = {
    'temperature.gpu', 'utilization.gpu', 'utilization.memory', 'memory.used', 'memory.total',
    'power.draw', 'power.limit', 'power.max_limit', 'fan.speed', 'clocks.gr', 'clocks.max.gr',
    'clocks.mem', 'clocks.max.mem', 'pcie.link.gen.current', 'pcie.link.gen.max',
    'pcie.link.width.current', 'pcie.link.width.max',
}
_cuda_cache: dict = {}


def _smi(args: list[str], timeout: float = 6) -> tuple[bool, str]:
    binary = shutil.which('nvidia-smi')
    if not binary:
        return False, 'nvidia-smi is not installed'
    try:
        proc = subprocess.run([binary, *args], capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return False, 'nvidia-smi timed out'
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, (proc.stdout if proc.returncode == 0 else (proc.stdout + proc.stderr)).strip()


def _value(field: str, raw: str):
    raw = raw.strip()
    if not raw or raw.startswith('[') or raw in ('N/A', 'Not Supported'):
        return None
    if field in _NUMERIC:
        try:
            return float(raw)
        except ValueError:
            return None
    return raw


def _cuda_version(driver: str | None) -> str | None:
    if driver and _cuda_cache.get('driver') == driver:
        return _cuda_cache.get('cuda')
    ok, out = _smi([])
    match = re.search(r'CUDA Version:\s*([\d.]+)', out) if ok else None
    _cuda_cache.update({'driver': driver, 'cuda': match.group(1) if match else None})
    return _cuda_cache['cuda']


def live_stats() -> dict:
    ok, out = _smi(['--query-gpu=' + ','.join(_GPU_FIELDS), '--format=csv,noheader,nounits'])
    if not ok:
        return {'ok': False, 'error': out.splitlines()[0] if out else 'nvidia-smi failed', 'gpus': [], 'processes': []}

    gpus = []
    for line in out.splitlines():
        values = [v.strip() for v in line.split(',')]
        if len(values) != len(_GPU_FIELDS):
            continue
        gpus.append({field.replace('.', '_'): _value(field, raw) for field, raw in zip(_GPU_FIELDS, values)})

    processes = []
    ok, out = _smi(['--query-compute-apps=gpu_bus_id,pid,process_name,used_memory', '--format=csv,noheader,nounits'])
    if ok:
        for line in out.splitlines():
            parts = [p.strip() for p in line.split(',')]
            if len(parts) == 4 and parts[1].isdigit():
                processes.append({'bus_id': parts[0], 'pid': int(parts[1]), 'name': parts[2],
                                  'memory': _value('memory.used', parts[3]), 'type': 'compute'})

    driver = gpus[0]['driver_version'] if gpus else None
    return {'ok': True, 'gpus': gpus, 'processes': processes, 'cuda_version': _cuda_version(driver),
            'time': time.time()}


__all__ = ['applicable', 'driver_state', 'generation', 'live_stats', 'needs_setup', 'nouveau_blacklisted',
           'secure_boot', 'userspace_version']
