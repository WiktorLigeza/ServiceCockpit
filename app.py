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
import socket
import fcntl
import struct
import re
from collections import defaultdict

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

def check_internet_connection():
    try:
        # Try to create a socket to Google's DNS server (8.8.8.8) at port 53
        socket.create_connection(("8.8.8.8", 53), timeout=3)
        return True
    except OSError:
        pass
    return False

def get_system_metrics():
    cpu_temp = get_cpu_temp()
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage('/')
    has_internet = check_internet_connection()
    
    return {
        'cpu_temp': cpu_temp,
        'memory_percent': memory.percent,
        'memory_used': round(memory.used / (1024 * 1024 * 1024), 2),  # GB
        'memory_free': round(memory.available / (1024 * 1024 * 1024), 2),  # GB
        'memory_total': round(memory.total / (1024 * 1024 * 1024), 2),  # GB
        'storage_percent': disk.percent,
        'storage_used': round(disk.used / (1024 * 1024 * 1024), 2),  # GB
        'storage_free': round(disk.free / (1024 * 1024 * 1024), 2),  # GB
        'storage_total': round(disk.total / (1024 * 1024 * 1024), 2),  # GB
        'has_internet': has_internet
    }

def get_network_info():
    ip_address = 'N/A'
    mac_address = 'N/A'
    
    # Try different interface names
    for interface in ['wlan0', 'eth0', 'en0', 'enp0s3']:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            ip_address = socket.inet_ntoa(fcntl.ioctl(
                s.fileno(),
                0x8915,  # SIOCGIFADDR
                struct.pack('256s', interface.encode('utf-8')[:15])
            )[20:24])
            break  # If successful, break the loop
        except:
            pass

    # Get MAC address (try different interfaces as well)
    for interface in ['wlan0', 'eth0', 'en0', 'enp0s3']:
        try:
            with open(f'/sys/class/net/{interface}/address', 'r') as f:
                mac_address = f.readline().strip()
            break
        except:
            pass

    return {'ip_address': ip_address, 'mac_address': mac_address}

# Replace the pyshark-based implementation with a simpler psutil-based approach
# Global cache for network traffic data
process_net_counters = {}
network_traffic_lock = threading.Lock()

def get_process_network_traffic(pid):
    """Calculate network traffic for a specific process using psutil"""
    try:
        # Get the process
        process = psutil.Process(pid)
        current_time = time.time()
        
        # Get connections for this process
        connections = process.connections()
        if not connections:
            return 0
            
        # Use a simple time-based approach to estimate traffic
        # Instead of counting actual bytes (which requires root), we'll use connection count as a proxy
        conn_count = len(connections)
        
        with network_traffic_lock:
            # Initialize or get previous data
            if pid not in process_net_counters:
                process_net_counters[pid] = {
                    'last_check': current_time,
                    'last_conn_count': conn_count,
                    'traffic_estimate': 0
                }
                return 0
            
            # Get time difference
            prev_data = process_net_counters[pid]
            time_diff = current_time - prev_data['last_check']
            
            if time_diff < 0.1:  # Avoid division by near-zero
                return prev_data['traffic_estimate']
                
            # Use connection count changes and activity to estimate traffic
            conn_diff = abs(conn_count - prev_data['last_conn_count'])
            
            # Get CPU usage as activity indicator
            cpu_percent = process.cpu_percent(interval=None) / 100.0
            
            # Estimate traffic based on connections and CPU activity
            # This is not accurate but provides relative scaling
            # More connections and higher CPU usually mean more network activity
            base_traffic = 5  # Base KB/s for active processes with network connections
            conn_factor = 2 * conn_diff  # More connection changes suggest more traffic
            cpu_factor = 10 * cpu_percent  # CPU activity often correlates with network activity
            
            # Calculate new estimate (with some smoothing from previous value)
            if conn_count > 0:
                new_estimate = base_traffic + conn_factor + cpu_factor
                # Smooth with previous estimate (70% new, 30% old)
                traffic_estimate = (0.7 * new_estimate) + (0.3 * prev_data['traffic_estimate'])
            else:
                traffic_estimate = 0
                
            # Update the cache
            process_net_counters[pid] = {
                'last_check': current_time,
                'last_conn_count': conn_count,
                'traffic_estimate': traffic_estimate
            }
            
            # Return the estimate, rounded to 2 decimal places
            return round(traffic_estimate, 2)
            
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return 0
    except Exception as e:
        print(f"Error calculating network traffic for PID {pid}: {str(e)}")
        return 0

@app.route('/system_metrics')
def system_metrics():
    return jsonify(get_system_metrics())

@app.route('/api/network_info')
def network_info():
    return jsonify(get_network_info())

