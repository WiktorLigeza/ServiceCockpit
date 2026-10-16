"""One module (or sub-package) per page or API.

Each exposes `build_<name>_blueprint()` and, when it talks over Socket.IO,
`register_<name>_socket_handlers(socketio)`; `cockpit.create_app` wires them.

services       Services page (start page) - systemd services
processes      Processes page
mqtt           MQTT Explorer page
file_explorer  File Explorer page + program runner
console        Web consoles (root / normal shells)
bluetooth/     Bluetooth page: adapter, pairing, audio, file transfer, serial
network/       Network page: interfaces, link/MTU, Wi-Fi, Wi-Fi Direct, profiles, routes
metrics        Header metrics (CPU, memory, storage, GPU, connectivity, uplink)
updates        "Update available" check against the git remote
export         Zip download of the source tree
"""
