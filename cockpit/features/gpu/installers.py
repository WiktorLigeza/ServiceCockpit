"""Installing / removing the NVIDIA driver the way each distro family expects.

  ubuntu    Ubuntu, Mint, Pop!_OS, ... (`ubuntu-drivers` present): picks from
            the drivers ubuntu-drivers offers; uses signed, prebuilt kernel
            modules when the archive has them (no DKMS, works with Secure Boot)
  debian    Debian: nvidia-driver + (open-)kernel-dkms from contrib/non-free,
            enabling those components if needed
  fedora    Fedora (and spins): RPM Fusion akmod-nvidia, enabling RPM Fusion
  rhel      RHEL / Rocky / Alma / CentOS Stream: NVIDIA's CUDA repo + EPEL
  arch      Arch / EndeavourOS: nvidia-open-dkms + headers for each kernel
  manjaro   Manjaro: mhwd picks the right driver
  opensuse  openSUSE Tumbleweed / Leap: NVIDIA's repo + install-new-recommends

Every plan is a list of options; each option's install steps run as one
BackgroundJob through sudo. After any install the nouveau driver is
blacklisted (most driver packages do that themselves) and a reboot finishes
the switch.
"""

from __future__ import annotations

import glob
import os
import platform
import re
import shutil
import subprocess
import time
import urllib.request

from cockpit.core.jobs import NONINTERACTIVE, BackgroundJob
from cockpit.features.gpu.detect import nouveau_blacklisted, secure_boot

BLACKLIST_FILE = '/etc/modprobe.d/cockpit-blacklist-nouveau.conf'
MANUAL_URL = 'https://www.nvidia.com/en-us/drivers/'
_APT_OPTS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']
# Packages from the NVIDIA family that are not the display/compute driver itself.
_KEEP = re.compile(r'container|docker|firmware|cuda-toolkit|^cuda-[a-z]')


def _run(args: list[str], timeout: float = 30) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except Exception as e:
        return False, str(e)
    return proc.returncode == 0, proc.stdout


def os_release() -> dict:
    info = {}
    try:
        with open('/etc/os-release') as f:
            for line in f:
                if '=' in line:
                    key, _, value = line.strip().partition('=')
                    info[key] = value.strip('"\'')
    except OSError:
        pass
    return info


def detect_method() -> tuple[str | None, dict]:
    osr = os_release()
    ids = {osr.get('ID', '').lower(), *osr.get('ID_LIKE', '').lower().split()}
    if shutil.which('ubuntu-drivers'):
        return 'ubuntu', osr
    if shutil.which('apt-get') and 'debian' in ids:
        return 'debian', osr
    if shutil.which('mhwd'):
        return 'manjaro', osr
    if shutil.which('pacman') and ids & {'arch', 'archlinux', 'endeavouros', 'manjaro'}:
        return 'arch', osr
    if shutil.which('zypper') and any('opensuse' in i or 'suse' in i for i in ids):
        return 'opensuse', osr
    if shutil.which('dnf') and 'fedora' in ids and not ids & {'rhel', 'centos'}:
        return 'fedora', osr
    if shutil.which('dnf') and ids & {'rhel', 'centos', 'rocky', 'almalinux'}:
        return 'rhel', osr
    return None, osr


METHOD_LABELS = {
    'ubuntu': 'Ubuntu driver manager (ubuntu-drivers)',
    'debian': 'Debian packages (contrib / non-free)',
    'fedora': 'RPM Fusion (akmod-nvidia)',
    'rhel': "NVIDIA's official CUDA repository (+ EPEL)",
    'arch': 'Arch packages (nvidia-open-dkms)',
    'manjaro': 'Manjaro hardware detection (mhwd)',
    'opensuse': "NVIDIA's openSUSE repository",
}


# ---------------------------------------------------------------- plan

_ubuntu_cache: dict = {}


def _ubuntu_drivers(force: bool = False) -> tuple[list[str], str | None]:
    """(driver packages, recommended) from `ubuntu-drivers devices`, cached for 10 minutes.

    Lines look like `driver   : nvidia-driver-595-open - distro non-free recommended`.
    """
    if not force and _ubuntu_cache and time.time() - _ubuntu_cache['at'] < 600:
        return _ubuntu_cache['list'], _ubuntu_cache['recommended']
    _, out = _run(['ubuntu-drivers', 'devices'], 90)
    packages, recommended = [], None
    for line in out.splitlines():
        match = re.match(r'\s*driver\s*:\s*(nvidia-driver-\d+(?:-server)?(?:-open)?)\b(.*)', line)
        if not match:
            continue
        name = match.group(1)
        if name not in packages:
            packages.append(name)
        if 'recommended' in match.group(2):
            recommended = name
    _ubuntu_cache.update({'at': time.time(), 'list': packages, 'recommended': recommended})
    return packages, recommended


