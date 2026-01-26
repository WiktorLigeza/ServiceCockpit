let execRunnerSocket = null;
const execRunners = new Map();
let execRunnerCounter = 0;

function setupExecutableRunner() {
    ensureExecSocket();
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
    if (runner.dockItem) {
        const label = runner.dockItem.querySelector('.dock-title');
        if (label) label.textContent = `${runner.titleText} • ${text}`;
    }
}

function createDockItem(runner) {
    const dock = document.getElementById('exec-runner-dock');
    if (!dock) return null;
    const item = document.createElement('div');
    item.className = 'exec-runner-dock-item';
    item.innerHTML = `
        <span class="dock-title">${runner.titleText} • ${runner.statusEl.textContent}</span>
        <button class="dock-kill" title="Kill">&times;</button>
    `;
    item.addEventListener('click', () => {
        restoreRunner(runner);
    });
    const killBtn = item.querySelector('.dock-kill');
    killBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        killRunnerProcess(runner);
    });
    dock.appendChild(item);
    return item;
}

function restoreRunner(runner) {
    runner.windowEl.style.display = 'flex';
    runner.windowEl.style.zIndex = `${2000 + execRunnerCounter}`;
    if (runner.dockItem) {
        runner.dockItem.remove();
        runner.dockItem = null;
    }
}

function minimizeRunner(runner) {
    runner.windowEl.style.display = 'none';
    if (!runner.dockItem) {
        runner.dockItem = createDockItem(runner);
    }
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

    const header = runnerWindow.querySelector('[data-role="header"]');
    const titleEl = runnerWindow.querySelector('[data-role="title"]');
    const pathEl = runnerWindow.querySelector('[data-role="path"]');
    const paramsEl = runnerWindow.querySelector('[data-role="params"]');
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
        outputEl,
        statusEl,
        startBtn,
        killBtn,
        minimizeBtn,
        closeBtn,
        file,
        titleText: file.name,
        processId: null,
        dockItem: null,
    };

    titleEl.innerHTML = `<i class="fas fa-terminal"></i> ${file.name}`;
    pathEl.textContent = file.path;
    statusEl.textContent = 'Ready';

    // Dragging
    let isDragging = false;
    let initialX, initialY;

    header.addEventListener('mousedown', (e) => {
        const target = e.target;
        if (target.closest('.exec-runner-controls')) return;
        initialX = e.clientX - runnerWindow.offsetLeft;
        initialY = e.clientY - runnerWindow.offsetTop;
        isDragging = true;
    });

    if (typeof registerWindowFocus === 'function') {
        registerWindowFocus(runnerWindow, [header, runnerWindow]);
    }

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const currentX = e.clientX - initialX;
        const currentY = e.clientY - initialY;
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
        try {
            const resp = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: file.path, params, cwd: currentPath }),
            });
            const data = await resp.json();
            if (!data.success) {
                setRunnerStatus(runner, 'Start failed');
                alert('Failed to start: ' + (data.error || 'unknown'));
                return;
            }

            runner.processId = data.process_id;
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

    closeBtn.addEventListener('click', () => {
        if (runner.processId) {
            execRunnerSocket?.emit('leave_exec', { process_id: runner.processId });
            execRunners.delete(runner.processId);
        }
        if (runner.dockItem) {
            runner.dockItem.remove();
        }
        runner.windowEl.remove();
    });

    document.body.appendChild(runnerWindow);
    return runner;
}

function openExecutableRunner(file) {
    if (!file) return;
    const runner = createRunnerWindow(file);
    if (!runner) return;
    restoreRunner(runner);
    if (typeof bringToFront === 'function') {
        bringToFront(runner.windowEl);
    }
}
