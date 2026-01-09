import json
import os

CONFIG_FILE = 'config.json'


def load_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(
                {
                    'services': {'favorites': []},
                    'folders': {'preferences': {}},
                    'processes': {'favorites': []},
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

    return config


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
