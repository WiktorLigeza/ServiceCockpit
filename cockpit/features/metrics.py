import fcntl
import re
import socket
import struct
import subprocess
from flask import Blueprint, jsonify
import psutil

from gpu_monitor import gpu_monitor
from platform_info import get_platform_info


def get_cpu_temp() -> float:
    try:
        with open('/sys/class/thermal/thermal_zone0/temp', 'r', encoding='utf-8') as f:
            temp = float(f.read()) / 1000.0
        return round(temp, 1)
    except Exception:
        return 0.0


def check_internet_connection() -> bool:
    try:
        socket.create_connection(('8.8.8.8', 53), timeout=3)
        return True
    except OSError:
        return False


def get_system_metrics() -> dict:
    cpu_temp = get_cpu_temp()

    # CPU percent: normalize overall to 0..100 by averaging per-core usage.
    cpu_per_core = psutil.cpu_percent(interval=0.1, percpu=True) or []
    cpu_percent = round(float(sum(cpu_per_core)) / float(len(cpu_per_core)), 1) if cpu_per_core else 0.0

    memory = psutil.virtual_memory()
    disk = psutil.disk_usage('/')
    has_internet = check_internet_connection()

    return {
        'cpu_temp': cpu_temp,
        'cpu_percent': cpu_percent,
        'cpu_percent_per_core': cpu_per_core,
        'memory_percent': memory.percent,
        'memory_used': round(memory.used / (1024 * 1024 * 1024), 2),
        'memory_free': round(memory.available / (1024 * 1024 * 1024), 2),
        'memory_total': round(memory.total / (1024 * 1024 * 1024), 2),
        'storage_percent': disk.percent,
        'storage_used': round(disk.used / (1024 * 1024 * 1024), 2),
        'storage_free': round(disk.free / (1024 * 1024 * 1024), 2),
        'storage_total': round(disk.total / (1024 * 1024 * 1024), 2),
        'has_internet': has_internet,
        'gpu': gpu_monitor.get_latest(),
    }


def _get_default_route_interface() -> str | None:
    """Ask the kernel which interface actually carries traffic right now.

    Jetson boards (and plenty of regular boxes) don't use the classic
    eth0/wlan0 naming - a Jetson reServer, for example, names its NIC
    something like enP8p1s0. Asking the routing table avoids guessing names.
    """
    try:
        result = subprocess.run(
            ['ip', 'route', 'show', 'default'],
            capture_output=True, text=True, timeout=2,
        )
        match = re.search(r'\bdev\s+(\S+)', result.stdout)
        if match:
            return match.group(1)
    except Exception:
        pass
    return None


def get_network_info() -> dict:
    ip_address = 'N/A'
    mac_address = 'N/A'

    default_iface = _get_default_route_interface()
    candidate_interfaces = [default_iface] if default_iface else []
    candidate_interfaces += ['wlan0', 'eth0', 'en0', 'enp0s3']

    for interface in candidate_interfaces:
        if not interface:
            continue
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            ip_address = socket.inet_ntoa(
                fcntl.ioctl(
                    s.fileno(),
                    0x8915,  # SIOCGIFADDR
                    struct.pack('256s', interface.encode('utf-8')[:15]),
                )[20:24]
            )
            break
        except Exception:
            pass

    for interface in candidate_interfaces:
        if not interface:
            continue
        try:
            with open(f'/sys/class/net/{interface}/address', 'r', encoding='utf-8') as f:
                mac_address = f.readline().strip()
            break
        except Exception:
            pass

    return {'ip_address': ip_address, 'mac_address': mac_address, 'interface': default_iface}


def build_metrics_blueprint() -> Blueprint:
    bp = Blueprint('metrics', __name__)

    @bp.route('/system_metrics')
    def system_metrics():
        return jsonify(get_system_metrics())

    @bp.route('/api/network_info')
    def network_info():
        return jsonify(get_network_info())

    @bp.route('/api/platform_info')
    def platform_info():
        return jsonify(get_platform_info())

    return bp


__all__ = ['build_metrics_blueprint', 'get_system_metrics']
