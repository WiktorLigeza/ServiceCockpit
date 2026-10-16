"""Response helpers shared by the network blueprints."""

from __future__ import annotations

from flask import jsonify

from cockpit.core.auth import require_sudo  # re-exported for the network views

__all__ = ['require_sudo', 'result']


def result(ok: bool, output: str = '', status: int = 200, **extra):
    """JSON body {success, output, error?}; failures default to HTTP 400."""
    body = {'success': ok, 'output': output, **extra}
    if not ok:
        body['error'] = output or 'Command failed'
    return jsonify(body), status if ok else (status if status != 200 else 400)