@app.route('/api/process_metrics/<int:pid>')
def process_metrics(pid):
    try:
        # Try to get the process
        process = psutil.Process(pid)
        
        # Get CPU usage (as a percentage)
        cpu_percent = process.cpu_percent(interval=0.1)
        
        # Get memory info
        memory_info = process.memory_info()
        memory_percent = process.memory_percent()
        
        # Get network connections
        network_connections = process.net_connections()
        num_connections = len(network_connections)
        
        # Get network traffic
        network_traffic = get_process_network_traffic(pid)
        
        # Get process name and status
        process_name = process.name()
        status = process.status()
        
        return jsonify({
            'success': True,
            'process_exists': True,
            'process_name': process_name,
            'status': status,
            'cpu_percent': cpu_percent,
            'memory_rss': memory_info.rss,  # RSS in bytes
            'memory_vms': memory_info.vms,  # VMS in bytes
            'memory_percent': memory_percent,
            'network_connections': num_connections,
            'network_traffic': network_traffic,
            'timestamp': time.time()
        })
    except psutil.NoSuchProcess:
        return jsonify({
            'success': False,
            'process_exists': False,
            'error': f'Process with PID {pid} not found'
        })
    except (psutil.AccessDenied, psutil.ZombieProcess) as e:
        return jsonify({
            'success': False,
            'process_exists': True,
            'error': str(e)
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        })

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

@app.route('/api/devices')
def get_devices():
    try:
        # Execute the command to get network interfaces
        result = subprocess.run(['ip', 'link'], capture_output=True, text=True, check=True)
        output = result.stdout

        devices = []
        interfaces = output.strip().split('\n')
        
        # Iterate through interfaces and extract relevant information
        i = 0
        while i < len(interfaces):
            if interfaces[i].strip().startswith(tuple(str(x) + ':' for x in range(10))):
                parts = interfaces[i].split(':')
                if len(parts) > 2:
                    interface_number = parts[0].strip()
                    interface_name = parts[1].strip()
                    
                    # Get the interface's operational status
                    operstate_result = subprocess.run(['cat', f'/sys/class/net/{interface_name}/operstate'], capture_output=True, text=True)
                    operstate = operstate_result.stdout.strip()
                    
                    # Get MAC address
                    mac_result = subprocess.run(['cat', f'/sys/class/net/{interface_name}/address'], capture_output=True, text=True)
                    mac_address = mac_result.stdout.strip()
                    
                    # Determine device type based on interface name
                    if interface_name.startswith('wlan'):
                        device_type = 'Wireless'
                    elif interface_name.startswith('eth'):
                        device_type = 'Ethernet'
                    elif interface_name.startswith('enp'):
                        device_type = 'Ethernet'
                    elif interface_name.startswith('docker'):
                        device_type = 'Docker'
                    elif interface_name == 'lo':
                        device_type = 'Loopback'
                    else:
                        device_type = 'Unknown'
                    
                    device = {
                        'type': device_type,
                        'name': interface_name,
                        'mac': mac_address,
                        'operstate': operstate
                    }
                    devices.append(device)
            i += 1
        
        return jsonify(devices)
    except subprocess.CalledProcessError as e:
        print(f"Subprocess error: {e}")
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        print(f"Error fetching devices: {e}")
        return jsonify({'error': str(e)}), 500

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

@app.route('/api/create_service', methods=['POST'])
def create_service():
    service_content = request.json.get('serviceContent')
    service_name = request.json.get('serviceName')

    if not service_content or not service_name:
        return jsonify(success=False, message="Service content and name are required"), 400

    service_file_path = f'/etc/systemd/system/{service_name}.service'

    try:
        # Save the service content to a file
        # Use subprocess to write the file with sudo privileges
        subprocess.run(['sudo', 'tee', service_file_path], input=service_content, text=True, check=True)

        # Enable the service
        subprocess.run(['sudo', 'systemctl', 'enable', service_name], check=True)

        # Start the service
        subprocess.run(['sudo', 'systemctl', 'start', service_name], check=True)

        services = SystemdManager.get_all_services()
        socketio.emit('update_services', {'services': services})

        return jsonify(success=True, message=f"Service {service_name} created and started successfully")

    except subprocess.CalledProcessError as e:
        print(f"Error creating service: {str(e)}")
        return jsonify(success=False, message=f"Failed to create service: {str(e)}"), 500
    except Exception as e:
        print(f"Error creating service: {str(e)}")
        return jsonify(success=False, message=f"Error creating service: {str(e)}"), 500

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
    
    socketio.run(app, host='0.0.0.0', port=2137, debug=False, allow_unsafe_werkzeug=True)

