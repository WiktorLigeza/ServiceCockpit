let execRunnerSocket = null;
const execRunners = new Map();
let execRunnerCounter = 0;

function setupExecutableRunner() {
    ensureExecSocket();
    restoreExecSessions();
}

function ensureExecSocket() {
    if (execRunnerSocket) return;
    execRunnerSocket = io({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000,
    });

    execRunnerSocket.on('exec_history', (data) => {
        if (!data || !data.process_id) return;
        const runner = execRunners.get(data.process_id);
        if (!runner) return;
        runner.outputEl.textContent = (data.lines || []).join('\n');
        if (runner.outputEl.textContent.length > 0) runner.outputEl.textContent += '\n';
        if (data.running) {
            setRunnerStatus(runner, 'Running');
        } else {
            setRunnerStatus(runner, `Exited (${data.return_code ?? 'unknown'})`);
        }
    });

    execRunnerSocket.on('exec_output', (data) => {
        if (!data || !data.process_id) return;
        const runner = execRunners.get(data.process_id);
        if (!runner) return;
        runner.outputEl.textContent += (data.line ?? '') + '\n';
        runner.outputEl.scrollTop = runner.outputEl.scrollHeight;
    });

    execRunnerSocket.on('exec_exit', (data) => {
        if (!data || !data.process_id) return;
        const runner = execRunners.get(data.process_id);
        if (!runner) return;
        setRunnerStatus(runner, `Exited (${data.return_code ?? 'unknown'})`);
    });

    execRunnerSocket.on('exec_error', (data) => {
        if (!data || !data.process_id) return;
        const runner = execRunners.get(data.process_id);
        if (!runner) return;
        setRunnerStatus(runner, `Error: ${data.error ?? 'unknown'}`);
    });
}

function setRunnerStatus(runner, text) {
    runner.statusEl.textContent = text;
    if (runner.startBtn) {
        runner.startBtn.disabled = !!runner.processId;
    }
    if (typeof window.onExecRunnersChanged === 'function') window.onExecRunnersChanged();
}

// Lets the sidebar's "Programs" panel bring an already-open runner window to
// front instead of navigating away, when we're already on this page.
function focusExecRunner(processId) {
    const runner = execRunners.get(processId);
    if (!runner) return false;
    restoreRunner(runner);
    return true;
}
window.focusExecRunner = focusExecRunner;

// Minimizing/restoring is otherwise-unmanaged UI state - visibility only.
// Discovering and restoring a minimized runner happens through the sidebar's
// "Programs" panel (mirrors how consoles work), not a dock bar.
function restoreRunner(runner) {
    runner.windowEl.style.display = 'flex';
    if (typeof bringToFront === 'function') bringToFront(runner.windowEl);
    if (typeof window.onExecRunnersChanged === 'function') window.onExecRunnersChanged();
}

function minimizeRunner(runner) {
    runner.windowEl.style.display = 'none';
    if (typeof window.onExecRunnersChanged === 'function') window.onExecRunnersChanged();
}

async function killRunnerProcess(runner) {
    if (!runner.processId) return;
    try {
        setRunnerStatus(runner, 'Killing...');
        const resp = await fetch('/api/execute/kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ process_id: runner.processId }),
        });
        const data = await resp.json();
        if (!data.success) {
            setRunnerStatus(runner, 'Kill failed');
            alert('Failed to kill: ' + (data.error || 'unknown'));
            return;
        }
        setRunnerStatus(runner, 'Kill sent');
    } catch (e) {
        setRunnerStatus(runner, 'Kill failed');
        alert('Failed to kill: ' + e);
    }
}

