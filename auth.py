from __future__ import annotations

import os
import subprocess
import time
from typing import Tuple

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for

SUDO_SESSION_KEY = 'sudo_password'
AUTH_SESSION_KEY = 'sudo_authenticated'


def is_authenticated() -> bool:
    return bool(session.get(AUTH_SESSION_KEY))


def _sudo_validate(password: str) -> Tuple[bool, str]:
    if not password:
        return False, 'Password required'
    try:
        # IMPORTANT: `sudo -v` can succeed even with a wrong password if a sudo
        # timestamp is already cached. Use `-k` with a harmless command to force
        # sudo to actually verify the provided password.
        result = subprocess.run(
            ['sudo', '-S', '-p', '', '-k', '/usr/bin/true'],
            input=password + '\n',
            text=True,
            capture_output=True,
            timeout=5,
        )
        if result.returncode == 0:
            return True, ''
        stderr = (result.stderr or '').strip()
        return False, stderr or 'Invalid sudo password'
    except Exception as e:
        return False, str(e)


def run_sudo(args: list[str], password: str, input_text: str | None = None, check: bool = True):
    command = ['sudo', '-S', '-p', ''] + args
    stdin = password + '\n'
    if input_text:
        stdin += input_text
    return subprocess.run(
        command,
        input=stdin,
        text=True,
        capture_output=True,
        check=check,
    )


def build_auth_blueprint() -> Blueprint:
    bp = Blueprint('auth', __name__)

    @bp.before_app_request
    def require_login_for_all_pages():
        endpoint = request.endpoint or ''
        # Allow static assets and login/logout endpoints
        if endpoint == 'static' or endpoint in {
            'auth.login',
            'auth.logout',
            'auth.api_sudo_login',
        }:
            return None
        if not is_authenticated():
            next_url = request.full_path if request.query_string else request.path
            return redirect(url_for('auth.login', next=next_url))
        return None

    @bp.route('/login', methods=['GET', 'POST'])
    def login():
        error = ''
        next_url = request.args.get('next') or request.form.get('next') or url_for('services.index')
        if request.method == 'POST':
            password = (request.form.get('password') or '').strip('\n')
            ok, msg = _sudo_validate(password)
            if ok:
                session[AUTH_SESSION_KEY] = True
                session[SUDO_SESSION_KEY] = password
                session['login_time'] = time.time()
                return redirect(next_url)
            error = msg
        return render_template('login.html', error=error, next=next_url)

    @bp.route('/api/sudo/login', methods=['POST'])
    def api_sudo_login():
        try:
            data = request.get_json(silent=True) or {}
            password = (data.get('password') or '').strip('\n')
            ok, msg = _sudo_validate(password)
            if not ok:
                return jsonify({'success': False, 'error': msg or 'Invalid sudo password'}), 401
            session[AUTH_SESSION_KEY] = True
            session[SUDO_SESSION_KEY] = password
            session['login_time'] = time.time()
            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/logout', methods=['GET'])
    def logout():
        session.clear()
        try:
            subprocess.run(['sudo', '-k'], capture_output=True, text=True)
        except Exception:
            pass
        return redirect(url_for('auth.login'))

    @bp.route('/api/reboot', methods=['POST'])
    def api_reboot():
        sudo_password = session.get(SUDO_SESSION_KEY)
        if not sudo_password:
            return (
                jsonify(
                    {
                        'success': False,
                        'error': 'sudo_required',
                        'message': 'Sudo password required to reboot.',
                    }
                ),
                401,
            )
        try:
            run_sudo(['systemctl', 'reboot'], sudo_password, check=False)
            return jsonify({'success': True})
        except subprocess.CalledProcessError as e:
            return jsonify({'success': False, 'error': (e.stderr or str(e)).strip()}), 500
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    return bp


def configure_session(app):
    # Server-side sessions are required because we cannot safely store a sudo password
    # in Flask's default signed-cookie session.
    app.secret_key = os.environ.get('SECRET_KEY') or os.urandom(32)
    app.config.update(
        SESSION_TYPE='filesystem',
        SESSION_FILE_DIR=os.path.join(os.path.dirname(__file__), '.flask_session'),
        SESSION_PERMANENT=False,
        SESSION_USE_SIGNER=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
    )


__all__ = [
    'AUTH_SESSION_KEY',
    'SUDO_SESSION_KEY',
    'build_auth_blueprint',
    'configure_session',
    'is_authenticated',
    'run_sudo',
]
