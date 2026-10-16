from __future__ import annotations

import os
import signal
import threading
import time
from collections import defaultdict

import psutil
from flask import Blueprint, jsonify, render_template, request, session

from auth import SUDO_SESSION_KEY, run_sudo
from config_store import load_config, save_process_favorites


def normalize_process_cpu_percent(cpu_percent) -> float:
    """Normalize psutil per-process CPU% to 0..100 across multi-core systems."""
    try:
        value = float(cpu_percent or 0.0)
        cores = psutil.cpu_count() or 1
        if not isinstance(cores, int) or cores < 1:
            cores = 1
        value = value / float(cores)
        if value < 0.0:
            return 0.0
        if value > 100.0:
            return 100.0
        return value
    except Exception:
        try:
            return float(cpu_percent or 0.0)
        except Exception:
            return 0.0


# Global cache for network traffic data
process_net_counters: dict[int, dict] = {}
network_traffic_lock = threading.Lock()


def get_process_network_traffic(pid: int) -> float:
    """Calculate network traffic for a specific process using psutil (estimate)."""
    try:
        process = psutil.Process(pid)
        current_time = time.time()

        connections = process.net_connections()
        if not connections:
            return 0.0

        conn_count = len(connections)

        with network_traffic_lock:
            if pid not in process_net_counters:
                process_net_counters[pid] = {
                    'last_check': current_time,
                    'last_conn_count': conn_count,
                    'traffic_estimate': 0.0,
                }
                return 0.0

            prev_data = process_net_counters[pid]
            time_diff = current_time - prev_data['last_check']

            if time_diff < 0.1:
                return float(prev_data['traffic_estimate'])

            conn_diff = abs(conn_count - prev_data['last_conn_count'])

            cpu_percent = process.cpu_percent(interval=None) / 100.0

            base_traffic = 5.0
            conn_factor = 2.0 * float(conn_diff)
            cpu_factor = 10.0 * float(cpu_percent)

            if conn_count > 0:
                new_estimate = base_traffic + conn_factor + cpu_factor
                traffic_estimate = (0.7 * new_estimate) + (0.3 * float(prev_data['traffic_estimate']))
            else:
                traffic_estimate = 0.0

            process_net_counters[pid] = {
                'last_check': current_time,
                'last_conn_count': conn_count,
                'traffic_estimate': traffic_estimate,
            }

            return round(float(traffic_estimate), 2)

    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return 0.0
    except Exception:
        return 0.0


