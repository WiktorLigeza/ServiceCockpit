"""Shared infrastructure used by the features.

auth          login, sudo session, `run_sudo`, `require_sudo`
config_store  config.json settings (favorites, MQTT history, folder prefs)
systemd       systemctl / journalctl wrapper
platform_info Raspberry Pi / Jetson / generic detection
gpu_monitor   background GPU sampling
"""
