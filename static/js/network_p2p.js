// Network page - Wi-Fi Direct tab (uses helpers from network.js)
let netP2pTimer = null;
let netP2pFindUntil = 0;
let netP2pState = null;

function stopNetP2pPolling() {
    clearTimeout(netP2pTimer);
    netP2pTimer = null;
}

async function loadNetP2p() {
    stopNetP2pPolling();
    const { ok, data } = await netApi('/api/network/p2p');
    const container = document.getElementById('net-p2p');
    if (!ok) {
        container.innerHTML = `<div class="net-empty">${netEscape(data.error || 'Failed')}</div>`;
    } else {
        netP2pState = data.p2p;
        renderNetP2p(data.p2p);
    }
    if (netActiveTab === 'p2p') {
        const discovering = Date.now() < netP2pFindUntil;
        netP2pTimer = setTimeout(loadNetP2p, discovering ? 3000 : 10000);
    }
}

function renderNetP2p(s) {
    const container = document.getElementById('net-p2p');
    // Don't rebuild under the user's cursor while they type in a field.
    if (container.contains(document.activeElement) && document.activeElement.matches('input, select')) return;

    if (!s.available) {
        container.innerHTML = renderP2pSetup(s);
        return;
    }

    const managers = s.managers.length ? `<div class="net-note warn"><i class="fas fa-robot"></i>
        Wi-Fi Direct on <code>${netEscape(s.control)}</code> is also driven by
        ${s.managers.map(m => `<b>${netEscape(m.name)}</b> (pid ${m.pid})`).join(', ')}.
        It reacts to connection requests and may recreate or remove groups on its own - changes made here can be overridden.</div>` : '';

    const discovering = Date.now() < netP2pFindUntil;
    const left = Math.max(0, Math.ceil((netP2pFindUntil - Date.now()) / 1000));

    const groups = s.groups.map(g => `
        <div class="net-section">
            <div class="net-section-title"><i class="fas ${g.is_go ? 'fa-crown' : 'fa-user'}"></i> ${netEscape(g.ssid || g.interface)}
                <span class="net-muted">${netEscape(g.role)} · ${netEscape(g.interface)}</span></div>
            ${netProps([
                g.passphrase ? ['Passphrase', `<span class="net-secret" data-secret="${netEscape(g.passphrase)}" title="Click to show">••••••••</span>`] : null,
                ['Channel', netEscape(g.channel || g.freq)],
                ['Security', netEscape(g.key_mgmt || '—')],
                ['IP', g.ipv4.length ? g.ipv4.map(a => `<code>${netEscape(a)}</code>`).join(', ')
                    : `<span class="net-warn-text">none - clients won't get an address</span>`],
                g.dhcp ? ['DHCP', '<span class="net-yes">served by the cockpit (dnsmasq)</span>'] : null,
                g.persistent_id !== '' && s.persistent.some(p => p.id === g.persistent_id) ? ['Persistent', 'yes (comes back after restart)'] : null,
            ])}
            ${g.is_go ? `
                <div class="net-subtitle">Clients (${g.stations.length})</div>
                ${g.stations.length ? `<div class="net-table-wrap"><table class="net-table">
                    <tr><th>MAC</th><th>IP</th><th>Signal</th><th>Rate</th><th>Connected</th></tr>
                    ${g.stations.map(st => `<tr><td><code>${netEscape(st.mac)}</code>${st.hostname ? ` ${netEscape(st.hostname)}` : ''}</td>
                        <td>${netEscape(st.ip || '—')}</td><td>${netEscape(st.signal)}</td><td>${netEscape(st.tx_bitrate)}</td>
                        <td>${netEscape(st.connected_time)}</td></tr>`).join('')}
                </table></div>` : '<div class="net-muted">No clients connected</div>'}` : ''}
            <div class="net-details-actions" style="margin-top:8px">
                ${g.is_go ? `<button class="btn btn-sm btn-outline-light" data-p2p="wps_pbc" data-iface="${netEscape(g.interface)}" title="Let a device join by pressing its WPS / connect button within 2 minutes"><i class="fas fa-hand-pointer"></i> Allow push-button join</button>
                <button class="btn btn-sm btn-outline-light" data-p2p="wps_pin" data-iface="${netEscape(g.interface)}"><i class="fas fa-key"></i> Join with PIN…</button>` : ''}
                ${g.is_go && !g.ipv4.length ? `<button class="btn btn-sm btn-outline-info" data-p2p="group_dhcp" data-iface="${netEscape(g.interface)}"><i class="fas fa-network-wired"></i> Assign IP + DHCP</button>` : ''}
                <button class="btn btn-sm btn-outline-danger" data-p2p="group_remove" data-iface="${netEscape(g.interface)}"><i class="fas fa-times"></i> Remove group</button>
            </div>
        </div>`).join('');

    const peers = s.peers.map(p => `<tr>
        <td>${p.level !== null ? `${p.level} dBm` : ''}</td>
        <td>${netEscape(p.name || '(unnamed)')} <div class="net-muted"><code>${netEscape(p.mac)}</code></div></td>
        <td>${p.is_go ? '<span class="net-badge info">group owner</span>' : ''}${p.in_group ? '<span class="net-badge">in a group</span>' : ''}</td>
        <td class="net-muted">${netEscape(p.config_methods)}</td>
        <td class="actions"><button class="btn btn-sm btn-outline-light" data-p2p="connect" data-mac="${netEscape(p.mac)}"
            data-name="${netEscape(p.name)}" data-go="${p.is_go ? 1 : 0}">Connect</button></td>
    </tr>`).join('');

    const persistent = s.persistent.map(p => {
        const running = s.groups.some(g => g.ssid === p.ssid);
        return `<tr><td>${netEscape(p.ssid)}</td><td class="net-muted"><code>${netEscape(p.bssid)}</code></td>
            <td>${running ? '<span class="net-badge ok">running</span>' : ''}</td>
            <td class="actions">${running ? '' : `<button class="btn btn-sm btn-outline-light" data-p2p="restart_persistent" data-id="${netEscape(p.id)}">Start</button>`}
                <button class="btn btn-sm btn-outline-danger" data-p2p="persistent_remove" data-id="${netEscape(p.id)}" data-ssid="${netEscape(p.ssid)}"><i class="fas fa-trash"></i></button></td></tr>`;
    }).join('');

    container.innerHTML = `
        ${managers}
        <div class="net-section">
            <div class="net-section-title">This device</div>
            ${netProps([
                ['Name', `<span class="net-inline"><input class="form-control form-control-sm" id="net-p2p-name" value="${netEscape(s.device_name)}" maxlength="32">
                    <button class="btn btn-sm btn-primary" data-p2p="device_name"><i class="fas fa-check"></i></button></span>`],
                ['P2P address', `<code>${netEscape(s.device_address)}</code>`],
                ['Interface', `${netEscape(s.interface)} <span class="net-muted">via ${netEscape(s.control)}</span>`],
                ['Group owner intent', `<span class="net-inline"><select class="form-control form-control-sm net-narrow" id="net-p2p-intent">
                    ${Array.from({ length: 16 }, (_, i) => `<option value="${i}" ${String(i) === s.go_intent ? 'selected' : ''}>${i}${i === 15 ? ' (always owner)' : i === 0 ? ' (always client)' : ''}</option>`).join('')}
                    </select></span>`],
                ['Join methods', netEscape(s.config_methods || '—')],
            ])}
        </div>

        <div class="net-subtitle">Groups (${s.groups.length})</div>
        ${groups || '<div class="net-muted" style="margin-bottom:8px">No active group.</div>'}
        <div class="net-section">
            <div class="net-section-title">Create a group <span class="net-muted">this device becomes the access point</span></div>
            <div class="net-form-row">
                <select class="form-control form-control-sm" id="net-p2p-band">
                    <option value="">Any band</option>
                    <option value="2">2.4 GHz (compatible)</option>
                    <option value="5">5 GHz (faster)</option>
                </select>
                <label class="net-check"><input type="checkbox" id="net-p2p-persistent" checked> Persistent</label>
                <label class="net-check" title="Give the group an IP (192.168.49.1) and hand out addresses to clients">
                    <input type="checkbox" id="net-p2p-dhcp" ${s.dnsmasq ? 'checked' : 'disabled'}> IP + DHCP</label>
                <button class="btn btn-sm btn-primary" data-p2p="group_add"><i class="fas fa-plus"></i> Create</button>
            </div>
            ${s.dnsmasq ? '' : '<div class="net-muted net-hint">Install dnsmasq-base to hand out IP addresses to clients.</div>'}
        </div>

        <div class="net-subtitle">Nearby devices
            ${discovering
                ? `<button class="btn btn-sm btn-outline-warning" data-p2p="stop_find"><i class="fas fa-stop"></i> Stop (${left}s)</button>`
                : '<button class="btn btn-sm btn-primary" data-p2p="find"><i class="fas fa-search"></i> Discover</button>'}
        </div>
        ${peers ? `<div class="net-table-wrap"><table class="net-table">
            <tr><th>Signal</th><th>Device</th><th></th><th>Methods</th><th></th></tr>${peers}</table></div>`
            : `<div class="net-muted">${discovering ? '<i class="fas fa-spinner fa-spin"></i> Looking for Wi-Fi Direct devices… (on a phone: Wi-Fi settings → Wi-Fi Direct)' : 'Click Discover to look for phones, printers, TVs…'}</div>`}

        ${s.persistent.length ? `<div class="net-subtitle">Persistent groups</div>
        <div class="net-table-wrap"><table class="net-table">${persistent}</table></div>` : ''}

        ${s.handover_active ? `<div class="net-section" style="margin-top:12px">
            <div class="net-section-title">Setup</div>
            <div class="net-muted">${netEscape(s.interface)} was handed from NetworkManager to wpa_supplicant by this page.</div>
            <button class="btn btn-sm btn-outline-warning" data-p2p="undo_setup" style="margin-top:6px"><i class="fas fa-undo"></i> Return ${netEscape(s.interface)} to NetworkManager</button>
        </div>` : ''}`;
}

function renderP2pSetup(s) {
    let html = `<div class="net-empty" style="padding-bottom:0"><i class="fas fa-exchange-alt" style="font-size:2rem"></i></div>
        <div class="net-note ${s.setup ? 'warn' : 'bad'}">${netEscape(s.reason || 'Wi-Fi Direct is not available.')}</div>`;
    if (s.setup) {
        html += `<div class="net-section">
            <div class="net-section-title">${netEscape(s.setup.title)}</div>
            <ol>${s.setup.steps.map(st => `<li>${netEscape(st)}</li>`).join('')}</ol>
            <button class="btn btn-sm btn-primary" data-p2p="setup"><i class="fas fa-magic"></i> Set up Wi-Fi Direct</button>
        </div>`;
    }
    if (s.handover_active) {
        html += `<button class="btn btn-sm btn-outline-warning" data-p2p="undo_setup"><i class="fas fa-undo"></i> Return ${netEscape(s.interface)} to NetworkManager</button>`;
    }
    html += `<div class="net-muted net-hint">Wi-Fi Direct lets phones and other devices connect straight to this machine without a router.
        This machine can be the group owner (acts like an access point) or join another device's group.</div>`;
    return html;
}

