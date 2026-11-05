"""Long-running privileged tasks (install / update / login) shown with a live log.

A feature keeps one `BackgroundJob`; only one task of that feature runs at a
time. Steps call `job.stream([...], password)` to run a command through sudo
with its output appended to the job log, which the page polls via `view()`.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
from typing import Callable

PACKAGE_MANAGERS = ('apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk')


def package_manager() -> str | None:
    for name in PACKAGE_MANAGERS:
        if shutil.which(name):
            return name
    return None


def install_commands(manager: str | None, packages: dict[str, list[str]]) -> list[list[str]]:
    """Commands that install `packages[manager]` non-interactively ([] if unsupported)."""
    pkgs = packages.get(manager or '') or []
    if not pkgs:
        return []
    return {
        'apt-get': [['apt-get', 'update'], ['apt-get', 'install', '-y', *pkgs]],
        'dnf': [['dnf', 'install', '-y', *pkgs]],
        'yum': [['yum', 'install', '-y', *pkgs]],
        'zypper': [['zypper', '--non-interactive', 'install', *pkgs]],
        'pacman': [['pacman', '-Sy', '--noconfirm', '--needed', *pkgs]],
        'apk': [['apk', 'add', *pkgs]],
    }.get(manager, [])


NONINTERACTIVE = {'DEBIAN_FRONTEND': 'noninteractive'}


class BackgroundJob:
    def __init__(self, link_pattern: str | None = None, max_lines: int = 800):
        self._lock = threading.Lock()
        self._link_re = re.compile(link_pattern) if link_pattern else None
        self._max_lines = max_lines
        self._state = {'id': 0, 'kind': None, 'state': 'idle', 'log': [], 'link': None,
                       'started': None, 'finished': None}
        self._proc: subprocess.Popen | None = None

    # -- state

    def view(self) -> dict:
        with self._lock:
            return {**self._state, 'log': list(self._state['log'])}

    @property
    def running(self) -> bool:
        with self._lock:
            return self._state['state'] == 'running'

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._state['state'] == 'cancelled'

    def log(self, line: str) -> None:
        line = line.rstrip('\n')
        with self._lock:
            log = self._state['log']
            log.append(line)
            del log[:-self._max_lines]
            if self._link_re and not self._state['link']:
                match = self._link_re.search(line)
                if match:
                    self._state['link'] = match.group(0)

    # -- running

    def start(self, kind: str, steps: Callable[[], bool]) -> tuple[bool, str]:
        """Run `steps()` in a thread; its return value decides done / failed."""
        with self._lock:
            if self._state['state'] == 'running':
                return False, f'Another task is still running ({self._state["kind"]}).'
            self._state.update({'id': self._state['id'] + 1, 'kind': kind, 'state': 'running', 'log': [],
                                'link': None, 'started': time.time(), 'finished': None})

        def runner():
            try:
                ok = bool(steps())
            except Exception as e:
                self.log(f'Error: {e}')
                ok = False
            with self._lock:
                if self._state['state'] == 'running':
                    self._state['state'] = 'done' if ok else 'failed'
                self._state['finished'] = time.time()

        threading.Thread(target=runner, daemon=True).start()
        return True, ''

    def stream(self, args: list[str], password: str, timeout: float = 600,
               env: dict | None = None, input_text: str | None = None, echo: bool = False) -> bool:
        """Run `sudo args`, appending merged stdout/stderr to the log. False on failure,
        timeout or cancel (and without running at all once the job was cancelled)."""
        if self.cancelled:
            return False
        if echo:
            self.log(f'$ {" ".join(args)}')
        command = ['sudo', '-S', '-k', '-p', '']
        if env:
            command += ['env', *[f'{k}={v}' for k, v in env.items()]]
        command += args
        try:
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
        except Exception as e:
            self.log(f'Failed to start {args[0]}: {e}')
            return False
        with self._lock:
            self._proc = proc
        try:
            proc.stdin.write(password + '\n' + (input_text or ''))
            proc.stdin.close()
        except Exception:
            pass

        timer = threading.Timer(timeout, proc.kill)
        timer.start()
        try:
            for line in proc.stdout:
                self.log(line)
            code = proc.wait()
        finally:
            timer.cancel()
            with self._lock:
                self._proc = None
        if code < 0:
            self.log(f'{args[0]} was stopped (timeout or cancelled).')
        return code == 0

    def cancel(self) -> bool:
        with self._lock:
            if self._state['state'] != 'running':
                return False
            self._state['state'] = 'cancelled'
            proc = self._proc
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
        self.log('Cancelled.')
        return True


__all__ = ['BackgroundJob', 'NONINTERACTIVE', 'install_commands', 'package_manager']
