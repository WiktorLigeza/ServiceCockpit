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
});

window.toggleSidebarPin = toggleSidebarPin;
