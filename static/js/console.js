document.addEventListener('DOMContentLoaded', () => {
    const consoleWindow = document.getElementById('consoleWindow');
    const consoleHeader = document.getElementById('consoleHeader');
    const minimizeConsole = document.getElementById('minimizeConsole');
    const terminalContainer = document.getElementById('consoleTerminal');
    if (!consoleWindow || !consoleHeader || !terminalContainer) return;

    // --- Dragging (same pattern used by the info card) ---
    let isDragging = false;
    let currentX, currentY, initialX, initialY;
    let xOffset = 100;
    let yOffset = 100;
    setTranslate(xOffset, yOffset, consoleWindow);

    consoleHeader.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    function getPointerPosition(e) {
        const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-zoom')) || 1;
        return { x: e.clientX / zoom, y: e.clientY / zoom };
    }

    function dragStart(e) {
        const pos = getPointerPosition(e);
        initialX = pos.x - xOffset;
        initialY = pos.y - yOffset;
        if (e.target === consoleHeader || e.target.parentNode === consoleHeader) {
            isDragging = true;
        }
    }

    function drag(e) {
        if (!isDragging) return;
        e.preventDefault();
        const pos = getPointerPosition(e);
        currentX = pos.x - initialX;
        currentY = pos.y - initialY;
        xOffset = currentX;
        yOffset = currentY;
        setTranslate(currentX, currentY, consoleWindow);
    }

    function dragEnd() {
        isDragging = false;
    }

    function setTranslate(xPos, yPos, el) {
        el.style.transform = `translate(${xPos}px, ${yPos}px)`;
    }

    minimizeConsole.addEventListener('click', () => {
        consoleWindow.style.display = 'none';
    });

    // --- Real terminal (xterm.js) wired to a per-session root pty on the server ---
    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace",
        fontSize: 14,
        scrollback: 5000,
        theme: {
            background: 'rgba(0, 0, 0, 0)',
            foreground: '#d6c9ff',
            cursor: '#c98fff',
            selectionBackground: 'rgba(140, 0, 255, 0.4)',
        },
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);

    const consoleSocket = io({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000,
    });

    function sendResize() {
        try {
            fitAddon.fit();
        } catch (_) { /* container not visible yet */ }
        consoleSocket.emit('console_resize', { cols: term.cols, rows: term.rows });
    }

    consoleSocket.on('connect', () => {
        consoleSocket.emit('join_console');
        setTimeout(sendResize, 50);
    });

    consoleSocket.on('console_output', (data) => {
        term.write(data.output);
    });

    consoleSocket.on('console_exit', () => {
        term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
    });

    consoleSocket.on('sudo_required', (payload = {}) => {
        term.write(`\r\n\x1b[31m[${payload.message || 'Sudo password required'}]\x1b[0m\r\n`);
    });

    term.onData((data) => {
        consoleSocket.emit('console_input', { data });
    });

    // Re-fit on manual window resize (the console window has a native CSS
    // resize handle) and whenever the console is actually shown - it starts
    // hidden (display: none), and xterm can't size itself against a
    // display:none container.
    if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(() => sendResize());
        resizeObserver.observe(consoleWindow);
    } else {
        window.addEventListener('resize', () => {
            if (consoleWindow.style.display !== 'none') sendResize();
        });
    }

    const visibilityObserver = new MutationObserver(() => {
        if (consoleWindow.style.display === 'flex') {
            setTimeout(() => {
                sendResize();
                term.focus();
            }, 50);
        }
    });
    visibilityObserver.observe(consoleWindow, { attributes: true, attributeFilter: ['style'] });
});
