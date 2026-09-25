// Bluetooth page
let btSocket = null;
let btAvailable = null;
let btDevices = [];
let btSelectedMac = null;
let btFilter = 'all';
let btScan = { scanning: false, remaining: null };
let btScanTick = null;
let btPendingPrompt = null;
let btStatusTimer = null;
let btConfirmAction = null;

const BT_ICONS = {
    'phone': 'fa-mobile-alt',
    'computer': 'fa-laptop',
    'audio-card': 'fa-volume-up',
    'audio-headset': 'fa-headset',
    'audio-headphones': 'fa-headphones',
    'input-keyboard': 'fa-keyboard',
    'input-mouse': 'fa-mouse',
    'input-gaming': 'fa-gamepad',
    'input-tablet': 'fa-tablet-alt',
    'printer': 'fa-print',
    'camera-photo': 'fa-camera',
    'camera-video': 'fa-video',
    'modem': 'fa-broadcast-tower',
    'network-wireless': 'fa-wifi',
    'video-display': 'fa-tv',
    'multimedia-player': 'fa-music',
    'scanner': 'fa-barcode',
};

document.addEventListener('DOMContentLoaded', () => {
    setupBtListeners();
    loadBtStatus();
});

// ---------------------------------------------------------------- helpers

function btEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function btDebounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

async function btApi(url, body = undefined) {
    const opts = body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
    try {
        const resp = await fetch(url, opts);
        const data = await resp.json().catch(() => ({}));
        return { ok: resp.ok && data.success !== false, status: resp.status, data };
    } catch (e) {
        return { ok: false, status: 0, data: { error: String(e) } };
    }
}

