"""Network page: interfaces, link settings, Wi-Fi, Wi-Fi Direct, profiles, routes.

Modules
-------
shell      timeouts-everywhere wrappers for ip / ethtool / iw / nmcli / wpa_cli / sudo
inventory  read-only view of interfaces, link capabilities, Wi-Fi hardware, routes, DNS
profiles   NetworkManager connection profiles
wifi       Wi-Fi client via NetworkManager or a standalone wpa_supplicant
rollback   auto-revert for changes on the interface the browser is using
p2p        Wi-Fi Direct (groups, peers, setup) through wpa_cli
views      the /network page and its JSON API

Reads run unprivileged (sysfs, `ip -j`, ethtool, iw, nmcli, and wpa_cli via
the netdev group). Changes run through sudo with the session's password.
"""

from .p2p import build_network_p2p_blueprint
from .views import build_network_blueprint

__all__ = ['build_network_blueprint', 'build_network_p2p_blueprint']
