// Multiple independent consoles, each backed by its own root-or-normal shell
// on the server (see command_executor.py). Sessions live in a server-side
// registry keyed by id, not tied to this socket connection, so they survive
// a page navigation - on load we just ask the server what's still running
// and reattach (restored windows start minimized so they don't pop three
// terminals onto every page you visit).

const consoleSessions = new Map(); // id -> { term, fitAddon, windowEl, sudo, cwd, minimized }
let consoleSocket = null;
let consoleWindowCounter = 0;

function _consoleGetPointerPosition(e) {
    if (typeof window.getPointerPosition === 'function') return window.getPointerPosition(e);
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-zoom')) || 1;
    return { x: e.clientX / zoom, y: e.clientY / zoom };
}

function _consoleBringToFront(el) {
    if (typeof window.bringToFront === 'function') {
        window.bringToFront(el);
        return;
    }
    el.style.zIndex = '19000';
}

function ensureConsoleSocket() {
    if (consoleSocket) return consoleSocket;

    consoleSocket = io({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000,
    });

    consoleSocket.on('connect', () => {
        // Rejoin rooms for whatever we already have windows for (e.g. after
        // a dropped connection), independent of the on-load restore below.
        consoleSessions.forEach((_entry, id) => consoleSocket.emit('attach_console', { id }));
    });

    consoleSocket.on('console_opened', (data) => {
        if (!data || !data.id || consoleSessions.has(data.id)) return;
        createConsoleWindow(data.id, { sudo: data.sudo, cwd: data.cwd, name: data.name });
    });

    consoleSocket.on('console_renamed', (data) => {
        const entry = consoleSessions.get(data && data.id);
        if (!entry) return;
        entry.name = data.name || null;
        _updateConsoleTitle(entry);
        renderConsolePanelList();
    });

    consoleSocket.on('console_output', (data) => {
        const entry = consoleSessions.get(data && data.id);
        if (entry) entry.term.write(data.output);
    });

    consoleSocket.on('console_exit', (data) => {
        const entry = consoleSessions.get(data && data.id);
        if (entry) entry.term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
    });

    consoleSocket.on('console_closed', (data) => {
        destroyConsoleWindow(data && data.id);
    });

    consoleSocket.on('console_error', (data) => {
        alert((data && data.error) || 'Console error');
    });

    consoleSocket.on('sudo_required', (payload = {}) => {
        alert(payload.message || 'Sudo password required.');
    });

    return consoleSocket;
}

function openNewConsole(sudo, cwd, name) {
    const socket = ensureConsoleSocket();
    const payload = {};
    if (cwd) payload.cwd = cwd;
    if (name) payload.name = name;

    if (sudo) {
        payload.sudo = true;
        if (typeof window.showSudoModal === 'function') {
            window.showSudoModal('Enter your sudo password to open a root console.', () => {
                socket.emit('open_console', payload);
            });
            return;
        }
    }
    socket.emit('open_console', payload);
}

// "Open Terminal Here" / "Open Terminal Here (sudo)" (file explorer) - a
// fresh console at that folder, same as opening a new terminal window in a
// real OS file manager.
window.openTerminalAt = function (path, sudo) {
    if (path) openNewConsole(!!sudo, path);
};

