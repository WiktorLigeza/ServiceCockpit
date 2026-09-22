"""Multiple, independent root-or-normal shells over the console socket.

Mirrors the exec-runner pattern used elsewhere in this app (see
file_explorer_feature.py's _ExecSession/_EXEC_SESSIONS): sessions live in a
process-global registry keyed by an opaque id, not tied to any one socket
connection, and clients join a socketio room per session id. That's what lets
a session survive a page navigation (a full reload here, since this isn't a
single-page app) - the browser just re-discovers it via /api/console/sessions
and rejoins its room, instead of losing it the moment the old socket
disconnects. Sessions are only ever torn down by an explicit close (hard kill
via SIGKILL), never implicitly on disconnect.
"""

import fcntl
import os
import pty
import signal
import struct
import subprocess
import termios
import threading
import time
import uuid

from flask import Blueprint, jsonify, request, session
from flask_socketio import join_room, leave_room

from auth import SUDO_SESSION_KEY, is_authenticated


class _ConsoleSession:
    def __init__(self, proc: subprocess.Popen, master_fd: int, cwd: str, sudo: bool):
        self.proc = proc
        self.master_fd = master_fd
        self.cwd = cwd
        self.sudo = sudo
        self.created_at = time.time()


_SESSIONS: dict[str, _ConsoleSession] = {}
_SESSIONS_LOCK = threading.Lock()


def _set_winsize(fd: int, rows: int, cols: int):
    try:
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def _spawn_shell(cwd: str, sudo: bool, sudo_password: str | None):
    master_fd, slave_fd = pty.openpty()
    _set_winsize(slave_fd, 24, 80)

    # The Flask process itself usually has no real TERM (systemd/service
    # launches report TERM=dumb or nothing at all), which tells bash, ls,
    # git, etc. to disable color entirely - even though xterm.js on the other
    # end is a full xterm-256color-capable terminal. Override it so the shell
    # matches what's actually rendering it.
    env = dict(os.environ)
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'

    command = ['sudo', '-S', '-p', '', 'bash'] if sudo else ['bash']

    proc = subprocess.Popen(
        command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=cwd,
        env=env,
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave_fd)

    if sudo:
        # `sudo -S` reads the password as a single line from what is now the
        # pty, then hands off to bash - same one-shot credential the
        # sudo-password modal just validated.
        try:
            os.write(master_fd, (sudo_password + '\n').encode())
        except OSError:
            pass

    return proc, master_fd


def _hard_kill(session_obj: _ConsoleSession):
    """No graceful terminate/wait - the console's close button means stop now."""
    try:
        os.close(session_obj.master_fd)
    except Exception:
        pass
    try:
        os.killpg(os.getpgid(session_obj.proc.pid), signal.SIGKILL)
    except Exception:
        try:
            session_obj.proc.kill()
        except Exception:
            pass


def _reader_loop(socketio, console_id: str, master_fd: int):
    try:
        while True:
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            socketio.emit(
                'console_output',
                {'id': console_id, 'output': chunk.decode('utf-8', errors='replace')},
                room=console_id,
            )
    finally:
        with _SESSIONS_LOCK:
            _SESSIONS.pop(console_id, None)
        socketio.emit('console_exit', {'id': console_id}, room=console_id)


def list_console_sessions() -> list[dict]:
    with _SESSIONS_LOCK:
        return [
            {
                'id': cid,
                'cwd': s.cwd,
                'sudo': s.sudo,
                'created_at': s.created_at,
                'alive': s.proc.poll() is None,
            }
            for cid, s in _SESSIONS.items()
        ]


def register_console_socket_handlers(socketio):
    @socketio.on('open_console')
    def on_open_console(data=None):
        if not is_authenticated():
            return

        sudo = bool((data or {}).get('sudo'))
        requested_cwd = (data or {}).get('cwd')
        cwd = requested_cwd if requested_cwd and os.path.isdir(requested_cwd) else os.path.expanduser('~')

        sudo_password = None
        if sudo:
            sudo_password = session.get(SUDO_SESSION_KEY)
            if not sudo_password:
                socketio.emit(
                    'sudo_required',
                    {'message': 'Sudo password required for a root console.'},
                    room=request.sid,
                )
                return

        try:
            proc, master_fd = _spawn_shell(cwd, sudo, sudo_password)
        except Exception as e:
            socketio.emit('console_error', {'error': f'Could not start console: {e}'}, room=request.sid)
            return

        console_id = uuid.uuid4().hex
        with _SESSIONS_LOCK:
            _SESSIONS[console_id] = _ConsoleSession(proc, master_fd, cwd, sudo)

        join_room(console_id)
        socketio.emit('console_opened', {'id': console_id, 'cwd': cwd, 'sudo': sudo}, room=request.sid)

        thread = threading.Thread(target=_reader_loop, args=(socketio, console_id, master_fd), daemon=True)
        thread.start()

    @socketio.on('attach_console')
    def on_attach_console(data):
        if not is_authenticated():
            return
        console_id = (data or {}).get('id')
        with _SESSIONS_LOCK:
            exists = console_id in _SESSIONS
        if not exists:
            socketio.emit('console_exit', {'id': console_id}, room=request.sid)
            return
        join_room(console_id)

    @socketio.on('console_input')
    def on_console_input(data):
        if not is_authenticated():
            return
        console_id = (data or {}).get('id')
        text = (data or {}).get('data', '')
        if not console_id or not text:
            return
        with _SESSIONS_LOCK:
            session_obj = _SESSIONS.get(console_id)
        if not session_obj:
            return
        try:
            os.write(session_obj.master_fd, text.encode('utf-8', errors='replace'))
        except OSError:
            with _SESSIONS_LOCK:
                _SESSIONS.pop(console_id, None)

    @socketio.on('console_resize')
    def on_console_resize(data):
        console_id = (data or {}).get('id')
        with _SESSIONS_LOCK:
            session_obj = _SESSIONS.get(console_id)
        if not session_obj:
            return
        cols = int((data or {}).get('cols') or 80)
        rows = int((data or {}).get('rows') or 24)
        _set_winsize(session_obj.master_fd, rows, cols)

    @socketio.on('close_console')
    def on_close_console(data):
        if not is_authenticated():
            return
        console_id = (data or {}).get('id')
        with _SESSIONS_LOCK:
            session_obj = _SESSIONS.pop(console_id, None)
        if not session_obj:
            return
        _hard_kill(session_obj)
        socketio.emit('console_closed', {'id': console_id}, room=console_id)
        leave_room(console_id)


def build_console_blueprint() -> Blueprint:
    bp = Blueprint('console_sessions', __name__)

    @bp.route('/api/console/sessions')
    def console_sessions():
        return jsonify({'success': True, 'sessions': list_console_sessions()})

    return bp


__all__ = ['register_console_socket_handlers', 'list_console_sessions', 'build_console_blueprint']
