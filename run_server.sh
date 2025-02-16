#!/bin/bash

# Set the working directory
cd "$(dirname "$0")"

# Environment variables
export FLASK_APP=app.py
export FLASK_ENV=production

# Launch with Gunicorn
gunicorn --worker-class eventlet \
         --workers 1 \
         --bind 0.0.0.0:2137 \
         --log-level info \
         app:app