async function p2pCall(action, body = {}, labels = {}) {
    const data = await netCall(`/api/network/p2p/${action}`, body, labels);
    loadNetP2p();
    pollNetInterfaces();
    return data;
}

async function p2pConnectDialog(mac, name, isGo) {
    const values = await netForm({
        title: `Connect to ${name || mac}`,
        message: isGo ? 'This device already runs a group - this machine joins it as a client.' : '',
        fields: [
            { name: 'method', label: 'How to confirm', type: 'select', value: 'pbc', options: [
                ['pbc', 'Push button (accept on the other device)'],
                ['display', 'Show a PIN here, type it on the other device'],
                ['keypad', 'Type the PIN shown on the other device'],
            ] },
            { name: 'pin', label: 'PIN (only for "type the PIN")', placeholder: '12345670' },
            { name: 'persistent', label: 'Remember (persistent group)', type: 'checkbox', value: true },
        ],
        okLabel: 'Connect',
        validate: v => (v.method === 'keypad' && !/^(\d{4}|\d{8})$/.test(v.pin) ? 'Enter the 4 or 8 digit PIN' : ''),
    });
    if (!values) return;
    const data = await p2pCall('connect', { mac, method: values.method, pin: values.pin, persistent: values.persistent, join: isGo },
        { busy: 'Sending connection request…', done: 'Request sent - confirm on the other device', quiet: values.method === 'display' });
    if (data && data.pin) {
        netConfirm('Enter this PIN on the other device', (() => {
            const el = document.createElement('div');
            el.innerHTML = `<div class="net-pin">${netEscape(data.pin)}</div><div class="net-muted">The group appears here once the other device accepts.</div>`;
            return el;
        })(), () => {}, 'Done', false);
    }
}