def _apt_candidate(package: str) -> str | None:
    ok, out = _run(['apt-cache', 'policy', package], 20)
    match = re.search(r'Candidate:\s*(\S+)', out) if ok else None
    return match.group(1) if match and match.group(1) != '(none)' else None


def _flavour_needs(gpus: list[dict]) -> tuple[bool, bool]:
    """(open modules required, open modules possible) for all the GPUs."""
    need = any(g.get('open') == 'required' for g in gpus)
    can = all(g.get('open') != 'unsupported' for g in gpus)
    return need, can


def _option(option_id: str, title: str, text: str, recommended: bool = False) -> dict:
    return {'id': option_id, 'title': title, 'text': text, 'recommended': recommended}


def _ubuntu_options(gpus: list[dict], force: bool) -> tuple[list[dict], list[str]]:
    need_open, can_open = _flavour_needs(gpus)
    packages, recommended = _ubuntu_drivers(force)
    options = []
    for pkg in packages:
        match = re.fullmatch(r'nvidia-driver-(\d+)(-server)?(-open)?', pkg)
        version, server, is_open = match.group(1), bool(match.group(2)), bool(match.group(3))
        if (need_open and not is_open) or (is_open and not can_open):
            continue
        title = f'NVIDIA {version}' + (' server' if server else '') + (' (open kernel modules)' if is_open else ' (proprietary)')
        text = ('Headless / compute flavour: long-term support branch, no desktop extras.' if server
                else 'Desktop driver: display, CUDA, Vulkan, video decode.')
        options.append(_option(pkg, title, text, pkg == recommended))
    options.sort(key=lambda o: (not o['recommended'], -int(re.search(r'\d+', o['id']).group()), 'server' in o['id']))
    notes = []
    if not options:
        options.append(_option('auto', 'Let ubuntu-drivers choose',
                               'Refreshes the package lists and installs the recommended driver.', True))
        notes.append('ubuntu-drivers did not list any NVIDIA driver yet - the package lists may be out of date.')
    return options, notes


