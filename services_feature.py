import subprocess

from flask import Blueprint, jsonify, render_template, request, session

from systemd_manager import SystemdManager
from auth import SUDO_SESSION_KEY, is_authenticated, run_sudo
from config_store import load_config, save_favorites

_socketio = None


def init_services_socketio(socketio):
    global _socketio
    _socketio = socketio


def build_services_blueprint() -> Blueprint:
    bp = Blueprint('services', __name__)

    @bp.route('/')
    def index():
        return render_template('services.html')

    @bp.route('/journal/<service>')
    def get_journal(service: str):
        sudo_password = session.get(SUDO_SESSION_KEY)
        logs = SystemdManager.get_journal_logs(service, sudo_password=sudo_password)
        return {'logs': logs}

    @bp.route('/api/devices')
    def get_devices():
        try:
            result = subprocess.run(['ip', 'link'], capture_output=True, text=True, check=True)
            output = result.stdout

            devices = []
            interfaces = output.strip().split('\n')

            i = 0
            while i < len(interfaces):
                if interfaces[i].strip().startswith(tuple(str(x) + ':' for x in range(10))):
                    parts = interfaces[i].split(':')
                    if len(parts) > 2:
                        interface_name = parts[1].strip()

                        operstate_result = subprocess.run(
                            ['cat', f'/sys/class/net/{interface_name}/operstate'],
                            capture_output=True,
                            text=True,
                        )
                        operstate = operstate_result.stdout.strip()

                        mac_result = subprocess.run(
                            ['cat', f'/sys/class/net/{interface_name}/address'],
                            capture_output=True,
                            text=True,
                        )
                        mac_address = mac_result.stdout.strip()

                        if interface_name.startswith('wlan'):
                            device_type = 'Wireless'
                        elif interface_name.startswith(('eth', 'enp')):
                            device_type = 'Ethernet'
                        elif interface_name.startswith('docker'):
                            device_type = 'Docker'
                        elif interface_name == 'lo':
                            device_type = 'Loopback'
                        else:
                            device_type = 'Unknown'

                        devices.append(
                            {
                                'type': device_type,
                                'name': interface_name,
                                'mac': mac_address,
                                'operstate': operstate,
                            }
                        )
                i += 1

            return jsonify(devices)
        except subprocess.CalledProcessError as e:
            return jsonify({'error': str(e)}), 500
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @bp.route('/favorites', methods=['GET'])
    def get_favorites():
        config = load_config()
        return jsonify(favorites=config['services']['favorites'])

    @bp.route('/favorites', methods=['POST'])
    def update_favorites():
        new_favorites = request.json.get('favorites', [])
        save_favorites(new_favorites)
        return jsonify(success=True)

    @bp.route('/service/<service>', methods=['DELETE'])
    def delete_service(service: str):
        sudo_password = session.get(SUDO_SESSION_KEY)
        if not sudo_password:
            return (
                jsonify({'success': False, 'error': 'sudo_required', 'message': 'Sudo password required.'}),
                401,
            )
        success = SystemdManager.delete_service(service, sudo_password=sudo_password)
        if success:
            if _socketio is not None:
                services = SystemdManager.get_all_services()
                _socketio.emit('update_services', {'services': services})
            return jsonify(success=True)
        return jsonify(success=False), 400

    @bp.route('/api/create_service', methods=['POST'])
    def create_service():
        service_content = request.json.get('serviceContent')
        service_name = request.json.get('serviceName')

        if not service_content or not service_name:
            return jsonify(success=False, message='Service content and name are required'), 400

        service_file_path = f'/etc/systemd/system/{service_name}.service'

        sudo_password = session.get(SUDO_SESSION_KEY)
        if not sudo_password:
            return jsonify(success=False, error='sudo_required', message='Sudo password required.'), 401

        try:
            run_sudo(['tee', service_file_path], sudo_password, input_text=(service_content or '') + '\n', check=True)
            run_sudo(['systemctl', 'enable', service_name], sudo_password, check=True)
            run_sudo(['systemctl', 'start', service_name], sudo_password, check=True)
            if _socketio is not None:
                services = SystemdManager.get_all_services()
                _socketio.emit('update_services', {'services': services})
            return jsonify(success=True, message=f'Service {service_name} created and started successfully')

        except subprocess.CalledProcessError as e:
            return jsonify(success=False, message=f'Failed to create service: {str(e)}'), 500
        except Exception as e:
            return jsonify(success=False, message=f'Error creating service: {str(e)}'), 500

    return bp


def register_services_socket_handlers(socketio):
    @socketio.on('connect')
    def handle_connect():
        if not is_authenticated():
            return False
        services = SystemdManager.get_all_services()
        socketio.emit('update_services', {'services': services})

    @socketio.on('service_action')
    def handle_service_action(data):
        if not is_authenticated():
            socketio.emit('console_output', {'output': '[ERROR] Not authenticated'}, room=request.sid)
            return

        service = (data or {}).get('service')
        action = (data or {}).get('action')
        if not service or not action:
            return

        sudo_password = session.get(SUDO_SESSION_KEY)
        if not sudo_password:
            socketio.emit('sudo_required', {'message': 'Sudo password required to control services.'}, room=request.sid)
            socketio.emit('console_output', {'output': '[ERROR] Sudo password required'}, room=request.sid)
            return

        success = SystemdManager.control_service(service, action, sudo_password=sudo_password)
        if success:
            services = SystemdManager.get_all_services()
            socketio.emit('update_services', {'services': services})


__all__ = ['build_services_blueprint', 'init_services_socketio', 'register_services_socket_handlers']