function createConsoleWindow(id, opts) {
    const win = document.createElement('div');
    win.className = 'console-window';
    win.style.display = 'flex';

    const stagger = 40 * (consoleWindowCounter % 6);
    consoleWindowCounter += 1;
    win.style.left = `${100 + stagger}px`;
    win.style.top = `${100 + stagger}px`;

    const header = document.createElement('div');
    header.className = 'console-header';

    const title = document.createElement('div');
    title.className = 'console-title';

    const controls = document.createElement('div');
    controls.className = 'console-controls';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'console-control-btn';
    renameBtn.title = 'Rename';
    renameBtn.innerHTML = '<i class="fas fa-pen"></i>';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'console-control-btn';
    minimizeBtn.title = 'Minimize';
    minimizeBtn.innerHTML = '<i class="fas fa-window-minimize"></i>';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'console-control-btn';
    closeBtn.title = 'Close (stops the shell)';
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';

    controls.appendChild(renameBtn);
    controls.appendChild(minimizeBtn);
    controls.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(controls);

    const terminalContainer = document.createElement('div');
    terminalContainer.className = 'console-terminal';

    win.appendChild(header);
    win.appendChild(terminalContainer);
    document.body.appendChild(win);

    // Dragging
    let isDragging = false;
    let initialX, initialY;

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.console-controls')) return;
        const pos = _consoleGetPointerPosition(e);
        initialX = pos.x - win.offsetLeft;
        initialY = pos.y - win.offsetTop;
        isDragging = true;
        _consoleBringToFront(win);
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const pos = _consoleGetPointerPosition(e);
        win.style.left = `${pos.x - initialX}px`;
        win.style.top = `${pos.y - initialY}px`;
    });
    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    if (typeof registerWindowFocus === 'function') {
        registerWindowFocus(win, [header, win]);
    } else {
        win.addEventListener('mousedown', () => _consoleBringToFront(win));
    }

    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace",
        fontSize: 14,
        scrollback: 5000,
        // 16-color ANSI palette based on Dracula (github.com/dracula/dracula-theme).
        theme: {
            background: 'rgba(0, 0, 0, 0)',
            foreground: '#f8f8f2',
            cursor: '#c98fff',
            cursorAccent: '#191970',
            selectionBackground: 'rgba(140, 0, 255, 0.4)',
            black: '#21222c',
            red: '#ff5555',
            green: '#50fa7b',
            yellow: '#f1fa8c',
            blue: '#bd93f9',
            magenta: '#ff79c6',
            cyan: '#8be9fd',
            white: '#f8f8f2',
            brightBlack: '#6272a4',
            brightRed: '#ff6e6e',
            brightGreen: '#69ff94',
            brightYellow: '#ffffa5',
            brightBlue: '#d6acff',
            brightMagenta: '#ff92df',
            brightCyan: '#a4ffff',
            brightWhite: '#ffffff',
        },
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);

    const entry = {
        id,
        term,
        fitAddon,
        windowEl: win,
        titleEl: title,
        sudo: !!opts.sudo,
        cwd: opts.cwd || '~',
        name: opts.name || null,
        minimized: false,
    };
    consoleSessions.set(id, entry);
    _updateConsoleTitle(entry);

    function sendResize() {
        try {
            fitAddon.fit();
        } catch (_) { /* container not visible yet */ }
        ensureConsoleSocket().emit('console_resize', { id, cols: term.cols, rows: term.rows });
    }

    term.onData((data) => {
        ensureConsoleSocket().emit('console_input', { id, data });
    });

    if (window.ResizeObserver) {
        new ResizeObserver(() => sendResize()).observe(win);
    }

    renameBtn.addEventListener('click', () => renameConsoleWindow(id));
    minimizeBtn.addEventListener('click', () => minimizeConsoleWindow(id));
    closeBtn.addEventListener('click', () => closeConsoleWindow(id));

    setTimeout(() => {
        sendResize();
        term.focus();
    }, 50);

    renderConsolePanelList();
    return entry;
}

function _updateConsoleTitle(entry) {
    if (!entry.titleEl) return;
    const roleIcon = entry.sudo ? 'fa-user-shield' : 'fa-user';
    const label = entry.name || entry.cwd;
    entry.titleEl.innerHTML = `<i class="fas fa-terminal"></i> <i class="fas ${roleIcon}" title="${entry.sudo ? 'root' : 'normal user'}"></i> ${label}`;
    entry.titleEl.title = entry.cwd;
}

function renameConsoleWindow(id) {
    const entry = consoleSessions.get(id);
    if (!entry) return;
    const name = prompt('Name this console:', entry.name || '');
    if (name === null) return; // cancelled
    const trimmed = name.trim();
    entry.name = trimmed || null;
    _updateConsoleTitle(entry);
    renderConsolePanelList();
    ensureConsoleSocket().emit('rename_console', { id, name: trimmed });
}

