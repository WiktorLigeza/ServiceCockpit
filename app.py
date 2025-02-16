from flask import Flask, render_template, url_for, jsonify, request
from flask_socketio import SocketIO
from systemd_manager import SystemdManager
import threading
import time
import json
import os
import psutil

app = Flask(__name__, static_folder='static')
socketio = SocketIO(app)

CONFIG_FILE = 'config.json'

def load_config():
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'w') as f:
            json.dump({"services": {"favorites": []}}, f)
    with open(CONFIG_FILE, 'r') as f:
        return json.load(f)

def save_favorites(favorites):
    config = load_config()
    config['services']['favorites'] = favorites
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f)

def get_cpu_temp():
    try:
        with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
            temp = float(f.read()) / 1000.0
        return round(temp, 1)
    except:
        return 0

def get_system_metrics():
    cpu_temp = get_cpu_temp()
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage('/')
    
    return {
        'cpu_temp': cpu_temp,
        'memory_percent': memory.percent,
        'storage_percent': disk.percent
    }

@app.route('/system_metrics')
def system_metrics():
    return jsonify(get_system_metrics())

def background_update():
    while True:
        try:
            current_services = SystemdManager.get_all_services()
            current_metrics = get_system_metrics()
            
            socketio.emit('update_services', {'services': current_services}, namespace='/')
            socketio.emit('update_metrics', current_metrics, namespace='/')
                
            socketio.sleep(5)  # Use socketio.sleep instead of time.sleep
            
        except Exception as e:
            print(f"Error in background update: {e}")
            socketio.sleep(5)

@app.route('/')
def index():
    return render_template('services.html')


@app.route('/journal/<service>')
def get_journal(service):
    logs = SystemdManager.get_journal_logs(service)
    return {'logs': logs}

@app.route('/favorites', methods=['GET'])
def get_favorites():
    config = load_config()
    return jsonify(favorites=config['services']['favorites'])

@app.route('/favorites', methods=['POST'])
def update_favorites():
    new_favorites = request.json.get('favorites', [])
    save_favorites(new_favorites)
    return jsonify(success=True)

@socketio.on('connect')
def handle_connect():
    services = SystemdManager.get_all_services()
    socketio.emit('update_services', {'services': services})

@socketio.on('service_action')
def handle_service_action(data):
    service = data['service']
    action = data['action']
    print(f"Service action: {service} - {action}")
    success = SystemdManager.control_service(service, action)
    if success:
        services = SystemdManager.get_all_services()
        socketio.emit('update_services', {'services': services})

if __name__ == '__main__':
    update_thread = threading.Thread(target=background_update)
    update_thread.daemon = True
    update_thread.start()
    
    socketio = SocketIO(app, 
                       host='0.0.0.0',
                       port=2137,
                       debug=True,
                       cors_allowed_origins="*",
                       async_mode='threading',
                       ping_timeout=20,
                       ping_interval=5)
    socketio.run(app)
