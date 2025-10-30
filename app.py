from flask import Flask, render_template, url_for, jsonify, request
from flask_socketio import SocketIO, emit, join_room, leave_room
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
import paho.mqtt.client as mqtt
import stat
from pathlib import Path
import shutil

app = Flask(__name__, static_folder='static')
socketio = SocketIO(app, 
                   cors_allowed_origins="*",
                   async_mode='threading',
                   ping_timeout=20,
                   ping_interval=5)

CONFIG_FILE = 'config.json'

# MQTT Manager Class
class MQTTManager:
    def __init__(self, socketio_instance):
        self.client = None
        self.socketio = socketio_instance
        self.connected = False
        self.topics = set()
        self.subscriptions = set()
        
    def connect(self, host='localhost', port=1883, username='', password=''):
        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            
            # Set callbacks
            self.client.on_connect = self.on_connect
            self.client.on_disconnect = self.on_disconnect
            self.client.on_message = self.on_message
            self.client.on_subscribe = self.on_subscribe
            self.client.on_publish = self.on_publish
            
            # Set authentication if provided
            if username:
                self.client.username_pw_set(username, password)
            
            # Connect to broker
            self.client.connect(host, port, 60)
            self.client.loop_start()
            
            return True
        except Exception as e:
            self.socketio.emit('mqtt_error', {'error': str(e)}, namespace='/mqtt')
            return False
    
    def disconnect(self):
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
            self.client = None
        self.connected = False
        self.topics.clear()
        self.subscriptions.clear()
        self.socketio.emit('mqtt_status', {'connected': False, 'message': 'Disconnected'}, namespace='/mqtt')
    
    def subscribe(self, topic):
        if self.client and self.connected:
            try:
                self.client.subscribe(topic)
                self.subscriptions.add(topic)
                return True
            except Exception as e:
                self.socketio.emit('mqtt_error', {'error': str(e)}, namespace='/mqtt')
                return False
        return False
    
    def publish(self, topic, payload, qos=0, retain=False):
        if self.client and self.connected:
            try:
                self.client.publish(topic, payload, qos, retain)
                return True
            except Exception as e:
                self.socketio.emit('mqtt_error', {'error': str(e)}, namespace='/mqtt')
                return False
        return False
    
    def on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            self.connected = True
            self.socketio.emit('mqtt_status', {'connected': True, 'message': 'Connected'}, namespace='/mqtt')
            # Subscribe to wildcard to discover topics
            client.subscribe('#')
        else:
            self.connected = False
            self.socketio.emit('mqtt_status', {'connected': False, 'message': f'Connection failed: {reason_code}'}, namespace='/mqtt')
    
    def on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected = False
        self.socketio.emit('mqtt_status', {'connected': False, 'message': 'Disconnected'}, namespace='/mqtt')
    
    def on_message(self, client, userdata, msg):
        try:
            topic = msg.topic
            payload = msg.payload.decode('utf-8')
            
            # Add topic to discovered topics
            self.topics.add(topic)
            
            # Emit message to frontend
            self.socketio.emit('mqtt_message', {
                'topic': topic,
                'payload': payload,
                'qos': msg.qos,
                'retain': msg.retain,
                'timestamp': time.time() * 1000  # milliseconds
            }, namespace='/mqtt')
            
            # Update topics list
            self.socketio.emit('mqtt_topics', {'topics': list(self.topics)}, namespace='/mqtt')
            
        except Exception as e:
            self.socketio.emit('mqtt_error', {'error': f'Message handling error: {str(e)}'}, namespace='/mqtt')
    
    def on_subscribe(self, client, userdata, mid, reason_code_list, properties=None):
        pass
    
    def on_publish(self, client, userdata, mid, reason_code, properties=None):
        pass

mqtt_manager = None

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
        connections = process.net_connections()
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

@app.route('/mqtt_explorer')
def mqtt_explorer():
    return render_template('mqtt_explorer.html')

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

@app.route('/file_explorer')
def file_explorer():
    return render_template('file_explorer.html')

