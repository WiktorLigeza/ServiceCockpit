"""ServiceCockpit entry point: `python app.py` (see run_server.sh).

The application itself lives in the `cockpit` package; this file only starts
the background workers and the server.
"""

from cockpit import create_app, shutdown, start_background_update
from cockpit.core.gpu_monitor import gpu_monitor

HOST = '0.0.0.0'
PORT = 2137

app, socketio = create_app()


if __name__ == '__main__':
    gpu_monitor.start()
    start_background_update(socketio)
    try:
        socketio.run(app, host=HOST, port=PORT, debug=False, allow_unsafe_werkzeug=True)
    finally:
        shutdown()
