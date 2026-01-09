import shutil
import stat
from pathlib import Path

from flask import Blueprint, jsonify, render_template, request

from config_store import get_folder_preferences, save_folder_preferences


def format_size(bytes_size: float) -> str:
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"


def build_file_explorer_blueprint() -> Blueprint:
    bp = Blueprint('file_explorer', __name__)

    @bp.route('/file_explorer')
    def file_explorer():
        return render_template('file_explorer.html')

    @bp.route('/api/files')
    def get_files():
        try:
            path = request.args.get('path', '/home')
            path_obj = Path(path)

            if not path_obj.exists():
                return jsonify({'success': False, 'error': 'Path does not exist'})

            if not path_obj.is_dir():
                return jsonify({'success': False, 'error': 'Path is not a directory'})

            files = []
            for item in path_obj.iterdir():
                try:
                    stat_info = item.stat()

                    files.append(
                        {
                            'name': item.name,
                            'path': str(item),
                            'is_directory': item.is_dir(),
                            'size': stat_info.st_size if item.is_file() else 0,
                            'permissions': stat.filemode(stat_info.st_mode),
                            'modified': stat_info.st_mtime,
                        }
                    )
                except (PermissionError, OSError):
                    continue

            return jsonify({'success': True, 'files': files})
        except PermissionError as e:
            return jsonify({'success': False, 'error': f'Permission denied: {str(e)}'})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/folder-size')
    def get_folder_size():
        try:
            path = request.args.get('path')
            if not path:
                return jsonify({'success': False, 'error': 'Path parameter required'}), 400

            path_obj = Path(path)

            if not path_obj.exists():
                return jsonify({'success': False, 'error': 'Path does not exist'}), 404

            if not path_obj.is_dir():
                return jsonify({'success': False, 'error': 'Path is not a directory'}), 400

            try:
                total_size = sum(f.stat().st_size for f in path_obj.rglob('*') if f.is_file())
                size_display = format_size(total_size)

                return jsonify({'success': True, 'size': total_size, 'size_display': size_display})
            except (PermissionError, OSError):
                return jsonify({'success': False, 'error': 'Permission denied or unable to calculate size'}), 403

        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/api/file-details')
    def get_file_details():
        try:
            path = request.args.get('path')
            if not path:
                return jsonify({'success': False, 'error': 'Path parameter required'}), 400

            path_obj = Path(path)

            if not path_obj.exists():
                return jsonify({'success': False, 'error': 'File does not exist'}), 404

            stat_info = path_obj.stat()

            try:
                import pwd

                owner = pwd.getpwuid(stat_info.st_uid).pw_name
            except Exception:
                owner = str(stat_info.st_uid)

            details = {
                'owner': owner,
                'modified': stat_info.st_mtime,
                'accessed': stat_info.st_atime,
                'created': stat_info.st_ctime,
            }

            return jsonify({'success': True, 'details': details})
        except PermissionError:
            return jsonify({'success': False, 'error': 'Permission denied'}), 403
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/api/create-folder', methods=['POST'])
    def create_folder():
        try:
            data = request.json
            path = data.get('path')
            name = data.get('name')

            if not path or not name:
                return jsonify({'success': False, 'error': 'Path and name required'})

            new_folder = Path(path) / name
            new_folder.mkdir(parents=True, exist_ok=False)

            return jsonify({'success': True})
        except FileExistsError:
            return jsonify({'success': False, 'error': 'Folder already exists'})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/create-file', methods=['POST'])
    def create_file():
        try:
            data = request.json
            path = data.get('path')
            name = data.get('name')

            if not path or not name:
                return jsonify({'success': False, 'error': 'Path and name required'})

            new_file = Path(path) / name
            new_file.touch(exist_ok=False)

            return jsonify({'success': True})
        except FileExistsError:
            return jsonify({'success': False, 'error': 'File already exists'})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/delete', methods=['POST'])
    def delete_item():
        try:
            data = request.json
            path = data.get('path')
            is_directory = data.get('is_directory', False)

            if not path:
                return jsonify({'success': False, 'error': 'Path required'})

            path_obj = Path(path)

            if not path_obj.exists():
                return jsonify({'success': False, 'error': 'Path does not exist'})

            if is_directory:
                shutil.rmtree(path_obj)
            else:
                path_obj.unlink()

            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/rename', methods=['POST'])
    def rename_item():
        try:
            data = request.json
            old_path = data.get('old_path')
            new_name = data.get('new_name')

            if not old_path or not new_name:
                return jsonify({'success': False, 'error': 'Old path and new name required'})

            old_path_obj = Path(old_path)
            new_path_obj = old_path_obj.parent / new_name

            if new_path_obj.exists():
                return (
                    jsonify({'success': False, 'error': 'A file or folder with that name already exists'}),
                    400,
                )

            old_path_obj.rename(new_path_obj)

            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/move', methods=['POST'])
    def move_item():
        try:
            data = request.json
            source_path = data.get('source_path')
            destination_path = data.get('destination_path')

            if not source_path or not destination_path:
                return jsonify({'success': False, 'error': 'Source and destination paths required'})

            source_obj = Path(source_path)
            dest_dir_obj = Path(destination_path)

            if not source_obj.exists():
                return jsonify({'success': False, 'error': 'Source does not exist'})

            if not dest_dir_obj.is_dir():
                return jsonify({'success': False, 'error': 'Destination must be a directory'})

            if source_obj.is_dir() and dest_dir_obj.is_relative_to(source_obj):
                return jsonify({'success': False, 'error': 'Cannot move a folder into itself or its subdirectory'})

            destination_path_obj = dest_dir_obj / source_obj.name

            if destination_path_obj.exists():
                return jsonify({'success': False, 'error': 'An item with that name already exists in the destination'})

            shutil.move(str(source_obj), str(destination_path_obj))

            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/paste', methods=['POST'])
    def paste_item():
        try:
            data = request.json
            source_path = data.get('source_path')
            destination_path = data.get('destination_path')
            is_cut = data.get('is_cut', False)

            if not source_path or not destination_path:
                return jsonify({'success': False, 'error': 'Source and destination paths required'})

            source_obj = Path(source_path)
            dest_dir_obj = Path(destination_path)

            if not source_obj.exists():
                return jsonify({'success': False, 'error': 'Source does not exist'})

            if not dest_dir_obj.is_dir():
                return jsonify({'success': False, 'error': 'Destination must be a directory'})

            destination_path_obj = dest_dir_obj / source_obj.name

            if destination_path_obj.exists():
                base_name = source_obj.stem
                extension = source_obj.suffix
                counter = 1

                while destination_path_obj.exists():
                    if source_obj.is_dir():
                        new_name = f"{source_obj.name}_copy{counter}"
                    else:
                        new_name = f"{base_name}_copy{counter}{extension}"
                    destination_path_obj = dest_dir_obj / new_name
                    counter += 1

            if is_cut:
                shutil.move(str(source_obj), str(destination_path_obj))
            else:
                if source_obj.is_dir():
                    shutil.copytree(str(source_obj), str(destination_path_obj))
                else:
                    shutil.copy2(str(source_obj), str(destination_path_obj))

            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/directories')
    def get_directories():
        try:
            path = request.args.get('path', '/')
            path_obj = Path(path)

            if not path_obj.exists() or not path_obj.is_dir():
                return jsonify({'success': False, 'error': 'Invalid directory'})

            directories = []
            for item in path_obj.iterdir():
                try:
                    if item.is_dir():
                        directories.append({'name': item.name, 'path': str(item)})
                except (PermissionError, OSError):
                    continue

            directories.sort(key=lambda x: x['name'].lower())

            return jsonify({'success': True, 'directories': directories})
        except PermissionError:
            return jsonify({'success': False, 'error': 'Permission denied'})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/download')
    def download_file():
        from flask import send_file

        try:
            path = request.args.get('path')
            return send_file(path, as_attachment=True)
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/read-file')
    def read_file_route():
        try:
            path = request.args.get('path')
            if not path:
                return jsonify({'success': False, 'error': 'Path parameter required'}), 400

            path_obj = Path(path)

            if not path_obj.exists():
                return jsonify({'success': False, 'error': 'File does not exist'}), 404

            if path_obj.is_dir():
                return jsonify({'success': False, 'error': 'Cannot read directory'}), 400

            try:
                with open(path_obj, 'r', encoding='utf-8') as f:
                    content = f.read()
                return jsonify({'success': True, 'content': content})
            except UnicodeDecodeError:
                return jsonify({'success': False, 'error': 'Cannot read binary file'}), 400

        except PermissionError:
            return jsonify({'success': False, 'error': 'Permission denied'}), 403
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/api/write-file', methods=['POST'])
    def write_file_route():
        try:
            data = request.json
            path = data.get('path')
            content = data.get('content')

            if not path:
                return jsonify({'success': False, 'error': 'Path required'})

            path_obj = Path(path)

            if not path_obj.exists():
                return jsonify({'success': False, 'error': 'File does not exist'})

            if path_obj.is_dir():
                return jsonify({'success': False, 'error': 'Cannot write to directory'})

            backup_path = str(path_obj) + '.backup'
            if path_obj.exists():
                shutil.copy2(path_obj, backup_path)

            try:
                with open(path_obj, 'w', encoding='utf-8') as f:
                    f.write(content)

                if Path(backup_path).exists():
                    Path(backup_path).unlink()

                return jsonify({'success': True})
            except Exception:
                if Path(backup_path).exists():
                    shutil.copy2(backup_path, path_obj)
                    Path(backup_path).unlink()
                raise

        except PermissionError:
            return jsonify({'success': False, 'error': 'Permission denied'}), 403
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/api/upload', methods=['POST'])
    def upload_file():
        try:
            if 'file' not in request.files:
                return jsonify({'success': False, 'error': 'No file provided'})

            file = request.files['file']
            target_path = request.form.get('path', '/home')

            if file.filename == '':
                return jsonify({'success': False, 'error': 'No file selected'})

            from werkzeug.utils import secure_filename

            filename = secure_filename(file.filename)

            target_dir = Path(target_path)
            if not target_dir.exists() or not target_dir.is_dir():
                return jsonify({'success': False, 'error': 'Invalid target directory'})

            file_path = target_dir / filename

            if file_path.exists():
                base_name = file_path.stem
                extension = file_path.suffix
                counter = 1

                while file_path.exists():
                    new_name = f"{base_name}_{counter}{extension}"
                    file_path = target_dir / new_name
                    counter += 1

            file.save(str(file_path))

            return jsonify({'success': True, 'filename': file_path.name})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/folder-preferences', methods=['GET'])
    def get_folder_preferences_route():
        try:
            preferences = get_folder_preferences()
            return jsonify({'success': True, 'preferences': preferences})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/api/folder-preferences', methods=['POST'])
    def save_folder_preferences_route():
        try:
            data = request.json
            preferences = data.get('preferences', {})
            save_folder_preferences(preferences)
            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    return bp


__all__ = ['build_file_explorer_blueprint']
