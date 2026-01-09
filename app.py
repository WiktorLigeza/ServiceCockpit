"""Application entrypoint.

This file is intentionally small: it wires together the feature modules
(blueprints + Socket.IO handlers) and starts the server.
"""

from __future__ import annotations

import threading

from flask import Flask
from flask_session import Session
from flask_socketio import SocketIO

from auth import build_auth_blueprint, configure_session
from command_executor import register_console_socket_handlers
from metrics import build_metrics_blueprint
from mqtt_feature import build_mqtt_blueprint, mqtt_cleanup_on_shutdown, register_mqtt_socket_handlers
from processes_feature import build_processes_blueprint
from services_feature import build_services_blueprint, init_services_socketio, register_services_socket_handlers
from file_explorer_feature import build_file_explorer_blueprint
from systemd_manager import SystemdManager
from metrics import get_system_metrics


def start_background_update(socketio: SocketIO) -> threading.Thread:
    """Emit service list + header metrics periodically (only when changed)."""

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


def create_app() -> tuple[Flask, SocketIO]:
    app = Flask(__name__, static_folder='static')

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
    app.register_blueprint(build_auth_blueprint())
    app.register_blueprint(build_metrics_blueprint())
    app.register_blueprint(build_services_blueprint())
    app.register_blueprint(build_processes_blueprint())
    app.register_blueprint(build_mqtt_blueprint())
    app.register_blueprint(build_file_explorer_blueprint())

    # Socket.IO
    init_services_socketio(socketio)
    register_services_socket_handlers(socketio)
    register_console_socket_handlers(socketio)
    register_mqtt_socket_handlers(socketio)

    return app, socketio


app, socketio = create_app()


if __name__ == '__main__':
    start_background_update(socketio)
    try:
        socketio.run(app, host='0.0.0.0', port=2137, debug=False, allow_unsafe_werkzeug=True)
    finally:
        mqtt_cleanup_on_shutdown()