function btToast(message, level = 'info', ms = 4000) {
    let stack = document.querySelector('.bt-toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.className = 'bt-toast-stack';
        document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `bt-toast ${level}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

function btDeviceIcon(icon) {
    return BT_ICONS[icon] ? `fas ${BT_ICONS[icon]}` : 'fab fa-bluetooth-b';
}

function btSignalBars(rssi) {
    if (rssi === null || rssi === undefined) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -67) return 3;
    if (rssi >= -80) return 2;
    return 1;
}

function btSignalHtml(rssi) {
    const bars = btSignalBars(rssi);
    const spans = [1, 2, 3, 4].map(i => `<span class="${i <= bars ? 'on' : ''}"></span>`).join('');
    return `<div class="bt-bars">${spans}</div><div>${rssi === null || rssi === undefined ? '' : rssi + ' dBm'}</div>`;
}

// ---------------------------------------------------------------- status / availability

async function loadBtStatus() {
    const { ok, data } = await btApi('/api/bluetooth/status');
    if (!ok) {
        btToast(data.error || 'Failed to read Bluetooth status', 'error');
        scheduleBtStatus(10000);
        return;
    }
    const availability = data.availability;
    const wasAvailable = btAvailable;
    btAvailable = availability.available;

    document.getElementById('bt-unavailable').hidden = btAvailable;
    document.getElementById('bt-main').hidden = !btAvailable;

    if (!btAvailable) {
        renderUnavailable(availability);
        disconnectBtSocket();
        scheduleBtStatus(5000);
        return;
    }

    renderAdapter(data.adapter, data.controllers, availability);
    setSessionState(data.session?.running);
    setScanState(data.scan || { scanning: false });

    if (wasAvailable !== true) {
        const log = document.getElementById('bt-log');
        log.innerHTML = '';
        (data.log || []).forEach(appendBtLog);
        connectBtSocket();
        loadBtDevices();
        if (data.session?.pending_prompt) showAuthPrompt(data.session.pending_prompt);
    }
    scheduleBtStatus(15000);
}

function scheduleBtStatus(ms) {
    clearTimeout(btStatusTimer);
    btStatusTimer = setTimeout(loadBtStatus, ms);
}

const refreshBtStatus = btDebounce(loadBtStatus, 500);

function renderUnavailable(av) {
    document.getElementById('bt-unavailable-reason').textContent = av.reason || 'Unknown reason';
    document.getElementById('bt-checklist').innerHTML = (av.checks || []).map(c => `
        <li><i class="fas ${c.ok ? 'fa-check-circle' : 'fa-times-circle'}"></i><span>${btEscape(c.label)}</span></li>
    `).join('');
    document.getElementById('bt-hints').innerHTML = (av.hints || []).map(h => `<li>${btEscape(h)}</li>`).join('');
    document.getElementById('bt-fixes').innerHTML = (av.fixes || []).map(f => `
        <button class="btn btn-sm btn-primary" data-fix="${btEscape(f.action)}">
            <i class="fas fa-wrench"></i> ${btEscape(f.label)}
        </button>
    `).join('');
}

async function runBtFix(action, button) {
    if (button) button.disabled = true;
    btToast('Running fix…');
    const { ok, status, data } = await btApi('/api/bluetooth/fix', { action });
    if (button) button.disabled = false;
    if (status === 401 && data.error === 'sudo_required') {
        if (typeof showSudoModal === 'function') {
            showSudoModal(data.message || 'Sudo password required.', () => runBtFix(action));
        }
        return;
    }
    if (!ok) {
        btToast(data.error || 'Fix failed', 'error', 7000);
    } else {
        btToast('Done', 'success');
    }
    btAvailable = null;  // force a full re-render / reconnect
    loadBtStatus();
}

// ---------------------------------------------------------------- socket

function connectBtSocket() {
    if (btSocket) return;
    btSocket = io('/bluetooth', { transports: ['websocket', 'polling'] });

    btSocket.on('bt_log', d => appendBtLog(d.line));
    btSocket.on('bt_session', d => setSessionState(d.running));
    btSocket.on('bt_scan', d => setScanState(d));
    btSocket.on('bt_adapter_changed', () => refreshBtStatus());
    btSocket.on('bt_devices_changed', d => {
        refreshBtDevices();
        if (d && d.mac && d.mac === btSelectedMac) refreshBtDetails();
    });
    btSocket.on('bt_rssi', d => updateDeviceRssi(d.mac, d.rssi));
    btSocket.on('bt_notice', d => {
        btToast(d.message, d.level);
        if (d.level !== 'info' && btSelectedMac) refreshBtDetails();
    });
    btSocket.on('bt_auth_request', showAuthPrompt);
    btSocket.on('bt_auth_display', showAuthDisplay);
    btSocket.on('bt_auth_cancel', () => {
        if (btPendingPrompt || !document.getElementById('bt-auth-modal').hidden) {
            hideAuthModal();
            btToast('Pairing request was canceled', 'info');
        }
    });
}

function disconnectBtSocket() {
    if (!btSocket) return;
    btSocket.disconnect();
    btSocket = null;
}

function setSessionState(running) {
    const dot = document.getElementById('bt-session-dot');
    dot.classList.toggle('running', !!running);
    dot.title = running
        ? 'bluetoothctl agent session running - pairing requests will appear here'
        : 'bluetoothctl agent session not running';
}

// ---------------------------------------------------------------- adapter

function renderAdapter(adapter, controllers, availability) {
    const disabled = !adapter;
    ['bt-powered', 'bt-pairable', 'bt-discoverable', 'bt-alias', 'bt-alias-save'].forEach(id => {
        document.getElementById(id).disabled = disabled;
    });
    document.getElementById('bt-unblock-btn').hidden = !(availability.rfkill || []).some(r => r.soft_blocked);

    if (!adapter) {
        document.getElementById('bt-adapter-mac').textContent = 'No controller reachable';
        return;
    }

    const alias = document.getElementById('bt-alias');
    if (document.activeElement !== alias) alias.value = adapter.alias || adapter.name || '';
    document.getElementById('bt-adapter-mac').textContent = adapter.mac;
    document.getElementById('bt-adapter-class').textContent = adapter.class || '—';
    document.getElementById('bt-powered').checked = adapter.powered;
    document.getElementById('bt-pairable').checked = adapter.pairable;
    document.getElementById('bt-discoverable').checked = adapter.discoverable;

    const timeoutSel = document.getElementById('bt-discoverable-timeout');
    if (adapter.discoverable && adapter.discoverable_timeout !== null) {
        const value = String(adapter.discoverable_timeout);
        if (![...timeoutSel.options].some(o => o.value === value)) {
            timeoutSel.add(new Option(`${adapter.discoverable_timeout} s`, value));
        }
        timeoutSel.value = value;
    }

    const note = document.getElementById('bt-discoverable-note');
    if (!adapter.powered) {
        note.textContent = 'Adapter is powered off.';
    } else if (adapter.discoverable) {
        note.textContent = `Visible to nearby devices as “${adapter.alias || adapter.name}”. Pairing requests will pop up here.`;
    } else {
        note.textContent = '';
    }

    const row = document.getElementById('bt-controllers-row');
    row.hidden = !controllers || controllers.length < 2;
    if (!row.hidden) {
        document.getElementById('bt-controllers').textContent =
            controllers.map(c => `${c.mac}${c.default ? ' (default)' : ''}`).join(', ');
    }
}

async function adapterAction(action, value, extra = {}) {
    const { ok, data } = await btApi('/api/bluetooth/adapter', { action, value, ...extra });
    if (!ok) btToast(data.error || `Failed: ${action}`, 'error', 6000);
    loadBtStatus();
    return ok;
}

// ---------------------------------------------------------------- scanning

function setScanState(state) {
    btScan = state || { scanning: false };
    const btn = document.getElementById('bt-scan-btn');
    btn.classList.toggle('scanning', !!btScan.scanning);
    btn.querySelector('span').textContent = btScan.scanning ? 'Stop scan' : 'Start scan';
    btn.querySelector('i').className = btScan.scanning ? 'fas fa-stop' : 'fas fa-search';

    clearInterval(btScanTick);
    btScanTick = null;
    renderScanStatus();
    if (btScan.scanning && btScan.remaining !== null && btScan.remaining !== undefined) {
        btScanTick = setInterval(() => {
            btScan.remaining = Math.max(0, btScan.remaining - 1);
            renderScanStatus();
        }, 1000);
    }
}

function renderScanStatus() {
    const el = document.getElementById('bt-scan-status');
    if (!btScan.scanning) {
        el.textContent = '';
        return;
    }
    const left = btScan.remaining === null || btScan.remaining === undefined ? 'until stopped' : `${btScan.remaining}s left`;
    el.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Scanning (${btEscape(left)})…`;
}

async function toggleScan() {
    const on = !btScan.scanning;
    const body = {
        on,
        transport: document.getElementById('bt-scan-transport').value,
        duration: Number(document.getElementById('bt-scan-duration').value),
    };
    const { ok, data } = await btApi('/api/bluetooth/scan', body);
    if (!ok) {
        btToast(data.error || 'Scan failed', 'error');
        return;
    }
    setScanState(data.scan);
    if (on && btFilter === 'paired') setBtFilter('all');
}

// ---------------------------------------------------------------- devices

async function loadBtDevices() {
    const { ok, data } = await btApi('/api/bluetooth/devices');
    if (!ok) {
        if (data.availability) refreshBtStatus();
        return;
    }
    btDevices = data.devices || [];
    renderBtDevices();
}

const refreshBtDevices = btDebounce(loadBtDevices, 800);

function setBtFilter(filter) {
    btFilter = filter;
    document.querySelectorAll('#bt-chips .bt-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
    renderBtDevices();
}

function renderBtDevices() {
    const list = document.getElementById('bt-device-list');
    const query = document.getElementById('bt-device-search').value.trim().toLowerCase();
    const hideUnnamed = document.getElementById('bt-hide-unnamed').checked;

    const shown = btDevices.filter(d => {
        if (btFilter === 'paired' && !d.paired) return false;
        if (btFilter === 'connected' && !d.connected) return false;
        if (btFilter === 'nearby' && (d.rssi === null || d.rssi === undefined)) return false;
        if (hideUnnamed && !d.has_name && !d.paired && !d.connected) return false;
        if (query && !d.name.toLowerCase().includes(query) && !d.mac.toLowerCase().includes(query)) return false;
        return true;
    });

    const hidden = btDevices.length - shown.length;
    document.getElementById('bt-device-count').textContent =
        `${shown.length}${hidden ? ` shown · ${hidden} hidden` : ''}`;

    if (!shown.length) {
        list.innerHTML = `<div class="bt-empty">${btDevices.length
            ? 'No devices match the current filter'
            : 'No known devices yet. Start a scan to discover nearby devices.'}</div>`;
        return;
    }

    list.innerHTML = shown.map(d => {
        const badges = [
            d.connected ? '<span class="bt-badge connected">Connected</span>' : '',
            d.paired ? '<span class="bt-badge paired">Paired</span>' : '',
            d.trusted ? '<span class="bt-badge trusted">Trusted</span>' : '',
            d.blocked ? '<span class="bt-badge blocked">Blocked</span>' : '',
            d.battery !== null && d.battery !== undefined ? `<span class="bt-badge"><i class="fas fa-battery-half"></i> ${d.battery}%</span>` : '',
        ].join('');
        return `
            <div class="bt-device ${d.connected ? 'connected' : ''} ${d.mac === btSelectedMac ? 'selected' : ''}" data-mac="${btEscape(d.mac)}">
                <div class="bt-device-icon"><i class="${btDeviceIcon(d.icon)}"></i></div>
                <div class="bt-device-main">
                    <div class="bt-device-name ${d.has_name ? '' : 'unnamed'}">${btEscape(d.has_name ? d.name : 'Unnamed device')}</div>
                    <div class="bt-device-mac">${btEscape(d.mac)}</div>
                    <div class="bt-badges">${badges}</div>
                </div>
                <div class="bt-signal">${btSignalHtml(d.rssi)}</div>
            </div>`;
    }).join('');
}

function updateDeviceRssi(mac, rssi) {
    const dev = btDevices.find(d => d.mac === mac);
    if (!dev) {
        refreshBtDevices();
        return;
    }
    dev.rssi = rssi;
    const el = document.querySelector(`.bt-device[data-mac="${CSS.escape(mac)}"] .bt-signal`);
    if (el) {
        el.innerHTML = btSignalHtml(rssi);
    } else if (btFilter === 'nearby') {
        refreshBtDevices();
    }
}

// ---------------------------------------------------------------- details

async function selectBtDevice(mac) {
    btSelectedMac = mac;
    document.querySelectorAll('.bt-device').forEach(el => el.classList.toggle('selected', el.dataset.mac === mac));
    document.getElementById('bt-details').innerHTML = '<div class="bt-empty"><i class="fas fa-spinner fa-spin"></i></div>';
    await loadBtDetails();
}

async function loadBtDetails() {
    const mac = btSelectedMac;
    if (!mac) return;
    const { ok, data } = await btApi(`/api/bluetooth/device/${encodeURIComponent(mac)}`);
    if (mac !== btSelectedMac) return;
    const container = document.getElementById('bt-details');
    if (!ok) {
        container.innerHTML = `<div class="bt-empty">${btEscape(data.error || 'Device not found')}</div>`;
        return;
    }
    renderBtDetails(data.device);
}

const refreshBtDetails = btDebounce(loadBtDetails, 600);

function renderBtDetails(d) {
    const yesNo = v => `<span class="${v ? 'bt-yes' : 'bt-no'}">${v ? 'Yes' : 'No'}</span>`;
    const btn = (action, label, icon, cls = 'btn-outline-light') =>
        `<button class="btn btn-sm ${cls}" data-action="${action}"><i class="fas ${icon}"></i> ${label}</button>`;

    const actions = [
        d.connected
            ? btn('disconnect', 'Disconnect', 'fa-unlink', 'btn-outline-warning')
            : btn('connect', 'Connect', 'fa-link', 'btn-success'),
        d.paired
            ? ''
            : btn('pair', 'Pair', 'fa-handshake', 'btn-primary') + btn('cancel_pair', 'Cancel pairing', 'fa-ban'),
        d.trusted ? btn('untrust', 'Untrust', 'fa-user-times') : btn('trust', 'Trust', 'fa-user-check'),
        d.blocked ? btn('unblock', 'Unblock', 'fa-check') : btn('block', 'Block', 'fa-ban', 'btn-outline-danger'),
        btn('remove', d.paired ? 'Unpair & remove' : 'Remove', 'fa-trash', 'btn-outline-danger'),
    ].join('');

    const props = [
        ['Address', `<code>${btEscape(d.mac)}</code> ${d.address_type ? `<span class="bt-muted">(${btEscape(d.address_type)})</span>` : ''}`],
        ['Remote name', btEscape(d.name || '—')],
        ['Type', btEscape(d.icon || '—')],
        ['Class', btEscape(d.class || d.appearance || '—')],
        ['Connected', yesNo(d.connected)],
        ['Paired', yesNo(d.paired)],
        ['Bonded', yesNo(d.bonded)],
        ['Trusted', yesNo(d.trusted) + ' <span class="bt-muted">(auto-accept connections)</span>'],
        ['Blocked', yesNo(d.blocked)],
        ['Legacy pairing', yesNo(d.legacy_pairing) + (d.legacy_pairing ? ' <span class="bt-muted">(PIN code)</span>' : '')],
        ['Services resolved', yesNo(d.services_resolved)],
        ['RSSI', d.rssi !== null && d.rssi !== undefined ? `${d.rssi} dBm` : '—'],
        ['TX power', d.tx_power !== null && d.tx_power !== undefined ? `${d.tx_power} dBm` : '—'],
        ['Battery', d.battery !== null && d.battery !== undefined ? `<span class="bt-battery"><i class="fas fa-battery-half"></i> ${d.battery}%</span>` : '—'],
        ['Modalias', btEscape(d.modalias || '—')],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

    const uuids = (d.uuids || []).length
        ? `<ul class="bt-uuids">${d.uuids.map(u => `<li><span>${btEscape(u.name)}</span><code>${btEscape(u.uuid)}</code></li>`).join('')}</ul>`
        : '<div class="bt-muted">No services advertised yet (connect to resolve them).</div>';

    document.getElementById('bt-details').innerHTML = `
        <div class="bt-details-head">
            <div class="bt-device-icon"><i class="${btDeviceIcon(d.icon)}"></i></div>
            <div class="bt-details-title">
                <div class="bt-device-name">${btEscape(d.alias || d.name || d.mac)}</div>
                <div class="bt-device-mac">${btEscape(d.mac)}</div>
            </div>
        </div>
        <div class="bt-details-actions">${actions}</div>
        <form class="bt-inline bt-rename" id="bt-rename-form" autocomplete="off">
            <input type="text" class="form-control form-control-sm" id="bt-rename-input" maxlength="248"
                   placeholder="Local alias (empty = use remote name)" value="${btEscape(d.alias && d.alias !== d.name ? d.alias : '')}">
            <button class="btn btn-sm btn-secondary" type="submit" title="Rename"><i class="fas fa-pen"></i></button>
        </form>
        <dl class="bt-props">${props}</dl>
        <div class="bt-subtitle">Services (${(d.uuids || []).length})</div>
        ${uuids}
    `;
    document.getElementById('bt-details').dataset.name = d.alias || d.name || d.mac;
}

async function deviceAction(action, extra = undefined) {
    const mac = btSelectedMac;
    if (!mac) return;
    const labels = {
        pair: 'Pairing…', connect: 'Connecting…', disconnect: 'Disconnecting…',
        trust: 'Trusting…', untrust: 'Untrusting…', block: 'Blocking…', unblock: 'Unblocking…',
        remove: 'Removing…', cancel_pair: 'Canceling pairing…', rename: 'Renaming…',
    };
    btToast(labels[action] || action, 'info', 2000);
    const { ok, data } = await btApi(`/api/bluetooth/device/${encodeURIComponent(mac)}/${action}`, extra || {});
    if (!ok) {
        btToast(data.error || `Failed: ${action}`, 'error', 7000);
    } else if (!data.pending) {
        btToast(data.output || 'Done', 'success');
    }
    if (action === 'remove' && ok) {
        btSelectedMac = null;
        document.getElementById('bt-details').innerHTML = '<div class="bt-empty">Select a device to see its details</div>';
    } else {
        refreshBtDetails();
    }
    refreshBtDevices();
}

function confirmBt(title, message, onOk) {
    document.getElementById('bt-confirm-title').textContent = title;
    document.getElementById('bt-confirm-message').textContent = message;
    btConfirmAction = onOk;
    document.getElementById('bt-confirm-modal').hidden = false;
}

function closeConfirmBt() {
    document.getElementById('bt-confirm-modal').hidden = true;
    btConfirmAction = null;
}

// ---------------------------------------------------------------- authentication prompts

function deviceLabel(device) {
    if (!device) return '';
    const known = btDevices.find(d => d.mac === device.mac);
    const name = device.name || (known && known.has_name ? known.name : '');
    return name ? `${name} (${device.mac})` : device.mac;
}

function showAuthPrompt(prompt) {
    btPendingPrompt = prompt;
    const titles = {
        pin: 'Enter PIN code',
        passkey: 'Enter passkey',
        confirm: 'Confirm passkey',
        authorize: 'Accept pairing?',
        service: 'Authorize service?',
        generic: 'Bluetooth request',
    };
    const messages = {
        pin: 'The device is asking for a PIN code. Enter the PIN shown on (or configured for) the device - often 0000 or 1234.',
        passkey: 'Enter the 6-digit passkey displayed on the other device.',
        confirm: 'Check that the other device shows the same passkey, then confirm.',
        authorize: 'A device wants to pair with this computer.',
        service: `The device wants to use service ${prompt.uuid || ''}.`,
        generic: prompt.message,
    };
    document.getElementById('bt-auth-title').textContent = titles[prompt.type] || 'Bluetooth request';
    document.getElementById('bt-auth-device').textContent = deviceLabel(prompt.device);
    document.getElementById('bt-auth-message').textContent = messages[prompt.type] || prompt.message;

    const code = document.getElementById('bt-auth-code');
    code.hidden = prompt.type !== 'confirm';
    code.textContent = prompt.passkey || '';

    const input = document.getElementById('bt-auth-input');
    const needsInput = !prompt.yes_no;
    input.hidden = !needsInput;
    input.value = '';
    input.inputMode = prompt.type === 'passkey' ? 'numeric' : 'text';
    input.maxLength = prompt.type === 'passkey' ? 6 : 16;
    input.placeholder = prompt.type === 'passkey' ? '000000' : 'PIN';

    document.getElementById('bt-auth-error').hidden = true;
    document.getElementById('bt-auth-actions').innerHTML = prompt.yes_no
        ? `<button class="btn btn-secondary btn-sm" data-answer="no">Reject</button>
           <button class="btn btn-success btn-sm" data-answer="yes">${prompt.type === 'confirm' ? 'Codes match - pair' : 'Accept'}</button>`
        : `<button class="btn btn-secondary btn-sm" data-answer="cancel">Cancel</button>
           <button class="btn btn-primary btn-sm" data-answer="submit">Submit</button>`;

    document.getElementById('bt-auth-modal').hidden = false;
    if (needsInput) setTimeout(() => input.focus(), 0);
}

function showAuthDisplay(d) {
    btPendingPrompt = null;
    document.getElementById('bt-auth-title').textContent = d.kind === 'PIN code' ? 'Enter this PIN on the device' : 'Enter this passkey on the device';
    document.getElementById('bt-auth-device').textContent = deviceLabel(d.device);
    document.getElementById('bt-auth-message').textContent = 'Type the code below on the other device to complete pairing.';
    const code = document.getElementById('bt-auth-code');
    code.hidden = false;
    code.textContent = d.code;
    document.getElementById('bt-auth-input').hidden = true;
    document.getElementById('bt-auth-error').hidden = true;
    document.getElementById('bt-auth-actions').innerHTML = '<button class="btn btn-secondary btn-sm" data-answer="close">Close</button>';
    document.getElementById('bt-auth-modal').hidden = false;
}

function hideAuthModal() {
    btPendingPrompt = null;
    document.getElementById('bt-auth-modal').hidden = true;
}

function answerAuth(answer) {
    const prompt = btPendingPrompt;
    if (!prompt || answer === 'close') {
        hideAuthModal();
        return;
    }
    let value;
    if (answer === 'yes' || answer === 'no') {
        value = answer;
    } else if (answer === 'cancel') {
        // bluetoothctl has no "cancel" answer for PIN/passkey input; an
        // invalid/empty answer would be rejected client-side, so cancel the
        // pairing itself.
        hideAuthModal();
        if (prompt.device) {
            btApi(`/api/bluetooth/device/${encodeURIComponent(prompt.device.mac)}/cancel_pair`, {});
        }
        return;
    } else {
        value = document.getElementById('bt-auth-input').value.trim();
    }
    if (!btSocket) return;
    btSocket.emit('bt_auth_response', { id: prompt.id, value }, (resp) => {
        if (resp && !resp.success) {
            const err = document.getElementById('bt-auth-error');
            err.textContent = resp.error;
            err.hidden = false;
            if (resp.error.includes('no longer pending')) setTimeout(hideAuthModal, 1500);
            return;
        }
        hideAuthModal();
    });
}

// ---------------------------------------------------------------- log

function appendBtLog(line) {
    const log = document.getElementById('bt-log');
    const el = document.createElement('div');
    if (line.startsWith('[NEW]')) el.className = 'l-new';
    else if (line.startsWith('[DEL]')) el.className = 'l-del';
    else if (line.startsWith('[CHG]')) el.className = 'l-chg';
    else if (line.includes('[agent]') || line.startsWith('Request')) el.className = 'l-agent';
    else if (/^Failed|Error|not available/i.test(line)) el.className = 'l-err';
    else if (/successful|succeeded/i.test(line)) el.className = 'l-ok';
    el.textContent = line;

    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(el);
    while (log.childElementCount > 500) log.firstElementChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- listeners

function setupBtListeners() {
    document.getElementById('bt-recheck-btn').addEventListener('click', loadBtStatus);

    document.body.addEventListener('click', (e) => {
        const fix = e.target.closest('[data-fix]');
        if (fix) {
            const action = fix.dataset.fix;
            if (action === 'restart_service') {
                confirmBt('Restart Bluetooth service?', 'All Bluetooth connections will be dropped briefly.', () => runBtFix(action, fix));
            } else {
                runBtFix(action, fix);
            }
        }
    });

    document.getElementById('bt-powered').addEventListener('change', e => adapterAction('power', e.target.checked));
    document.getElementById('bt-pairable').addEventListener('change', e => adapterAction('pairable', e.target.checked));
    document.getElementById('bt-discoverable').addEventListener('change', e => adapterAction('discoverable', e.target.checked, {
        timeout: Number(document.getElementById('bt-discoverable-timeout').value),
    }));
    document.getElementById('bt-discoverable-timeout').addEventListener('change', e => {
        if (document.getElementById('bt-discoverable').checked) {
            adapterAction('discoverable', true, { timeout: Number(e.target.value) });
        }
    });

    const saveAlias = () => adapterAction('alias', document.getElementById('bt-alias').value);
    document.getElementById('bt-alias-save').addEventListener('click', saveAlias);
    document.getElementById('bt-alias').addEventListener('keydown', e => {
        if (e.key === 'Enter') saveAlias();
    });

    document.getElementById('bt-scan-btn').addEventListener('click', toggleScan);

    document.getElementById('bt-device-search').addEventListener('input', renderBtDevices);
    document.getElementById('bt-hide-unnamed').addEventListener('change', renderBtDevices);
    document.getElementById('bt-chips').addEventListener('click', e => {
        const chip = e.target.closest('.bt-chip');
        if (chip) setBtFilter(chip.dataset.filter);
    });
    document.getElementById('bt-device-list').addEventListener('click', e => {
        const dev = e.target.closest('.bt-device');
        if (dev) selectBtDevice(dev.dataset.mac);
    });

    const details = document.getElementById('bt-details');
    details.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const name = details.dataset.name || btSelectedMac;
        if (action === 'remove') {
            confirmBt('Remove device?', `${name} will be unpaired and forgotten. You will have to pair again to use it.`, () => deviceAction('remove'));
        } else if (action === 'block') {
            confirmBt('Block device?', `${name} will be disconnected and prevented from connecting.`, () => deviceAction('block'));
        } else {
            deviceAction(action);
        }
    });
    details.addEventListener('submit', e => {
        if (e.target.id !== 'bt-rename-form') return;
        e.preventDefault();
        deviceAction('rename', { name: document.getElementById('bt-rename-input').value });
    });

    document.getElementById('bt-confirm-cancel').addEventListener('click', closeConfirmBt);
    document.getElementById('bt-confirm-ok').addEventListener('click', () => {
        const fn = btConfirmAction;
        closeConfirmBt();
        if (fn) fn();
    });

    document.getElementById('bt-auth-actions').addEventListener('click', e => {
        const btn = e.target.closest('[data-answer]');
        if (btn) answerAuth(btn.dataset.answer);
    });
    document.getElementById('bt-auth-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') answerAuth('submit');
    });

    document.getElementById('bt-log-clear').addEventListener('click', () => {
        document.getElementById('bt-log').innerHTML = '';
    });
    document.getElementById('bt-raw-form').addEventListener('submit', e => {
        e.preventDefault();
        const input = document.getElementById('bt-raw-input');
        const command = input.value.trim();
        if (!command || !btSocket) return;
        btSocket.emit('bt_raw_command', { command }, resp => {
            if (resp && !resp.success) btToast(resp.error, 'error');
        });
        input.value = '';
    });

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (!document.getElementById('bt-confirm-modal').hidden) closeConfirmBt();
    });
}
