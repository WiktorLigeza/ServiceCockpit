"""A real, interactive root shell over the console socket.

Each console session gets its own pseudo-terminal running `sudo bash`, so the
frontend (xterm.js) gets genuine terminal behavior - colors, prompts, tab
completion, job control, ctrl-c, resizing, even full-screen programs like
top/nano - instead of a line-oriented command runner. There is no command
allowlist by design: the console is already gated behind a fresh sudo-password
prompt before it opens (see the frontend), and every command runs as root
regardless, so filtering *which* commands can run would be theater, not
security.
"""

import fcntl
import os
import pty
import signal
import struct
import subprocess
import termios
import threading

from flask import request, session

from auth import SUDO_SESSION_KEY, is_authenticated

# sid -> {'proc': subprocess.Popen, 'master_fd': int}
_sessions: dict[str, dict] = {}


def _set_winsize(fd: int, rows: int, cols: int):
    try:
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def _spawn_shell(sudo_password: str, cwd: str):
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

    proc = subprocess.Popen(
        ['sudo', '-S', '-p', '', 'bash'],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=cwd,
        env=env,
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave_fd)

    # `sudo -S` reads the password as a single line from what is now the pty,
    # then hands off to bash - same one-shot credential the sudo-password
    # modal just validated before the console was allowed to open.
    try:
        os.write(master_fd, (sudo_password + '\n').encode())
    except OSError:
        pass

    return proc, master_fd


def _cleanup_session(sid: str):
    entry = _sessions.pop(sid, None)
    if not entry:
        return
    try:
        os.close(entry['master_fd'])
    except Exception:
        pass
    proc = entry.get('proc')
    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass


def _reader_loop(socketio, sid: str, master_fd: int):
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
                {'output': chunk.decode('utf-8', errors='replace')},
                room=sid,
            )
    finally:
        _cleanup_session(sid)
        socketio.emit('console_exit', {}, room=sid)


def register_console_socket_handlers(socketio):
    @socketio.on('join_console')
    def on_join_console(data=None):
        if not is_authenticated():
            return

        sid = request.sid
        if sid in _sessions:
            return  # already has a live shell

        sudo_password = session.get(SUDO_SESSION_KEY)
        if not sudo_password:
            socketio.emit(
                'sudo_required',
                {'message': 'Sudo password required for the console.'},
                room=sid,
            )
            return

        requested_cwd = (data or {}).get('cwd')
        cwd = requested_cwd if requested_cwd and os.path.isdir(requested_cwd) else os.path.expanduser('~')

        try:
            proc, master_fd = _spawn_shell(sudo_password, cwd)
        except Exception as e:
            socketio.emit('console_output', {'output': f'\r\n[ERROR] Could not start console: {e}\r\n'}, room=sid)
            return

        _sessions[sid] = {'proc': proc, 'master_fd': master_fd}
        thread = threading.Thread(target=_reader_loop, args=(socketio, sid, master_fd), daemon=True)
        thread.start()

    @socketio.on('console_input')
    def on_console_input(data):
        sid = request.sid
        if not is_authenticated():
            return
        entry = _sessions.get(sid)
        if not entry:
            return
        text = (data or {}).get('data', '')
        if not text:
            return
        try:
            os.write(entry['master_fd'], text.encode('utf-8', errors='replace'))
        except OSError:
            _cleanup_session(sid)

    @socketio.on('console_resize')
    def on_console_resize(data):
        entry = _sessions.get(request.sid)
        if not entry:
            return
        cols = int((data or {}).get('cols') or 80)
        rows = int((data or {}).get('rows') or 24)
        _set_winsize(entry['master_fd'], rows, cols)

    @socketio.on('disconnect')
    def on_console_disconnect():
        _cleanup_session(request.sid)


__all__ = ['register_console_socket_handlers']
