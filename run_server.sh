#!/bin/bash

# Set the working directory
if [ -n "$1" ]; then
    cd "$1"
else
    cd "$(dirname "$0")"
fi
source venv/bin/activate

# Launch the Flask app
python app.py
