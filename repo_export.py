"""Builds a clean, downloadable zip of the current repo state.

This app is public - the export deliberately leaves out anything that isn't
source (venv, caches, git internals) or that's local/sensitive (config.json
holds this device's favorites/MQTT history, .flask_session holds live
session data, any dotenv-style secrets file).
"""

import io
import os
import zipfile
from datetime import datetime

from flask import Blueprint, send_file

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))

EXCLUDE_DIR_NAMES = {
    'venv', '.venv', 'env',
    '.git',
    '__pycache__',
    '.flask_session',
    'node_modules',
    '.pytest_cache',
    '.mypy_cache',
    '.idea',
    '.vscode',
}

EXCLUDE_FILE_NAMES = {
    'config.json',
    '.DS_Store',
}

EXCLUDE_FILE_SUFFIXES = ('.pyc', '.pyo')


def _is_excluded_file(filename: str) -> bool:
    if filename in EXCLUDE_FILE_NAMES:
        return True
    if filename.endswith(EXCLUDE_FILE_SUFFIXES):
        return True
    if filename.startswith('.env'):
        return True
    return False


def build_repo_zip(archive_name: str = 'ServiceCockpit') -> io.BytesIO:
    buffer = io.BytesIO()

    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIR_NAMES)

            for filename in sorted(filenames):
                if _is_excluded_file(filename):
                    continue

                file_path = os.path.join(dirpath, filename)
                rel_path = os.path.relpath(file_path, REPO_ROOT)
                arcname = os.path.join(archive_name, rel_path)

                try:
                    zf.write(file_path, arcname)
                except OSError:
                    continue

    buffer.seek(0)
    return buffer


def build_download_filename() -> str:
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    return f'ServiceCockpit-{timestamp}.zip'


def build_export_blueprint() -> Blueprint:
    bp = Blueprint('repo_export', __name__)

    @bp.route('/api/download_repo')
    def download_repo():
        buffer = build_repo_zip()
        return send_file(
            buffer,
            mimetype='application/zip',
            as_attachment=True,
            download_name=build_download_filename(),
        )

    return bp


__all__ = ['build_repo_zip', 'build_download_filename', 'build_export_blueprint']