function createRunnerWindow(file) {
    const template = document.getElementById('exec-runner-template');
    if (!template) return null;

    const runnerWindow = template.cloneNode(true);
    runnerWindow.id = `exec-runner-${++execRunnerCounter}`;
    runnerWindow.classList.remove('exec-runner-template');
    runnerWindow.style.display = 'flex';
    runnerWindow.style.zIndex = `${2000 + execRunnerCounter}`;
    const offsetX = Math.floor(Math.random() * 120) - 60;
    const offsetY = Math.floor(Math.random() * 120) - 60;
    runnerWindow.style.left = `calc(50% + ${offsetX}px)`;
    runnerWindow.style.top = `calc(50% + ${offsetY}px)`;
    runnerWindow.style.transform = 'translate(-50%, -50%)';

    const header = runnerWindow.querySelector('[data-role="header"]');
    const titleEl = runnerWindow.querySelector('[data-role="title"]');
    const pathEl = runnerWindow.querySelector('[data-role="path"]');
    const paramsEl = runnerWindow.querySelector('[data-role="params"]');
    const sudoEl = runnerWindow.querySelector('[data-role="sudo"]');
    const outputEl = runnerWindow.querySelector('[data-role="output"]');
    const statusEl = runnerWindow.querySelector('[data-role="status"]');
    const startBtn = runnerWindow.querySelector('[data-role="start"]');
    const killBtn = runnerWindow.querySelector('[data-role="kill"]');
    const minimizeBtn = runnerWindow.querySelector('[data-role="minimize"]');
    const closeBtn = runnerWindow.querySelector('[data-role="close"]');

    const runner = {
        windowEl: runnerWindow,
        headerEl: header,
        titleEl,
        pathEl,
        paramsEl,
        sudoEl,
        outputEl,
        statusEl,
        startBtn,
        killBtn,
        minimizeBtn,
        closeBtn,
        file,
        titleText: file.name,
        processId: null,
    };

    titleEl.innerHTML = `<i class="fas fa-terminal"></i> ${file.name}`;
    pathEl.textContent = file.path;
    statusEl.textContent = 'Ready';
    startBtn.disabled = false;

    // Dragging
    let isDragging = false;
    let initialX, initialY;

    header.addEventListener('mousedown', (e) => {
        const target = e.target;
        if (target.closest('.exec-runner-controls')) return;
        const pos = typeof getPointerPosition === 'function'
            ? getPointerPosition(e)
            : { x: e.clientX, y: e.clientY };
        initialX = pos.x - runnerWindow.offsetLeft;
        initialY = pos.y - runnerWindow.offsetTop;
        isDragging = true;
    });

    if (typeof registerWindowFocus === 'function') {
        registerWindowFocus(runnerWindow, [header, runnerWindow]);
    }

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const pos = typeof getPointerPosition === 'function'
            ? getPointerPosition(e)
            : { x: e.clientX, y: e.clientY };
        const currentX = pos.x - initialX;
        const currentY = pos.y - initialY;
        runnerWindow.style.left = currentX + 'px';
        runnerWindow.style.top = currentY + 'px';
        runnerWindow.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    startBtn.addEventListener('click', async () => {
        if (!file || runner.processId) return;
        outputEl.textContent = '';
        setRunnerStatus(runner, 'Starting...');

        const params = (paramsEl.value || '').trim();
        const sudo = !!(sudoEl && sudoEl.checked);
        try {
            const resp = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: file.path, params, cwd: currentPath, sudo }),
            });
            const data = await resp.json();
            if (!data.success) {
                setRunnerStatus(runner, 'Start failed');
                alert('Failed to start: ' + (data.error || 'unknown'));
                return;
            }

            runner.processId = data.process_id;
            if (sudoEl) sudoEl.disabled = true;
            execRunners.set(runner.processId, runner);
            ensureExecSocket();
            execRunnerSocket.emit('join_exec', { process_id: runner.processId });
            setRunnerStatus(runner, 'Running');
        } catch (e) {
            setRunnerStatus(runner, 'Start failed');
            alert('Failed to start: ' + e);
        }
    });

    killBtn.addEventListener('click', async () => {
        await killRunnerProcess(runner);
    });

    minimizeBtn.addEventListener('click', () => {
        minimizeRunner(runner);
    });

    closeBtn.addEventListener('click', async () => {
        if (runner.processId) {
            // Hard-stop and forget server-side too - otherwise the backend
            // session lives forever and reappears on every reload even
            // though its window was closed.
            try {
                await fetch('/api/execute/close', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ process_id: runner.processId }),
                });
            } catch (e) {
                console.error('Failed to close runner session:', e);
            }
            execRunnerSocket?.emit('leave_exec', { process_id: runner.processId });
            execRunners.delete(runner.processId);
        }
        runner.windowEl.remove();
        if (typeof window.onExecRunnersChanged === 'function') window.onExecRunnersChanged();
    });

    document.body.appendChild(runnerWindow);
    return runner;
}

async function restoreExecSessions() {
    try {
        const resp = await fetch('/api/execute/sessions');
        const data = await resp.json();
        if (!data.success || !Array.isArray(data.sessions)) return;

        data.sessions.forEach((session) => {
            if (!session || !session.process_id || !session.path) return;
            if (execRunners.has(session.process_id)) return;

            const fileName = session.path.split('/').pop() || session.path;
            const runner = createRunnerWindow({
                name: fileName,
                path: session.path,
                is_directory: false,
                is_executable: true,
            });
            if (!runner) return;

            runner.processId = session.process_id;
            runner.paramsEl.value = session.params || '';
            if (runner.sudoEl) {
                runner.sudoEl.checked = !!session.sudo;
                runner.sudoEl.disabled = true;
            }
            execRunners.set(runner.processId, runner);
            ensureExecSocket();
            execRunnerSocket.emit('join_exec', { process_id: runner.processId });

            if (session.running) {
                setRunnerStatus(runner, 'Running');
            } else {
                setRunnerStatus(runner, `Exited (${session.return_code ?? 'unknown'})`);
            }

            // Restored on page load, not freshly opened - stay out of the way
            // (visible again via the sidebar's Programs panel), same as
            // consoles restore minimized rather than popping open.
            minimizeRunner(runner);
        });
    } catch (e) {
        console.error('Failed to restore exec sessions:', e);
    }
}

function openExecutableRunner(file) {
    if (!file) return;
    const runner = createRunnerWindow(file);
    if (!runner) return;
    restoreRunner(runner);
}
