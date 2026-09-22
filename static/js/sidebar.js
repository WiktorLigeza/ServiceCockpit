const SIDEBAR_PIN_KEY = 'cockpit_sidebar_pinned';

function _getSidebarEls() {
    return {
        sidebar: document.getElementById('app-sidebar'),
        pinBtn: document.getElementById('sidebar-pin-btn'),
    };
}

function toggleSidebarPin() {
    const { sidebar, pinBtn } = _getSidebarEls();
    if (!sidebar) return;
    const pinned = !sidebar.classList.contains('sidebar-pinned');
    sidebar.classList.toggle('sidebar-pinned', pinned);
    if (pinBtn) pinBtn.classList.toggle('active', pinned);
    try {
        localStorage.setItem(SIDEBAR_PIN_KEY, pinned ? '1' : '0');
    } catch (_) {}
}

function _getSidebarUpdateEls() {
    return {
        item: document.getElementById('sidebar-update-item'),
        dot: document.getElementById('sidebar-update-dot'),
        label: document.getElementById('sidebar-update-label'),
    };
}

function refreshSidebarUpdateStatus() {
    const { item, dot, label } = _getSidebarUpdateEls();
    if (!item) return;

    fetch('/api/update_status')
        .then(response => response.json())
        .then(data => {
            item.classList.remove('status-available');
            if (dot) dot.classList.remove('status-uptodate', 'status-available', 'status-error');

            if (!data.is_git_repo || data.error) {
                if (dot) dot.classList.add('status-error');
                item.title = data.error || 'Could not check for updates';
                if (label) label.textContent = 'Update';
                return;
            }

            if (data.up_to_date) {
                if (dot) dot.classList.add('status-uptodate');
                item.title = `Up to date with ${data.remote}`;
                if (label) label.textContent = 'Up to date';
            } else {
                item.classList.add('status-available');
                if (dot) dot.classList.add('status-available');
                item.title = `${data.behind} commit${data.behind === 1 ? '' : 's'} behind ${data.remote} - click to pull the latest`;
                if (label) label.textContent = `Update (${data.behind})`;
            }
        })
        .catch(error => {
            console.error('Error checking for updates:', error);
            if (dot) dot.classList.add('status-error');
            item.title = 'Could not check for updates';
        });
}

async function performSidebarUpdate() {
    const { item, label } = _getSidebarUpdateEls();
    if (!item || item.classList.contains('updating')) return;

    if (!confirm('Pull the latest changes from origin/main?\n\nAny uncommitted local changes on this device will be stashed automatically (recoverable via `git stash pop`), not discarded.')) {
        return;
    }

    const icon = item.querySelector('i');
    const originalIconClass = icon ? icon.className : '';
    const originalLabel = label ? label.textContent : '';

    item.classList.add('updating');
    if (icon) icon.className = 'fas fa-spinner fa-spin';
    if (label) label.textContent = 'Updating...';
    item.title = 'Pulling latest changes...';

    try {
        const resp = await fetch('/api/update_pull', { method: 'POST' });
        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.success) {
            alert(data.error || 'Update failed.');
        } else {
            alert(data.message || 'Update complete.');
        }
    } catch (e) {
        console.error('Update failed:', e);
        alert('Update failed. See console for details.');
    } finally {
        item.classList.remove('updating');
        if (icon) icon.className = originalIconClass;
        if (label) label.textContent = originalLabel;
        refreshSidebarUpdateStatus();
    }
}

// The flyout panels live outside .app-sidebar (which clips overflow), so
// showing them on hover is done in JS rather than pure CSS :hover - position
// next to the sidebar item and keep it open while the pointer is over either
// the item or the panel itself.
function _initFlyoutHover(wrapperId, panelId) {
    const wrapper = document.getElementById(wrapperId);
    const panel = document.getElementById(panelId);
    if (!wrapper || !panel) return;

    let hideTimer = null;

    function show() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        const rect = wrapper.getBoundingClientRect();
        panel.style.left = `${rect.right + 8}px`;
        panel.style.top = `${Math.max(8, rect.top)}px`;
        panel.classList.add('visible');
    }

    function scheduleHide() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => panel.classList.remove('visible'), 200);
    }

    wrapper.addEventListener('mouseenter', show);
    wrapper.addEventListener('mouseleave', scheduleHide);
    panel.addEventListener('mouseenter', show);
    panel.addEventListener('mouseleave', scheduleHide);
}

