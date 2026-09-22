import os
import subprocess
import threading

from flask import request, session

from auth import SUDO_SESSION_KEY, is_authenticated

# Full shell access, run as root via sudo. There is no command allowlist here
# by design - the console is gated behind a fresh sudo-password prompt before
# it even opens (see sidebar/header JS), and every command already runs with
# root privileges, so restricting *which* commands can run would be theater,
# not security.
_console_cwd_by_sid: dict[str, str] = {}


def _get_cwd(sid: str) -> str:
    return _console_cwd_by_sid.get(sid) or os.path.expanduser('~')


class CommandExecutor:
    @staticmethod
    def execute_command(socketio, command: str, socket_id: str, sudo_password: str | None):
        try:
            command = command.strip()
            if not command:
                return

            if not sudo_password:
                socketio.emit(
                    'sudo_required',
                    {'message': 'Sudo password required for the console.'},
                    room=socket_id,
                )
                socketio.emit('console_output', {'output': '[ERROR] Sudo password required'}, room=socket_id)
                return

            cwd = _get_cwd(socket_id)

            # Each subprocess call is stateless, so `cd` is handled here rather
            # than shelled out, and the resulting directory is remembered for
            # the next command on this console session.
            if command == 'cd' or command.startswith('cd '):
                target = command[2:].strip() or os.path.expanduser('~')
                target = os.path.expanduser(target)
                new_path = target if os.path.isabs(target) else os.path.normpath(os.path.join(cwd, target))
                if os.path.isdir(new_path):
                    _console_cwd_by_sid[socket_id] = new_path
                    socketio.emit('console_output', {'output': f'[INFO] {new_path}'}, room=socket_id)
                else:
                    socketio.emit('console_output', {'output': f'[ERROR] No such directory: {target}'}, room=socket_id)
                return

            process = subprocess.Popen(
                ['sudo', '-S', '-p', '', 'bash', '-c', command],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                cwd=cwd,
                text=True,
                bufsize=1,
                universal_newlines=True,
            )

            try:
                process.stdin.write(sudo_password + '\n')
                process.stdin.flush()
                process.stdin.close()
            except Exception:
                pass

            while True:
                output = process.stdout.readline()
                if output:
                    socketio.emit('console_output', {'output': output.rstrip('\n')}, room=socket_id)
                    socketio.sleep(0)

                error = process.stderr.readline()
                if error:
                    text = error.rstrip('\n')
                    lowered = text.lower()
                    if 'incorrect password' in lowered or 'sorry, try again' in lowered:
                        socketio.emit(
                            'sudo_required',
                            {'message': 'Invalid sudo password. Please re-enter it.'},
                            room=socket_id,
                        )
                    socketio.emit('console_output', {'output': f'[ERROR] {text}'}, room=socket_id)
                    socketio.sleep(0)

                if output == '' and error == '' and process.poll() is not None:
                    break

            return_code = process.poll()
            if return_code not in (0, None):
                socketio.emit(
                    'console_output',
                    {'output': f'[ERROR] Command exited with status {return_code}'},
                    room=socket_id,
                )

        except Exception as e:
            socketio.emit('console_output', {'output': f'[ERROR] {e}'}, room=socket_id)


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

            thread = threading.Thread(
                target=CommandExecutor.execute_command,
                args=(socketio, command, request.sid, sudo_password),
            )
            thread.daemon = True
            thread.start()

        except Exception as e:
            socketio.emit('console_output', {'output': f"[ERROR] {str(e)}"}, room=request.sid)

    @socketio.on('join_console')
    def on_join_console():
        if not is_authenticated():
            return
        _console_cwd_by_sid[request.sid] = os.path.expanduser('~')
        socketio.emit(
            'console_output',
            {'output': "[SUCCESS] Connected to console - running as root via sudo. Type 'help' for tips."},
            room=request.sid,
        )

    @socketio.on('disconnect')
    def on_console_disconnect():
        _console_cwd_by_sid.pop(request.sid, None)

    @socketio.on('console_help')
    def handle_console_help():
        help_text = (
            '[INFO] Full shell - pipes, redirects, globs, and cd all work.\n'
            "[INFO] Every command runs as root via 'sudo bash -c'.\n"
            "[INFO] Type 'clear' to clear the screen."
        )
        socketio.emit('console_output', {'output': help_text}, room=request.sid)


__all__ = ['register_console_socket_handlers']
