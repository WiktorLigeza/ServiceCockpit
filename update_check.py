"""Checks whether this checkout is behind the public repo's main branch.

Network can be flaky on-device, so every git call here is short-timeout and
failure-tolerant - a check that can't reach the remote just reports that
instead of raising.
"""

import subprocess

from flask import Blueprint, jsonify

from repo_export import REPO_ROOT

REMOTE_NAME = 'origin'
REMOTE_BRANCH = 'main'
GIT_TIMEOUT = 8


def _run_git(args: list[str], timeout: int = GIT_TIMEOUT):
    return subprocess.run(
        ['git', *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def check_for_updates() -> dict:
    result = {
        'is_git_repo': False,
        'checked': False,
        'current_branch': None,
        'remote': f'{REMOTE_NAME}/{REMOTE_BRANCH}',
        'ahead': 0,
        'behind': 0,
        'up_to_date': True,
        'has_local_changes': False,
        'error': None,
    }

    try:
        branch = _run_git(['rev-parse', '--abbrev-ref', 'HEAD'], timeout=3)
        if branch.returncode != 0:
            result['error'] = 'Not a git repository'
            return result
        result['is_git_repo'] = True
        result['current_branch'] = branch.stdout.strip()
    except Exception as e:
        result['error'] = str(e)
        return result

    try:
        status = _run_git(['status', '--porcelain'], timeout=3)
        result['has_local_changes'] = bool(status.stdout.strip())
    except Exception:
        pass

    try:
        fetch = _run_git(['fetch', REMOTE_NAME, REMOTE_BRANCH, '--quiet'])
        if fetch.returncode != 0:
            result['error'] = (fetch.stderr or 'Could not reach the remote').strip()
            return result
    except subprocess.TimeoutExpired:
        result['error'] = 'Timed out reaching the remote'
        return result
    except Exception as e:
        result['error'] = str(e)
        return result

    try:
        counts = _run_git(
            ['rev-list', '--left-right', '--count', f'HEAD...{REMOTE_NAME}/{REMOTE_BRANCH}'],
            timeout=3,
        )
        if counts.returncode != 0:
            result['error'] = (counts.stderr or 'Could not compare against the remote').strip()
            return result
        ahead_str, behind_str = counts.stdout.split()
        result['ahead'] = int(ahead_str)
        result['behind'] = int(behind_str)
        result['up_to_date'] = result['behind'] == 0
        result['checked'] = True
    except Exception as e:
        result['error'] = str(e)

    return result


def _current_sha() -> str | None:
    try:
        sha = _run_git(['rev-parse', '--short', 'HEAD'], timeout=3)
        return sha.stdout.strip() if sha.returncode == 0 else None
    except Exception:
        return None


def perform_update() -> dict:
    """git pull --ff-only origin main, auto-stashing local changes first.

    Never rebases/merges - if the pull can't fast-forward (history has
    diverged) it fails loudly rather than creating a merge commit. Local
    changes are stashed (not discarded) before pulling and are only restored
    automatically if the pull itself fails, so a successful update always
    leaves them recoverable via `git stash list` rather than silently gone.
    """
    result = {
        'success': False,
        'stashed': False,
        'before': None,
        'after': None,
        'restart_required': False,
        'error': None,
        'message': None,
    }

    try:
        branch = _run_git(['rev-parse', '--abbrev-ref', 'HEAD'], timeout=3)
        if branch.returncode != 0:
            result['error'] = 'Not a git repository'
            return result
    except Exception as e:
        result['error'] = str(e)
        return result

    result['before'] = _current_sha()

    try:
        status = _run_git(['status', '--porcelain'], timeout=3)
        is_dirty = bool(status.stdout.strip())
    except Exception as e:
        result['error'] = f'Could not check working tree status: {e}'
        return result

    if is_dirty:
        try:
            stash = _run_git(
                ['stash', 'push', '-u', '-m', 'servicecockpit-auto-update'],
                timeout=10,
            )
            if stash.returncode != 0:
                result['error'] = (stash.stderr or 'Could not stash local changes').strip()
                return result
            result['stashed'] = True
        except Exception as e:
            result['error'] = f'Could not stash local changes: {e}'
            return result

    try:
        pull = _run_git(['pull', '--ff-only', REMOTE_NAME, REMOTE_BRANCH], timeout=30)
    except subprocess.TimeoutExpired:
        result['error'] = 'Timed out pulling from the remote'
        pull = None
    except Exception as e:
        result['error'] = str(e)
        pull = None

    if pull is None or pull.returncode != 0:
        if result['error'] is None:
            result['error'] = (pull.stderr or pull.stdout or 'git pull failed').strip()
        # Pull didn't take effect - restore the working tree exactly as it was.
        if result['stashed']:
            try:
                _run_git(['stash', 'pop'], timeout=10)
            except Exception:
                result['error'] += ' (local changes remain stashed - run `git stash pop` manually)'
        return result

    result['after'] = _current_sha()
    result['success'] = True
    result['restart_required'] = result['before'] != result['after']

    if result['stashed']:
        result['message'] = 'Updated. Your local changes were stashed - run `git stash pop` to bring them back.'
    elif result['restart_required']:
        result['message'] = 'Updated. Restart the app to apply the new code.'
    else:
        result['message'] = 'Already up to date.'

    return result


def build_update_check_blueprint() -> Blueprint:
    bp = Blueprint('update_check', __name__)

    @bp.route('/api/update_status')
    def update_status():
        return jsonify(check_for_updates())

    @bp.route('/api/update_pull', methods=['POST'])
    def update_pull():
        return jsonify(perform_update())

    return bp


__all__ = ['check_for_updates', 'perform_update', 'build_update_check_blueprint']
