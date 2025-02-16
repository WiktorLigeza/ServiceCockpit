#!/bin/bash

# Set the working directory
cd "$(dirname "$0")"

# Environment variables
export FLASK_APP=app.py
export FLASK_ENV=production

# Launch with Gunicorn using Socket.IO worker
gunicorn --worker-class eventlet \
         --workers 1 \
         --worker-connections 1000 \
         --bind 0.0.0.0:2137 \
         --log-level info \
         --timeout 120 \
         --keep-alive 65 \
         app:app
