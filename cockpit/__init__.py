"""ServiceCockpit - a web cockpit for managing a Linux device (Raspberry Pi, Jetson, ...).

Package layout
--------------
paths      project-root based file locations
core/      shared infrastructure: login + sudo, settings, systemd, platform, GPU
features/  one module (or sub-package) per page / API

`create_app()` wires every feature's Flask blueprint and Socket.IO handlers
into one app; `app.py` at the repository root runs it.
"""

from __future__ import annotations

import threading

from flask import Flask
from flask_session import Session
from flask_socketio import SocketIO

from cockpit.core.auth import build_auth_blueprint, configure_session
from cockpit.core.systemd import SystemdManager
from cockpit.features.bluetooth import (
    bluetooth_cleanup_on_shutdown, bluetooth_services_cleanup, build_bluetooth_blueprint,
    build_bluetooth_services_blueprint, register_bluetooth_services_socket_handlers,
    register_bluetooth_socket_handlers,
)
from cockpit.features.console import build_console_blueprint, register_console_socket_handlers
from cockpit.features.export import build_export_blueprint
from cockpit.features.file_explorer import build_file_explorer_blueprint, register_file_exec_socket_handlers
from cockpit.features.metrics import build_metrics_blueprint, get_system_metrics
from cockpit.features.mqtt import build_mqtt_blueprint, mqtt_cleanup_on_shutdown, register_mqtt_socket_handlers
from cockpit.features.network import build_network_blueprint, build_network_p2p_blueprint
from cockpit.features.processes import build_processes_blueprint
from cockpit.features.services import (
    build_services_blueprint, init_services_socketio, register_services_socket_handlers,
)
from cockpit.features.updates import build_update_check_blueprint
from cockpit.paths import STATIC_DIR, TEMPLATE_DIR

__all__ = ['create_app', 'start_background_update', 'shutdown']


def create_app() -> tuple[Flask, SocketIO]:
    """Build the Flask app and its Socket.IO server with every feature registered."""
    app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)

    configure_session(app)
    Session(app)

    socketio = SocketIO(
        app,
        cors_allowed_origins='*',
        async_mode='threading',
        ping_timeout=20,
        ping_interval=5,
    )

    # HTTP routes
    for blueprint in (
        build_auth_blueprint(),
        build_metrics_blueprint(),
        build_services_blueprint(),
        build_processes_blueprint(),
        build_mqtt_blueprint(),
        build_file_explorer_blueprint(),
        build_export_blueprint(),
        build_update_check_blueprint(),
        build_console_blueprint(),
        build_bluetooth_blueprint(),
        build_bluetooth_services_blueprint(),
        build_network_blueprint(),
        build_network_p2p_blueprint(),
    ):
        app.register_blueprint(blueprint)

    # Socket.IO
    init_services_socketio(socketio)
    register_services_socket_handlers(socketio)
    register_console_socket_handlers(socketio)
    register_mqtt_socket_handlers(socketio)
    register_file_exec_socket_handlers(socketio)
    register_bluetooth_socket_handlers(socketio)
    register_bluetooth_services_socket_handlers(socketio)

    return app, socketio


def start_background_update(socketio: SocketIO) -> threading.Thread:
    """Emit the service list + header metrics every 2 s (only when they changed)."""

    def background_update():
        last_services = None
        last_metrics = None

        while True:
            try:
                current_services = SystemdManager.get_all_services()
                current_metrics = get_system_metrics()

                if last_services != current_services:
                    socketio.emit('update_services', {'services': current_services}, namespace='/')
                    last_services = current_services

                if last_metrics != current_metrics:
                    socketio.emit('update_metrics', current_metrics, namespace='/')
                    last_metrics = current_metrics

                socketio.sleep(2)
            except Exception:
                socketio.sleep(5)

    thread = threading.Thread(target=background_update, daemon=True)
    thread.start()
    return thread


def shutdown():
    """Stop child processes (bluetoothctl, D-Bus helper, MQTT clients) on exit."""
    mqtt_cleanup_on_shutdown()
    bluetooth_cleanup_on_shutdown()
    bluetooth_services_cleanup()