def install_plan(gpus: list[dict], force: bool = False) -> dict:
    method, osr = detect_method()
    need_open, can_open = _flavour_needs(gpus)
    plan = {
        'method': method,
        'method_label': METHOD_LABELS.get(method),
        'distro': osr.get('PRETTY_NAME') or osr.get('NAME') or platform.system(),
        'supported': method is not None,
        'options': [],
        'notes': [],
        'warnings': [],
        'manual_url': MANUAL_URL,
        'secure_boot': secure_boot(),
    }
    if any(g.get('legacy') for g in gpus):
        plan['warnings'].append('This GPU is older than Maxwell - current drivers no longer support it. '
                                'Use your distro\'s legacy driver (e.g. 470 series) or stay on nouveau.')

    if method == 'ubuntu':
        plan['options'], plan['notes'] = _ubuntu_options(gpus, force)

    elif method == 'debian':
        has_driver = _apt_candidate('nvidia-driver')
        if not has_driver:
            plan['notes'].append('The contrib, non-free and non-free-firmware components will be enabled in your apt sources.')
        open_ok = can_open and (not has_driver or _apt_candidate('nvidia-open-kernel-dkms'))
        if open_ok:
            plan['options'].append(_option('open', 'NVIDIA (open kernel modules)',
                                           f'nvidia-open-kernel-dkms + nvidia-driver {has_driver or ""}'.strip(), True))
        if not need_open:
            plan['options'].append(_option('proprietary', 'NVIDIA (proprietary kernel module)',
                                           'nvidia-kernel-dkms + nvidia-driver', not open_ok))
        major = re.search(r'(\d+)\.', has_driver or '')
        if need_open and major and int(major.group(1)) < 570:
            plan['warnings'].append(f'Debian ships driver {has_driver}, which is too old for this GPU (needs 570+). '
                                    'Use backports or NVIDIA\'s CUDA repository for Debian.')

    elif method == 'fedora':
        plan['options'].append(_option('akmod', 'NVIDIA from RPM Fusion',
                                       'akmod-nvidia + CUDA libraries. The kernel module is built for each new kernel automatically.', True))
        if not glob.glob('/etc/yum.repos.d/rpmfusion-nonfree*.repo'):
            plan['notes'].append('RPM Fusion (free + nonfree) will be enabled first.')
        plan['notes'].append('Building the kernel module takes a few minutes.')

    elif method == 'rhel':
        if can_open:
            plan['options'].append(_option('open', 'NVIDIA (open kernel modules)', 'nvidia-open from NVIDIA\'s CUDA repository.', True))
        if not need_open:
            plan['options'].append(_option('proprietary', 'NVIDIA (proprietary kernel module)', 'cuda-drivers from NVIDIA\'s CUDA repository.', not can_open))
        plan['notes'].append('EPEL and NVIDIA\'s CUDA repository will be added (needed for DKMS).')
        if osr.get('ID') == 'rhel':
            plan['notes'].append('On RHEL the CodeReady Builder repository must be enabled for EPEL.')

    elif method == 'arch':
        if can_open:
            plan['options'].append(_option('open', 'NVIDIA (open kernel modules)',
                                           'nvidia-open-dkms + nvidia-utils + headers for each installed kernel.', True))
        else:
            plan['supported'] = False
            plan['warnings'].append('Arch only packages the open-module driver (Turing and newer). For this GPU use '
                                    'the nvidia-580xx-dkms package from the AUR.')

    elif method == 'manjaro':
        plan['options'].append(_option('mhwd', 'Proprietary NVIDIA driver (mhwd)',
                                       'Manjaro picks the right driver for this GPU (mhwd -a pci nonfree 0300).', True))

    elif method == 'opensuse':
        plan['options'].append(_option('auto', 'NVIDIA from NVIDIA\'s openSUSE repository',
                                       'zypper picks the right driver for this GPU (install-new-recommends).', True))

    else:
        plan['warnings'].append('Automatic installation is not supported on this distribution. '
                                'Install the driver with your package manager or from nvidia.com.')

    if plan['secure_boot'] and method != 'ubuntu':
        plan['warnings'].append('Secure Boot is on: the driver module is built locally and must be signed with a key '
                                'you enroll at the next boot (MOK), or Secure Boot must be turned off - otherwise it will not load.')
    elif plan['secure_boot']:
        plan['notes'].append('Secure Boot is on - Ubuntu uses signed prebuilt modules when they exist for your kernel.')
    if not plan['options']:
        plan['supported'] = False
    return plan


# ---------------------------------------------------------------- install steps

def _uname() -> str:
    return platform.release()


def _installed_packages(method: str) -> list[str]:
    if method in ('ubuntu', 'debian'):
        ok, out = _run(['dpkg-query', '-W', '-f=${Package} ${db:Status-Abbrev}\n'])
        names = [l.split()[0] for l in out.splitlines() if l.split()[1:2] == ['ii']] if ok else []
        pattern = r'^(nvidia-|libnvidia-|linux-modules-nvidia-|linux-objects-nvidia-|linux-signatures-nvidia-|xserver-xorg-video-nvidia)'
    elif method in ('arch', 'manjaro'):
        ok, out = _run(['pacman', '-Qq'])
        names = out.split() if ok else []
        pattern = r'^(nvidia|lib32-nvidia|opencl-nvidia)'
    else:
        ok, out = _run(['rpm', '-qa', '--qf', '%{NAME}\n'])
        names = out.split() if ok else []
        pattern = r'(^|-)nvidia|^cuda-drivers'
    return sorted({n for n in names if re.search(pattern, n) and not _KEEP.search(n)})


def _rebuild_initramfs(job: BackgroundJob, password: str) -> None:
    if shutil.which('update-initramfs'):
        job.stream(['update-initramfs', '-u'], password, 600, echo=True)
    elif shutil.which('mkinitcpio'):
        job.stream(['mkinitcpio', '-P'], password, 600, echo=True)
    elif shutil.which('dracut'):
        job.stream(['dracut', '-f', '--regenerate-all'], password, 900, echo=True)


def _blacklist_nouveau(job: BackgroundJob, password: str) -> None:
    if nouveau_blacklisted():
        job.log('nouveau is blacklisted by the driver packages.')
        return
    job.log(f'Blacklisting nouveau in {BLACKLIST_FILE}')
    text = ('# Written by ServiceCockpit (GPU page): use the NVIDIA driver instead of nouveau.\n'
            'blacklist nouveau\noptions nouveau modeset=0\n')
    if job.stream(['sh', '-c', 'cat > "$0"', BLACKLIST_FILE], password, 20, input_text=text):
        _rebuild_initramfs(job, password)


