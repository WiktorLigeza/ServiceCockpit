"""Automatic rollback for changes that could cut the browser off.

A change to the interface the page is served over (MTU, forced link speed,
new static IP...) is applied together with the commands that undo it. Unless
the browser confirms within REVERT_SECONDS, the undo commands run.
"""

from __future__ import annotations

import threading
import time
import uuid

from .shell import sudo_all

REVERT_SECONDS = 30

_pending: dict[str, dict] = {}
_pending_lock = threading.Lock()


def schedule_revert(description: str, revert_cmds: list[list[str]], password: str) -> dict:
    token = uuid.uuid4().hex
    deadline = time.time() + REVERT_SECONDS

    def expire():
        with _pending_lock:
            entry = _pending.pop(token, None)
        if entry:
            sudo_all(entry['revert'], entry['password'])

    timer = threading.Timer(REVERT_SECONDS, expire)
    timer.daemon = True
    with _pending_lock:
        _pending[token] = {'revert': revert_cmds, 'password': password, 'timer': timer, 'description': description}
    timer.start()
    return {'token': token, 'seconds': REVERT_SECONDS, 'deadline': deadline, 'description': description}


def resolve_revert(token: str, keep: bool) -> tuple[bool, str]:
    with _pending_lock:
        entry = _pending.pop(token, None)
    if not entry:
        return False, 'Nothing pending (it may already have been rolled back)'
    entry['timer'].cancel()
    if keep:
        return True, 'Changes kept'
    return sudo_all(entry['revert'], entry['password'])
