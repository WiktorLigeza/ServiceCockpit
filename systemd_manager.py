import subprocess

class SystemdManager:
    @staticmethod
    def _run_sudo(args, sudo_password: str | None, check=True):
        if not sudo_password:
            raise ValueError('sudo_password is required')
        cmd = ['sudo', '-S', '-p', ''] + args
        return subprocess.run(
            cmd,
            input=sudo_password + '\n',
            text=True,
            capture_output=True,
            check=check,
        )

    @staticmethod
    def get_service_status(service_name):
        try:
            cmd = f"systemctl show {service_name} --property=ActiveState,UnitFileState,ExecMainPID,FragmentPath,TasksCurrent,Restart"
            result = subprocess.run(cmd.split(), capture_output=True, text=True)
            status = {}
            for line in result.stdout.strip().split('\n'):
                key, value = line.split('=')
                status[key] = value

            return {
                'name': service_name,
                'active': status['ActiveState'] == 'active',
                'enabled': status['UnitFileState'] == 'enabled',
                'main_pid': status['ExecMainPID'],
                'fragment_path': status['FragmentPath'],
                'tasks': status['TasksCurrent'],
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
    def control_service(service_name, action, sudo_password: str | None = None):
        valid_actions = ['start', 'stop', 'restart', 'enable', 'disable']
        if action not in valid_actions:
            return False
        try:
            if sudo_password:
                SystemdManager._run_sudo(['systemctl', action, service_name], sudo_password, check=True)
            else:
                subprocess.run(['sudo', 'systemctl', action, service_name], check=True)
            return True
        except Exception:
            return False

    @staticmethod
    def get_journal_logs(service_name, sudo_password: str | None = None):
        try:
            args = ['journalctl', '-u', service_name, '-n', '100', '--no-pager']
            if sudo_password:
                result = SystemdManager._run_sudo(args, sudo_password, check=False)
                return result.stdout or result.stderr or ''
            result = subprocess.run(args, capture_output=True, text=True)
            return result.stdout
        except Exception:
            return "Error fetching logs"

    @staticmethod
    def delete_service(service_name, sudo_password: str | None = None):
        try:
            if sudo_password:
                SystemdManager._run_sudo(['systemctl', 'stop', service_name], sudo_password, check=True)
                SystemdManager._run_sudo(['systemctl', 'disable', service_name], sudo_password, check=True)
                SystemdManager._run_sudo(['rm', f'/etc/systemd/system/{service_name}'], sudo_password, check=True)
                SystemdManager._run_sudo(['systemctl', 'daemon-reload'], sudo_password, check=True)
            else:
                subprocess.run(['sudo', 'systemctl', 'stop', service_name], check=True)
                subprocess.run(['sudo', 'systemctl', 'disable', service_name], check=True)
                subprocess.run(['sudo', 'rm', f'/etc/systemd/system/{service_name}'], check=True)
                subprocess.run(['sudo', 'systemctl', 'daemon-reload'], check=True)
            return True
        except Exception:
            return False
