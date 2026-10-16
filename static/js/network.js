// Network page
let netIfaces = [];
let netSelected = null;
let netFilter = 'all';
let netPrevStats = {};
let netRates = {};
let netOverview = null;
let netPollTimer = null;
let netActiveTab = 'iface';
let netConfirmAction = null;
let netWifiIface = null;
let netWifiScanned = {};
let netSelectedProfile = null;
let netRevert = null;

const NET_ICONS = {
    ethernet: 'fas fa-ethernet',
    wifi: 'fas fa-wifi',
    p2p: 'fas fa-exchange-alt',
    bridge: 'fas fa-project-diagram',
    bond: 'fas fa-link',
    vlan: 'fas fa-tags',
    vpn: 'fas fa-shield-alt',
    bluetooth: 'fab fa-bluetooth-b',
    virtual: 'fas fa-cube',
    loopback: 'fas fa-redo',
};

const NET_KIND_LABELS = {
    ethernet: 'Ethernet',
    wifi: 'Wi-Fi',
    p2p: 'Wi-Fi Direct group',
    bridge: 'Bridge',
    bond: 'Bond',
    vlan: 'VLAN',
    vpn: 'VPN / tunnel',
    bluetooth: 'Bluetooth PAN',
    virtual: 'Virtual',
    loopback: 'Loopback',
};

const NET_FILTERS = {
    all: () => true,
    wired: i => ['ethernet', 'bridge', 'bond', 'vlan'].includes(i.kind),
    wireless: i => ['wifi', 'p2p'].includes(i.kind),
    virtual: i => ['vpn', 'virtual', 'bluetooth', 'loopback'].includes(i.kind),
};

document.addEventListener('DOMContentLoaded', () => {
    setupNetListeners();
    loadNetOverview();
    pollNetInterfaces();
});

// ---------------------------------------------------------------- helpers

function netEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function netApi(url, body = undefined) {
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

function netToast(message, level = 'info', ms = 4000) {
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

function netBytes(n) {
    if (n === null || n === undefined) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function netBits(bytesPerSec) {
    const bits = (bytesPerSec || 0) * 8;
    if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
    if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
    return `${bits.toFixed(0)} b/s`;
}

function netSpeed(mbps) {
    if (!mbps) return '';
    return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gb/s` : `${mbps} Mb/s`;
}

function netSignalHtml(pct) {
    if (pct === null || pct === undefined) return '';
    const bars = pct >= 75 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : 1;
    return `<span class="net-signal">${[1, 2, 3, 4].map(i => `<span class="${i <= bars ? 'on' : ''}"></span>`).join('')}</span>`;
}

function netYesNo(v) {
    return `<span class="${v ? 'net-yes' : 'net-no'}">${v ? 'Yes' : 'No'}</span>`;
}

function netProps(rows) {
    return `<dl class="net-props">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

// Run a state-changing request: handles the sudo prompt, the keep/revert
// dialog and toasts. Returns the response data on success, null otherwise.
async function netCall(url, body = {}, { busy = 'Working…', done = 'Done', quiet = false } = {}) {
    if (busy) netToast(busy, 'info', 2000);
    const { ok, status, data } = await netApi(url, body);
    if (status === 401 && data.error === 'sudo_required') {
        if (typeof showSudoModal === 'function') {
            return new Promise(resolve => {
                showSudoModal(data.message || 'Sudo password required.', async () => {
                    resolve(await netCall(url, body, { busy, done, quiet }));
                });
            });
        }
        netToast('Sudo password required', 'error');
        return null;
    }
    if (!ok) {
        netToast(data.error || data.output || 'Failed', 'error', 8000);
        return null;
    }
    if (data.revert) {
        showRevert(data.revert);
    } else if (!quiet) {
        netToast(data.output && data.output.length < 300 ? `${done}\n${data.output}` : done, 'success');
    }
    return data;
}

function netConfirm(title, message, onOk, okLabel = 'Confirm', danger = true) {
    document.getElementById('net-confirm-title').textContent = title;
    const msg = document.getElementById('net-confirm-message');
    if (message instanceof Node) {
        msg.innerHTML = '';
        msg.appendChild(message);
    } else {
        msg.textContent = message;
    }
    const ok = document.getElementById('net-confirm-ok');
    ok.textContent = okLabel;
    ok.className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
    netConfirmAction = onOk;
    document.getElementById('net-confirm-modal').hidden = false;
}

function closeNetConfirm() {
    document.getElementById('net-confirm-modal').hidden = true;
    netConfirmAction = null;
}

// Small form dialog. fields: [{name, label, type, value, placeholder, options, hint}]
// Resolves to {name: value} or null when canceled. validate(values) may return an error string.
function netForm({ title, message = '', fields = [], okLabel = 'OK', validate = null, html = '' }) {
    return new Promise(resolve => {
        document.getElementById('net-form-title').textContent = title;
        const msg = document.getElementById('net-form-message');
        if (html) msg.innerHTML = html; else msg.textContent = message;
        document.getElementById('net-form-ok').textContent = okLabel;
        const err = document.getElementById('net-form-error');
        err.hidden = true;

        document.getElementById('net-form-fields').innerHTML = fields.map(f => {
            const id = `net-f-${f.name}`;
            if (f.type === 'checkbox') {
                return `<label class="net-check"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}> ${netEscape(f.label)}</label>`;
            }
            if (f.type === 'select') {
                return `<div><label for="${id}">${netEscape(f.label)}</label>
                    <select class="form-control form-control-sm" id="${id}">
                        ${f.options.map(([v, l]) => `<option value="${netEscape(v)}" ${String(v) === String(f.value) ? 'selected' : ''}>${netEscape(l)}</option>`).join('')}
                    </select></div>`;
            }
            return `<div><label for="${id}">${netEscape(f.label)}</label>
                <input class="form-control form-control-sm" id="${id}" type="${f.type || 'text'}"
                       value="${netEscape(f.value ?? '')}" placeholder="${netEscape(f.placeholder || '')}"
                       ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>
                ${f.hint ? `<div class="net-muted">${netEscape(f.hint)}</div>` : ''}</div>`;
        }).join('');

        const modal = document.getElementById('net-form-modal');
        const form = document.getElementById('net-form');
        const collect = () => Object.fromEntries(fields.map(f => {
            const el = document.getElementById(`net-f-${f.name}`);
            return [f.name, f.type === 'checkbox' ? el.checked : el.value];
        }));
        const finish = value => {
            modal.hidden = true;
            form.onsubmit = null;
            document.getElementById('net-form-cancel').onclick = null;
            resolve(value);
        };
        form.onsubmit = e => {
            e.preventDefault();
            const values = collect();
            const problem = validate ? validate(values) : '';
            if (problem) {
                err.textContent = problem;
                err.hidden = false;
                return;
            }
            finish(values);
        };
        document.getElementById('net-form-cancel').onclick = () => finish(null);
        modal.hidden = false;
        const first = form.querySelector('input:not([type=checkbox]), select');
        if (first) setTimeout(() => first.focus(), 0);
    });
}

// ---------------------------------------------------------------- keep / revert

function showRevert(revert) {
    netRevert = { ...revert, ends: Date.now() + revert.seconds * 1000 };
    document.getElementById('net-revert-message').textContent =
        `${revert.description} was applied to the interface this page is using. ` +
        'If you can still see this and click Keep, the change stays. ' +
        'Otherwise it is rolled back automatically.';
    document.getElementById('net-revert-modal').hidden = false;
    tickRevert();
}

function tickRevert() {
    if (!netRevert) return;
    const left = Math.max(0, Math.ceil((netRevert.ends - Date.now()) / 1000));
    document.getElementById('net-revert-count').textContent = `${left}s`;
    if (left <= 0) {
        document.getElementById('net-revert-modal').hidden = true;
        netRevert = null;
        netToast('Not confirmed - previous settings restored', 'info', 6000);
        setTimeout(refreshAll, 1500);
        return;
    }
    netRevert.timer = setTimeout(tickRevert, 250);
}

async function resolveRevert(keep) {
    if (!netRevert) return;
    const { token, timer } = netRevert;
    clearTimeout(timer);
    netRevert = null;
    document.getElementById('net-revert-modal').hidden = true;
    const { ok, data } = await netApi(`/api/network/revert/${token}`, { keep });
    netToast(ok ? (keep ? 'Changes kept' : 'Rolled back') : (data.error || 'Failed'), ok ? 'success' : 'error');
    refreshAll();
}

function refreshAll() {
    loadNetOverview();
    pollNetInterfaces();
    if (netActiveTab === 'wifi') loadNetWifi();
    if (netActiveTab === 'connections') loadNetConnections();
    if (netActiveTab === 'routes') loadNetRoutes();
    if (netActiveTab === 'p2p' && typeof loadNetP2p === 'function') loadNetP2p();
}

// ---------------------------------------------------------------- overview

async function loadNetOverview() {
    const { ok, data } = await netApi('/api/network/overview');
    if (!ok) return;
    const o = netOverview = data.overview;

    const host = document.getElementById('net-hostname');
    if (document.activeElement !== host) host.value = o.hostname;
    document.getElementById('net-manager').textContent = o.manager;

    const conn = document.getElementById('net-connectivity');
    if (o.nm) {
        const cls = { full: 'net-yes', limited: 'net-warn-text', portal: 'net-warn-text', none: 'net-bad-text' }[o.nm.connectivity] || '';
        conn.innerHTML = `<span class="${cls}">${netEscape(o.nm.connectivity || o.nm.state || '—')}</span>`;
    } else {
        conn.textContent = '—';
    }

    const gws = o.gateways.filter(g => g.family === 4);
    document.getElementById('net-gateway').innerHTML = gws.length
        ? gws.map(g => `${netEscape(g.gateway)} <span class="net-muted">via ${netEscape(g.dev)}</span>`).join('<br>')
        : '<span class="net-bad-text">none</span>';

    const dns = o.dns.links.length
        ? o.dns.links.map(l => `${netEscape(l.servers.join(', '))} <span class="net-muted">(${netEscape(l.link)})</span>`).join('<br>')
        : netEscape(o.dns.nameservers.join(', ') || '—');
    document.getElementById('net-dns').innerHTML = dns;

    document.getElementById('net-wifi-radio-row').hidden = !o.wifi.present;
    const radio = document.getElementById('net-wifi-radio');
    radio.checked = o.wifi.enabled;
    radio.disabled = !o.wifi.hw_enabled;
    document.getElementById('net-wifi-radio-note').textContent = o.wifi.hw_enabled ? '' : 'Wi-Fi is hard-blocked (hardware switch).';
    document.getElementById('net-restart-nm').hidden = o.manager !== 'NetworkManager';
}

// ---------------------------------------------------------------- interfaces

async function pollNetInterfaces() {
    clearTimeout(netPollTimer);
    if (!document.hidden) {
        const { ok, data } = await netApi('/api/network/interfaces');
        if (ok) {
            computeRates(data.interfaces, data.time);
            netIfaces = data.interfaces;
            if (!netSelected || !netIfaces.some(i => i.name === netSelected)) {
                const first = netIfaces.find(i => i.is_client) || netIfaces.find(i => i.kind !== 'loopback');
                if (first) selectNetIface(first.name);
            }
            renderNetIfaces();
            renderTraffic();
            updateLiveStats();
            const hasWifi = netIfaces.some(i => i.kind === 'wifi');
            document.getElementById('net-tab-wifi').hidden = !hasWifi;
        }
    }
    netPollTimer = setTimeout(pollNetInterfaces, 3000);
}

function computeRates(ifaces, time) {
    ifaces.forEach(i => {
        const prev = netPrevStats[i.name];
        if (prev && time > prev.time) {
            const dt = time - prev.time;
            netRates[i.name] = {
                rx: Math.max(0, (i.stats.rx_bytes - prev.rx) / dt),
                tx: Math.max(0, (i.stats.tx_bytes - prev.tx) / dt),
            };
        }
        netPrevStats[i.name] = { rx: i.stats.rx_bytes, tx: i.stats.tx_bytes, time };
    });
}

function ifaceBadges(i) {
    const b = [];
    if (i.is_client) b.push('<span class="net-badge purple" title="The browser reaches the cockpit through this interface">This connection</span>');
    if (!i.up) b.push('<span class="net-badge bad">Down</span>');
    else if (!i.carrier && i.kind !== 'loopback') b.push('<span class="net-badge warn">No link</span>');
    if (i.speed) b.push(`<span class="net-badge ok">${netSpeed(i.speed)}${i.duplex === 'half' ? ' half' : ''}</span>`);
    if (i.max_speed && i.max_speed !== i.speed) b.push(`<span class="net-badge" title="Fastest mode the adapter supports">max ${netSpeed(i.max_speed)}</span>`);
    if (i.mtu && i.mtu !== 1500 && i.kind !== 'loopback') {
        b.push(`<span class="net-badge ${i.mtu > 1500 ? 'info' : ''}">MTU ${i.mtu}${i.mtu > 1500 ? ' (jumbo)' : ''}</span>`);
    }
    if (i.wireless && i.wireless.ssid) b.push(`<span class="net-badge info">${netEscape(i.wireless.ssid)}</span>`);
    if (i.bus === 'usb') b.push('<span class="net-badge">USB</span>');
    return b.join('');
}

function renderNetIfaces() {
    const list = document.getElementById('net-iface-list');
    const hideLo = document.getElementById('net-hide-lo').checked;
    const shown = netIfaces.filter(i => NET_FILTERS[netFilter](i) && !(hideLo && i.kind === 'loopback'));
    document.getElementById('net-iface-count').textContent = `${shown.length}`;
    if (!shown.length) {
        list.innerHTML = '<div class="net-empty">No interfaces match the filter</div>';
        return;
    }
    list.innerHTML = shown.map(i => {
        const state = !i.up ? 'down' : (i.carrier || i.kind === 'loopback' ? 'up' : 'nocarrier');
        const rate = netRates[i.name];
        const addr = i.ipv4[0] || (i.ipv6.find(a => a.scope === 'global') || {}).addr || '';
        return `
            <div class="net-iface ${state} ${i.name === netSelected ? 'selected' : ''}" data-name="${netEscape(i.name)}">
                <div class="net-iface-icon"><i class="${NET_ICONS[i.kind] || 'fas fa-network-wired'}"></i></div>
                <div class="net-iface-main">
                    <div class="net-iface-name">${netEscape(i.name)}</div>
                    <div class="net-iface-sub">${netEscape(NET_KIND_LABELS[i.kind] || i.kind)}${addr ? ` · <code>${netEscape(addr)}</code>` : ''}</div>
                    <div class="net-badges">${ifaceBadges(i)}</div>
                </div>
                <div class="net-iface-rate">${rate && i.kind !== 'loopback'
                    ? `<div class="net-rx">↓ ${netBits(rate.rx)}</div><div class="net-tx">↑ ${netBits(rate.tx)}</div>` : ''}</div>
            </div>`;
    }).join('');
}

function renderTraffic() {
    const rows = netIfaces.filter(i => i.up && i.kind !== 'loopback' && netRates[i.name]);
    const el = document.getElementById('net-traffic');
    if (!rows.length) {
        el.innerHTML = '<div class="net-muted">Measuring…</div>';
        return;
    }
    el.innerHTML = rows.map(i => `
        <div class="net-traffic-row">
            <span class="name">${netEscape(i.name)}</span>
            <span class="net-rx">↓ ${netBits(netRates[i.name].rx)}</span>
            <span class="net-tx">↑ ${netBits(netRates[i.name].tx)}</span>
        </div>`).join('');
}

function setNetFilter(filter) {
    netFilter = filter;
    document.querySelectorAll('#net-chips .net-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
    renderNetIfaces();
}

// ---------------------------------------------------------------- interface details

async function selectNetIface(name) {
    netSelected = name;
    document.querySelectorAll('.net-iface').forEach(el => el.classList.toggle('selected', el.dataset.name === name));
    const iface = netIfaces.find(i => i.name === name);
    if (iface && iface.kind === 'wifi') netWifiIface = name;
    document.getElementById('net-details').innerHTML = '<div class="net-empty"><i class="fas fa-spinner fa-spin"></i></div>';
    await loadNetDetails();
}

async function loadNetDetails() {
    const name = netSelected;
    if (!name) return;
    const { ok, data } = await netApi(`/api/network/interface/${encodeURIComponent(name)}`);
    if (name !== netSelected) return;
    if (!ok) {
        document.getElementById('net-details').innerHTML = `<div class="net-empty">${netEscape(data.error || 'Interface not found')}</div>`;
        return;
    }
    renderNetDetails(data);
}

function renderNetDetails(d) {
    const i = d.interface;
    const isOpen = id => document.getElementById(id)?.open;
    const openState = {
        features: isOpen('net-sec-features'),
        rings: isOpen('net-sec-rings'),
        modes: isOpen('net-sec-modes'),
    };
    const canPersist = d.profile && !d.profile.external;
    const persistBox = id => canPersist
        ? `<label class="net-check" title="Also store it in the NetworkManager profile “${netEscape(d.profile.name)}” so it survives reboots"><input type="checkbox" id="${id}" checked> Keep after reboot</label>`
        : `<span class="net-muted">${d.profile && d.profile.external ? 'Applied until reboot (interface is configured outside NetworkManager)' : 'Applied until reboot'}</span>`;

    const actions = [];
    if (i.kind !== 'loopback') {
        actions.push(i.up
            ? `<button class="btn btn-sm btn-outline-warning" data-iface-action="down"><i class="fas fa-power-off"></i> Bring down</button>`
            : `<button class="btn btn-sm btn-success" data-iface-action="up"><i class="fas fa-power-off"></i> Bring up</button>`);
    }
    if (i.kind === 'wifi') actions.push('<button class="btn btn-sm btn-outline-light" data-goto-tab="wifi"><i class="fas fa-wifi"></i> Wi-Fi networks</button>');
    if (i.kind === 'p2p' || (d.wifi && d.wifi.phy.modes && d.wifi.phy.modes.includes('P2P-GO'))) {
        actions.push('<button class="btn btn-sm btn-outline-light" data-goto-tab="p2p"><i class="fas fa-exchange-alt"></i> Wi-Fi Direct</button>');
    }
    if (d.profile) actions.push(`<button class="btn btn-sm btn-outline-light" data-goto-profile="${netEscape(d.profile.uuid)}"><i class="fas fa-list"></i> Profile</button>`);

    let html = `
        <div class="net-details-head">
            <div class="net-iface-icon"><i class="${NET_ICONS[i.kind] || 'fas fa-network-wired'}"></i></div>
            <div class="net-details-title">
                <div class="net-iface-name">${netEscape(i.name)}</div>
                <div class="net-iface-sub">${netEscape(NET_KIND_LABELS[i.kind] || i.kind)}${i.bus ? ` · ${netEscape(i.bus.toUpperCase())}` : ''}${i.driver ? ` · ${netEscape(i.driver)}` : ''}</div>
                <div class="net-badges">${ifaceBadges(i)}</div>
            </div>
        </div>
        <div class="net-details-actions">${actions.join('')}</div>`;

    if (i.is_client) {
        html += `<div class="net-note warn"><i class="fas fa-exclamation-triangle"></i> You are connected to the cockpit through ${netEscape(i.name)}.
            Risky changes here are applied with a ${30}-second safety timer and rolled back unless you confirm them.</div>`;
    }

    // General
    const drv = d.driver || {};
    html += `<div class="net-section"><div class="net-section-title">General</div>${netProps([
        ['State', `${netEscape(i.operstate)}${i.up && !i.carrier && i.kind !== 'loopback' ? ' <span class="net-warn-text">(no cable / not associated)</span>' : ''}`],
        i.mac ? ['MAC address', `<code>${netEscape(i.mac)}</code>${i.perm_mac && i.perm_mac !== i.mac ? ` <span class="net-muted">(hardware ${netEscape(i.perm_mac)})</span>` : ''}`] : null,
        ['IPv4', i.ipv4.length ? i.ipv4.map(a => `<code>${netEscape(a)}</code>`).join('<br>') : '<span class="net-muted">none</span>'],
        i.ipv6.length ? ['IPv6', i.ipv6.map(a => `<code>${netEscape(a.addr)}</code> <span class="net-muted">${netEscape(a.scope)}</span>`).join('<br>')] : null,
        drv.driver ? ['Driver', `${netEscape(drv.driver)} ${drv.version ? `<span class="net-muted">${netEscape(drv.version)}</span>` : ''}`] : null,
        drv.firmware ? ['Firmware', netEscape(drv.firmware)] : null,
        drv.bus_info ? ['Bus', `<code>${netEscape(drv.bus_info)}</code>`] : null,
        d.profile ? ['NM profile', `${netEscape(d.profile.name)}${d.profile.external ? ' <span class="net-muted">(external)</span>' : ''}`] : null,
        i.nm && !d.profile ? ['NetworkManager', netEscape(i.nm.state)] : null,
    ])}</div>`;

    // Link speed (ethtool)
    const link = d.link;
    if (link && link.available) {
        const both = new Set(link.partner_modes);
        const modeChips = link.supported_modes.map(m => {
            const cls = both.has(m) && link.advertised_modes.includes(m) ? 'both' : link.advertised_modes.includes(m) ? 'adv' : '';
            return `<span class="net-mode ${cls}">${netEscape(m)}</span>`;
        }).join('');
        const speeds = [];
        link.supported_modes.forEach(m => {
            const match = m.match(/^(\d+)base[^/]*\/(Full|Half)$/);
            if (!match) return;
            const key = `${match[1]}/${match[2].toLowerCase()}`;
            if (!speeds.includes(key)) speeds.push(key);
        });
        speeds.sort((a, b) => parseInt(b) - parseInt(a));
        const current = link.autoneg ? 'auto' : `${link.speed}/${link.duplex}`;
        const partnerMax = Math.max(0, ...link.partner_modes.map(m => parseInt(m) || 0));
        html += `<div class="net-section">
            <div class="net-section-title">Link speed <span class="net-muted">${netEscape(link.port || '')}</span></div>
            ${netProps([
                ['Current', link.speed ? `${netSpeed(link.speed)} ${netEscape(link.duplex)} duplex` : '<span class="net-muted">no link</span>'],
                ['Adapter maximum', link.max_speed ? netSpeed(link.max_speed) : '—'],
                partnerMax ? ['Other end maximum', `${netSpeed(partnerMax)}${link.max_speed && partnerMax < link.max_speed ? ' <span class="net-warn-text">(limits the link)</span>' : ''}`] : null,
                ['Auto-negotiation', netYesNo(link.autoneg)],
                link.pause ? ['Flow control', `${netEscape(link.pause)}${link.partner_pause ? ` <span class="net-muted">(partner: ${netEscape(link.partner_pause)})</span>` : ''}`] : null,
            ])}
            ${link.speed && link.max_speed && link.speed < link.max_speed && link.link_detected
                ? `<div class="net-note warn">Running below the adapter maximum. Check the cable (Cat5e or better for 1 Gb/s) and the switch port.</div>` : ''}
            <div class="net-form-row">
                <select class="form-control form-control-sm" id="net-link-mode">
                    <option value="auto" ${current === 'auto' ? 'selected' : ''}>Auto-negotiate (recommended)</option>
                    ${speeds.map(s => {
                        const [sp, dup] = s.split('/');
                        return `<option value="${s}" ${current === s ? 'selected' : ''}>Force ${netSpeed(+sp)} ${dup} duplex</option>`;
                    }).join('')}
                </select>
                <button class="btn btn-sm btn-primary" data-iface-action="link">Apply</button>
                ${persistBox('net-link-persist')}
            </div>
            <details class="net-modes-wrap" id="net-sec-modes" ${openState.modes ? 'open' : ''}>
                <summary class="net-muted">Link modes (green = supported by both ends)</summary>
                <div class="net-modes">${modeChips}</div>
            </details>
        </div>`;
    }

    // MTU / jumbo frames
    if (i.kind !== 'loopback' && i.mtu) {
        const max = i.max_mtu || i.mtu;
        const presets = [1280, 1500, 4000, 9000, 9216].filter(p => p >= (i.min_mtu || 68) && p <= max);
        if (max > 1500 && max <= 16000 && !presets.includes(max)) presets.push(max);
        const jumbo = max > 1500;
        html += `<div class="net-section">
            <div class="net-section-title">MTU${jumbo && ['ethernet', 'bridge', 'bond', 'vlan'].includes(i.kind) ? ' / Jumbo frames' : ''}
                <span class="net-muted">range ${i.min_mtu ?? '?'}–${max}</span></div>
            <div class="net-presets">${presets.map(p =>
                `<button class="net-preset ${p === i.mtu ? 'current' : ''}" data-mtu="${p}">${p}${p === 1500 ? ' standard' : p === 9000 ? ' jumbo' : p === max && p !== 9000 ? ' max' : ''}</button>`
            ).join('')}</div>
            <div class="net-form-row">
                <input type="number" class="form-control form-control-sm net-narrow" id="net-mtu" min="${i.min_mtu || 68}" max="${max}" value="${i.mtu}">
                <button class="btn btn-sm btn-primary" data-iface-action="mtu">Apply MTU</button>
                ${persistBox('net-mtu-persist')}
            </div>
            ${i.kind === 'ethernet' && !jumbo ? '<div class="net-muted net-hint">This adapter does not support jumbo frames (max MTU 1500).</div>' : ''}
            ${jumbo && i.kind === 'ethernet' ? `<div class="net-muted net-hint">Jumbo frames only help when every device on the path (switch, NAS, PC) uses the same MTU.
                Verify with Ping in Routes &amp; DNS using size ${'MTU − 28'} (e.g. 8972 for 9000).</div>` : ''}
        </div>`;
    }

    // Wireless
    if (d.wifi) {
        const w = d.wifi;
        const l = w.link;
        const bands = (w.phy.bands || []).map(b => `<tr>
            <td>${netEscape(b.band)}</td>
            <td>${b.standards.map(s => `802.11${s}`).join(', ') || '802.11a/b/g'}</td>
            <td>${b.widths.join('/')} MHz</td>
            <td>${b.streams}×${b.streams}</td>
            <td>~${b.max_rate} Mb/s</td>
            <td>${b.channels}</td></tr>`).join('');
        html += `<div class="net-section"><div class="net-section-title">Wireless</div>
            ${netProps([
                l ? ['Connection', l.connected
                    ? `${netEscape(l.ssid)} <span class="net-muted">${netEscape(l.bssid)}</span>`
                    : '<span class="net-muted">not connected</span>'] : null,
                l && l.connected ? ['Signal', netEscape(l.signal)] : null,
                l && l.connected ? ['Frequency', `${netEscape(l.freq)} MHz`] : null,
                l && l.connected ? ['Bitrate', `↓ ${netEscape(l.rx_bitrate || '—')}<br>↑ ${netEscape(l.tx_bitrate || '—')}`] : null,
                i.wireless && i.wireless.channel ? ['Channel', netEscape(i.wireless.channel)] : null,
                ['Country', w.regdomain ? netEscape(w.regdomain) : '<span class="net-warn-text">not set (some channels disabled)</span>'],
                ['TX power', netEscape(w.txpower || '—')],
                ['Modes', netEscape((w.phy.modes || []).join(', '))],
            ])}
            ${bands ? `<div class="net-table-wrap"><table class="net-table">
                <tr><th>Band</th><th>Standards</th><th>Width</th><th>MIMO</th><th>Max PHY rate</th><th>Channels</th></tr>${bands}</table></div>` : ''}
            ${i.kind === 'wifi' ? `<label class="net-toggle" title="Power saving adds latency and can drop SSH/web sessions on Raspberry Pi">
                <input type="checkbox" id="net-powersave" ${w.power_save ? 'checked' : ''}>
                <span class="net-toggle-track"></span><span>Power saving <span class="net-muted">(off = lower latency, until reboot)</span></span>
            </label>` : ''}
        </div>`;
    }

    // Statistics
    html += `<div class="net-section"><div class="net-section-title">Statistics</div><div id="net-live-stats"></div></div>`;

    // Offloads
    if (d.features && d.features.length) {
        const editable = d.features.filter(f => !f.fixed);
        html += `<details class="net-section" id="net-sec-features" ${openState.features ? 'open' : ''}>
            <summary>Offloads &amp; features <span class="net-muted">${editable.length} adjustable · until reboot</span></summary>
            <div class="net-features">${d.features.map(f => `
                <label class="net-toggle ${f.fixed ? 'fixed' : ''}" title="${f.fixed ? 'Fixed by the driver' : netEscape(f.name)}">
                    <input type="checkbox" data-feature="${netEscape(f.name)}" ${f.active ? 'checked' : ''} ${f.fixed ? 'disabled' : ''}>
                    <span class="net-toggle-track"></span><span>${netEscape(f.name)}</span>
                </label>`).join('')}</div>
        </details>`;
    }

    // Ring buffers
    if (d.rings) {
        const r = d.rings;
        html += `<details class="net-section" id="net-sec-rings" ${openState.rings ? 'open' : ''}>
            <summary>Ring buffers <span class="net-muted">RX ${r.rx ?? '—'}/${r.rx_max ?? '—'} · TX ${r.tx ?? '—'}/${r.tx_max ?? '—'}</span></summary>
            <div class="net-muted">Bigger rings absorb bursts (fewer drops under load) at the cost of a little latency.</div>
            <div class="net-form-row">
                RX <input type="number" class="form-control form-control-sm net-narrow" id="net-ring-rx" min="1" max="${r.rx_max || ''}" value="${r.rx ?? ''}">
                TX <input type="number" class="form-control form-control-sm net-narrow" id="net-ring-tx" min="1" max="${r.tx_max || ''}" value="${r.tx ?? ''}">
                <button class="btn btn-sm btn-primary" data-iface-action="rings">Apply</button>
                <span class="net-muted">until reboot</span>
            </div>
        </details>`;
    }

    // Wake-on-LAN
    if (link && link.wol_supported) {
        const on = link.wol && link.wol !== 'd';
        html += `<div class="net-section"><div class="net-section-title">Wake-on-LAN <span class="net-muted">supports ${netEscape(link.wol_supported)}</span></div>
            <label class="net-toggle"><input type="checkbox" id="net-wol" ${on ? 'checked' : ''} data-wol-mode="${link.wol_supported.includes('g') ? 'g' : link.wol_supported[0]}">
            <span class="net-toggle-track"></span><span>Wake on magic packet</span></label></div>`;
    }

    const container = document.getElementById('net-details');
    const scroll = container.scrollTop;
    container.innerHTML = html;
    container.scrollTop = scroll;
    updateLiveStats();
}

function updateLiveStats() {
    const el = document.getElementById('net-live-stats');
    const i = netIfaces.find(x => x.name === netSelected);
    if (!el || !i) return;
    const s = i.stats;
    const r = netRates[i.name];
    el.innerHTML = `<div class="net-table-wrap"><table class="net-table">
        <tr><th></th><th>Now</th><th>Bytes</th><th>Packets</th><th>Errors</th><th>Dropped</th></tr>
        <tr><td class="net-rx">↓ RX</td><td>${r ? netBits(r.rx) : '—'}</td><td>${netBytes(s.rx_bytes)}</td><td>${s.rx_packets.toLocaleString()}</td>
            <td class="${s.rx_errors ? 'net-bad-text' : ''}">${s.rx_errors}</td><td class="${s.rx_dropped ? 'net-warn-text' : ''}">${s.rx_dropped}</td></tr>
        <tr><td class="net-tx">↑ TX</td><td>${r ? netBits(r.tx) : '—'}</td><td>${netBytes(s.tx_bytes)}</td><td>${s.tx_packets.toLocaleString()}</td>
            <td class="${s.tx_errors ? 'net-bad-text' : ''}">${s.tx_errors}</td><td class="${s.tx_dropped ? 'net-warn-text' : ''}">${s.tx_dropped}</td></tr>
    </table></div>`;
}

async function ifaceAction(action, body = {}, labels = {}) {
    const name = netSelected;
    const data = await netCall(`/api/network/interface/${encodeURIComponent(name)}/${action}`, body, labels);
    pollNetInterfaces();
    if (name === netSelected) setTimeout(loadNetDetails, data && data.revert ? 300 : 0);
    return data;
}

function handleIfaceAction(action) {
    const iface = netIfaces.find(i => i.name === netSelected);
    if (!iface) return;
    if (action === 'down') {
        netConfirm(`Bring ${iface.name} down?`,
            iface.is_client
                ? `You are connected through ${iface.name}. The page will lose its connection; ${iface.name} comes back up automatically after 30 seconds.`
                : `${iface.name} stops passing traffic until it is brought up again.`,
            () => ifaceAction('down', {}, { busy: 'Bringing down…' }), 'Bring down');
    } else if (action === 'up') {
        ifaceAction('up', {}, { busy: 'Bringing up…' });
    } else if (action === 'mtu') {
        const mtu = Number(document.getElementById('net-mtu').value);
        const persist = document.getElementById('net-mtu-persist')?.checked || false;
        const go = () => ifaceAction('mtu', { mtu, persist }, { busy: `Setting MTU ${mtu}…`, done: `MTU ${mtu} applied` });
        if (mtu > 1500 && ['ethernet', 'bridge', 'bond', 'vlan'].includes(iface.kind)) {
            netConfirm(`Enable jumbo frames (MTU ${mtu})?`,
                'Every device on this network segment (switch, router, other hosts) must support this MTU, ' +
                'otherwise large packets are silently dropped and connections hang.' +
                (iface.is_client ? '\n\nThis is the interface you are connected through - the change is rolled back after 30 s unless you confirm.' : ''),
                go, 'Apply', false);
        } else {
            go();
        }
    } else if (action === 'link') {
        const mode = document.getElementById('net-link-mode').value;
        const persist = document.getElementById('net-link-persist')?.checked || false;
        const body = mode === 'auto' ? { autoneg: true, persist } : { autoneg: false, speed: mode.split('/')[0], duplex: mode.split('/')[1], persist };
        const go = () => ifaceAction('link', body, { busy: 'Renegotiating link…', done: 'Link settings applied' });
        if (mode !== 'auto') {
            netConfirm('Force link speed?',
                'With auto-negotiation off, the other end must be set to exactly the same speed and duplex, otherwise the link fails or runs with errors.',
                go, 'Force', false);
        } else {
            go();
        }
    } else if (action === 'rings') {
        ifaceAction('rings', {
            rx: document.getElementById('net-ring-rx').value,
            tx: document.getElementById('net-ring-tx').value,
        }, { busy: 'Resizing rings…' });
    }
}

// ---------------------------------------------------------------- Wi-Fi tab

async function loadNetWifi(rescan = false) {
    const wifiIfaces = netIfaces.filter(i => i.kind === 'wifi');
    const container = document.getElementById('net-wifi');
    if (!wifiIfaces.length) {
        container.innerHTML = '<div class="net-empty">No Wi-Fi interface</div>';
        return;
    }
    if (!netWifiIface || !wifiIfaces.some(i => i.name === netWifiIface)) netWifiIface = wifiIfaces[0].name;
    const name = netWifiIface;
    if (!netWifiScanned[name]) {
        rescan = true;
        netWifiScanned[name] = true;
    }
    if (rescan) {
        const btn = document.getElementById('net-wifi-scan');
        if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning…';
        else container.innerHTML = '<div class="net-empty"><i class="fas fa-spinner fa-spin"></i> Scanning…</div>';
    }
    const { ok, data } = await netApi(`/api/network/wifi/${encodeURIComponent(name)}${rescan ? '?rescan=1' : ''}`);
    if (name !== netWifiIface) return;
    if (!ok) {
        container.innerHTML = `<div class="net-empty">${netEscape(data.error || 'Failed')}</div>`;
        return;
    }
    renderNetWifi(data.wifi, wifiIfaces);
}

function renderNetWifi(w, wifiIfaces) {
    const l = w.link;
    const backendNote = {
        nm: 'Managed by NetworkManager.',
        wpa: 'Managed by wpa_supplicant directly (NetworkManager does not control this interface - typical when Wi-Fi Direct is set up). WPA2-Personal and open networks can be added here.',
        none: w.note,
    }[w.backend];

    const picker = wifiIfaces.length > 1
        ? `<select class="form-control form-control-sm net-narrow" id="net-wifi-iface">${wifiIfaces.map(i =>
            `<option value="${netEscape(i.name)}" ${i.name === w.interface ? 'selected' : ''}>${netEscape(i.name)}</option>`).join('')}</select>` : '';

    const savedSsids = new Set(w.saved.map(s => s.ssid));
    const nets = [];
    const seen = new Set();
    w.networks.forEach(n => {
        // One row per SSID (strongest BSSID), hidden networks kept by BSSID.
        const key = n.ssid || n.bssid;
        if (seen.has(key)) return;
        seen.add(key);
        nets.push(n);
    });

    const netRows = nets.map(n => `
        <tr class="${n.in_use ? 'active' : ''}">
            <td>${netSignalHtml(n.signal)}${n.signal ?? ''}%</td>
            <td>${n.ssid ? netEscape(n.ssid) : '<span class="net-muted">(hidden)</span>'} ${savedSsids.has(n.ssid) ? '<span class="net-badge info">saved</span>' : ''}</td>
            <td>${n.security ? `<i class="fas fa-lock net-muted"></i> ${netEscape(n.security)}` : '<span class="net-muted">open</span>'}</td>
            <td class="net-muted">${netEscape(n.channel)}${n.freq ? ` · ${netEscape(n.freq)}` : ''}</td>
            <td class="actions">${n.in_use
                ? '<span class="net-badge ok">connected</span>'
                : n.ssid ? `<button class="btn btn-sm btn-outline-light" data-wifi-connect="${netEscape(n.ssid)}" data-secure="${n.security ? 1 : 0}" data-sae="${n.sae_only ? 1 : 0}">Connect</button>` : ''}</td>
        </tr>`).join('');

    const savedRows = w.saved.map(s => {
        const actions = w.backend === 'nm'
            ? `${s.current ? '' : `<button class="btn btn-sm btn-outline-light" data-wifi-profile-up="${netEscape(s.id)}">Connect</button>`}
               <button class="btn btn-sm btn-outline-danger" data-wifi-forget="${netEscape(s.id)}" data-ssid="${netEscape(s.ssid)}">Forget</button>`
            : `${s.disabled
                ? `<button class="btn btn-sm btn-outline-light" data-wifi-saved="enable" data-id="${netEscape(s.id)}">Enable</button>`
                : `<button class="btn btn-sm btn-outline-light" data-wifi-saved="disable" data-id="${netEscape(s.id)}">Disable</button>`}
               <button class="btn btn-sm btn-outline-danger" data-wifi-forget="${netEscape(s.id)}" data-ssid="${netEscape(s.ssid)}">Forget</button>`;
        return `<tr class="${s.current ? 'active' : ''}"><td>${netEscape(s.ssid)}</td>
            <td>${s.current ? '<span class="net-badge ok">current</span>' : s.disabled ? '<span class="net-badge">disabled</span>' : ''}</td>
            <td class="actions">${actions}</td></tr>`;
    }).join('');

    document.getElementById('net-wifi').innerHTML = `
        <div class="net-inline" style="margin-bottom:8px">
            ${picker}
            <button class="btn btn-sm btn-primary" id="net-wifi-scan"><i class="fas fa-search"></i> Scan</button>
            <button class="btn btn-sm btn-outline-light" id="net-wifi-hidden"><i class="fas fa-eye-slash"></i> Hidden network…</button>
            ${w.backend === 'nm' ? '<button class="btn btn-sm btn-outline-light" id="net-wifi-hotspot"><i class="fas fa-broadcast-tower"></i> Hotspot…</button>' : ''}
        </div>
        <div class="net-muted">${netEscape(backendNote || '')}</div>
        ${w.note && w.backend !== 'none' ? `<div class="net-note warn">${netEscape(w.note)}</div>` : ''}
        <div class="net-section" style="margin-top:10px">
            <div class="net-section-title">Current connection</div>
            ${l.connected ? `${netProps([
                ['Network', `${netEscape(l.ssid)} <span class="net-muted">${netEscape(l.bssid)}</span>`],
                ['Signal', netEscape(l.signal)],
                ['Frequency', `${netEscape(l.freq)} MHz`],
                ['Bitrate', `↓ ${netEscape(l.rx_bitrate || '—')} · ↑ ${netEscape(l.tx_bitrate || '—')}`],
            ])}<button class="btn btn-sm btn-outline-warning" id="net-wifi-disconnect"><i class="fas fa-unlink"></i> Disconnect</button>`
            : `<div class="net-muted">Not connected${w.backend === 'wpa' && w.status ? ` (${netEscape(w.status.wpa_state || '')})` : ''}</div>`}
        </div>
        <div class="net-subtitle">Available networks (${nets.length})</div>
        ${nets.length ? `<div class="net-table-wrap"><table class="net-table">
            <tr><th>Signal</th><th>SSID</th><th>Security</th><th>Channel</th><th></th></tr>${netRows}</table></div>`
            : '<div class="net-muted">No networks found. Click Scan.</div>'}
        <div class="net-subtitle">Saved networks (${w.saved.length})</div>
        ${w.saved.length ? `<div class="net-table-wrap"><table class="net-table">${savedRows}</table></div>` : '<div class="net-muted">None</div>'}
    `;
    document.getElementById('net-wifi').dataset.backend = w.backend;
}

async function wifiAction(action, body, labels) {
    const data = await netCall(`/api/network/wifi/${encodeURIComponent(netWifiIface)}/${action}`, body, labels);
    setTimeout(() => loadNetWifi(), 1500);
    pollNetInterfaces();
    return data;
}

async function wifiConnectDialog(ssid, secure, saeOnly, hidden = false) {
    const backend = document.getElementById('net-wifi').dataset.backend;
    if (saeOnly && backend === 'wpa') {
        netToast('This network is WPA3-only; add it with NetworkManager or edit wpa_supplicant.conf (sae_password).', 'error', 8000);
        return;
    }
    const fields = [];
    if (hidden) fields.push({ name: 'ssid', label: 'Network name (SSID)', value: '' });
    if (secure || hidden) {
        fields.push({ name: 'password', label: hidden ? 'Password (empty = open network)' : 'Password', type: 'password',
                      placeholder: '8-63 characters' });
    }
    let values = { ssid };
    if (fields.length) {
        values = await netForm({
            title: hidden ? 'Connect to hidden network' : `Connect to ${ssid}`,
            message: backend === 'wpa' && !hidden ? 'Leave the password empty to reuse a saved one.' : '',
            fields,
            okLabel: 'Connect',
            validate: v => {
                if (hidden && !v.ssid) return 'Enter the network name';
                if (v.password && (v.password.length < 8 || v.password.length > 63)) return 'Password must be 8-63 characters';
                if (!hidden && secure && !v.password && backend === 'nm') return 'Enter the password';
                return '';
            },
        });
        if (!values) return;
        if (!hidden) values.ssid = ssid;
    }
    const client = netIfaces.find(i => i.is_client);
    const go = () => wifiAction('connect', { ssid: values.ssid, password: values.password || '', hidden },
        { busy: `Connecting to ${values.ssid}…`, done: `Connecting to ${values.ssid}` });
    if (client && client.name === netWifiIface) {
        netConfirm('Switch network?', `You are connected through ${netWifiIface}. Joining another network will probably disconnect this page.`, go, 'Switch');
    } else {
        go();
    }
}

async function wifiHotspotDialog() {
    const values = await netForm({
        title: 'Start a Wi-Fi hotspot',
        message: `${netWifiIface} becomes an access point and stops being a client. NetworkManager shares this machine's connection with devices that join.`,
        fields: [
            { name: 'ssid', label: 'Network name', value: (netOverview && netOverview.hostname) || 'raspberrypi' },
            { name: 'password', label: 'Password', type: 'password', placeholder: '8-63 characters' },
            { name: 'band', label: 'Band', type: 'select', value: 'bg', options: [['bg', '2.4 GHz (range)'], ['a', '5 GHz (speed)']] },
        ],
        okLabel: 'Start hotspot',
        validate: v => (!v.ssid ? 'Enter a network name' : v.password.length < 8 || v.password.length > 63 ? 'Password must be 8-63 characters' : ''),
    });
    if (values) wifiAction('hotspot', values, { busy: 'Starting hotspot…', done: 'Hotspot started' });
}

// ---------------------------------------------------------------- Profiles tab

async function loadNetConnections() {
    const container = document.getElementById('net-connections');
    const { ok, data } = await netApi('/api/network/connections');
    if (!ok) {
        container.innerHTML = `<div class="net-empty">${netEscape(data.error || 'Failed')}</div>`;
        return;
    }
    if (!data.available) {
        container.innerHTML = '<div class="net-empty">NetworkManager is not running - connection profiles are not available.<br>Interfaces are configured by another tool (see Overview).</div>';
        return;
    }
    const typeLabel = t => ({ '802-3-ethernet': 'Ethernet', '802-11-wireless': 'Wi-Fi', bluetooth: 'Bluetooth', loopback: 'Loopback',
                              tun: 'Tunnel', bridge: 'Bridge', vlan: 'VLAN', 'wifi-p2p': 'Wi-Fi Direct', wireguard: 'WireGuard', vpn: 'VPN' }[t] || t);
    const rows = data.connections.map(c => `
        <tr class="${c.active ? 'active' : ''} ${c.uuid === netSelectedProfile ? 'selected' : ''}">
            <td><a href="#" data-profile="${netEscape(c.uuid)}">${netEscape(c.name)}</a></td>
            <td class="net-muted">${netEscape(typeLabel(c.type))}</td>
            <td>${c.device ? `<code>${netEscape(c.device)}</code>` : ''}</td>
            <td><label class="net-toggle" title="Connect automatically"><input type="checkbox" data-profile-autoconnect="${netEscape(c.uuid)}" ${c.autoconnect ? 'checked' : ''}>
                <span class="net-toggle-track"></span></label></td>
            <td class="actions">
                ${c.active
                    ? `<button class="btn btn-sm btn-outline-warning" data-profile-action="down" data-uuid="${netEscape(c.uuid)}">Down</button>`
                    : `<button class="btn btn-sm btn-outline-light" data-profile-action="up" data-uuid="${netEscape(c.uuid)}">Up</button>`}
                <button class="btn btn-sm btn-outline-danger" data-profile-action="delete" data-uuid="${netEscape(c.uuid)}" data-name="${netEscape(c.name)}" title="Delete"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`).join('');
    container.innerHTML = `
        <div class="net-muted">NetworkManager connection profiles: saved configurations (IP settings, Wi-Fi credentials, MTU…) applied to an interface when activated.</div>
        <div class="net-table-wrap"><table class="net-table">
            <tr><th>Name</th><th>Type</th><th>Device</th><th>Auto</th><th></th></tr>${rows}
        </table></div>
        <div id="net-profile-editor"></div>`;
    if (netSelectedProfile) loadNetProfile(netSelectedProfile);
}

async function loadNetProfile(uuid) {
    netSelectedProfile = uuid;
    const editor = document.getElementById('net-profile-editor');
    if (!editor) return;
    editor.innerHTML = '<div class="net-empty"><i class="fas fa-spinner fa-spin"></i></div>';
    const { ok, data } = await netApi(`/api/network/connection/${encodeURIComponent(uuid)}`);
    if (!ok) {
        editor.innerHTML = `<div class="net-empty">${netEscape(data.error || 'Not found')}</div>`;
        return;
    }
    const c = data.connection;
    const editable = ['802-3-ethernet', '802-11-wireless', 'bridge', 'vlan', 'bond'].includes(c.type);
    const external = netIfaces.some(i => i.nm && i.nm.uuid === uuid && /externally/.test(i.nm.state));
    editor.innerHTML = `
        <div class="net-section" style="margin-top:12px">
            <div class="net-section-title">${netEscape(c.name)} <span class="net-muted">${netEscape(c.state || 'inactive')}</span></div>
            ${netProps([
                ['Interface', netEscape(c.interface || 'any')],
                c.ssid ? ['SSID', `${netEscape(c.ssid)}${c.wifi_mode && c.wifi_mode !== 'infrastructure' ? ` <span class="net-muted">(${netEscape(c.wifi_mode)})</span>` : ''}`] : null,
                c.security ? ['Security', netEscape(c.security)] : null,
                c.active_ip4.length ? ['Active IPv4', c.active_ip4.map(netEscape).join('<br>')] : null,
                c.active_gateway ? ['Active gateway', netEscape(c.active_gateway)] : null,
                c.active_dns.length ? ['Active DNS', c.active_dns.map(netEscape).join(', ')] : null,
                c.filename ? ['Stored in', `<code>${netEscape(c.filename)}</code>`] : null,
            ])}
            ${external ? '<div class="net-note warn">This profile was generated for an interface configured outside NetworkManager. Saving and applying it hands the interface to NetworkManager.</div>' : ''}
            ${editable ? `
            <form class="net-profile-form" id="net-profile-form" data-uuid="${netEscape(uuid)}" autocomplete="off">
                <label for="net-p-name">Name</label>
                <input class="form-control form-control-sm" id="net-p-name" value="${netEscape(c.name)}">
                <label for="net-p-method">IPv4</label>
                <select class="form-control form-control-sm" id="net-p-method">
                    ${[['auto', 'Automatic (DHCP)'], ['manual', 'Manual (static)'], ['shared', 'Shared to other computers'],
                       ['link-local', 'Link-local only'], ['disabled', 'Disabled']].map(([v, l]) =>
                        `<option value="${v}" ${c.ipv4.method === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                <label for="net-p-addr" class="net-p-manual">Addresses</label>
                <input class="form-control form-control-sm net-p-manual" id="net-p-addr" value="${netEscape(c.ipv4.addresses)}" placeholder="192.168.1.50/24, …">
                <label for="net-p-gw" class="net-p-manual">Gateway</label>
                <input class="form-control form-control-sm net-p-manual" id="net-p-gw" value="${netEscape(c.ipv4.gateway)}" placeholder="192.168.1.1">
                <label for="net-p-dns">DNS servers</label>
                <input class="form-control form-control-sm" id="net-p-dns" value="${netEscape(c.ipv4.dns)}" placeholder="1.1.1.1, 8.8.8.8 (empty = from DHCP)">
                <span></span>
                <label class="net-check"><input type="checkbox" id="net-p-ignore-dns" ${c.ipv4.ignore_auto_dns ? 'checked' : ''}> Ignore DNS servers from DHCP</label>
                ${c.mtu !== null ? `<label for="net-p-mtu">MTU</label>
                <input class="form-control form-control-sm" id="net-p-mtu" value="${netEscape(c.mtu)}" placeholder="auto">` : ''}
                <span></span>
                <div class="net-inline">
                    <button class="btn btn-sm btn-primary" type="submit"><i class="fas fa-save"></i> Save${c.state === 'activated' ? ' &amp; apply' : ''}</button>
                </div>
            </form>` : '<div class="net-muted">This profile type is not editable here (use nmcli).</div>'}
        </div>`;
    toggleManualFields();
    editor.scrollIntoView({ block: 'nearest' });
}

function toggleManualFields() {
    const method = document.getElementById('net-p-method');
    if (!method) return;
    document.querySelectorAll('.net-p-manual').forEach(el => { el.hidden = method.value !== 'manual'; });
}

async function saveNetProfile(form) {
    const uuid = form.dataset.uuid;
    const body = {
        name: document.getElementById('net-p-name').value,
        ipv4: {
            method: document.getElementById('net-p-method').value,
            addresses: document.getElementById('net-p-addr').value,
            gateway: document.getElementById('net-p-gw').value,
            dns: document.getElementById('net-p-dns').value,
            ignore_auto_dns: document.getElementById('net-p-ignore-dns').checked,
        },
        apply: true,
    };
    const mtu = document.getElementById('net-p-mtu');
    if (mtu) body.mtu = mtu.value.trim() || 'auto';
    await netCall(`/api/network/connection/${encodeURIComponent(uuid)}/edit`, body, { busy: 'Saving profile…', done: 'Profile saved' });
    loadNetConnections();
    pollNetInterfaces();
}

async function profileAction(action, uuid, name) {
    const run = async () => {
        await netCall(`/api/network/connection/${encodeURIComponent(uuid)}/${action}`, {},
            { busy: { up: 'Activating…', down: 'Deactivating…', delete: 'Deleting…' }[action] });
        if (action === 'delete' && netSelectedProfile === uuid) netSelectedProfile = null;
        loadNetConnections();
        pollNetInterfaces();
    };
    if (action === 'delete') {
        netConfirm('Delete profile?', `“${name}” and its stored settings (including Wi-Fi passwords) will be removed.`, run, 'Delete');
    } else {
        run();
    }
}

// ---------------------------------------------------------------- Routes & DNS tab

async function loadNetRoutes() {
    const { ok, data } = await netApi('/api/network/routes');
    const el = document.getElementById('net-routes');
    if (!ok) {
        el.innerHTML = `<div class="net-empty">${netEscape(data.error || 'Failed')}</div>`;
        return;
    }
    const routeRows = routes => routes.map(r => `<tr>
        <td><code>${netEscape(r.dst)}</code></td>
        <td>${r.gateway ? netEscape(r.gateway) : '<span class="net-muted">direct</span>'}</td>
        <td>${netEscape(r.dev || '')}</td>
        <td class="net-muted">${netEscape(r.protocol || '')}</td>
        <td class="net-muted">${r.metric ?? ''}</td>
        <td class="net-muted">${netEscape(r.prefsrc || '')}</td></tr>`).join('');
    const neighbors = data.neighbors.map(n => `<tr>
        <td><code>${netEscape(n.dst)}</code></td><td><code>${netEscape(n.lladdr)}</code></td>
        <td>${netEscape(n.dev)}</td><td class="net-muted">${netEscape((n.state || []).join(' '))}</td></tr>`).join('');
    const dns = data.dns;
    el.innerHTML = `
        <div class="net-subtitle">DNS</div>
        ${netProps([
            ...dns.links.map(l => [netEscape(l.link), netEscape(l.servers.join(', '))]),
            ['resolv.conf', netEscape(dns.nameservers.join(', ') || '—') + (dns.resolved ? ' <span class="net-muted">(systemd-resolved stub)</span>' : '')],
            dns.search ? ['Search domains', netEscape(dns.search)] : null,
        ])}
        <div class="net-subtitle">IPv4 routes</div>
        <div class="net-table-wrap"><table class="net-table">
            <tr><th>Destination</th><th>Gateway</th><th>Device</th><th>Proto</th><th>Metric</th><th>Source</th></tr>
            ${routeRows(data.ipv4)}</table></div>
        ${data.ipv6.length ? `<div class="net-subtitle">IPv6 routes</div>
        <div class="net-table-wrap"><table class="net-table">
            <tr><th>Destination</th><th>Gateway</th><th>Device</th><th>Proto</th><th>Metric</th><th>Source</th></tr>
            ${routeRows(data.ipv6)}</table></div>` : ''}
        <div class="net-subtitle">Neighbours (ARP / NDP) <span class="net-muted">devices this machine has talked to recently</span></div>
        ${neighbors ? `<div class="net-table-wrap"><table class="net-table">
            <tr><th>IP</th><th>MAC</th><th>Device</th><th>State</th></tr>${neighbors}</table></div>` : '<div class="net-muted">None</div>'}`;
}

async function runPing(e) {
    e.preventDefault();
    const host = document.getElementById('net-ping-host').value.trim();
    if (!host) return;
    const size = document.getElementById('net-ping-size').value;
    const out = document.getElementById('net-ping-out');
    out.hidden = false;
    out.textContent = `Pinging ${host}…`;
    const { ok, data } = await netApi('/api/network/ping', { host, size, count: 4 });
    if (!ok) {
        out.textContent = data.error || 'Failed';
        return;
    }
    let text = data.output;
    if (!data.reachable && size && /message too long|Frag needed|mtu/i.test(text)) {
        text += `\n\n→ ${size} bytes + 28 header bytes does not fit the MTU of the path.`;
    }
    out.textContent = text;
}

// ---------------------------------------------------------------- tabs + listeners

function setNetTab(tab) {
    netActiveTab = tab;
    document.querySelectorAll('#net-tabs .net-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.net-tab-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'wifi') loadNetWifi();
    if (tab === 'connections') loadNetConnections();
    if (tab === 'routes') loadNetRoutes();
    if (tab === 'p2p' && typeof loadNetP2p === 'function') loadNetP2p();
    if (tab !== 'p2p' && typeof stopNetP2pPolling === 'function') stopNetP2pPolling();
}

function setupNetListeners() {
    document.getElementById('net-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.net-tab');
        if (tab) setNetTab(tab.dataset.tab);
    });
    document.getElementById('net-chips').addEventListener('click', e => {
        const chip = e.target.closest('.net-chip');
        if (chip) setNetFilter(chip.dataset.filter);
    });
    document.getElementById('net-hide-lo').addEventListener('change', renderNetIfaces);
    document.getElementById('net-iface-list').addEventListener('click', e => {
        const el = e.target.closest('.net-iface');
        if (!el) return;
        selectNetIface(el.dataset.name);
        if (netActiveTab !== 'iface') setNetTab('iface');
    });

    // Overview
    const saveHostname = () => {
        const value = document.getElementById('net-hostname').value.trim();
        if (!netOverview || value === netOverview.hostname) return;
        netConfirm('Change hostname?', `The machine will be called “${value}”. Other devices may need a moment to see the new name (mDNS: ${value}.local).`,
            async () => {
                await netCall('/api/network/system', { action: 'hostname', value }, { busy: 'Renaming…', done: 'Hostname changed' });
                loadNetOverview();
            }, 'Rename', false);
    };
    document.getElementById('net-hostname-save').addEventListener('click', saveHostname);
    document.getElementById('net-hostname').addEventListener('keydown', e => { if (e.key === 'Enter') saveHostname(); });

    document.getElementById('net-wifi-radio').addEventListener('change', e => {
        const value = e.target.checked;
        const run = async () => {
            await netCall('/api/network/system', { action: 'wifi_radio', value }, { busy: value ? 'Turning Wi-Fi on…' : 'Turning Wi-Fi off…' });
            refreshAll();
        };
        if (!value) {
            e.target.checked = true;
            netConfirm('Turn Wi-Fi off?', 'All wireless connections stop, including Wi-Fi Direct groups and hotspots.', () => {
                document.getElementById('net-wifi-radio').checked = false;
                run();
            }, 'Turn off');
        } else {
            run();
        }
    });
    document.getElementById('net-restart-nm').addEventListener('click', () => {
        netConfirm('Restart NetworkManager?', 'Connections it manages may drop for a few seconds.', async () => {
            await netCall('/api/network/system', { action: 'restart_nm' }, { busy: 'Restarting NetworkManager…' });
            setTimeout(refreshAll, 3000);
        }, 'Restart');
    });

    // Interface details
    const details = document.getElementById('net-details');
    details.addEventListener('click', e => {
        const act = e.target.closest('[data-iface-action]');
        if (act) return handleIfaceAction(act.dataset.ifaceAction);
        const preset = e.target.closest('[data-mtu]');
        if (preset) {
            document.getElementById('net-mtu').value = preset.dataset.mtu;
            return;
        }
        const tab = e.target.closest('[data-goto-tab]');
        if (tab) return setNetTab(tab.dataset.gotoTab);
        const profile = e.target.closest('[data-goto-profile]');
        if (profile) {
            netSelectedProfile = profile.dataset.gotoProfile;
            setNetTab('connections');
        }
    });
    details.addEventListener('change', e => {
        const t = e.target;
        if (t.dataset.feature) {
            ifaceAction('feature', { feature: t.dataset.feature, value: t.checked }, { busy: `${t.dataset.feature} ${t.checked ? 'on' : 'off'}…`, quiet: true });
        } else if (t.id === 'net-powersave') {
            ifaceAction('power_save', { value: t.checked }, { busy: 'Updating power saving…', done: `Power saving ${t.checked ? 'on' : 'off'}` });
        } else if (t.id === 'net-wol') {
            ifaceAction('wol', { mode: t.checked ? t.dataset.wolMode : 'd' }, { busy: 'Updating Wake-on-LAN…' });
        }
    });

    // Wi-Fi
    const wifi = document.getElementById('net-wifi');
    wifi.addEventListener('click', e => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.id === 'net-wifi-scan') return loadNetWifi(true);
        if (t.id === 'net-wifi-hidden') return wifiConnectDialog('', true, false, true);
        if (t.id === 'net-wifi-hotspot') return wifiHotspotDialog();
        if (t.id === 'net-wifi-disconnect') {
            return netConfirm('Disconnect Wi-Fi?', `${netWifiIface} leaves its current network.`, () =>
                wifiAction('disconnect', {}, { busy: 'Disconnecting…' }), 'Disconnect');
        }
        if (t.dataset.wifiConnect !== undefined) return wifiConnectDialog(t.dataset.wifiConnect, t.dataset.secure === '1', t.dataset.sae === '1');
        if (t.dataset.wifiProfileUp) return profileAction('up', t.dataset.wifiProfileUp).then(() => loadNetWifi());
        if (t.dataset.wifiSaved) return wifiAction(t.dataset.wifiSaved, { id: t.dataset.id }, { busy: 'Updating…' });
        if (t.dataset.wifiForget) {
            const backend = wifi.dataset.backend;
            return netConfirm('Forget network?', `“${t.dataset.ssid}” and its password will be removed.`, () => {
                if (backend === 'nm') {
                    netCall(`/api/network/connection/${encodeURIComponent(t.dataset.wifiForget)}/delete`, {}, { busy: 'Forgetting…' })
                        .then(() => loadNetWifi());
                } else {
                    wifiAction('forget', { id: t.dataset.wifiForget }, { busy: 'Forgetting…' });
                }
            }, 'Forget');
        }
    });
    wifi.addEventListener('change', e => {
        if (e.target.id === 'net-wifi-iface') {
            netWifiIface = e.target.value;
            loadNetWifi();
        }
    });

    // Profiles
    const conns = document.getElementById('net-connections');
    conns.addEventListener('click', e => {
        const link = e.target.closest('[data-profile]');
        if (link) {
            e.preventDefault();
            return loadNetProfile(link.dataset.profile);
        }
        const act = e.target.closest('[data-profile-action]');
        if (act) profileAction(act.dataset.profileAction, act.dataset.uuid, act.dataset.name);
    });
    conns.addEventListener('change', e => {
        if (e.target.dataset.profileAutoconnect) {
            netCall(`/api/network/connection/${encodeURIComponent(e.target.dataset.profileAutoconnect)}/autoconnect`,
                { value: e.target.checked }, { busy: '', done: `Autoconnect ${e.target.checked ? 'on' : 'off'}` })
                .then(() => loadNetConnections());
        } else if (e.target.id === 'net-p-method') {
            toggleManualFields();
        }
    });
    conns.addEventListener('submit', e => {
        if (e.target.id !== 'net-profile-form') return;
        e.preventDefault();
        saveNetProfile(e.target);
    });

    document.getElementById('net-ping-form').addEventListener('submit', runPing);

    // Modals
    document.getElementById('net-confirm-cancel').addEventListener('click', closeNetConfirm);
    document.getElementById('net-confirm-ok').addEventListener('click', () => {
        const fn = netConfirmAction;
        closeNetConfirm();
        if (fn) fn();
    });
    document.getElementById('net-revert-keep').addEventListener('click', () => resolveRevert(true));
    document.getElementById('net-revert-undo').addEventListener('click', () => resolveRevert(false));
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (!document.getElementById('net-confirm-modal').hidden) closeNetConfirm();
        else if (!document.getElementById('net-form-modal').hidden) document.getElementById('net-form-cancel').click();
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollNetInterfaces();
    });
}
