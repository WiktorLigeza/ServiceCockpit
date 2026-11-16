// Remote Browser page: a browser running on the device's virtual screen (Xvnc),
// drawn with noVNC over the /api/remote-browser/ws WebSocket. The viewer runs in an
// iframe (remote_browser_screen.js) so the cockpit's page zoom does not skew the pointer.
let rbStatus = null;
let rbConnected = false;       // the iframe's viewer is connected (or connecting)
let rbPollTimer = null;
let rbReconnectTimer = null;
let rbBusy = false;

const rbEl = id => document.getElementById(id);

const rbJobModal = new JobModal({
    jobUrl: '/api/remote-browser/job',
    cancelUrl: '/api/remote-browser/job/cancel',
    titles: { install: '<i class="fas fa-download"></i> Installing the remote browser' },
    doneText: { install: 'Installed. Turn the browser on with the switch.' },
    onFinish: () => rbLoad(),
});

document.addEventListener('DOMContentLoaded', () => {
    rbSetupListeners();
    rbLoad();
});

// ---------------------------------------------------------------- helpers

async function rbApi(url, body = undefined, retry = null) {
    const opts = body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
    try {
        const resp = await fetch(url, opts);
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 && data.error === 'sudo_required') {
            if (retry && window.showSudoModal) window.showSudoModal(data.message, retry);
            return { ok: false, sudo: true, data };
        }
        return { ok: resp.ok && data.success !== false, data };
    } catch (e) {
        return { ok: false, data: { error: String(e) } };
    }
}

