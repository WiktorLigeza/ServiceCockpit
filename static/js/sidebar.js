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

// The flyout panel lives outside .app-sidebar (which clips overflow), so
// showing it on hover is done in JS rather than pure CSS :hover - position it
// next to the sidebar item and keep it open while the pointer is over either
// the item or the panel itself.
function _initSidebarConsoleHover() {
    const wrapper = document.getElementById('sidebar-console');
    const panel = document.getElementById('sidebar-console-panel');
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

    _initSidebarConsoleHover();
});

window.toggleSidebarPin = toggleSidebarPin;
window.performSidebarUpdate = performSidebarUpdate;
