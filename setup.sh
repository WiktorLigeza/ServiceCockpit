#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Run privileged commands directly when root, via sudo otherwise.
if [[ $EUID -eq 0 ]]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO="__missing_sudo__"
fi

need_root() {
    if [[ "$SUDO" == "__missing_sudo__" ]]; then
        echo "Root privileges are needed for: $1"
        echo "sudo is not installed. Rerun this script as root, or install sudo first."
        exit 1
    fi
}

# Install system packages with whatever package manager this distro uses.
# Usage: pkg_install <apt pkgs> -- <dnf/yum/zypper pkgs> -- <pacman pkgs> -- <apk pkgs>
pkg_install() {
    local apt=() rpm=() pac=() apk=() target=apt
    for arg in "$@"; do
        if [[ "$arg" == "--" ]]; then
            case $target in apt) target=rpm ;; rpm) target=pac ;; pac) target=apk ;; esac
            continue
        fi
        case $target in
            apt) apt+=("$arg") ;; rpm) rpm+=("$arg") ;; pac) pac+=("$arg") ;; apk) apk+=("$arg") ;;
        esac
    done

    if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update && $SUDO apt-get install -y "${apt[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        $SUDO dnf install -y "${rpm[@]}"
    elif command -v yum >/dev/null 2>&1; then
        $SUDO yum install -y "${rpm[@]}"
    elif command -v zypper >/dev/null 2>&1; then
        $SUDO zypper --non-interactive install "${rpm[@]}"
    elif command -v pacman >/dev/null 2>&1; then
        $SUDO pacman -Sy --noconfirm --needed "${pac[@]}"
    elif command -v apk >/dev/null 2>&1; then
        $SUDO apk add "${apk[@]}"
    else
        echo "No supported package manager found (apt, dnf, yum, zypper, pacman, apk)."
        return 1
    fi
}

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 was not found; installing it..."
    need_root "installing python3"
    if ! pkg_install python3 python3-venv -- python3 -- python -- python3; then
        echo "Could not install python3. Install it manually and rerun this script."
        exit 1
    fi
fi

echo "Step 1: Creating virtual environment if it doesn't exist..."
# Debian-family distros ship python3 without ensurepip (python3-venv);
# most other distros include it. Install it if missing.
if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
    py_ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    echo "Python venv support (ensurepip) is missing; installing it..."
    need_root "installing python venv support"
    if ! pkg_install "python${py_ver}-venv" -- python3-pip -- python-pip -- py3-pip \
        && ! pkg_install python3-venv -- python3-pip -- python-pip -- py3-pip; then
        echo "Could not install Python venv support. Install it manually and rerun this script."
        exit 1
    fi
fi

# A previous failed attempt can leave a venv directory without pip; rebuild it.
if [[ -d "venv" && ! -x "venv/bin/pip" ]]; then
    echo "Found an incomplete virtual environment; recreating it..."
    rm -rf venv
fi
if [[ ! -d "venv" ]]; then
    if ! python3 -m venv venv; then
        echo "Failed to create the virtual environment."
        exit 1
    fi
fi

echo "Step 2: Activating virtual environment..."
source venv/bin/activate

echo "Step 3: Installing dependencies..."
if ! venv/bin/pip install -r requirements.txt; then
    echo "Failed to install dependencies."
    exit 1
fi

read -r -p "Would you like to install and start ServiceCockpit as a systemd service? [y/N] " setup_service
if [[ "$setup_service" =~ ^[Yy]$ ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "systemctl was not found; skipping service setup."
        exit 1
    fi
    need_root "installing the systemd service"

    service_name="PhantomCockpit.service"
    service_user="${SUDO_USER:-$(id -un)}"
    service_home="$(getent passwd "$service_user" | cut -d: -f6)"
    service_home="${service_home:-$HOME}"

    if ! $SUDO tee "/etc/systemd/system/$service_name" >/dev/null <<EOF
[Unit]
Description=PhantomCockpit Flask service management app
After=network.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$SCRIPT_DIR
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

    if ! $SUDO systemctl daemon-reload || ! $SUDO systemctl enable --now "$service_name"; then
        echo "The service file was installed, but enabling or starting the service failed."
        exit 1
    fi

    if ! venv/bin/python -c'from cockpit.core.config_store import load_config, save_favorites; name = "PhantomCockpit.service"; favorites = load_config()["services"]["favorites"]; save_favorites(favorites if name in favorites else favorites + [name])'; then
        echo "The service is running, but could not add it to the service favorites in config.json."
        exit 1
    fi

    echo "PhantomCockpit is enabled and running as $service_name."
    echo "Added $service_name to the service favorites in config.json."
fi
