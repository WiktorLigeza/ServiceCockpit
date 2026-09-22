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
// next to the sidebar item (top-aligned with it) and keep both the panel and
// the sidebar itself expanded while the pointer is over the item or the
// panel. Without the sidebar-side of this, moving the mouse off the rail and
// into the panel exits .app-sidebar's own :hover, so the rail would snap
// back to its collapsed width mid-interaction, right as you're trying to
// click something in the list.
let _openFlyoutCount = 0;

function _initFlyoutHover(wrapperId, panelId) {
    const wrapper = document.getElementById(wrapperId);
    const panel = document.getElementById(panelId);
    const { sidebar } = _getSidebarEls();
    if (!wrapper || !panel) return;

    let hideTimer = null;
    let isOpen = false;

    function show() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }

        // Position against the sidebar's *expanded* right edge, not the
        // wrapper's live rect - hovering also triggers the sidebar's own
        // width transition (56px -> 208px), and the wrapper's rect at the
        // instant of mouseenter still reflects the pre-transition width, so
        // trusting it would leave the panel positioned too close in.
        const sidebarRect = (sidebar || wrapper).getBoundingClientRect();
        const expandedWidth = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-expanded')
        ) || 208;
        const itemRect = wrapper.getBoundingClientRect();

        panel.style.left = `${sidebarRect.left + expandedWidth + 8}px`;
        panel.style.top = `${Math.max(8, itemRect.top)}px`;
        panel.classList.add('visible');

        if (!isOpen) {
            isOpen = true;
            _openFlyoutCount += 1;
            if (sidebar) sidebar.classList.add('sidebar-flyout-active');
        }
    }

    function hideNow() {
        panel.classList.remove('visible');
        if (isOpen) {
            isOpen = false;
            _openFlyoutCount = Math.max(0, _openFlyoutCount - 1);
            if (sidebar && _openFlyoutCount === 0) sidebar.classList.remove('sidebar-flyout-active');
        }
    }

    function scheduleHide() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hideNow, 200);
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
