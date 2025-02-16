from flask import Flask, render_template
from flask_socketio import SocketIO
import subprocess
from datetime import datetime
import threading
import time

app = Flask(__name__)
socketio = SocketIO(app)

class SystemdManager:
    @staticmethod
    def get_service_status(service_name):
        try:
            cmd = f"systemctl show {service_name} --property=ActiveState,UnitFileState"
            result = subprocess.run(cmd.split(), capture_output=True, text=True)
            status = {}
            for line in result.stdout.strip().split('\n'):
                key, value = line.split('=')
                status[key] = value
            return {
                'name': service_name,
                'active': status['ActiveState'] == 'active',
                'enabled': status['UnitFileState'] == 'enabled'
            }
        except:
            return None

    @staticmethod
    def get_all_services():
        # List all service units, including disabled ones
        cmd = "systemctl list-unit-files --type=service --all --plain --no-legend"
        result = subprocess.run(cmd.split(), capture_output=True, text=True)
        services = []
        for line in result.stdout.strip().split('\n'):
            if line:
                service_name = line.split()[0]
                if service_name.endswith('.service'):
                    status = SystemdManager.get_service_status(service_name)
                    if status:
                        services.append(status)
        return services

    @staticmethod
    def control_service(service_name, action):
        valid_actions = ['start', 'stop', 'restart', 'enable', 'disable']
        if action not in valid_actions:
            return False
        try:
            subprocess.run(['sudo', 'systemctl', action, service_name], check=True)
            return True
        except:
            return False

    @staticmethod
    def get_journal_logs(service_name):
        try:
            cmd = f"journalctl -u {service_name} -n 100 --no-pager"
            result = subprocess.run(cmd.split(), capture_output=True, text=True)
            return result.stdout
        except:
            return "Error fetching logs"

def background_update():
    while True:
        services = SystemdManager.get_all_services()
        socketio.emit('update_services', {'services': services})
        time.sleep(5)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/journal/<service>')
def get_journal(service):
    logs = SystemdManager.get_journal_logs(service)
    return {'logs': logs}

@socketio.on('connect')
def handle_connect():
    services = SystemdManager.get_all_services()
    socketio.emit('update_services', {'services': services})

@socketio.on('service_action')
def handle_service_action(data):
    service = data['service']
    action = data['action']
    success = SystemdManager.control_service(service, action)
    if success:
        services = SystemdManager.get_all_services()
        socketio.emit('update_services', {'services': services})

if __name__ == '__main__':
    update_thread = threading.Thread(target=background_update)
    update_thread.daemon = True
    update_thread.start()
    socketio.run(app, host='0.0.0.0', port=2137, debug=True)
