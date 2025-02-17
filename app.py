from flask import Flask, render_template, url_for, jsonify, request
from flask_socketio import SocketIO
from systemd_manager import SystemdManager
import threading
import time
import json
import os
import psutil
import subprocess
import shlex
import threading
from queue import Queue

app = Flask(__name__, static_folder='static')
socketio = SocketIO(app, 
                   cors_allowed_origins="*",
                   async_mode='threading',
                   ping_timeout=20,
                   ping_interval=5)

CONFIG_FILE = 'config.json'

ALLOWED_COMMANDS = {
    'ls': '/bin/ls',
    'ps': '/bin/ps',
    'df': '/bin/df',
    'free': '/usr/bin/free',
    'top': '/usr/bin/top',
    'systemctl': '/bin/systemctl',
    'journalctl': '/bin/journalctl',
    'cat': '/bin/cat',
    'grep': '/bin/grep',
    'uptime': '/usr/bin/uptime',
    'who': '/usr/bin/who',
    'date': '/bin/date',
    'pwd': '/bin/pwd',
}

class CommandExecutor:
    @staticmethod
    def execute_command(command, socket_id):
        try:
            # Parse the command
            args = shlex.split(command)
            if not args:
                return "[ERROR] Empty command"

            base_command = args[0]
            if base_command not in ALLOWED_COMMANDS:
                return f"[ERROR] Command '{base_command}' not allowed"

            # Replace the command with the full path
            args[0] = ALLOWED_COMMANDS[base_command]

            # Special handling for potentially dangerous commands
            if base_command in ['systemctl', 'journalctl']:
                if not all(arg.isalnum() or arg in ['-', '_', '.'] for arg in args[1:]):
                    return "Error: Invalid characters in arguments"

            # Execute the command
            process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True
            )

            # Stream output in real-time
            while True:
                output = process.stdout.readline()
                if output:
                    # Preserve ANSI color codes or add INFO prefix
                    if any(code in output for code in ['\x1b[31m', '\x1b[32m', '\x1b[33m', '\x1b[34m']):
                        formatted_output = output.strip()
                    else:
                        formatted_output = f"[INFO] {output.strip()}"
                    socketio.emit('console_output', {'output': formatted_output}, room=socket_id)
                    socketio.sleep(0)
                
                error = process.stderr.readline()
                if error:
                    socketio.emit('console_output', {'output': f"[ERROR] {error.strip()}"}, room=socket_id)
                    socketio.sleep(0)
                
                if output == '' and error == '' and process.poll() is not None:
                    break

            return_code = process.poll()
            if return_code != 0:
                socketio.emit('console_output', 
                            {'output': f"[ERROR] Command exited with status {return_code}"}, 
                            room=socket_id)

        except Exception as e:
            return f"[ERROR] Error executing command: {str(e)}"

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
        'memory_used': round(memory.used / (1024 * 1024 * 1024), 2),  # GB
        'memory_free': round(memory.available / (1024 * 1024 * 1024), 2),  # GB
        'memory_total': round(memory.total / (1024 * 1024 * 1024), 2),  # GB
        'storage_percent': disk.percent,
        'storage_used': round(disk.used / (1024 * 1024 * 1024), 2),  # GB
        'storage_free': round(disk.free / (1024 * 1024 * 1024), 2),  # GB
        'storage_total': round(disk.total / (1024 * 1024 * 1024), 2)  # GB
    }

@app.route('/system_metrics')
def system_metrics():
    return jsonify(get_system_metrics())

def background_update():
    last_services = None
    last_metrics = None
    
    while True:
        try:
            current_services = SystemdManager.get_all_services()
            current_metrics = get_system_metrics()
            
            # Only emit services update if there are changes
            if last_services != current_services:
                socketio.emit('update_services', {'services': current_services}, namespace='/')
                last_services = current_services
            
            # Only emit metrics update if there are changes
            if last_metrics != current_metrics:
                socketio.emit('update_metrics', current_metrics, namespace='/')
                last_metrics = current_metrics
                
            socketio.sleep(2)
            
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

@app.route('/service/<service>', methods=['DELETE'])
def delete_service(service):
    success = SystemdManager.delete_service(service)
    if success:
        services = SystemdManager.get_all_services()
        socketio.emit('update_services', {'services': services})
        return jsonify(success=True)
    return jsonify(success=False), 400

@app.route('/service/<service>/info')
def get_service_info(service):
    try:
        # Get service status using systemctl show
        status_cmd = f"systemctl show {service} --property=MainPID,Tasks,CPUUsageSec,MemoryCurrent,ActiveState,FragmentPath,ExecStart,CGroup"
        status = subprocess.check_output(['systemctl', 'show', service], text=True)
        
        # Parse the status output
        info = {}
        for line in status.split('\n'):
            if '=' in line:
                key, value = line.split('=', 1)
                info[key] = value

        # Get service file content
        file_path = info.get('FragmentPath', '')
        file_content = ''
        if file_path and os.path.exists(file_path):
            with open(file_path, 'r') as f:
                file_content = f.read()

        # Get CGroup info
        cgroup_cmd = f"systemctl status {service}"
        try:
            cgroup_output = subprocess.check_output(shlex.split(cgroup_cmd), text=True)
            cgroup_info = [line for line in cgroup_output.split('\n') if 'CGroup:' in line or '└' in line or '├' in line]
            cgroup = '\n'.join(cgroup_info)
        except:
            cgroup = 'CGroup information not available'

        return jsonify({
            'mainPid': info.get('MainPID', 'N/A'),
            'tasks': info.get('Tasks', 'N/A'),
            'cpuTime': f"{float(info.get('CPUUsageSec', 0)):.2f}s",
            'memoryUsage': f"{int(info.get('MemoryCurrent', 0)) / (1024*1024):.2f} MB",
            'status': info.get('ActiveState', 'N/A'),
            'path': file_path,
            'fileContent': file_content,
            'cgroup': cgroup
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

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

@socketio.on('console_command')
def handle_console_command(data):
    try:
        command = data.get('command', '').strip()
        if not command:
            return
        
        # Create a thread for command execution
        thread = threading.Thread(
            target=CommandExecutor.execute_command,
            args=(command, request.sid)
        )
        thread.daemon = True
        thread.start()

    except Exception as e:
        socketio.emit('console_output', 
                     {'output': f"Error: {str(e)}"}, 
                     room=request.sid)

@socketio.on('join_console')
def on_join_console():
    socketio.emit('console_output', 
                 {'output': f"[SUCCESS] Connected to console. Type 'help' for available commands."}, 
                 room=request.sid)

@socketio.on('console_help')
def handle_console_help():
    help_text = "[INFO] Available commands:\n" + \
                "\n".join(f"- {cmd}" for cmd in sorted(ALLOWED_COMMANDS.keys())) + \
                "\n\n[WARNING] Note: All commands are executed with restricted privileges."
    socketio.emit('console_output', {'output': help_text}, room=request.sid)

if __name__ == '__main__':
    update_thread = threading.Thread(target=background_update)
    update_thread.daemon = True
    update_thread.start()
    
    socketio.run(app, host='0.0.0.0', port=2137, debug=True)

