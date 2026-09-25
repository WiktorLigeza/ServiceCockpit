// Bluetooth page: features (audio / files / internet / serial), per-device
// "what would you like to do", and the Audio / Files / Serial tabs.
// Builds on helpers from bluetooth.js (btApi, btToast, btEscape, confirmBt, …).

let btFeatures = {};
let btSetup = { state: 'idle', feature: null };
let btActiveTab = 'device';
let btTransfers = {};
let btFileRequests = [];
let btSerialLinks = [];
let btSerialMac = null;
const btSerialEntries = {};   // mac -> [{dir: 'in'|'out', bytes: Uint8Array}]
let btAudioTimer = null;

const BT_SERVICE_ACTIONS = {
    connect: { label: 'Connect', icon: 'fa-link', cls: 'btn-success' },
    disconnect: { label: 'Disconnect', icon: 'fa-unlink', cls: 'btn-outline-warning' },
    make_default: { label: 'Make default output', icon: 'fa-star', cls: 'btn-outline-info' },
    open_terminal: { label: 'Open terminal', icon: 'fa-terminal', cls: 'btn-primary' },
    send: { label: 'Send a file…', icon: 'fa-paper-plane', cls: 'btn-primary' },
};

function btFormatSize(bytes) {
    if (bytes === null || bytes === undefined) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function btDeviceName(mac) {
    const dev = btDevices.find(d => d.mac === mac);
    return dev && dev.has_name ? dev.name : mac;
}

// ---------------------------------------------------------------- init / socket

function btServicesInit() {
    loadBtFeatures();
    loadBtFiles();
    loadBtSerial();
}

function btServicesAttach(socket) {
    socket.on('bt_features_changed', () => {
        refreshBtFeatures();
        if (btSelectedMac) refreshDeviceServices();
    });
    socket.on('bt_setup', onBtSetupEvent);
    socket.on('bt_file_request', req => {
        btFileRequests.push(req);
        showNextFileRequest();
        renderBtBadges();
    });
    socket.on('bt_file_request_closed', d => {
        btFileRequests = btFileRequests.filter(r => r.id !== d.id);
        const modal = document.getElementById('bt-file-modal');
        if (modal.dataset.id === d.id) {
            modal.hidden = true;
            modal.dataset.id = '';
            if (d.reason === 'timeout' || d.reason === 'canceled') btToast('The file offer was withdrawn', 'info');
            showNextFileRequest();
        }
        renderBtBadges();
    });
    socket.on('bt_transfer', t => {
        if (t.transfer && !t.transfer.startsWith('pending:') && t.job) delete btTransfers[`pending:${t.job}`];
        btTransfers[t.transfer] = { ...(btTransfers[t.transfer] || {}), ...t };
        renderBtTransfers();
        if (t.status === 'complete' && t.direction === 'incoming') refreshBtFiles();
    });
    socket.on('bt_serial_links', d => {
        btSerialLinks = d.links || [];
        renderBtSerial();
        if (btSelectedMac) refreshDeviceServices();
    });
    socket.on('bt_serial_data', d => {
        pushSerialEntry(d.mac, 'in', Uint8Array.from(atob(d.data), c => c.charCodeAt(0)));
    });
    socket.on('bt_devices_changed', () => {
        if (btActiveTab === 'audio') refreshBtAudio();
    });
}

// ---------------------------------------------------------------- tabs

function setBtTab(tab) {
    btActiveTab = tab;
    document.querySelectorAll('#bt-tabs .bt-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.bt-tab-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    clearInterval(btAudioTimer);
    btAudioTimer = null;
    if (tab === 'audio') {
        loadBtAudio();
        btAudioTimer = setInterval(loadBtAudio, 6000);
    } else if (tab === 'files') {
        loadBtFiles();
        fillSendDevices();
    } else if (tab === 'serial') {
        renderBtSerial();
    } else if (tab === 'log') {
        const log = document.getElementById('bt-log');
        log.scrollTop = log.scrollHeight;
    }
}

function renderBtBadges() {
    const active = Object.values(btTransfers).filter(t => !['complete', 'error'].includes(t.status)).length + btFileRequests.length;
    const files = document.getElementById('bt-files-badge');
    files.hidden = !active;
    files.textContent = active;
    const serial = document.getElementById('bt-serial-badge');
    serial.hidden = !btSerialLinks.length;
    serial.textContent = btSerialLinks.length;
}

// ---------------------------------------------------------------- features + setup

async function loadBtFeatures() {
    const { ok, data } = await btApi('/api/bluetooth/features');
    if (!ok) return;
    btFeatures = data.features || {};
    if (data.setup) {
        btSetup = data.setup;
        const log = document.getElementById('bt-setup-log');
        if (data.setup.state !== 'idle' && data.setup.lines?.length && !log.childElementCount) {
            data.setup.lines.forEach(appendSetupLine);
            log.hidden = false;
        }
    }
    renderBtFeatures();
    renderFeatureNotes();
}

const refreshBtFeatures = btDebounce(loadBtFeatures, 700);

function renderBtFeatures() {
    const el = document.getElementById('bt-features');
    const entries = Object.entries(btFeatures);
    if (!entries.length) {
        el.innerHTML = '<div class="bt-muted">Unavailable</div>';
        return;
    }
    el.innerHTML = entries.map(([key, f]) => {
        const running = btSetup.state === 'running' && btSetup.feature === key;
        let status;
        if (running) {
            status = '<span class="bt-feature-state busy"><i class="fas fa-spinner fa-spin"></i> Setting up…</span>';
        } else if (f.ready) {
            status = '<span class="bt-feature-state ok"><i class="fas fa-check-circle"></i> Ready</span>';
        } else {
            status = '<span class="bt-feature-state bad"><i class="fas fa-exclamation-circle"></i> Needs setup</span>';
        }
        const setupBtn = !f.ready && f.can_setup && !running
            ? `<button class="btn btn-sm btn-primary" data-setup="${btEscape(key)}" ${btSetup.state === 'running' ? 'disabled' : ''}>Set up</button>`
            : '';
        const issues = !f.ready && f.issues?.length
            ? `<ul class="bt-feature-issues">${f.issues.map(i => `<li>${btEscape(i)}</li>`).join('')}</ul>`
            : '';
        return `
            <div class="bt-feature">
                <div class="bt-feature-head">
                    <i class="fas ${btEscape(f.icon)}"></i>
                    <div class="bt-feature-title">
                        <div>${btEscape(f.title)}</div>
                        <div class="bt-muted">${btEscape(f.description)}</div>
                    </div>
                    ${status}
                </div>
                ${issues}
                ${setupBtn ? `<div class="bt-feature-actions">${setupBtn}</div>` : ''}
            </div>`;
    }).join('');
}

function renderFeatureNotes() {
    const note = (id, feature) => {
        const el = document.getElementById(id);
        const f = btFeatures[feature];
        if (!el || !f) return;
        el.hidden = f.ready;
        if (f.ready) return;
        el.innerHTML = `
            <div><i class="fas fa-exclamation-triangle"></i> ${btEscape(f.title)} isn't ready: ${btEscape((f.issues || []).join('; '))}</div>
            ${f.can_setup ? `<button class="btn btn-sm btn-primary" data-setup="${btEscape(feature)}">Set up ${btEscape(f.title.toLowerCase())}</button>` : ''}`;
    };
    note('bt-files-note', 'files');
    note('bt-serial-note', 'serial');
}

function requestBtSetup(feature) {
    const f = btFeatures[feature];
    if (!f) return;
    confirmBt(`Set up ${f.title.toLowerCase()}?`,
        `${f.setup_summary} This needs internet access and may take a few minutes. Progress is shown under “Bluetooth features”.`,
        () => startBtSetup(feature));
}

async function startBtSetup(feature) {
    const { ok, status, data } = await btApi(`/api/bluetooth/features/${encodeURIComponent(feature)}/setup`, {});
    if (status === 401 && data.error === 'sudo_required') {
        if (typeof showSudoModal === 'function') {
            showSudoModal(data.message || 'Sudo password required.', () => startBtSetup(feature));
        }
        return;
    }
    if (!ok) {
        btToast(data.error || 'Could not start setup', 'error');
        return;
    }
    btSetup = { state: 'running', feature };
    const log = document.getElementById('bt-setup-log');
    log.innerHTML = '';
    log.hidden = false;
    renderBtFeatures();
}

function appendSetupLine(line) {
    const log = document.getElementById('bt-setup-log');
    const el = document.createElement('div');
    if (line.startsWith('==>')) el.className = 'l-chg';
    else if (/^Setup failed|^E: /.test(line)) el.className = 'l-err';
    else if (/^Setup finished/.test(line)) el.className = 'l-ok';
    el.textContent = line;
    log.appendChild(el);
    while (log.childElementCount > 400) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
}

function onBtSetupEvent(d) {
    if (d.line) appendSetupLine(d.line);
    const finished = d.state !== btSetup.state && (d.state === 'done' || d.state === 'failed');
    btSetup = { state: d.state, feature: d.feature };
    if (finished) {
        btToast(d.state === 'done' ? 'Setup finished' : 'Setup failed - see the output under “Bluetooth features”',
            d.state === 'done' ? 'success' : 'error', 7000);
        loadBtFeatures();
        if (btSelectedMac) refreshDeviceServices();
        if (btActiveTab === 'audio') loadBtAudio();
    }
    renderBtFeatures();
}

// ---------------------------------------------------------------- per-device services

async function loadDeviceServices(mac) {
    const { ok, data } = await btApi(`/api/bluetooth/device/${encodeURIComponent(mac)}/services`);
    const el = document.getElementById('bt-device-services');
    if (!el || mac !== btSelectedMac) return;
    if (!ok) {
        el.innerHTML = `<div class="bt-muted">${btEscape(data.error || 'Could not read device services')}</div>`;
        return;
    }
    const dev = btDevices.find(d => d.mac === mac);
    const pairNote = dev && !dev.paired
        ? '<div class="bt-feature-note"><i class="fas fa-handshake"></i> Pair the device first - most of these need a paired device.</div>'
        : '';
    if (!data.services.length) {
        el.innerHTML = pairNote + `<div class="bt-muted">This device doesn't advertise anything the Pi knows how to use.
            ${dev && !dev.connected ? 'Connecting it once can reveal more services.' : ''}</div>`;
        return;
    }
    el.innerHTML = pairNote + data.services.map(s => {
        let body;
        if (!s.ready) {
            body = `<div class="bt-service-status bad">${btEscape((s.issues || []).join('; ') || 'Not available')}</div>
                ${s.can_setup ? `<div class="bt-service-actions"><button class="btn btn-sm btn-primary" data-setup="${btEscape(s.feature)}">Set up</button></div>` : ''}`;
        } else {
            const buttons = s.actions.map(a => {
                const def = BT_SERVICE_ACTIONS[a] || { label: a, icon: 'fa-cog', cls: 'btn-outline-light' };
                const label = a === 'connect' && s.id === 'audio_out' ? 'Connect & use' : def.label;
                return `<button class="btn btn-sm ${def.cls}" data-service="${btEscape(s.id)}" data-service-action="${btEscape(a)}">
                    <i class="fas ${def.icon}"></i> ${btEscape(label)}</button>`;
            }).join('');
            body = `${s.detail ? `<div class="bt-service-status ${s.active ? 'ok' : ''}">${btEscape(s.detail)}</div>` : ''}
                <div class="bt-service-actions">${buttons}</div>`;
        }
        return `
            <div class="bt-service ${s.active ? 'active' : ''}">
                <div class="bt-service-icon"><i class="fas ${btEscape(s.icon)}"></i></div>
                <div class="bt-service-main">
                    <div class="bt-service-title">${btEscape(s.title)}</div>
                    <div class="bt-muted">${btEscape(s.description)}</div>
                    ${body}
                </div>
            </div>`;
    }).join('');
}

const refreshDeviceServices = btDebounce(() => btSelectedMac && loadDeviceServices(btSelectedMac), 600);

async function runServiceAction(button, service, action) {
    const mac = btSelectedMac;
    if (!mac) return;
    if (action === 'open_terminal') {
        btSerialMac = mac;
        setBtTab('serial');
        return;
    }
    if (action === 'send') {
        setBtTab('files');
        document.getElementById('bt-send-device').value = mac;
        document.getElementById('bt-send-file').click();
        return;
    }
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working…';
    const { ok, status, data } = await btApi(
        `/api/bluetooth/device/${encodeURIComponent(mac)}/service/${encodeURIComponent(service)}/${encodeURIComponent(action)}`, {});
    button.disabled = false;
    button.innerHTML = original;
    if (status === 401 && data.error === 'sudo_required') {
        if (typeof showSudoModal === 'function') {
            showSudoModal(data.message || 'Sudo password required.', () => runServiceAction(button, service, action));
        }
        return;
    }
    if (!ok) {
        btToast((data.error || 'Failed') + (data.hint ? `\n${data.hint}` : ''), 'error', 9000);
    } else {
        const done = {
            connect: service === 'serial' ? 'Connecting serial port…' : 'Connected',
            disconnect: 'Disconnected',
            make_default: 'Now the default audio output',
        };
        btToast(done[action] || 'Done', 'success');
        if (service === 'serial' && action === 'connect') btSerialMac = mac;
    }
    loadDeviceServices(mac);
    refreshBtDevices();
    if (btActiveTab === 'audio') loadBtAudio();
}

// ---------------------------------------------------------------- audio

async function loadBtAudio() {
    const el = document.getElementById('bt-audio');
    const { ok, data } = await btApi('/api/bluetooth/audio');
    if (!ok) {
        el.innerHTML = `<div class="bt-empty">${btEscape(data.error || 'Could not read audio state')}</div>`;
        return;
    }
    const feature = btFeatures.audio;
    if (!data.available || (feature && !feature.ready)) {
        el.innerHTML = `
            <div class="bt-feature-note">
                <div><i class="fas fa-exclamation-triangle"></i> Bluetooth audio isn't ready${feature ? ': ' + btEscape((feature.issues || []).join('; ')) : ''}.</div>
                <button class="btn btn-sm btn-primary" data-setup="audio">Set up audio</button>
            </div>`;
        if (!data.available) return;
    } else {
        el.innerHTML = '';
    }
    // Don't clobber a slider the user is dragging.
    if (el.querySelector('input[type=range]:active')) return;

    const row = (n, kind) => {
        const vol = n.volume === null ? '' : `
            <input type="range" min="0" max="150" step="1" value="${Math.round((n.volume || 0) * 100)}"
                   data-volume="${n.id}" title="Volume">
            <span class="bt-vol-label">${n.volume === null ? '' : Math.round(n.volume * 100) + '%'}</span>
            <button class="bt-icon-btn ${n.muted ? 'muted' : ''}" data-mute="${n.id}" title="${n.muted ? 'Unmute' : 'Mute'}">
                <i class="fas ${n.muted ? 'fa-volume-mute' : 'fa-volume-up'}"></i></button>`;
        const makeDefault = kind === 'out' || !n.stream
            ? `<button class="bt-icon-btn ${n.default ? 'is-default' : ''}" data-default="${n.id}" title="${n.default ? 'Default' : 'Make default'}">
                   <i class="${n.default ? 'fas' : 'far'} fa-star"></i></button>`
            : '';
        const test = kind === 'out' ? `<button class="btn btn-sm btn-outline-light" data-test="${n.id}" title="Play a test sound"><i class="fas fa-bell"></i></button>` : '';
        return `
            <div class="bt-audio-row ${n.default ? 'default' : ''}">
                ${makeDefault}
                <div class="bt-audio-name">
                    <div>${n.bluetooth ? '<i class="fab fa-bluetooth-b"></i> ' : ''}${btEscape(n.description)}</div>
                    <div class="bt-muted">${n.stream ? 'Playing from device' : ''}${n.codec ? ' · ' + btEscape(n.codec) : ''}${n.default ? ' · default' : ''}</div>
                </div>
                <div class="bt-audio-controls">${vol}${test}</div>
            </div>`;
    };

    el.insertAdjacentHTML('beforeend', `
        <div class="bt-subtitle">Outputs</div>
        ${data.outputs.length ? data.outputs.map(n => row(n, 'out')).join('')
            : '<div class="bt-muted">No audio outputs. Connect Bluetooth headphones/speakers, HDMI with audio, or a USB sound card.</div>'}
        <div class="bt-subtitle">Inputs &amp; Bluetooth streams</div>
        ${data.inputs.length ? data.inputs.map(n => row(n, 'in')).join('') : '<div class="bt-muted">No inputs.</div>'}
        <div class="bt-muted bt-audio-help">
            To play a phone's music on the Pi: select the phone → “Play its audio on the Pi” → connect, then press play on the phone.
            It comes out of the output marked with a star.
        </div>`);
}

const refreshBtAudio = btDebounce(loadBtAudio, 1000);

async function audioAction(id, action, body = {}) {
    const { ok, data } = await btApi(`/api/bluetooth/audio/${id}/${action}`, body);
    if (!ok) btToast(data.error || 'Audio action failed', 'error');
    if (action !== 'test') loadBtAudio();
}

// ---------------------------------------------------------------- files

async function loadBtFiles() {
    const { ok, data } = await btApi('/api/bluetooth/files');
    if (!ok) return;
    document.getElementById('bt-received-folder').textContent = data.folder ? `(${data.folder})` : '';
    (data.transfers || []).forEach(t => { btTransfers[t.transfer] = t; });
    renderBtTransfers();
    (data.requests || []).forEach(r => {
        if (!btFileRequests.some(x => x.id === r.id)) btFileRequests.push(r);
    });
    showNextFileRequest();

    const list = document.getElementById('bt-received');
    list.innerHTML = (data.received || []).length ? data.received.map(f => `
        <div class="bt-file-row">
            <i class="fas fa-file"></i>
            <a href="/api/bluetooth/files/received/${encodeURIComponent(f.name)}" class="bt-file-name" title="Download">${btEscape(f.name)}</a>
            <span class="bt-muted">${btFormatSize(f.size)} · ${new Date(f.mtime * 1000).toLocaleString()}</span>
            <button class="bt-icon-btn" data-delete-file="${btEscape(f.name)}" title="Delete"><i class="fas fa-trash"></i></button>
        </div>`).join('') : '<div class="bt-muted">Nothing received yet. Make the Pi discoverable and send a file from your phone.</div>';
    renderBtBadges();
}

const refreshBtFiles = btDebounce(loadBtFiles, 800);

function fillSendDevices() {
    const select = document.getElementById('bt-send-device');
    const current = select.value;
    const paired = btDevices.filter(d => d.paired);
    select.innerHTML = paired.length
        ? paired.map(d => `<option value="${btEscape(d.mac)}">${btEscape(d.has_name ? d.name : d.mac)} (${btEscape(d.mac)})</option>`).join('')
        : '<option value="">No paired devices</option>';
    if (current && paired.some(d => d.mac === current)) select.value = current;
    else if (btSelectedMac && paired.some(d => d.mac === btSelectedMac)) select.value = btSelectedMac;
}

function renderBtTransfers() {
    const el = document.getElementById('bt-transfers');
    const items = Object.values(btTransfers).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    el.innerHTML = items.length ? items.map(t => {
        const pct = t.size ? Math.min(100, Math.round(((t.transferred || 0) / t.size) * 100)) : (t.status === 'complete' ? 100 : 0);
        const statusText = {
            connecting: 'Connecting…', queued: 'Waiting for the other device to accept…', active: `${pct}%`,
            complete: 'Done', error: t.error ? `Failed: ${t.error}` : 'Failed', suspended: 'Paused',
        }[t.status] || t.status;
        const canCancel = t.transfer && t.transfer.startsWith('/') && !['complete', 'error'].includes(t.status);
        return `
            <div class="bt-transfer ${btEscape(t.status || '')}">
                <div class="bt-transfer-head">
                    <i class="fas ${t.direction === 'incoming' ? 'fa-download' : 'fa-upload'}"></i>
                    <span class="bt-file-name">${btEscape(t.name || 'file')}</span>
                    <span class="bt-muted">${t.direction === 'incoming' ? 'from' : 'to'} ${btEscape(btDeviceName((t.mac || '').toUpperCase()))}</span>
                    ${canCancel ? `<button class="bt-icon-btn" data-cancel-transfer="${btEscape(t.transfer)}" title="Cancel"><i class="fas fa-times"></i></button>` : ''}
                </div>
                <div class="bt-progress"><div style="width:${pct}%"></div></div>
                <div class="bt-muted">${btEscape(statusText)} ${t.size ? '· ' + btFormatSize(t.size) : ''}</div>
            </div>`;
    }).join('') : '<div class="bt-muted">No transfers</div>';
    renderBtBadges();
}

function showNextFileRequest() {
    const modal = document.getElementById('bt-file-modal');
    if (!modal.hidden || !btFileRequests.length) return;
    const req = btFileRequests[0];
    modal.dataset.id = req.id;
    document.getElementById('bt-file-device').textContent = `${btDeviceName((req.mac || '').toUpperCase())} ${req.mac ? '(' + req.mac + ')' : ''}`;
    document.getElementById('bt-file-message').textContent =
        `wants to send you “${req.name}”${req.size ? ` (${btFormatSize(req.size)})` : ''}. It will be saved to ~/Bluetooth.`;
    modal.hidden = false;
}

function answerFileRequest(accept) {
    const modal = document.getElementById('bt-file-modal');
    const id = modal.dataset.id;
    modal.hidden = true;
    modal.dataset.id = '';
    btFileRequests = btFileRequests.filter(r => r.id !== id);
    if (id && btSocket) btSocket.emit('bt_file_answer', { id, accept });
    if (accept) setBtTab('files');
    renderBtBadges();
    setTimeout(showNextFileRequest, 300);
}

async function sendBtFile(e) {
    e.preventDefault();
    const mac = document.getElementById('bt-send-device').value;
    const fileInput = document.getElementById('bt-send-file');
    const pathInput = document.getElementById('bt-send-path');
    if (!mac) {
        btToast('Pick a paired device first', 'error');
        return;
    }
    let resp;
    if (fileInput.files.length) {
        const form = new FormData();
        form.append('file', fileInput.files[0]);
        btToast(`Uploading ${fileInput.files[0].name}…`, 'info', 2000);
        resp = await fetch(`/api/bluetooth/device/${encodeURIComponent(mac)}/send`, { method: 'POST', body: form })
            .then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
            .catch(err => ({ ok: false, data: { error: String(err) } }));
    } else if (pathInput.value.trim()) {
        resp = await btApi(`/api/bluetooth/device/${encodeURIComponent(mac)}/send`, { path: pathInput.value.trim() });
    } else {
        btToast('Choose a file or type a path', 'error');
        return;
    }
    if (!resp.ok || resp.data.success === false) {
        btToast((resp.data.error || 'Sending failed') + (resp.data.hint ? `\n${resp.data.hint}` : ''), 'error', 8000);
        return;
    }
    fileInput.value = '';
    pathInput.value = '';
    btToast('Sending… accept the file on the other device', 'info', 5000);
}

// ---------------------------------------------------------------- serial

async function loadBtSerial() {
    const { ok, data } = await btApi('/api/bluetooth/serial');
    if (!ok) return;
    btSerialLinks = data.links || [];
    Object.entries(data.buffers || {}).forEach(([mac, b64]) => {
        if (!btSerialEntries[mac] && b64) {
            btSerialEntries[mac] = [{ dir: 'in', bytes: Uint8Array.from(atob(b64), c => c.charCodeAt(0)) }];
        }
    });
    renderBtSerial();
}

function renderBtSerial() {
    const select = document.getElementById('bt-serial-select');
    const linked = new Set(btSerialLinks.map(l => l.mac));
    const options = [
        ...btSerialLinks.map(l => ({ mac: l.mac, label: `● ${btDeviceName(l.mac)} - connected (${l.direction})` })),
        ...btDevices.filter(d => d.paired && !linked.has(d.mac)).map(d => ({ mac: d.mac, label: `${btDeviceName(d.mac)} (${d.mac})` })),
    ];
    if (!btSerialMac && btSerialLinks.length) btSerialMac = btSerialLinks[0].mac;
    select.innerHTML = options.length
        ? options.map(o => `<option value="${btEscape(o.mac)}">${btEscape(o.label)}</option>`).join('')
        : '<option value="">No paired devices</option>';
    if (btSerialMac && options.some(o => o.mac === btSerialMac)) select.value = btSerialMac;
    btSerialMac = select.value || null;

    const link = btSerialLinks.find(l => l.mac === btSerialMac);
    document.getElementById('bt-serial-connect').hidden = !!link || !btSerialMac;
    document.getElementById('bt-serial-disconnect').hidden = !link;
    document.getElementById('bt-serial-input').disabled = !link;
    document.getElementById('bt-serial-info').innerHTML = link
        ? `Connected (${btEscape(link.direction)}) · serial port for scripts: <code>${btEscape(link.link || link.pty)}</code>`
        : (btSerialMac ? 'Not connected. The device needs a serial (SPP) service - e.g. HC-05, ESP32 BluetoothSerial, or a phone serial-terminal app. Phones can also connect to the Pi themselves.' : '');
    renderSerialOutput();
    renderBtBadges();
}

function pushSerialEntry(mac, dir, bytes) {
    const entries = btSerialEntries[mac] || (btSerialEntries[mac] = []);
    entries.push({ dir, bytes });
    let total = entries.reduce((n, e) => n + e.bytes.length, 0);
    while (total > 65536 && entries.length > 1) total -= entries.shift().bytes.length;
    if (mac === btSerialMac) appendSerialEntry({ dir, bytes });
}

function serialEntryText(entry) {
    if (document.getElementById('bt-serial-hex').checked) {
        return Array.from(entry.bytes, b => b.toString(16).padStart(2, '0')).join(' ') + ' ';
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes);
}

function appendSerialEntry(entry) {
    const out = document.getElementById('bt-serial-out');
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const el = document.createElement('span');
    if (entry.dir === 'out') {
        el.className = 'l-sent';
        el.textContent = `» ${serialEntryText(entry)}\n`;
    } else {
        el.textContent = serialEntryText(entry);
    }
    out.appendChild(el);
    while (out.childElementCount > 2000) out.firstElementChild.remove();
    if (atBottom) out.scrollTop = out.scrollHeight;
}

function renderSerialOutput() {
    const out = document.getElementById('bt-serial-out');
    out.innerHTML = '';
    (btSerialEntries[btSerialMac] || []).forEach(appendSerialEntry);
    out.scrollTop = out.scrollHeight;
}

async function serialConnect(connect) {
    const mac = document.getElementById('bt-serial-select').value;
    if (!mac) return;
    btSerialMac = mac;
    const { ok, data } = await btApi(`/api/bluetooth/device/${encodeURIComponent(mac)}/service/serial/${connect ? 'connect' : 'disconnect'}`, {});
    if (!ok) btToast((data.error || 'Failed') + (data.hint ? `\n${data.hint}` : ''), 'error', 8000);
    else if (connect) btToast('Connecting serial port…', 'info');
}

function sendSerial(e) {
    e.preventDefault();
    const input = document.getElementById('bt-serial-input');
    const hex = document.getElementById('bt-serial-hex').checked;
    const eol = document.getElementById('bt-serial-eol').value;
    const text = input.value;
    if (!btSerialMac || !btSocket) return;
    btSocket.emit('bt_serial_write', { mac: btSerialMac, text, eol: hex ? '' : eol, hex }, resp => {
        if (resp && !resp.success) {
            btToast(resp.error || 'Send failed', 'error');
            return;
        }
        const bytes = hex
            ? Uint8Array.from((text.replace(/[\s,:]/g, '').match(/../g) || []).map(h => parseInt(h, 16)))
            : new TextEncoder().encode(text);
        pushSerialEntry(btSerialMac, 'out', bytes);
    });
    input.value = '';
}

// ---------------------------------------------------------------- listeners

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('bt-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.bt-tab');
        if (tab) setBtTab(tab.dataset.tab);
    });

    document.body.addEventListener('click', e => {
        const setup = e.target.closest('[data-setup]');
        if (setup) {
            requestBtSetup(setup.dataset.setup);
            return;
        }
        const svc = e.target.closest('[data-service-action]');
        if (svc) {
            runServiceAction(svc, svc.dataset.service, svc.dataset.serviceAction);
            return;
        }
        const def = e.target.closest('[data-default]');
        if (def) return audioAction(def.dataset.default, 'default');
        const mute = e.target.closest('[data-mute]');
        if (mute) return audioAction(mute.dataset.mute, 'mute');
        const test = e.target.closest('[data-test]');
        if (test) return audioAction(test.dataset.test, 'test');
        const del = e.target.closest('[data-delete-file]');
        if (del) {
            const name = del.dataset.deleteFile;
            confirmBt('Delete file?', `${name} will be deleted from ~/Bluetooth.`, async () => {
                const resp = await fetch(`/api/bluetooth/files/received/${encodeURIComponent(name)}`, { method: 'DELETE' });
                if (!resp.ok) btToast('Delete failed', 'error');
                loadBtFiles();
            });
            return;
        }
        const cancel = e.target.closest('[data-cancel-transfer]');
        if (cancel) btApi('/api/bluetooth/transfer/cancel', { transfer: cancel.dataset.cancelTransfer });
    });

    document.getElementById('bt-audio').addEventListener('change', e => {
        const slider = e.target.closest('[data-volume]');
        if (slider) audioAction(slider.dataset.volume, 'volume', { volume: Number(slider.value) / 100 });
    });
    document.getElementById('bt-audio').addEventListener('input', e => {
        const slider = e.target.closest('[data-volume]');
        const label = slider?.parentElement.querySelector('.bt-vol-label');
        if (label) label.textContent = `${slider.value}%`;
    });

    document.getElementById('bt-send-form').addEventListener('submit', sendBtFile);
    document.getElementById('bt-file-accept').addEventListener('click', () => answerFileRequest(true));
    document.getElementById('bt-file-decline').addEventListener('click', () => answerFileRequest(false));

    document.getElementById('bt-serial-select').addEventListener('change', e => {
        btSerialMac = e.target.value || null;
        renderBtSerial();
    });
    document.getElementById('bt-serial-connect').addEventListener('click', () => serialConnect(true));
    document.getElementById('bt-serial-disconnect').addEventListener('click', () => serialConnect(false));
    document.getElementById('bt-serial-form').addEventListener('submit', sendSerial);
    document.getElementById('bt-serial-hex').addEventListener('change', renderSerialOutput);
    document.getElementById('bt-serial-clear').addEventListener('click', () => {
        if (btSerialMac) btSerialEntries[btSerialMac] = [];
        renderSerialOutput();
    });
});
