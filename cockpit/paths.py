"""Filesystem locations, resolved from the project root.

Everything that used to be relative to the working directory or to a
module's own file lives here, so modules can move without breaking paths.
"""

import os

# Repository root: the directory holding app.py, templates/ and static/.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEMPLATE_DIR = os.path.join(PROJECT_ROOT, 'templates')
STATIC_DIR = os.path.join(PROJECT_ROOT, 'static')

# User settings (favorites, MQTT connections, ...). Not tracked by git.
CONFIG_FILE = os.path.join(PROJECT_ROOT, 'config.json')

# Server-side Flask sessions.
SESSION_DIR = os.path.join(PROJECT_ROOT, '.flask_session')
