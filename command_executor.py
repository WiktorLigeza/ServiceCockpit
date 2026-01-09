import shlex
import subprocess
import threading

from flask import request, session

from auth import AUTH_SESSION_KEY, SUDO_SESSION_KEY, is_authenticated

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
    def execute_command(socketio, command: str, socket_id: str, sudo_password=None, sudo_enabled: bool = False):
        try:
            args = shlex.split(command)
            if not args:
                return "[ERROR] Empty command"

            base_command = args[0]
            if base_command not in ALLOWED_COMMANDS:
                return f"[ERROR] Command '{base_command}' not allowed"

            args[0] = ALLOWED_COMMANDS[base_command]

            if base_command in ['systemctl', 'journalctl']:
                if not all(arg.isalnum() or arg in ['-', '_', '.'] for arg in args[1:]):
                    return 'Error: Invalid characters in arguments'

            popen_args = args
            popen_input = None

            if sudo_enabled and sudo_password and base_command in ['systemctl', 'journalctl']:
                popen_args = ['sudo', '-S', '-p', ''] + args
                popen_input = sudo_password + '\n'

            process = subprocess.Popen(
                popen_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE if popen_input is not None else None,
                text=True,
                bufsize=1,
                universal_newlines=True,
            )

            if popen_input is not None:
                try:
                    process.stdin.write(popen_input)
                    process.stdin.flush()
                except Exception:
                    pass

            while True:
                output = process.stdout.readline()
                if output:
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
                socketio.emit('console_output', {'output': f"[ERROR] Command exited with status {return_code}"}, room=socket_id)

        except Exception as e:
            return f"[ERROR] Error executing command: {str(e)}"


def register_console_socket_handlers(socketio):
    @socketio.on('console_command')
    def handle_console_command(data):
        try:
            if not is_authenticated():
                socketio.emit('console_output', {'output': '[ERROR] Not authenticated'}, room=request.sid)
                return

            command = (data or {}).get('command', '').strip()
            if not command:
                return

            sudo_password = session.get(SUDO_SESSION_KEY)
            sudo_enabled = bool(session.get(AUTH_SESSION_KEY) and sudo_password)

            thread = threading.Thread(
                target=CommandExecutor.execute_command,
                args=(socketio, command, request.sid, sudo_password, sudo_enabled),
            )
            thread.daemon = True
            thread.start()

        except Exception as e:
            socketio.emit('console_output', {'output': f"Error: {str(e)}"}, room=request.sid)

    @socketio.on('join_console')
    def on_join_console():
        if not is_authenticated():
            return
        socketio.emit(
            'console_output',
            {'output': "[SUCCESS] Connected to console. Type 'help' for available commands."},
            room=request.sid,
        )

    @socketio.on('console_help')
    def handle_console_help():
        help_text = (
            '[INFO] Available commands:\n'
            + '\n'.join(f"- {cmd}" for cmd in sorted(ALLOWED_COMMANDS.keys()))
            + '\n\n[WARNING] Note: All commands are executed with restricted privileges.'
        )
        socketio.emit('console_output', {'output': help_text}, room=request.sid)


__all__ = ['register_console_socket_handlers']