def _install_ubuntu(job, password, option):
    apt = NONINTERACTIVE
    if not job.stream(['apt-get', 'update'], password, 600, env=apt, echo=True):
        return False
    if option == 'auto':
        cmd = ['ubuntu-drivers', 'install']
    else:
        match = re.fullmatch(r'nvidia-driver-(\d+(?:-server)?(?:-open)?)', option)
        cmd = ['ubuntu-drivers', 'install', *(['--gpgpu'] if '-server' in option else []), f'nvidia:{match.group(1)}']
    return job.stream(cmd, password, 1800, env=apt, echo=True)


_DEBIAN_SED_DEB822 = (r'/^Components:/ { / contrib( |$)/! s/$/ contrib/; / non-free( |$)/! s/$/ non-free/; '
                      r'/ non-free-firmware( |$)/! s/$/ non-free-firmware/ }')
_DEBIAN_SED_LIST = (r'/^deb(-src)? .*debian/ { / contrib( |$)/! s/$/ contrib/; / non-free( |$)/! s/$/ non-free/; '
                    r'/ non-free-firmware( |$)/! s/$/ non-free-firmware/ }')


def _install_debian(job, password, option):
    apt = NONINTERACTIVE
    if not _apt_candidate('nvidia-driver'):
        job.log('Enabling the contrib, non-free and non-free-firmware components…')
        for path in glob.glob('/etc/apt/sources.list.d/*.sources'):
            job.stream(['sed', '-i', '-E', _DEBIAN_SED_DEB822, path], password, 20, echo=True)
        if os.path.exists('/etc/apt/sources.list'):
            job.stream(['sed', '-i', '-E', _DEBIAN_SED_LIST, '/etc/apt/sources.list'], password, 20, echo=True)
    if not job.stream(['apt-get', 'update'], password, 600, env=apt, echo=True):
        return False
    if not _apt_candidate('nvidia-driver'):
        job.log('nvidia-driver is still not available - check /etc/apt/sources.list(.d).')
        return False
    headers = f'linux-headers-{_uname()}'
    if not _apt_candidate(headers):
        arch = _run(['dpkg', '--print-architecture'])[1].strip() or 'amd64'
        headers = f'linux-headers-{arch}'
    kernel = 'nvidia-open-kernel-dkms' if option == 'open' else 'nvidia-kernel-dkms'
    pkgs = [headers, kernel, 'nvidia-driver', 'firmware-misc-nonfree']
    if _apt_candidate('firmware-nvidia-gsp'):
        pkgs.append('firmware-nvidia-gsp')
    return job.stream(['apt-get', 'install', '-y', *_APT_OPTS, *pkgs], password, 1800, env=apt, echo=True)


def _install_fedora(job, password, option):
    if not glob.glob('/etc/yum.repos.d/rpmfusion-nonfree*.repo'):
        release = _run(['rpm', '-E', '%fedora'])[1].strip()
        if not release.isdigit():
            job.log('Could not tell the Fedora release.')
            return False
        job.log('Enabling RPM Fusion…')
        urls = [f'https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-{release}.noarch.rpm',
                f'https://mirrors.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-{release}.noarch.rpm']
        if not job.stream(['dnf', 'install', '-y', *urls], password, 600, echo=True):
            return False
    if not job.stream(['dnf', 'install', '-y', 'akmod-nvidia', 'xorg-x11-drv-nvidia-cuda'], password, 1800, echo=True):
        return False
    job.log('Building the kernel module (this takes a few minutes)…')
    job.stream(['akmods', '--force', '--kernels', _uname()], password, 1800, echo=True)
    return True


def _install_rhel(job, password, option):
    osr = os_release()
    major = (osr.get('VERSION_ID') or '').split('.')[0]
    if not major.isdigit():
        job.log('Could not tell the RHEL major version.')
        return False
    arch = 'sbsa' if platform.machine() == 'aarch64' else platform.machine()
    if not glob.glob('/etc/yum.repos.d/epel*.repo'):
        epel = 'epel-release' if osr.get('ID') != 'rhel' else \
            f'https://dl.fedoraproject.org/pub/epel/epel-release-latest-{major}.noarch.rpm'
        if not job.stream(['dnf', 'install', '-y', epel], password, 600, echo=True):
            return False
    repo = f'https://developer.download.nvidia.com/compute/cuda/repos/rhel{major}/{arch}/cuda-rhel{major}.repo'
    if not glob.glob('/etc/yum.repos.d/cuda*.repo'):
        job.log(f'Adding {repo}')
        try:   # minimal installs may not have curl
            with urllib.request.urlopen(repo, timeout=30) as resp:
                text = resp.read().decode()
        except Exception as e:
            job.log(f'Could not download the repository file: {e}')
            return False
        if not job.stream(['sh', '-c', 'cat > "$0"', f'/etc/yum.repos.d/cuda-rhel{major}.repo'], password, 20,
                          input_text=text):
            return False
    job.stream(['dnf', 'install', '-y', f'kernel-devel-{_uname()}', 'kernel-headers'], password, 900, echo=True)
    package = 'nvidia-open' if option == 'open' else 'cuda-drivers'
    return job.stream(['dnf', 'install', '-y', package], password, 1800, echo=True)