// --- Running Programs panel (exec runners from the file explorer) ---
function _programRowStatusText(p) {
    if (p.running) return 'Running';
    return `Exited (${p.return_code === null || p.return_code === undefined ? 'unknown' : p.return_code})`;
}

function _focusOrNavigateToProgram(processId) {
    if (typeof window.focusExecRunner === 'function' && window.focusExecRunner(processId)) {
        return;
    }
    window.location.href = '/file_explorer';
}

async function killProgramFromSidebar(processId, ev) {
    ev?.stopPropagation?.();
    try {
        await fetch('/api/execute/kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ process_id: processId }),
        });
    } catch (e) {
        console.error('Failed to kill program:', e);
    }
    refreshProgramsPanel();
}

async function closeProgramFromSidebar(processId, ev) {
    ev?.stopPropagation?.();
    try {
        await fetch('/api/execute/close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ process_id: processId }),
        });
    } catch (e) {
        console.error('Failed to close program:', e);
    }
    refreshProgramsPanel();
}

async function refreshProgramsPanel() {
    const wrapper = document.getElementById('sidebar-programs');
    const countEl = document.getElementById('sidebar-programs-count');
    const list = document.getElementById('sidebar-programs-panel-list');
    if (!wrapper) return;

    try {
        const resp = await fetch('/api/execute/sessions');
        const data = await resp.json();
        const sessions = (data.success && Array.isArray(data.sessions)) ? data.sessions : [];

        wrapper.hidden = sessions.length === 0;
        if (countEl) {
            countEl.hidden = sessions.length === 0;
            countEl.textContent = String(sessions.length);
        }

        if (!list) return;
        list.innerHTML = '';

        if (sessions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sidebar-console-panel-empty';
            empty.textContent = 'No running programs';
            list.appendChild(empty);
            return;
        }

        sessions.forEach((p) => {
            const fileName = (p.path || '').split('/').pop() || p.path;
            const row = document.createElement('div');
            row.className = 'sidebar-console-row';

            const info = document.createElement('div');
            info.className = 'sidebar-console-row-info';
            info.innerHTML = `<i class="fas ${p.sudo ? 'fa-user-shield' : 'fa-user'}"></i> <span title="${fileName}">${fileName} - ${_programRowStatusText(p)}</span>`;
            info.addEventListener('click', () => _focusOrNavigateToProgram(p.process_id));

            const actions = document.createElement('div');
            actions.className = 'sidebar-console-row-actions';

            if (p.running) {
                const killBtn = document.createElement('button');
                killBtn.type = 'button';
                killBtn.title = 'Kill';
                killBtn.innerHTML = '<i class="fas fa-stop"></i>';
                killBtn.addEventListener('click', (e) => killProgramFromSidebar(p.process_id, e));
                actions.appendChild(killBtn);
            }

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'sidebar-console-row-close';
            closeBtn.title = 'Close (stops it if running, forgets it)';
            closeBtn.innerHTML = '<i class="fas fa-times"></i>';
            closeBtn.addEventListener('click', (e) => closeProgramFromSidebar(p.process_id, e));
            actions.appendChild(closeBtn);

            row.appendChild(info);
            row.appendChild(actions);
            list.appendChild(row);
        });
    } catch (e) {
        console.error('Failed to refresh programs panel:', e);
    }
}
window.refreshProgramsPanel = refreshProgramsPanel;

document.addEventListener('DOMContentLoaded', () => {
    const { sidebar, pinBtn } = _getSidebarEls();
    if (!sidebar) return;

    let pinned = false;
    try {
        pinned = localStorage.getItem(SIDEBAR_PIN_KEY) === '1';
    } catch (_) {}

    if (pinned) {
        sidebar.classList.add('sidebar-pinned');
        if (pinBtn) pinBtn.classList.add('active');
    }

    refreshSidebarUpdateStatus();
    setInterval(refreshSidebarUpdateStatus, 5 * 60 * 1000);

    _initFlyoutHover('sidebar-console', 'sidebar-console-panel');
    _initFlyoutHover('sidebar-programs', 'sidebar-programs-panel');

    refreshProgramsPanel();
    setInterval(refreshProgramsPanel, 15000);

    window.onExecRunnersChanged = refreshProgramsPanel;
});

window.toggleSidebarPin = toggleSidebarPin;
window.performSidebarUpdate = performSidebarUpdate;
