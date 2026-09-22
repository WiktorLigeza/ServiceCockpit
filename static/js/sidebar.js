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

function _getSidebarSettingsEls() {
    return {
        wrapper: document.getElementById('sidebar-settings'),
        menu: document.getElementById('sidebar-settings-menu'),
        btn: document.querySelector('.sidebar-settings-btn'),
    };
}

function toggleSidebarSettings(ev) {
    ev?.stopPropagation?.();
    const { menu, btn } = _getSidebarSettingsEls();
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.classList.toggle('active', !isOpen);
}

function hideSidebarSettings() {
    const { menu, btn } = _getSidebarSettingsEls();
    if (menu) menu.style.display = 'none';
    if (btn) btn.classList.remove('active');
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

    document.addEventListener('click', (e) => {
        const { wrapper, menu } = _getSidebarSettingsEls();
        if (!menu || !wrapper) return;
        if (menu.style.display === 'none') return;
        if (!wrapper.contains(e.target)) {
            hideSidebarSettings();
        }
    });
});

window.toggleSidebarPin = toggleSidebarPin;
window.toggleSidebarSettings = toggleSidebarSettings;
window.hideSidebarSettings = hideSidebarSettings;
