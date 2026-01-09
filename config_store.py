import json
import os

CONFIG_FILE = 'config.json'


MAX_MQTT_CONNECTION_HISTORY = 10


def load_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(
                {
                    'services': {'favorites': []},
                    'folders': {'preferences': {}},
                    'processes': {'favorites': []},
                    'mqtt': {
                        'connections': {'history': [], 'last': {'host': 'localhost', 'port': 1883}},
                    },
                },
                f,
            )
    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)

    # Backwards compatible defaults
    if 'services' not in config:
        config['services'] = {}
    if 'favorites' not in config['services']:
        config['services']['favorites'] = []

    if 'folders' not in config:
        config['folders'] = {}
    if 'preferences' not in config['folders']:
        config['folders']['preferences'] = {}

    if 'processes' not in config:
        config['processes'] = {}
    if 'favorites' not in config['processes']:
        config['processes']['favorites'] = []

    if 'mqtt' not in config:
        config['mqtt'] = {}
    if 'connections' not in config['mqtt']:
        config['mqtt']['connections'] = {}
    if 'history' not in config['mqtt']['connections']:
        config['mqtt']['connections']['history'] = []
    if 'last' not in config['mqtt']['connections']:
        config['mqtt']['connections']['last'] = {'host': 'localhost', 'port': 1883}

    # Validate last connection
    last = config['mqtt']['connections'].get('last') or {}
    if not isinstance(last, dict):
        last = {}
    host = last.get('host') or 'localhost'
    try:
        port = int(last.get('port') or 1883)
    except Exception:
        port = 1883
    config['mqtt']['connections']['last'] = {'host': host, 'port': port}

    # Normalize history entries
    history = config['mqtt']['connections'].get('history')
    if not isinstance(history, list):
        history = []
    normalized_history: list[dict] = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        h = (entry.get('host') or '').strip() or None
        if not h:
            continue
        try:
            p = int(entry.get('port') or 1883)
        except Exception:
            p = 1883
        normalized_history.append({'host': h, 'port': p})
    config['mqtt']['connections']['history'] = normalized_history[:MAX_MQTT_CONNECTION_HISTORY]

    return config


def get_mqtt_connection_settings() -> dict:
    config = load_config()
    return config.get('mqtt', {}).get('connections', {'history': [], 'last': {'host': 'localhost', 'port': 1883}})


def save_mqtt_connection(host: str, port: int) -> None:
    host = (host or '').strip() or 'localhost'
    try:
        port = int(port)
    except Exception:
        port = 1883

    config = load_config()
    mqtt_cfg = config.setdefault('mqtt', {})
    connections = mqtt_cfg.setdefault('connections', {})
    history = connections.setdefault('history', [])
    if not isinstance(history, list):
        history = []

    # Move existing entry to the end, then append.
    history = [h for h in history if not (isinstance(h, dict) and h.get('host') == host and int(h.get('port') or 0) == port)]
    history.append({'host': host, 'port': port})
    connections['history'] = history[-MAX_MQTT_CONNECTION_HISTORY:]
    connections['last'] = {'host': host, 'port': port}
    save_config(config)


def save_config(config: dict) -> None:
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)


def save_favorites(favorites: list) -> None:
    config = load_config()
    if 'services' not in config:
        config['services'] = {}
    config['services']['favorites'] = favorites
    save_config(config)


def save_process_favorites(favorites: list[str]) -> None:
    config = load_config()
    if 'processes' not in config:
        config['processes'] = {}
    config['processes']['favorites'] = favorites
    save_config(config)


def save_folder_preferences(preferences: dict) -> None:
    config = load_config()
    if 'folders' not in config:
        config['folders'] = {}
    config['folders']['preferences'] = preferences
    save_config(config)


def get_folder_preferences() -> dict:
    config = load_config()
    return config.get('folders', {}).get('preferences', {})