def _install_arch(job, password, option):
    ok, out = _run(['pacman', '-Qq'])
    installed = set(out.split()) if ok else set()
    kernels = [k for k in ('linux', 'linux-lts', 'linux-zen', 'linux-hardened', 'linux-rt', 'linux-rt-lts')
               if k in installed]
    headers = [f'{k}-headers' for k in kernels] or ['linux-headers']
    return job.stream(['pacman', '-Syu', '--noconfirm', '--needed', *headers, 'nvidia-open-dkms', 'nvidia-utils'],
                      password, 1800, echo=True)


def _install_manjaro(job, password, option):
    return job.stream(['mhwd', '-a', 'pci', 'nonfree', '0300'], password, 1800, echo=True)


def _install_opensuse(job, password, option):
    osr = os_release()
    osid = osr.get('ID', '')
    if 'leap' in osid:
        url = f'https://download.nvidia.com/opensuse/leap/{osr.get("VERSION_ID", "")}'
    else:
        url = 'https://download.nvidia.com/opensuse/tumbleweed'
    have_repo = any('download.nvidia.com' in open(p, errors='ignore').read()
                    for p in glob.glob('/etc/zypp/repos.d/*.repo'))
    if not have_repo:
        if not job.stream(['zypper', '--non-interactive', 'addrepo', '--refresh', url, 'NVIDIA'], password, 120, echo=True):
            return False
    if not job.stream(['zypper', '--non-interactive', '--gpg-auto-import-keys', 'refresh'], password, 600, echo=True):
        return False
    return job.stream(['zypper', '--non-interactive', 'install-new-recommends', '--repo', 'NVIDIA'], password, 1800, echo=True)


_INSTALLERS = {
    'ubuntu': _install_ubuntu, 'debian': _install_debian, 'fedora': _install_fedora, 'rhel': _install_rhel,
    'arch': _install_arch, 'manjaro': _install_manjaro, 'opensuse': _install_opensuse,
}


def run_install(job: BackgroundJob, password: str, method: str, option: str) -> bool:
    job.log(f'Installing the NVIDIA driver via {METHOD_LABELS[method]} ({option})')
    if not _INSTALLERS[method](job, password, option):
        job.log('The driver installation failed - see the log above.')
        return False
    _blacklist_nouveau(job, password)
    job.log('Done. Reboot to start using the NVIDIA driver.')
    return True


def run_remove(job: BackgroundJob, password: str, method: str) -> bool:
    packages = _installed_packages(method)
    if not packages:
        job.log('No NVIDIA driver packages found.')
    else:
        job.log(f'Removing: {" ".join(packages)}')
        if method in ('ubuntu', 'debian'):
            ok = job.stream(['apt-get', 'purge', '-y', *packages], password, 1200, env=NONINTERACTIVE, echo=True)
            if ok:
                job.stream(['apt-get', 'autoremove', '-y'], password, 900, env=NONINTERACTIVE, echo=True)
        elif method in ('arch', 'manjaro'):
            ok = job.stream(['pacman', '-Rns', '--noconfirm', *packages], password, 1200, echo=True)
        elif method == 'opensuse':
            ok = job.stream(['zypper', '--non-interactive', 'remove', '--clean-deps', *packages], password, 1200, echo=True)
        else:
            ok = job.stream(['dnf', 'remove', '-y', *packages], password, 1200, echo=True)
        if not ok:
            return False
    if os.path.exists(BLACKLIST_FILE):
        job.stream(['rm', '-f', BLACKLIST_FILE], password, 20, echo=True)
    _rebuild_initramfs(job, password)
    job.log('Done. Reboot to go back to the open-source nouveau driver.')
    return True


__all__ = ['detect_method', 'install_plan', 'os_release', 'run_install', 'run_remove']