function rbToast(message, level = 'info', ms = 4000) {
    let stack = document.querySelector('.net-toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.className = 'net-toast-stack';
        document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `net-toast ${level}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

function rbOption(value, label, selected) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = selected;
    return o;
}

// ---------------------------------------------------------------- status

async function rbLoad() {
    clearTimeout(rbPollTimer);
    const res = await rbApi('/api/remote-browser');
    if (res.ok) {
        rbStatus = res.data;
        rbRender();
    }
    // Poll while the page is open: memory use, browser restarts, errors.
    rbPollTimer = setTimeout(rbLoad, rbStatus?.running?.xvnc ? 5000 : 10000);
}

function rbRender() {
    const s = rbStatus;
    rbEl('rb-loading').hidden = true;
    rbEl('rb-install-view').hidden = s.installed;
    rbEl('rb-app-view').hidden = !s.installed;
    if (!s.installed) {
        if (s.job?.state === 'running' && rbJobModal.el?.hidden !== false) rbJobModal.show();
        return;
    }

    const run = s.running;
    const on = s.settings.enabled;
    if (!rbBusy) rbEl('rb-enabled').checked = on;

    const badge = rbEl('rb-badge');
    if (on && run.xvnc && run.browser) {
        badge.textContent = 'Running';
        badge.className = 'net-badge ok';
    } else if (on && run.xvnc) {
        badge.textContent = 'Starting browser…';
        badge.className = 'net-badge info';
    } else if (on) {
        badge.textContent = 'Stopped';
        badge.className = 'net-badge bad';
    } else {
        badge.textContent = 'Off';
        badge.className = 'net-badge';
    }
    rbEl('rb-usage').textContent = run.xvnc
        ? `${run.memory_mb.toFixed(0)} MB RAM · ${run.resolution}`
        : '';

    // Settings (don't overwrite a field the user is editing)
    const browserSel = rbEl('rb-browser');
    if (document.activeElement !== browserSel) {
        browserSel.innerHTML = '';
        if (!s.browsers.length) browserSel.appendChild(rbOption('', 'No browser installed', true));
        const chosen = run.browser_id || s.settings.browser || s.browsers[0]?.id;
        s.browsers.forEach(b => browserSel.appendChild(rbOption(b.id, b.label + (b.snap ? ' (snap)' : ''), b.id === chosen)));
    }
    const resSel = rbEl('rb-resolution');
    if (document.activeElement !== resSel) {
        resSel.innerHTML = '';
        s.resolutions.forEach(r => resSel.appendChild(rbOption(r, r.replace('x', ' × '), r === s.settings.resolution)));
    }
    const home = rbEl('rb-home');
    if (document.activeElement !== home) home.value = s.settings.home_url || '';

    rbEl('rb-restart-btn').disabled = !run.xvnc;
    rbEl('rb-clipboard-btn').disabled = !run.xvnc;
    ['rb-zoom-in', 'rb-zoom-out', 'rb-zoom-reset'].forEach(id => { rbEl(id).disabled = !run.xvnc; });

    const err = rbEl('rb-error');
    err.hidden = !run.error;
    err.textContent = run.error || '';

    rbEl('rb-overlay').hidden = on && run.xvnc;
    if (on && run.xvnc) rbConnect();
    else rbDisconnect();
}

// ---------------------------------------------------------------- noVNC (in the iframe)

// The viewer page in the iframe calls this with connect / disconnect / clipboard / loaderror.
window.rbScreenEvent = (type, detail) => {
    if (type === 'disconnect') {
        rbConnected = false;
        // Still supposed to be running (e.g. screen restarted for a new size)? Reconnect.
        if (rbStatus?.settings?.enabled) {
            clearTimeout(rbReconnectTimer);
            rbReconnectTimer = setTimeout(() => rbLoad(), 1500);
        }
    } else if (type === 'clipboard') {
        rbEl('rb-clipboard-text').value = detail;
    } else if (type === 'loaderror') {
        rbToast('Could not load the VNC viewer (noVNC). Does this computer have internet access?', 'error', 8000);
    } else if (type === 'ready' && rbStatus) {
        rbRender();
    }
};

function rbScreen() {
    try {
        return rbEl('rb-screen').contentWindow?.rbScreen || null;
    } catch (_) {
        return null;
    }
}

async function rbConnect() {
    const screen = rbScreen();
    if (!screen || rbConnected) return;   // not loaded yet: 'ready' calls rbRender again
    clearTimeout(rbReconnectTimer);
    rbConnected = true;
    if (!await screen.connect(rbStatus.novnc_local)) rbConnected = false;
}

function rbDisconnect() {
    clearTimeout(rbReconnectTimer);
    rbConnected = false;
    rbScreen()?.disconnect();
}

// ---------------------------------------------------------------- actions

function rbSetupListeners() {
    rbEl('rb-install-btn').addEventListener('click', rbInstall);

    rbEl('rb-enabled').addEventListener('change', async e => {
        const enabled = e.target.checked;
        rbBusy = true;
        e.target.disabled = true;
        rbEl('rb-badge').textContent = enabled ? 'Starting…' : 'Stopping…';
        rbEl('rb-badge').className = 'net-badge info';
        if (!enabled) rbDisconnect();
        const res = await rbApi('/api/remote-browser/enabled', { enabled });
        e.target.disabled = false;
        rbBusy = false;
        if (!res.ok) rbToast(res.data.error || 'Failed', 'error', 10000);
        rbLoad();
    });

    const saveSetting = async (body, message) => {
        const res = await rbApi('/api/remote-browser/settings', body);
        if (!res.ok) rbToast(res.data.error || 'Could not save', 'error', 8000);
        else if (message) rbToast(message, 'success');
        if ('resolution' in body) rbDisconnect();
        rbLoad();
    };
    rbEl('rb-browser').addEventListener('change', e => saveSetting({ browser: e.target.value }));
    rbEl('rb-resolution').addEventListener('change', e => saveSetting({ resolution: e.target.value }));
    rbEl('rb-home').addEventListener('change', e => saveSetting({ home_url: e.target.value.trim() }, 'Start page saved.'));

    rbEl('rb-restart-btn').addEventListener('click', async () => {
        const res = await rbApi('/api/remote-browser/restart', { browser_only: true });
        if (!res.ok) rbToast(res.data.error || 'Could not restart', 'error', 8000);
        rbLoad();
    });

    rbEl('rb-fullscreen-btn').addEventListener('click', () => {
        // Full screen from inside the iframe, so the zoomed cockpit page is not involved.
        rbScreen()?.toggleFullscreen();
    });

    // Magnify the viewer itself (scrollbars appear when it is larger than the panel).
    [['rb-zoom-in', 'in'], ['rb-zoom-out', 'out'], ['rb-zoom-reset', 'fit']].forEach(([id, direction]) => {
        rbEl(id).addEventListener('click', () => {
            const label = rbScreen()?.zoom(direction);
            if (label) rbEl('rb-zoom-reset').textContent = label;
        });
    });

    rbEl('rb-clipboard-btn').addEventListener('click', () => {
        rbEl('rb-clipboard').hidden = !rbEl('rb-clipboard').hidden;
    });
    rbEl('rb-clipboard-send').addEventListener('click', () => {
        if (!rbScreen()?.paste(rbEl('rb-clipboard-text').value)) return;
        rbToast('Sent - press Ctrl+V in the remote browser to paste.', 'success');
    });
}

async function rbInstall() {
    const res = await rbJobModal.start('/api/remote-browser/install', {}, rbInstall);
    if (!res.ok && !res.sudo) rbToast(res.error || 'Could not start the install.', 'error', 8000);
}
