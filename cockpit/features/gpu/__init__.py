"""GPU Manager page: NVIDIA GPU detection, live stats and a driver install wizard.

Shown only on regular Linux boxes with a discrete NVIDIA GPU - Jetson boards
get their GPU driver from JetPack and are left alone (see core/platform_info).

  detect.py      sysfs-based detection, driver state, nvidia-smi stats
  installers.py  per-distro install / remove (Ubuntu, Debian, Fedora, RHEL,
                 Arch, Manjaro, openSUSE)
"""

from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from cockpit.core.auth import require_sudo
from cockpit.core.jobs import BackgroundJob
from cockpit.core.platform_info import get_jetson_info
from cockpit.features.gpu import detect, installers

_job = BackgroundJob()


def _reply(ok: bool, message: str = '', status: int = 400):
    body = {'success': ok}
    if not ok:
        body['error'] = message or 'Failed'
    return jsonify(body), 200 if ok else status


def get_gpu_status() -> dict:
    if not detect.applicable():
        return {'applicable': False, 'jetson': get_jetson_info()['is_jetson'], 'job': _job.view()}
    method, osr = installers.detect_method()
    return {
        'applicable': True,
        **detect.driver_state(),
        'secure_boot': detect.secure_boot(),
        'method': method,
        'method_label': installers.METHOD_LABELS.get(method),
        'distro': osr.get('PRETTY_NAME'),
        'job': _job.view(),
    }


def sidebar_gpu_context() -> dict:
    """For the sidebar on every page: sysfs reads only, no subprocesses."""
    try:
        if not detect.applicable():
            return {'nvidia_gpu': None}
        return {'nvidia_gpu': {'needs_setup': detect.needs_setup()}}
    except Exception:
        return {'nvidia_gpu': None}


def build_gpu_blueprint() -> Blueprint:
    bp = Blueprint('gpu', __name__)

    @bp.app_context_processor
    def inject_gpu():
        return sidebar_gpu_context()

    @bp.route('/gpu')
    def gpu_page():
        return render_template('gpu.html')

    @bp.route('/api/gpu/status')
    def api_status():
        return jsonify(get_gpu_status())

    @bp.route('/api/gpu/stats')
    def api_stats():
        if not detect.applicable():
            return jsonify({'ok': False, 'error': 'No NVIDIA GPU', 'gpus': [], 'processes': []})
        return jsonify(detect.live_stats())

    @bp.route('/api/gpu/drivers')
    def api_drivers():
        if not detect.applicable():
            return jsonify({'supported': False, 'options': [], 'warnings': ['No NVIDIA GPU detected.']})
        gpus = detect.driver_state()['gpus']
        return jsonify(installers.install_plan(gpus, force=request.args.get('refresh') == '1'))

    @bp.route('/api/gpu/job')
    def api_job():
        return jsonify(_job.view())

    @bp.route('/api/gpu/job/cancel', methods=['POST'])
    def api_job_cancel():
        return _reply(_job.cancel(), 'Nothing to cancel', 409)

    @bp.route('/api/gpu/install', methods=['POST'])
    def api_install():
        password, err = require_sudo()
        if err:
            return err
        if not detect.applicable():
            return _reply(False, 'No NVIDIA GPU detected (or this is a Jetson).', 409)
        option = (request.get_json(silent=True) or {}).get('option')
        plan = installers.install_plan(detect.driver_state()['gpus'])
        if not plan['supported'] or option not in {o['id'] for o in plan['options']}:
            return _reply(False, 'This driver option is not available here.')
        method = plan['method']
        # Package installs must not be interrupted halfway.
        return _reply(*_job.start('install', lambda: installers.run_install(_job, password, method, option),
                                  cancellable=False), status=409)

    @bp.route('/api/gpu/remove', methods=['POST'])
    def api_remove():
        password, err = require_sudo()
        if err:
            return err
        method, _ = installers.detect_method()
        if not detect.applicable() or not method:
            return _reply(False, 'Removing the driver is not supported here.', 409)
        return _reply(*_job.start('remove', lambda: installers.run_remove(_job, password, method),
                                  cancellable=False), status=409)

    @bp.route('/api/gpu/persistence', methods=['POST'])
    def api_persistence():
        password, err = require_sudo()
        if err:
            return err
        enabled = bool((request.get_json(silent=True) or {}).get('enabled'))

        def steps():
            return _job.stream(['nvidia-smi', '-pm', '1' if enabled else '0'], password, 30, echo=True)
        return _reply(*_job.start('persistence', steps), status=409)

    return bp


__all__ = ['build_gpu_blueprint', 'get_gpu_status']
