#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "Step 1: Creating virtual environment if it doesn't exist..."
if [[ ! -d "venv" ]]; then
    python3 -m venv venv
fi

echo "Step 2: Activating virtual environment..."
source venv/bin/activate

echo "Step 3: Installing dependencies..."
pip install -r requirements.txt

read -r -p "Would you like to install and start ServiceCockpit as a systemd service? [y/N] " setup_service
if [[ "$setup_service" =~ ^[Yy]$ ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "systemctl was not found; skipping service setup."
        exit 1
    fi

    service_name="PhantomCockpit.service"
    service_user="${SUDO_USER:-$(id -un)}"
    service_home="$(getent passwd "$service_user" | cut -d: -f6)"
    service_home="${service_home:-$HOME}"

    if ! sudo tee "/etc/systemd/system/$service_name" >/dev/null <<EOF
[Unit]
Description=PhantomCockpit Flask service management app
After=network.target

[Service]
Type=simple
User=$service_user
WorkingDirectory="$SCRIPT_DIR"
ExecStart="$SCRIPT_DIR/run_server.sh"
Restart=always
RestartSec=1s
Environment="HOME=$service_home"

[Install]
WantedBy=multi-user.target
EOF
    then
        echo "Failed to write the systemd service file."
        exit 1
    fi

    if ! sudo systemctl daemon-reload || ! sudo systemctl enable --now "$service_name"; then
        echo "The service file was installed, but enabling or starting the service failed."
        exit 1
    fi

    if ! python -c 'from config_store import load_config, save_favorites; name = "PhantomCockpit.service"; favorites = load_config()["services"]["favorites"]; save_favorites(favorites if name in favorites else favorites + [name])'; then
        echo "The service is running, but could not add it to the service favorites in config.json."
        exit 1
    fi

    echo "PhantomCockpit is enabled and running as $service_name."
    echo "Added $service_name to the service favorites in config.json."
fi
