import subprocess

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

    @staticmethod
    def delete_service(service_name):
        try:
            # First stop and disable the service
            subprocess.run(['sudo', 'systemctl', 'stop', service_name], check=True)
            subprocess.run(['sudo', 'systemctl', 'disable', service_name], check=True)
            # Remove the service file
            subprocess.run(['sudo', 'rm', f'/etc/systemd/system/{service_name}'], check=True)
            # Reload systemd
            subprocess.run(['sudo', 'systemctl', 'daemon-reload'], check=True)
            return True
        except:
            return False
