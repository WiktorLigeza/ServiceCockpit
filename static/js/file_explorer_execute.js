let execRunnerFile = null;
let execRunnerProcessId = null;
let execRunnerSocket = null;
let execRunnerStreaming = false;

function setupExecutableRunner() {
    const runnerWindow = document.getElementById('exec-runner-window');
    if (!runnerWindow) return;

    const header = runnerWindow.querySelector('.exec-runner-header');
    const title = document.getElementById('exec-runner-title');
    const pathEl = document.getElementById('exec-runner-path');
    const paramsEl = document.getElementById('exec-runner-params');
    const outputEl = document.getElementById('exec-runner-output');
    const statusEl = document.getElementById('exec-runner-status');
    const startBtn = document.getElementById('exec-runner-start');
    const killBtn = document.getElementById('exec-runner-kill');
    const minimizeBtn = document.getElementById('exec-runner-minimize');
    const closeBtn = document.getElementById('exec-runner-close');
    const resumeBtn = document.getElementById('exec-runner-resume');

    // Dragging
    let isDragging = false;
    let currentX, currentY, initialX, initialY;

    header.addEventListener('mousedown', (e) => {
        const target = e.target;
        if (target.closest('.exec-runner-controls')) return;
        initialX = e.clientX - runnerWindow.offsetLeft;
        initialY = e.clientY - runnerWindow.offsetTop;
        isDragging = true;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;
        runnerWindow.style.left = currentX + 'px';
        runnerWindow.style.top = currentY + 'px';
        runnerWindow.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    function ensureSocket() {
        if (execRunnerSocket) return;
        execRunnerSocket = io({
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            timeout: 20000,
        });

        execRunnerSocket.on('exec_history', (data) => {
            if (!data || data.process_id !== execRunnerProcessId) return;
            outputEl.textContent = (data.lines || []).join('\n');
            if (outputEl.textContent.length > 0) outputEl.textContent += '\n';
            if (data.running) {
                statusEl.textContent = 'Running (streaming)';
            } else {
                statusEl.textContent = `Exited (${data.return_code ?? 'unknown'})`;
            }
        });

        execRunnerSocket.on('exec_output', (data) => {
            if (!data || data.process_id !== execRunnerProcessId) return;
            outputEl.textContent += (data.line ?? '') + '\n';
            outputEl.scrollTop = outputEl.scrollHeight;
        });

        execRunnerSocket.on('exec_exit', (data) => {
            if (!data || data.process_id !== execRunnerProcessId) return;
            execRunnerStreaming = false;
            resumeBtn.style.display = 'none';
            statusEl.textContent = `Exited (${data.return_code ?? 'unknown'})`;
        });

        execRunnerSocket.on('exec_error', (data) => {
            if (!data || data.process_id !== execRunnerProcessId) return;
            statusEl.textContent = `Error: ${data.error ?? 'unknown'}`;
        });
    }

    function joinStream() {
        if (!execRunnerProcessId) return;
        ensureSocket();
        execRunnerSocket.emit('join_exec', { process_id: execRunnerProcessId });
        execRunnerStreaming = true;
        resumeBtn.style.display = 'none';
        statusEl.textContent = 'Running (streaming)';
    }

    function leaveStream() {
        if (!execRunnerSocket || !execRunnerProcessId) return;
        execRunnerSocket.emit('leave_exec', { process_id: execRunnerProcessId });
        execRunnerStreaming = false;
        resumeBtn.style.display = 'inline-block';
        statusEl.textContent = 'Minimized (not streaming)';
    }

    startBtn.addEventListener('click', async () => {
        if (!execRunnerFile) return;

        outputEl.textContent = '';
        statusEl.textContent = 'Starting...';

        const params = (paramsEl.value || '').trim();

        try {
            const resp = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: execRunnerFile.path, params }),
            });
            const data = await resp.json();
            if (!data.success) {
                statusEl.textContent = 'Start failed';
                alert('Failed to start: ' + (data.error || 'unknown'));
                return;
            }

            execRunnerProcessId = data.process_id;
            pathEl.textContent = execRunnerFile.path;
            joinStream();
        } catch (e) {
            statusEl.textContent = 'Start failed';
            alert('Failed to start: ' + e);
        }
    });

    killBtn.addEventListener('click', async () => {
        if (!execRunnerProcessId) return;
        try {
            statusEl.textContent = 'Killing...';
            const resp = await fetch('/api/execute/kill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ process_id: execRunnerProcessId }),
            });
            const data = await resp.json();
            if (!data.success) {
                statusEl.textContent = 'Kill failed';
                alert('Failed to kill: ' + (data.error || 'unknown'));
                return;
            }
            statusEl.textContent = 'Kill sent';
        } catch (e) {
            statusEl.textContent = 'Kill failed';
            alert('Failed to kill: ' + e);
        }
    });

    minimizeBtn.addEventListener('click', () => {
        if (execRunnerProcessId && execRunnerStreaming) {
            leaveStream();
        } else if (execRunnerProcessId) {
            joinStream();
        }
    });

    resumeBtn.addEventListener('click', () => {
        joinStream();
    });

    closeBtn.addEventListener('click', () => {
        // Close means: stop streaming, but keep process running.
        if (execRunnerProcessId && execRunnerStreaming) {
            leaveStream();
        }
        runnerWindow.style.display = 'none';
    });

    // Initialize UI
    title.innerHTML = '<i class="fas fa-terminal"></i> Runner';
    pathEl.textContent = '';
    statusEl.textContent = 'Idle';
    resumeBtn.style.display = 'none';
}

function openExecutableRunner(file) {
    execRunnerFile = file;
    const runnerWindow = document.getElementById('exec-runner-window');
    const title = document.getElementById('exec-runner-title');
    const pathEl = document.getElementById('exec-runner-path');
    const outputEl = document.getElementById('exec-runner-output');
    const statusEl = document.getElementById('exec-runner-status');
    const resumeBtn = document.getElementById('exec-runner-resume');

    if (!runnerWindow || !title) return;

    title.innerHTML = `<i class="fas fa-terminal"></i> ${file.name}`;
    pathEl.textContent = file.path;

    if (!execRunnerProcessId) {
        outputEl.textContent = '';
        statusEl.textContent = 'Ready';
    }

    // If we have a running process already but streaming is off, let user resume.
    if (execRunnerProcessId && !execRunnerStreaming) {
        resumeBtn.style.display = 'inline-block';
    }

    runnerWindow.style.display = 'flex';
}