@app.route('/api/files')
def get_files():
    try:
        path = request.args.get('path', '/home')
        path_obj = Path(path)
        
        if not path_obj.exists():
            return jsonify({'success': False, 'error': 'Path does not exist'})
        
        if not path_obj.is_dir():
            return jsonify({'success': False, 'error': 'Path is not a directory'})
        
        files = []
        for item in path_obj.iterdir():
            try:
                stat_info = item.stat()
                
                files.append({
                    'name': item.name,
                    'path': str(item),
                    'is_directory': item.is_dir(),
                    'size': stat_info.st_size if item.is_file() else 0,
                    'permissions': stat.filemode(stat_info.st_mode),
                    'modified': stat_info.st_mtime
                })
            except (PermissionError, OSError) as e:
                # Skip files/folders we don't have permission to access
                continue
        
        return jsonify({'success': True, 'files': files})
    except PermissionError as e:
        return jsonify({'success': False, 'error': f'Permission denied: {str(e)}'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/folder-size')
def get_folder_size():
    try:
        path = request.args.get('path')
        if not path:
            return jsonify({'success': False, 'error': 'Path parameter required'}), 400
            
        path_obj = Path(path)
        
        if not path_obj.exists():
            return jsonify({'success': False, 'error': 'Path does not exist'}), 404
        
        if not path_obj.is_dir():
            return jsonify({'success': False, 'error': 'Path is not a directory'}), 400
        
        try:
            total_size = sum(f.stat().st_size for f in path_obj.rglob('*') if f.is_file())
            size_display = format_size(total_size)
            
            return jsonify({
                'success': True,
                'size': total_size,
                'size_display': size_display
            })
        except (PermissionError, OSError) as e:
            return jsonify({'success': False, 'error': 'Permission denied or unable to calculate size'}), 403
            
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/file-details')
def get_file_details():
    try:
        path = request.args.get('path')
        if not path:
            return jsonify({'success': False, 'error': 'Path parameter required'}), 400
            
        path_obj = Path(path)
        
        if not path_obj.exists():
            return jsonify({'success': False, 'error': 'File does not exist'}), 404
        
        stat_info = path_obj.stat()
        
        # Get owner name
        try:
            import pwd
            owner = pwd.getpwuid(stat_info.st_uid).pw_name
        except:
            owner = str(stat_info.st_uid)
        
        details = {
            'owner': owner,
            'modified': stat_info.st_mtime,
            'accessed': stat_info.st_atime,
            'created': stat_info.st_ctime
        }
        
        return jsonify({'success': True, 'details': details})
    except PermissionError:
        return jsonify({'success': False, 'error': 'Permission denied'}), 403
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/create-folder', methods=['POST'])
def create_folder():
    try:
        data = request.json
        path = data.get('path')
        name = data.get('name')
        
        if not path or not name:
            return jsonify({'success': False, 'error': 'Path and name required'})
        
        new_folder = Path(path) / name
        new_folder.mkdir(parents=True, exist_ok=False)
        
        return jsonify({'success': True})
    except FileExistsError:
        return jsonify({'success': False, 'error': 'Folder already exists'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/create-file', methods=['POST'])
def create_file():
    try:
        data = request.json
        path = data.get('path')
        name = data.get('name')
        
        if not path or not name:
            return jsonify({'success': False, 'error': 'Path and name required'})
        
        new_file = Path(path) / name
        new_file.touch(exist_ok=False)
        
        return jsonify({'success': True})
    except FileExistsError:
        return jsonify({'success': False, 'error': 'File already exists'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/delete', methods=['POST'])
def delete_item():
    try:
        data = request.json
        path = data.get('path')
        is_directory = data.get('is_directory', False)
        
        if not path:
            return jsonify({'success': False, 'error': 'Path required'})
        
        path_obj = Path(path)
        
        if not path_obj.exists():
            return jsonify({'success': False, 'error': 'Path does not exist'})
        
        if is_directory:
            shutil.rmtree(path_obj)
        else:
            path_obj.unlink()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/rename', methods=['POST'])
def rename_item():
    try:
        data = request.json
        old_path = data.get('old_path')
        new_name = data.get('new_name')
        
        if not old_path or not new_name:
            return jsonify({'success': False, 'error': 'Old path and new name required'})
        
        old_path_obj = Path(old_path)
        new_path_obj = old_path_obj.parent / new_name
        
        if new_path_obj.exists():
            return jsonify({'success': False, 'error': 'A file or folder with that name already exists'})
        
        old_path_obj.rename(new_path_obj)
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/move', methods=['POST'])
def move_item():
    try:
        data = request.json
        source_path = data.get('source_path')
        destination_path = data.get('destination_path')
        
        if not source_path or not destination_path:
            return jsonify({'success': False, 'error': 'Source and destination paths required'})
        
        source_obj = Path(source_path)
        dest_dir_obj = Path(destination_path)
        
        if not source_obj.exists():
            return jsonify({'success': False, 'error': 'Source does not exist'})
        
        if not dest_dir_obj.is_dir():
            return jsonify({'success': False, 'error': 'Destination must be a directory'})
        
        # Check if moving into itself or subdirectory
        if source_obj.is_dir() and dest_dir_obj.is_relative_to(source_obj):
            return jsonify({'success': False, 'error': 'Cannot move a folder into itself or its subdirectory'})
        
        destination_path_obj = dest_dir_obj / source_obj.name
        
        if destination_path_obj.exists():
            return jsonify({'success': False, 'error': 'An item with that name already exists in the destination'})
        
        shutil.move(str(source_obj), str(destination_path_obj))
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/paste', methods=['POST'])
def paste_item():
    try:
        data = request.json
        source_path = data.get('source_path')
        destination_path = data.get('destination_path')
        is_cut = data.get('is_cut', False)
        
        if not source_path or not destination_path:
            return jsonify({'success': False, 'error': 'Source and destination paths required'})
        
        source_obj = Path(source_path)
        dest_dir_obj = Path(destination_path)
        
        if not source_obj.exists():
            return jsonify({'success': False, 'error': 'Source does not exist'})
        
        if not dest_dir_obj.is_dir():
            return jsonify({'success': False, 'error': 'Destination must be a directory'})
        
        destination_path_obj = dest_dir_obj / source_obj.name
        
        # Handle name conflicts
        if destination_path_obj.exists():
            base_name = source_obj.stem
            extension = source_obj.suffix
            counter = 1
            
            while destination_path_obj.exists():
                if source_obj.is_dir():
                    new_name = f"{source_obj.name}_copy{counter}"
                else:
                    new_name = f"{base_name}_copy{counter}{extension}"
                destination_path_obj = dest_dir_obj / new_name
                counter += 1
        
        if is_cut:
            # Move operation
            shutil.move(str(source_obj), str(destination_path_obj))
        else:
            # Copy operation
            if source_obj.is_dir():
                shutil.copytree(str(source_obj), str(destination_path_obj))
            else:
                shutil.copy2(str(source_obj), str(destination_path_obj))
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

def format_size(bytes_size):
    """Format bytes to human readable size"""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

@app.route('/api/directories')
def get_directories():
    try:
        path = request.args.get('path', '/')
        path_obj = Path(path)
        
        if not path_obj.exists() or not path_obj.is_dir():
            return jsonify({'success': False, 'error': 'Invalid directory'})
        
        directories = []
        for item in path_obj.iterdir():
            try:
                if item.is_dir():
                    directories.append({
                        'name': item.name,
                        'path': str(item)
                    })
            except (PermissionError, OSError):
                # Skip directories we don't have permission to access
                continue
        
        # Sort directories alphabetically
        directories.sort(key=lambda x: x['name'].lower())
        
        return jsonify({'success': True, 'directories': directories})
    except PermissionError as e:
        return jsonify({'success': False, 'error': f'Permission denied'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/download')
def download_file():
    from flask import send_file
    try:
        path = request.args.get('path')
        return send_file(path, as_attachment=True)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

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

# MQTT Socket Handlers
@socketio.on('connect', namespace='/mqtt')
def handle_mqtt_connect():
    print("Client connected to MQTT namespace")

@socketio.on('disconnect', namespace='/mqtt')
def handle_mqtt_disconnect():
    print("Client disconnected from MQTT namespace")

@socketio.on('mqtt_connect', namespace='/mqtt')
def handle_mqtt_broker_connect(data):
    global mqtt_manager
    if mqtt_manager:
        mqtt_manager.disconnect()
    
    mqtt_manager = MQTTManager(socketio)
    
    host = data.get('host', 'localhost')
    port = data.get('port', 1883)
    username = data.get('username', '')
    password = data.get('password', '')
    
    success = mqtt_manager.connect(host, port, username, password)
    if not success:
        emit('mqtt_status', {'connected': False, 'message': 'Connection failed'})

@socketio.on('mqtt_disconnect', namespace='/mqtt')
def handle_mqtt_broker_disconnect():
    global mqtt_manager
    if mqtt_manager:
        mqtt_manager.disconnect()
        mqtt_manager = None

@socketio.on('mqtt_subscribe', namespace='/mqtt')
def handle_mqtt_subscribe(data):
    global mqtt_manager
    if mqtt_manager:
        topic = data.get('topic', '')
        if topic:
            mqtt_manager.subscribe(topic)

@socketio.on('mqtt_publish', namespace='/mqtt')
def handle_mqtt_publish(data):
    global mqtt_manager
    if mqtt_manager:
        topic = data.get('topic', '')
        payload = data.get('payload', '')
        qos = data.get('qos', 0)
        retain = data.get('retain', False)
        
        if topic:
            mqtt_manager.publish(topic, payload, qos, retain)

@app.route('/api/read-file')
def read_file():
    try:
        path = request.args.get('path')
        if not path:
            return jsonify({'success': False, 'error': 'Path parameter required'}), 400
            
        path_obj = Path(path)
        
        if not path_obj.exists():
            return jsonify({'success': False, 'error': 'File does not exist'}), 404
        
        if path_obj.is_dir():
            return jsonify({'success': False, 'error': 'Cannot read directory'}), 400
        
        try:
            with open(path_obj, 'r', encoding='utf-8') as f:
                content = f.read()
            return jsonify({'success': True, 'content': content})
        except UnicodeDecodeError:
            return jsonify({'success': False, 'error': 'Cannot read binary file'}), 400
            
    except PermissionError:
        return jsonify({'success': False, 'error': 'Permission denied'}), 403
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/write-file', methods=['POST'])
def write_file():
    try:
        data = request.json
        path = data.get('path')
        content = data.get('content')
        
        if not path:
            return jsonify({'success': False, 'error': 'Path required'})
        
        path_obj = Path(path)
        
        if not path_obj.exists():
            return jsonify({'success': False, 'error': 'File does not exist'})
        
        if path_obj.is_dir():
            return jsonify({'success': False, 'error': 'Cannot write to directory'})
        
        # Create backup
        backup_path = str(path_obj) + '.backup'
        if path_obj.exists():
            shutil.copy2(path_obj, backup_path)
        
        try:
            with open(path_obj, 'w', encoding='utf-8') as f:
                f.write(content)
            
            # Remove backup after successful write
            if Path(backup_path).exists():
                Path(backup_path).unlink()
                
            return jsonify({'success': True})
        except Exception as e:
            # Restore backup on error
            if Path(backup_path).exists():
                shutil.copy2(backup_path, path_obj)
                Path(backup_path).unlink()
            raise e
            
    except PermissionError:
        return jsonify({'success': False, 'error': 'Permission denied'}), 403
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/upload', methods=['POST'])
def upload_file():
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No file provided'})
        
        file = request.files['file']
        target_path = request.form.get('path', '/home')
        
        if file.filename == '':
            return jsonify({'success': False, 'error': 'No file selected'})
        
        # Secure the filename to prevent path traversal
        from werkzeug.utils import secure_filename
        filename = secure_filename(file.filename)
        
        target_dir = Path(target_path)
        if not target_dir.exists() or not target_dir.is_dir():
            return jsonify({'success': False, 'error': 'Invalid target directory'})
        
        file_path = target_dir / filename
        
        # Handle name conflicts
        if file_path.exists():
            base_name = file_path.stem
            extension = file_path.suffix
            counter = 1
            
            while file_path.exists():
                new_name = f"{base_name}_{counter}{extension}"
                file_path = target_dir / new_name
                counter += 1
        
        # Save the file
        file.save(str(file_path))
        
        return jsonify({'success': True, 'filename': file_path.name})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

if __name__ == '__main__':
    update_thread = threading.Thread(target=background_update)
    update_thread.daemon = True
    update_thread.start()
    
    try:
        socketio.run(app, host='0.0.0.0', port=2137, debug=False, allow_unsafe_werkzeug=True)
    finally:
        # Cleanup MQTT connection on shutdown
        if mqtt_manager:
            mqtt_manager.disconnect()