def build_processes_blueprint() -> Blueprint:
    bp = Blueprint('processes', __name__)

    @bp.route('/processes')
    def processes_page():
        return render_template('processes.html')

    @bp.route('/api/process_favorites', methods=['GET'])
    def get_process_favorites():
        config = load_config()
        return jsonify(favorites=config.get('processes', {}).get('favorites', []))

    @bp.route('/api/process_favorites', methods=['POST'])
    def update_process_favorites():
        new_favorites = request.json.get('favorites', [])
        if not isinstance(new_favorites, list):
            new_favorites = []
        save_process_favorites(new_favorites)
        return jsonify(success=True)

    @bp.route('/api/processes')
    def api_processes():
        processes = []
        for proc in psutil.process_iter(['pid', 'name', 'username', 'status']):
            try:
                pid = proc.info.get('pid')
                name = proc.info.get('name') or 'unknown'
                username = proc.info.get('username') or ''
                status = proc.info.get('status') or ''

                try:
                    exe = proc.exe()
                except (psutil.AccessDenied, psutil.ZombieProcess):
                    exe = ''
                except Exception:
                    exe = ''

                try:
                    cwd = proc.cwd()
                except (psutil.AccessDenied, psutil.ZombieProcess):
                    cwd = ''
                except Exception:
                    cwd = ''

                try:
                    cmdline = proc.cmdline() or []
                except (psutil.AccessDenied, psutil.ZombieProcess):
                    cmdline = []
                except Exception:
                    cmdline = []

                if isinstance(cmdline, list) and len(cmdline) > 40:
                    cmdline = cmdline[:40] + ['...']

                cpu_percent = normalize_process_cpu_percent(proc.cpu_percent(interval=None))
                memory_rss = proc.memory_info().rss

                try:
                    network_connections = len(proc.net_connections())
                except (psutil.AccessDenied, psutil.ZombieProcess):
                    network_connections = 0
                except Exception:
                    network_connections = 0

                processes.append(
                    {
                        'pid': pid,
                        'name': name,
                        'username': username,
                        'status': status,
                        'exe': exe,
                        'cwd': cwd,
                        'cmdline': cmdline,
                        'cpu_percent': cpu_percent,
                        'memory_rss': memory_rss,
                        'network_connections': network_connections,
                    }
                )
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            except Exception:
                continue

        processes.sort(key=lambda p: (p.get('cpu_percent', 0), p.get('memory_rss', 0)), reverse=True)
        return jsonify(success=True, processes=processes)

    @bp.route('/api/process_info/<int:pid>')
    def api_process_info(pid: int):
        try:
            p = psutil.Process(pid)

            def safe(callable_, default=None):
                try:
                    return callable_()
                except (psutil.AccessDenied, psutil.ZombieProcess):
                    return default
                except psutil.NoSuchProcess:
                    raise
                except Exception:
                    return default

            name = safe(p.name, '')
            username = safe(p.username, '')
            status = safe(p.status, '')
            exe = safe(p.exe, '')
            cwd = safe(p.cwd, '')
            cmdline = safe(p.cmdline, []) or []
            ppid = safe(p.ppid, None)
            create_time = safe(p.create_time, None)
            threads = safe(p.num_threads, None)

            cpu_percent = normalize_process_cpu_percent(safe(lambda: p.cpu_percent(interval=0.0), 0.0))
            mem_rss = safe(lambda: p.memory_info().rss, 0)
            connections = safe(lambda: len(p.net_connections()), 0)

            return jsonify(
                {
                    'success': True,
                    'pid': pid,
                    'ppid': ppid,
                    'name': name,
                    'username': username,
                    'status': status,
                    'exe': exe,
                    'cwd': cwd,
                    'cmdline': cmdline,
                    'cpu_percent': cpu_percent,
                    'memory_rss': mem_rss,
                    'threads': threads,
                    'create_time': create_time,
                    'network_connections': connections,
                }
            )
        except psutil.NoSuchProcess:
            return jsonify({'success': False, 'process_exists': False, 'error': 'process_not_found'}), 404
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @bp.route('/api/process_metrics/<int:pid>')
    def process_metrics(pid: int):
        try:
            process = psutil.Process(pid)

            cpu_percent = normalize_process_cpu_percent(process.cpu_percent(interval=0.1))

            memory_info = process.memory_info()
            memory_percent = process.memory_percent()

            network_connections = process.net_connections()
            num_connections = len(network_connections)

            network_traffic = get_process_network_traffic(pid)

            process_name = process.name()
            status = process.status()

            try:
                threads = process.num_threads()
            except (psutil.AccessDenied, psutil.ZombieProcess):
                threads = 0
            except Exception:
                threads = 0

            return jsonify(
                {
                    'success': True,
                    'process_exists': True,
                    'process_name': process_name,
                    'status': status,
                    'cpu_percent': cpu_percent,
                    'memory_rss': memory_info.rss,
                    'memory_vms': memory_info.vms,
                    'memory_percent': memory_percent,
                    'threads': threads,
                    'network_connections': num_connections,
                    'network_traffic': network_traffic,
                    'timestamp': time.time(),
                }
            )
        except psutil.NoSuchProcess:
            return jsonify({'success': False, 'process_exists': False, 'error': f'Process with PID {pid} not found'})
        except (psutil.AccessDenied, psutil.ZombieProcess) as e:
            return jsonify({'success': False, 'process_exists': True, 'error': str(e)})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    @bp.route('/api/process/kill', methods=['POST'])
    def api_kill_process():
        data = request.get_json(silent=True) or {}
        pid = int(data.get('pid') or 0)
        if pid <= 1:
            return jsonify(success=False, error='Invalid PID'), 400

        try:
            os.kill(pid, signal.SIGKILL)
            return jsonify(success=True)
        except ProcessLookupError:
            return jsonify(success=False, error='process_not_found', process_exists=False), 404
        except PermissionError:
            pass
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500

        sudo_password = session.get(SUDO_SESSION_KEY)
        if not sudo_password:
            return (
                jsonify(error='sudo_required', message='Sudo password required to kill this process.'),
                401,
            )

        try:
            run_sudo(['/bin/kill', '-9', str(pid)], sudo_password)
            return jsonify(success=True)
        except psutil.NoSuchProcess:
            return jsonify(success=False, error='process_not_found', process_exists=False), 404
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500

    return bp


__all__ = ['build_processes_blueprint', 'normalize_process_cpu_percent']
