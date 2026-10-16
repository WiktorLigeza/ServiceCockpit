"""Bluetooth page.

controller   adapter, scanning, pairing agent, device actions (bluetoothctl)
services     what to do with a device: audio, file transfer, internet, serial
dbus_helper  standalone script run with the *system* python (needs python3-dbus
             and python3-gi); hosts the serial profile and the OBEX agent
"""

from .controller import bluetooth_cleanup_on_shutdown, build_bluetooth_blueprint, register_bluetooth_socket_handlers
from .services import (
    bluetooth_services_cleanup, build_bluetooth_services_blueprint, register_bluetooth_services_socket_handlers,
)

__all__ = [
    'build_bluetooth_blueprint', 'register_bluetooth_socket_handlers', 'bluetooth_cleanup_on_shutdown',
    'build_bluetooth_services_blueprint', 'register_bluetooth_services_socket_handlers', 'bluetooth_services_cleanup',
]