function minimizeConsoleWindow(id) {
    const entry = consoleSessions.get(id);
    if (!entry) return;
    entry.windowEl.style.display = 'none';
    entry.minimized = true;
    renderConsolePanelList();
}

function restoreConsoleWindow(id) {
    const entry = consoleSessions.get(id);
    if (!entry) return;
    entry.windowEl.style.display = 'flex';
    entry.minimized = false;
    _consoleBringToFront(entry.windowEl);
    try {
        entry.fitAddon.fit();
    } catch (_) {}
    entry.term.focus();
    renderConsolePanelList();
}

function toggleConsoleWindow(id) {
    const entry = consoleSessions.get(id);
    if (!entry) return;
    if (entry.minimized) restoreConsoleWindow(id);
    else minimizeConsoleWindow(id);
}

function closeConsoleWindow(id) {
    // Hard stop: tell the server to SIGKILL it, and tear the window down
    // immediately rather than waiting for confirmation.
    ensureConsoleSocket().emit('close_console', { id });
    destroyConsoleWindow(id);
}

function destroyConsoleWindow(id) {
    const entry = consoleSessions.get(id);
    if (!entry) return;
    try {
        entry.term.dispose();
    } catch (_) {}
    entry.windowEl.remove();
    consoleSessions.delete(id);
    renderConsolePanelList();
}

function renderConsolePanelList() {
    const list = document.getElementById('sidebar-console-panel-list');
    const countEl = document.getElementById('sidebar-console-count');
    const entries = Array.from(consoleSessions.values());

    if (countEl) {
        countEl.hidden = entries.length === 0;
        countEl.textContent = String(entries.length);
    }

    if (!list) return;
    list.innerHTML = '';

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sidebar-console-panel-empty';
        empty.textContent = 'No open consoles';
        list.appendChild(empty);
        return;
    }

    entries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'sidebar-console-row';

        const info = document.createElement('div');
        info.className = 'sidebar-console-row-info';
        info.title = entry.cwd;
        info.innerHTML = `<i class="fas ${entry.sudo ? 'fa-user-shield' : 'fa-user'}"></i> <span>${entry.name || entry.cwd}</span>`;
        info.addEventListener('click', () => restoreConsoleWindow(entry.id));

        const actions = document.createElement('div');
        actions.className = 'sidebar-console-row-actions';

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.title = 'Rename';
        renameBtn.innerHTML = '<i class="fas fa-pen"></i>';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            renameConsoleWindow(entry.id);
        });
        actions.appendChild(renameBtn);

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.title = entry.minimized ? 'Restore' : 'Minimize';
        minBtn.innerHTML = `<i class="fas ${entry.minimized ? 'fa-window-restore' : 'fa-window-minimize'}"></i>`;
        minBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleConsoleWindow(entry.id);
        });

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'sidebar-console-row-close';
        closeBtn.title = 'Close (stops the shell)';
        closeBtn.innerHTML = '<i class="fas fa-times"></i>';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeConsoleWindow(entry.id);
        });

        actions.appendChild(minBtn);
        actions.appendChild(closeBtn);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

async function restoreConsoleSessions() {
    try {
        const resp = await fetch('/api/console/sessions');
        const data = await resp.json();
        if (!data.success || !Array.isArray(data.sessions)) return;

        const socket = ensureConsoleSocket();
        data.sessions.forEach((s) => {
            if (!s || !s.id || !s.alive || consoleSessions.has(s.id)) return;
            createConsoleWindow(s.id, { sudo: s.sudo, cwd: s.cwd, name: s.name });
            socket.emit('attach_console', { id: s.id });
            minimizeConsoleWindow(s.id);
        });
    } catch (e) {
        console.error('Failed to restore console sessions:', e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    renderConsolePanelList();
    restoreConsoleSessions();
});

window.openNewConsole = openNewConsole;
window.restoreConsoleWindow = restoreConsoleWindow;
window.minimizeConsoleWindow = minimizeConsoleWindow;
window.closeConsoleWindow = closeConsoleWindow;
window.toggleConsoleWindow = toggleConsoleWindow;