function setupNetP2pListeners() {
    const container = document.getElementById('net-p2p');
    container.addEventListener('click', async e => {
        const secret = e.target.closest('[data-secret]');
        if (secret) {
            secret.textContent = secret.textContent.startsWith('•') ? secret.dataset.secret : '••••••••';
            return;
        }
        const btn = e.target.closest('[data-p2p]');
        if (!btn) return;
        const action = btn.dataset.p2p;
        const iface = btn.dataset.iface;

        if (action === 'setup') {
            const s = netP2pState && netP2pState.setup;
            const client = netIfaces.find(i => i.is_client);
            const warn = client && s && client.name === s.interface
                ? `\n\nYou are connected through ${s.interface} - this page will disconnect while Wi-Fi restarts.` : '';
            netConfirm('Set up Wi-Fi Direct?', `${s ? s.steps.map((st, i) => `${i + 1}. ${st}`).join('\n') : ''}${warn}`,
                () => p2pCall('setup', {}, { busy: 'Setting up Wi-Fi Direct (takes ~20 s)…', done: 'Wi-Fi Direct set up' }), 'Set up', false);
        } else if (action === 'undo_setup') {
            netConfirm('Return Wi-Fi to NetworkManager?',
                'wpa_supplicant@ is disabled and NetworkManager manages Wi-Fi again. Wi-Fi Direct stops working. Networks added in wpa_supplicant mode are not copied back.',
                () => p2pCall('undo_setup', {}, { busy: 'Restoring…', done: 'Wi-Fi returned to NetworkManager' }), 'Return');
        } else if (action === 'find') {
            const data = await p2pCall('find', { timeout: 30 }, { busy: 'Discovering…', quiet: true });
            if (data) netP2pFindUntil = Date.now() + (data.timeout || 30) * 1000;
            loadNetP2p();
        } else if (action === 'stop_find') {
            netP2pFindUntil = 0;
            p2pCall('stop_find', {}, { busy: '', quiet: true });
        } else if (action === 'device_name') {
            p2pCall('device_name', { value: document.getElementById('net-p2p-name').value.trim() }, { busy: '', done: 'Name saved' });
        } else if (action === 'group_add') {
            p2pCall('group_add', {
                freq: document.getElementById('net-p2p-band').value,
                persistent: document.getElementById('net-p2p-persistent').checked,
                dhcp: document.getElementById('net-p2p-dhcp').checked,
            }, { busy: 'Starting group…', done: 'Group created' });
        } else if (action === 'restart_persistent') {
            p2pCall('group_add', { persistent_id: btn.dataset.id }, { busy: 'Starting group…', done: 'Group started' });
        } else if (action === 'group_remove') {
            netConfirm(`Remove group ${iface}?`, 'All connected clients are disconnected. A persistent group can be started again later.',
                () => p2pCall('group_remove', { interface: iface }, { busy: 'Removing group…' }), 'Remove');
        } else if (action === 'group_dhcp') {
            p2pCall('group_dhcp', { interface: iface }, { busy: 'Assigning address…' });
        } else if (action === 'wps_pbc') {
            p2pCall('wps_pbc', { interface: iface }, { busy: '', done: 'Push-button join open for 2 minutes' });
        } else if (action === 'wps_pin') {
            const v = await netForm({
                title: 'Allow join with PIN',
                fields: [{ name: 'pin', label: 'PIN shown on the joining device', placeholder: '12345670' }],
                validate: x => (/^(\d{4}|\d{8})$/.test(x.pin) ? '' : 'PIN must be 4 or 8 digits'),
            });
            if (v) p2pCall('wps_pin', { interface: iface, pin: v.pin }, { busy: '', done: 'PIN accepted - waiting for the device' });
        } else if (action === 'connect') {
            p2pConnectDialog(btn.dataset.mac, btn.dataset.name, btn.dataset.go === '1');
        } else if (action === 'persistent_remove') {
            netConfirm('Forget persistent group?', `“${btn.dataset.ssid}” is removed; devices that remembered it must pair again.`,
                () => p2pCall('persistent_remove', { id: btn.dataset.id }, { busy: 'Removing…' }), 'Forget');
        }
    });
    container.addEventListener('change', e => {
        if (e.target.id === 'net-p2p-intent') {
            p2pCall('go_intent', { value: e.target.value }, { busy: '', done: 'Group owner intent saved' });
        }
    });
    container.addEventListener('keydown', e => {
        if (e.target.id === 'net-p2p-name' && e.key === 'Enter') container.querySelector('[data-p2p="device_name"]').click();
    });
}

document.addEventListener('DOMContentLoaded', setupNetP2pListeners);
