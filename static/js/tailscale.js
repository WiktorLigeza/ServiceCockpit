// Tailscale page
let tsStatus = null;
let tsListTab = 'devices';
let tsFilter = 'all';
let tsSearch = '';
let tsSelected = null;          // {type: 'device'|'user', id}
let tsPollTimer = null;
let tsJobTimer = null;
let tsJobShownId = null;
let tsConfirmAction = null;
let tsBusy = false;

const TS_OS_ICONS = {
    linux: 'fab fa-linux',
    windows: 'fab fa-windows',
    macos: 'fab fa-apple',
    ios: 'fas fa-mobile-alt',
    android: 'fab fa-android',
    freebsd: 'fab fa-freebsd',
    tvos: 'fas fa-tv',
};

const TS_JOB_TITLES = {
    install: '<i class="fas fa-download"></i> Installing Tailscale',
    update: '<i class="fas fa-arrow-circle-up"></i> Updating Tailscale',
    login: '<i class="fas fa-sign-in-alt"></i> Logging in to Tailscale',
};

document.addEventListener('DOMContentLoaded', () => {
    setupTsListeners();
    loadTsStatus();
});

// ---------------------------------------------------------------- helpers

function tsEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

const tsEl = id => document.getElementById(id);

async function tsApi(url, body = undefined, retry = null) {
    const opts = body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
    try {
        const resp = await fetch(url, opts);
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 && data.error === 'sudo_required') {
            // header.js opens the modal; give it the retry so the action continues after unlocking.
            if (retry && window.showSudoModal) window.showSudoModal(data.message, retry);
            return { ok: false, status: 401, data, sudo: true };
        }
        return { ok: resp.ok && data.success !== false, status: resp.status, data };
    } catch (e) {
        return { ok: false, status: 0, data: { error: String(e) } };
    }
}

function tsToast(message, level = 'info', ms = 4000) {
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

function tsBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function tsValidDate(value) {
    if (!value || value.startsWith('0001-')) return null;
    const d = new Date(value);
    return isNaN(d) ? null : d;
}

function tsAgo(value) {
    const d = tsValidDate(value);
    if (!d) return '—';
    const s = Math.round((Date.now() - d) / 1000);
    if (s < 0) return tsIn(value);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} days ago`;
}

function tsIn(value) {
    const d = tsValidDate(value);
    if (!d) return '—';
    const s = Math.round((d - Date.now()) / 1000);
    if (s <= 0) return 'expired';
    if (s < 3600) return `in ${Math.ceil(s / 60)} min`;
    if (s < 86400) return `in ${Math.floor(s / 3600)} h`;
    return `in ${Math.floor(s / 86400)} days`;
}

function tsDate(value) {
    const d = tsValidDate(value);
    return d ? d.toLocaleString() : '—';
}

function tsIp4(node) {
    return (node?.ips || []).find(ip => ip.includes('.')) || '';
}

function tsIp6(node) {
    return (node?.ips || []).find(ip => ip.includes(':')) || '';
}

function tsOsIcon(os) {
    return TS_OS_ICONS[(os || '').toLowerCase()] || 'fas fa-desktop';
}

function tsShortName(node) {
    return node?.hostname || (node?.dns_name || '').split('.')[0] || 'unknown';
}

async function tsCopy(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        tsToast(`Copied ${text}`, 'success', 1800);
    } catch (_) {
        tsToast('Could not copy', 'error');
    }
}

function tsConfirm(title, message, okLabel, action) {
    tsEl('ts-confirm-title').textContent = title;
    tsEl('ts-confirm-message').textContent = message;
    tsEl('ts-confirm-ok').textContent = okLabel;
    tsConfirmAction = action;
    tsEl('ts-confirm-modal').hidden = false;
}

// ---------------------------------------------------------------- listeners

function setupTsListeners() {
    tsEl('ts-install-btn').addEventListener('click', tsInstall);
    tsEl('ts-update-btn').addEventListener('click', tsUpdate);
    tsEl('ts-check-update').addEventListener('click', () => loadTsStatus(true));
    tsEl('ts-login-browser').addEventListener('click', () => tsLogin(false));
    tsEl('ts-login-key-btn').addEventListener('click', () => tsLogin(true));
    tsEl('ts-auth-key').addEventListener('input', e => {
        tsEl('ts-login-key-btn').hidden = !e.target.value.trim();
        tsEl('ts-login-browser').hidden = !!e.target.value.trim();
    });
    tsEl('ts-daemon-start').addEventListener('click', tsStartDaemon);
    tsEl('ts-connected').addEventListener('change', tsToggleConnected);
    tsEl('ts-logout').addEventListener('click', () => tsConfirm(
        'Log out of Tailscale?',
        'This device leaves the tailnet until you log in again. If you are using this page over Tailscale, you will lose the connection.',
        'Log out',
        () => tsConnection('logout'),
    ));

    document.querySelectorAll('.ts-settings input[data-pref]').forEach(input => {
        input.addEventListener('change', () => tsSetPref({ [input.dataset.pref]: input.checked }, input));
    });
    tsEl('ts-exit-select').addEventListener('change', e => tsSetPref({ exit_node: e.target.value }, e.target));

    document.querySelectorAll('#ts-list-tabs .net-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            tsListTab = btn.dataset.tab;
            document.querySelectorAll('#ts-list-tabs .net-tab').forEach(b => b.classList.toggle('active', b === btn));
            tsEl('ts-chips').hidden = tsListTab !== 'devices';
            renderTsList();
        });
    });
    document.querySelectorAll('#ts-chips .net-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            tsFilter = chip.dataset.filter;
            document.querySelectorAll('#ts-chips .net-chip').forEach(c => c.classList.toggle('active', c === chip));
            renderTsList();
        });
    });
    tsEl('ts-search').addEventListener('input', e => {
        tsSearch = e.target.value.trim().toLowerCase();
        renderTsList();
    });

    tsEl('ts-list').addEventListener('click', e => {
        const row = e.target.closest('[data-select]');
        if (!row) return;
        const [type, id] = row.dataset.select.split(':');
        tsSelected = { type, id };
        renderTsList();
        renderTsDetails();
    });

    tsEl('ts-details').addEventListener('click', e => {
        const copy = e.target.closest('[data-copy]');
        if (copy) return tsCopy(copy.dataset.copy);
        const action = e.target.closest('[data-action]');
        if (!action) return;
        const { action: name, target } = action.dataset;
        if (name === 'ping') tsPing(target, action);
        if (name === 'use-exit') tsSetPref({ exit_node: target });
        if (name === 'clear-exit') tsSetPref({ exit_node: '' });
        if (name === 'show-user') {
            tsSelected = { type: 'user', id: target };
            renderTsList();
            renderTsDetails();
        }
        if (name === 'show-device') {
            tsSelected = { type: 'device', id: target };
            renderTsList();
            renderTsDetails();
        }
    });

    tsEl('ts-confirm-cancel').addEventListener('click', () => { tsEl('ts-confirm-modal').hidden = true; });
    tsEl('ts-confirm-ok').addEventListener('click', () => {
        tsEl('ts-confirm-modal').hidden = true;
        const action = tsConfirmAction;
        tsConfirmAction = null;
        if (action) action();
    });

    tsEl('ts-job-close').addEventListener('click', () => {
        tsEl('ts-job-modal').hidden = true;
        loadTsStatus();
    });
    tsEl('ts-job-cancel').addEventListener('click', async () => {
        await tsApi('/api/tailscale/job/cancel', {});
        pollTsJob();
    });
    tsEl('ts-job-login-copy').addEventListener('click', () => tsCopy(tsEl('ts-job-login-link').href));

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadTsStatus();
    });
}

// ---------------------------------------------------------------- status

async function loadTsStatus(checkUpdate = false) {
    clearTimeout(tsPollTimer);
    if (checkUpdate) {
        tsEl('ts-check-update').disabled = true;
        tsEl('ts-check-update').innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Checking…';
    }
    const res = await tsApi(`/api/tailscale/status${checkUpdate ? '?check_update=1' : ''}`);
    if (checkUpdate) {
        tsEl('ts-check-update').disabled = false;
        tsEl('ts-check-update').innerHTML = '<i class="fas fa-sync-alt"></i> Check now';
    }
    if (res.status === 200 && res.data) {
        tsStatus = res.data;
        renderTs();
        if (checkUpdate) {
            const u = tsStatus.update || {};
            if (u.available) tsToast(`Update available: ${u.latest}`, 'info');
            else if (u.latest) tsToast('Tailscale is up to date.', 'success');
            else if (u.error) tsToast(u.error, 'error', 6000);
        }
        if (tsStatus.job?.state === 'running') showTsJob();
    }
    // Poll less often when nothing changes much (not installed / not logged in uses the job poller).
    if (!document.hidden) tsPollTimer = setTimeout(loadTsStatus, 5000);
}

function renderTs() {
    const s = tsStatus;
    tsEl('ts-loading').hidden = true;
    tsEl('ts-install-view').hidden = s.installed;
    tsEl('ts-app-view').hidden = !s.installed;
    if (!s.installed) {
        if (s.package_manager === null) {
            tsEl('ts-install-note').textContent = 'No supported package manager found - the install script may not work on this system.';
        }
        return;
    }

    renderTsSelf();
    renderTsVersion();
    renderTsSettings();
    renderTsList();
    renderTsDetails();
}

function renderTsSelf() {
    const s = tsStatus;
    const badge = tsEl('ts-state-badge');
    const state = !s.reachable ? 'ServiceDown' : s.backend_state;
    const stateClass = { Running: 'ok', Stopped: 'warn', NeedsLogin: 'warn', NeedsMachineAuth: 'warn', Starting: 'info' }[state] || 'bad';
    const stateLabel = { Running: 'Connected', Stopped: 'Disconnected', NeedsLogin: 'Logged out', NeedsMachineAuth: 'Waiting for approval', NoState: 'Starting', ServiceDown: 'Stopped' }[state] || state || 'Unknown';
    badge.className = `net-badge ${stateClass}`;
    badge.textContent = stateLabel;

    const daemonDown = !s.reachable;
    tsEl('ts-daemon-note').hidden = !daemonDown;
    if (daemonDown) {
        tsEl('ts-daemon-text').textContent = s.daemon === 'active'
            ? `The Tailscale service is running but not answering: ${s.error || 'no response'}`
            : `The Tailscale service (tailscaled) is ${s.daemon === 'unknown' ? 'not running' : s.daemon}.`;
        tsEl('ts-daemon-start').innerHTML = s.daemon === 'active'
            ? '<i class="fas fa-redo"></i> Restart tailscaled' : '<i class="fas fa-play"></i> Start tailscaled';
    }

    const needsLogin = s.reachable && !tsLoggedIn();
    tsEl('ts-login').hidden = !needsLogin;
    const loggedIn = tsLoggedIn();
    tsEl('ts-self').hidden = !loggedIn;
    tsEl('ts-settings-panel').hidden = !loggedIn;
    if (!loggedIn) return;

    const me = s.self || {};
    const connected = tsEl('ts-connected');
    connected.checked = s.backend_state === 'Running';
    connected.disabled = tsBusy || s.backend_state === 'NeedsMachineAuth';
    tsEl('ts-connected-label').textContent = s.backend_state === 'NeedsMachineAuth'
        ? 'Waiting for admin approval' : (connected.checked ? 'Connected' : 'Disconnected');

    tsEl('ts-self-name').innerHTML = me.dns_name
        ? `<span class="ts-copy" data-copy-self="${tsEscape(me.dns_name)}" title="Copy">${tsEscape(tsShortName(me))}</span>`
        : tsEscape(tsShortName(me));
    tsEl('ts-self-ip4').innerHTML = tsIp4(me) ? `<code class="ts-copy" data-copy-self="${tsIp4(me)}" title="Copy">${tsIp4(me)}</code>` : '—';
    tsEl('ts-self-ip6').innerHTML = tsIp6(me) ? `<code class="ts-copy ts-small" data-copy-self="${tsIp6(me)}" title="Copy">${tsIp6(me)}</code>` : '—';
    tsEl('ts-tailnet').textContent = s.tailnet?.name || s.magic_dns_suffix || '—';
    tsEl('ts-self-user').textContent = me.user || '—';
    tsEl('ts-self-expiry').textContent = tsValidDate(me.key_expiry) ? tsIn(me.key_expiry) : 'never';

    const exitPeer = s.exit_node && (s.peers || []).find(p => p.id === s.exit_node.id);
    tsEl('ts-self-exit').textContent = exitPeer ? tsShortName(exitPeer) : (s.exit_node ? s.exit_node.ips[0] || 'yes' : 'none');

    const health = tsEl('ts-health');
    health.innerHTML = (s.health || []).map(h => `<div class="net-note warn"><i class="fas fa-exclamation-triangle"></i> ${tsEscape(h)}</div>`).join('');

    document.querySelectorAll('#ts-self [data-copy-self]').forEach(el => {
        el.onclick = () => tsCopy(el.dataset.copySelf);
    });
}

function renderTsVersion() {
    const s = tsStatus;
    const u = s.update || {};
    tsEl('ts-version').textContent = s.version || '—';
    tsEl('ts-latest').textContent = u.latest || (u.error ? 'unknown' : 'checking…');
    tsEl('ts-update-btn').hidden = !u.available;
    tsEl('ts-update-pill').hidden = !u.available;
    tsEl('ts-update-pill').classList.toggle('urgent', !!u.urgent);

    let note = '';
    if (u.available) note = u.urgent ? 'Security update available - install it soon.' : 'A newer version is available.';
    else if (u.latest) note = 'Up to date.';
    else if (u.error) note = u.error;
    if (u.track === 'unstable') note += ' (unstable track)';
    if (s.daemon_version && s.version && !s.daemon_version.startsWith(s.version.split('-')[0])) {
        note += ` The running service is ${s.daemon_version.split('-')[0]} - restart tailscaled to use the new version.`;
    }
    tsEl('ts-update-note').textContent = note.trim();
}

function renderTsSettings() {
    const s = tsStatus;
    const prefs = s.prefs;
    tsEl('ts-prefs-note').hidden = !!prefs;
    document.querySelectorAll('.ts-settings input[data-pref]').forEach(input => {
        input.disabled = !prefs || tsBusy;
        if (prefs && document.activeElement !== input) input.checked = !!prefs[input.dataset.pref];
    });

    const select = tsEl('ts-exit-select');
    if (document.activeElement !== select) {
        const options = (s.peers || []).filter(p => p.exit_node_option);
        const current = s.exit_node?.ips?.[0] || prefs?.exit_node_ip || '';
        const currentId = s.exit_node?.id || prefs?.exit_node_id;
        select.innerHTML = '<option value="">None</option>' + options.map(p => {
            const ip = tsIp4(p);
            const selected = p.id === currentId || (current && p.ips.includes(current));
            return `<option value="${tsEscape(ip)}" ${selected ? 'selected' : ''}>${tsEscape(tsShortName(p))}${p.online ? '' : ' (offline)'}</option>`;
        }).join('');
        select.disabled = !options.length || tsBusy;
        if (!options.length) select.innerHTML = '<option value="">No exit nodes in this tailnet</option>';
    }
    tsEl('ts-exit-lan-row').hidden = !s.exit_node;

    const control = prefs?.control_url || '';
    tsEl('ts-admin-link').hidden = !!control && !control.includes('tailscale.com');
}

// ---------------------------------------------------------------- list

function tsLoggedIn() {
    return !!(tsStatus?.reachable && tsStatus.self && !['NeedsLogin', 'NoState'].includes(tsStatus.backend_state));
}

function tsAllDevices() {
    if (!tsLoggedIn()) return [];
    return [{ ...tsStatus.self, is_self: true }, ...(tsStatus.peers || [])];
}

function tsMatches(text) {
    return !tsSearch || text.toLowerCase().includes(tsSearch);
}

function renderTsList() {
    const list = tsEl('ts-list');
    if (!tsLoggedIn()) {
        list.innerHTML = `<div class="net-empty">${tsStatus?.reachable ? 'Log in to see your tailnet.' : 'Tailscale is not running.'}</div>`;
        tsEl('ts-device-count').textContent = '';
        tsEl('ts-user-count').textContent = '';
        return;
    }
    const devices = tsAllDevices();
    const users = tsStatus.users || [];
    tsEl('ts-device-count').textContent = `${devices.filter(d => d.online).length}/${devices.length}`;
    tsEl('ts-user-count').textContent = users.length;

    if (tsListTab === 'users') {
        const rows = users.filter(u => tsMatches(`${u.login_name} ${u.display_name}`));
        list.innerHTML = rows.length ? rows.map(tsUserRow).join('') : '<div class="net-empty">No users match.</div>';
        return;
    }

    const filters = {
        all: () => true,
        online: d => d.online,
        offline: d => !d.online,
        exit: d => d.exit_node_option || d.exit_node,
    };
    const rows = devices.filter(filters[tsFilter]).filter(d => tsMatches(
        `${d.hostname} ${d.dns_name} ${d.ips.join(' ')} ${d.os} ${d.user} ${d.tags.join(' ')}`));
    list.innerHTML = rows.length ? rows.map(tsDeviceRow).join('') : '<div class="net-empty">No devices match.</div>';
}

function tsDeviceRow(d) {
    const selected = tsSelected?.type === 'device' && tsSelected.id === d.id;
    const badges = [];
    if (d.is_self) badges.push('<span class="net-badge purple">this device</span>');
    if (d.exit_node) badges.push('<span class="net-badge ok">exit node in use</span>');
    else if (d.exit_node_option) badges.push('<span class="net-badge info">exit node</span>');
    if (d.expired) badges.push('<span class="net-badge bad">key expired</span>');
    if (d.shared) badges.push('<span class="net-badge">shared</span>');
    d.tags.forEach(t => badges.push(`<span class="net-badge">${tsEscape(t.replace(/^tag:/, '#'))}</span>`));
    if (!d.is_self && d.online && d.connection) {
        badges.push(`<span class="net-badge ${d.connection === 'direct' ? 'ok' : 'warn'}">${d.connection === 'direct' ? 'direct' : `relay ${tsEscape(d.relay || '')}`}</span>`);
    }
    const sub = [tsIp4(d), d.os, d.tags.length ? 'tagged' : d.user].filter(Boolean).join(' · ');
    const seen = d.online ? '<span class="net-yes">online</span>' : `<span class="net-no">${tsAgo(d.last_seen)}</span>`;
    return `
        <div class="net-iface ${d.online ? 'up' : ''} ${selected ? 'selected' : ''}" data-select="device:${tsEscape(d.id)}">
            <div class="net-iface-icon"><i class="${tsOsIcon(d.os)}"></i></div>
            <div class="net-iface-main">
                <div class="net-iface-name">${tsEscape(tsShortName(d))}</div>
                <div class="net-iface-sub">${tsEscape(sub)}</div>
                ${badges.length ? `<div class="net-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="net-iface-rate">${seen}</div>
        </div>`;
}

function tsAvatar(u, size = '') {
    const initial = tsEscape((u.display_name || u.login_name || '?').trim()[0]?.toUpperCase() || '?');
    const img = u.picture
        ? `<img src="${tsEscape(u.picture)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
        : '';
    return `<div class="net-iface-icon ts-avatar ${size}"><span>${initial}</span>${img}</div>`;
}

function tsUserRow(u) {
    const selected = tsSelected?.type === 'user' && String(tsSelected.id) === String(u.id);
    return `
        <div class="net-iface ${u.online ? 'up' : ''} ${selected ? 'selected' : ''}" data-select="user:${tsEscape(u.id)}">
            ${tsAvatar(u)}
            <div class="net-iface-main">
                <div class="net-iface-name">${tsEscape(u.display_name || u.login_name)}
                    ${u.is_me ? '<span class="net-badge purple">you</span>' : ''}</div>
                <div class="net-iface-sub">${tsEscape(u.login_name || '')}</div>
            </div>
            <div class="net-iface-rate">${u.online}/${u.devices}<br><span class="net-muted">online</span></div>
        </div>`;
}

// ---------------------------------------------------------------- details

function renderTsDetails() {
    const box = tsEl('ts-details');
    if (!tsLoggedIn()) {
        box.innerHTML = '<div class="net-empty">Nothing to show yet.</div>';
        return;
    }
    if (!tsSelected) tsSelected = { type: 'device', id: tsStatus.self.id };

    // Don't redraw while a ping result is on screen for the same node.
    const pingOut = box.querySelector('.ts-ping-out:not([hidden])');
    if (pingOut && box.dataset.for === `${tsSelected.type}:${tsSelected.id}`) {
        tsUpdateDetailsLive();
        return;
    }
    box.dataset.for = `${tsSelected.type}:${tsSelected.id}`;

    if (tsSelected.type === 'user') {
        const u = (tsStatus.users || []).find(x => String(x.id) === String(tsSelected.id));
        box.innerHTML = u ? tsUserDetails(u) : '<div class="net-empty">User not found.</div>';
        return;
    }
    const d = tsAllDevices().find(x => x.id === tsSelected.id);
    box.innerHTML = d ? tsDeviceDetails(d) : '<div class="net-empty">Device is no longer in the tailnet.</div>';
}

function tsUpdateDetailsLive() {
    const d = tsAllDevices().find(x => x.id === tsSelected.id);
    const el = tsEl('ts-detail-status');
    if (d && el) el.innerHTML = tsDeviceStatusHtml(d);
}

function tsDeviceStatusHtml(d) {
    return d.online ? '<span class="net-yes"><i class="fas fa-circle"></i> online</span>'
        : `<span class="net-no"><i class="far fa-circle"></i> offline · last seen ${tsAgo(d.last_seen)}</span>`;
}

function tsCopyable(value, small = false) {
    if (!value) return '—';
    return `<code class="ts-copy ${small ? 'ts-small' : ''}" data-copy="${tsEscape(value)}" title="Click to copy">${tsEscape(value)}</code>`;
}

function tsDeviceDetails(d) {
    const owner = (tsStatus.users || []).find(u => String(u.id) === String(d.user_id));
    const actions = [];
    if (!d.is_self) {
        actions.push(`<button class="btn btn-sm btn-outline-light" data-action="ping" data-target="${tsEscape(tsIp4(d) || d.ips[0])}"><i class="fas fa-satellite-dish"></i> Ping</button>`);
        if (d.exit_node) {
            actions.push('<button class="btn btn-sm btn-outline-warning" data-action="clear-exit"><i class="fas fa-times"></i> Stop using as exit node</button>');
        } else if (d.exit_node_option) {
            actions.push(`<button class="btn btn-sm btn-outline-info" data-action="use-exit" data-target="${tsEscape(tsIp4(d))}"><i class="fas fa-door-open"></i> Use as exit node</button>`);
        }
    }
    const connection = d.is_self ? 'this device'
        : !d.online ? '—'
        : d.connection === 'direct' ? `direct <code>${tsEscape(d.cur_addr)}</code>`
        : d.connection === 'relay' ? `relayed via DERP <code>${tsEscape(d.relay)}</code>`
        : 'idle (no traffic yet)';

    return `
        <div class="net-details-head">
            <div class="net-iface-icon ${d.online ? 'ts-on' : ''}"><i class="${tsOsIcon(d.os)}"></i></div>
            <div class="net-details-title">
                <div class="net-iface-name">${tsEscape(tsShortName(d))}
                    ${d.is_self ? '<span class="net-badge purple">this device</span>' : ''}</div>
                <div class="net-muted" id="ts-detail-status">${tsDeviceStatusHtml(d)}</div>
            </div>
        </div>
        ${actions.length ? `<div class="net-details-actions">${actions.join('')}</div>` : ''}
        <pre class="net-log ts-ping-out" id="ts-ping-out" hidden></pre>

        <div class="net-section">
            <div class="net-section-title">Addresses</div>
            <dl class="net-props">
                <dt>IPv4</dt><dd>${tsCopyable(tsIp4(d))}</dd>
                <dt>IPv6</dt><dd>${tsCopyable(tsIp6(d), true)}</dd>
                <dt>DNS name</dt><dd>${tsCopyable(d.dns_name, true)}</dd>
                ${d.routes.length ? `<dt>Subnet routes</dt><dd>${d.routes.map(r => `<code>${tsEscape(r)}</code>`).join(' ')}</dd>` : ''}
            </dl>
        </div>

        <div class="net-section">
            <div class="net-section-title">Device</div>
            <dl class="net-props">
                <dt>OS</dt><dd>${tsEscape(d.os || '—')}</dd>
                <dt>Owner</dt><dd>${d.tags.length
                    ? d.tags.map(t => `<span class="net-badge">${tsEscape(t)}</span>`).join(' ')
                    : owner ? `<a href="#" class="ts-link" data-action="show-user" data-target="${tsEscape(owner.id)}">${tsEscape(owner.login_name)}</a>` : tsEscape(d.user || '—')}</dd>
                <dt>Connection</dt><dd>${connection}</dd>
                ${d.is_self ? '' : `<dt>Traffic</dt><dd><span class="net-rx">↓ ${tsBytes(d.rx_bytes)}</span> &nbsp; <span class="net-tx">↑ ${tsBytes(d.tx_bytes)}</span></dd>`}
                <dt>Exit node</dt><dd>${d.exit_node ? '<span class="net-yes">in use</span>' : d.exit_node_option ? 'available' : 'no'}</dd>
                ${d.shared ? '<dt>Shared</dt><dd>shared in from another tailnet</dd>' : ''}
            </dl>
        </div>

        <div class="net-section">
            <div class="net-section-title">Key</div>
            <dl class="net-props">
                <dt>Added</dt><dd>${tsDate(d.created)}</dd>
                <dt>Key expiry</dt><dd>${tsValidDate(d.key_expiry)
                    ? `${tsDate(d.key_expiry)} <span class="${d.expired ? 'net-bad-text' : 'net-muted'}">(${tsIn(d.key_expiry)})</span>`
                    : 'disabled'}</dd>
                ${d.is_self ? '' : `<dt>Last handshake</dt><dd>${tsAgo(d.last_handshake)}</dd>`}
                <dt>Node ID</dt><dd>${tsCopyable(d.id, true)}</dd>
            </dl>
        </div>`;
}

function tsUserDetails(u) {
    const devices = tsAllDevices().filter(d => String(d.user_id) === String(u.id) && !d.tags.length);
    return `
        <div class="net-details-head">
            ${tsAvatar(u, 'ts-avatar-lg')}
            <div class="net-details-title">
                <div class="net-iface-name">${tsEscape(u.display_name || u.login_name)}
                    ${u.is_me ? '<span class="net-badge purple">you</span>' : ''}</div>
                <div class="net-muted">${tsCopyable(u.login_name, true)}</div>
            </div>
        </div>
        <div class="net-section">
            <div class="net-section-title">Devices <span class="net-muted">${u.online}/${u.devices} online</span></div>
            ${devices.length ? `<div class="ts-user-devices">${devices.map(d => `
                <a href="#" class="ts-user-device" data-action="show-device" data-target="${tsEscape(d.id)}">
                    <i class="${tsOsIcon(d.os)}"></i>
                    <span>${tsEscape(tsShortName(d))}</span>
                    <code>${tsEscape(tsIp4(d))}</code>
                    <span class="${d.online ? 'net-yes' : 'net-no'}">${d.online ? 'online' : tsAgo(d.last_seen)}</span>
                </a>`).join('')}</div>` : '<div class="net-muted">No devices visible from here (tagged devices are listed under their tags).</div>'}
        </div>
        <div class="net-muted ts-small">
            Only users who own a device this node can see are listed. Roles and invites are managed in the admin console.
        </div>`;
}

// ---------------------------------------------------------------- actions

async function tsPing(target, button) {
    const out = tsEl('ts-ping-out');
    out.hidden = false;
    out.textContent = `Pinging ${target}…`;
    button.disabled = true;
    const res = await tsApi('/api/tailscale/ping', { target });
    button.disabled = false;
    out.textContent = res.data.output || res.data.error || 'No reply';
}

async function tsSetPref(change, input = null) {
    tsBusy = true;
    if (input) input.disabled = true;
    const res = await tsApi('/api/tailscale/set', change, () => tsSetPref(change, input));
    tsBusy = false;
    if (res.ok) {
        tsToast('Setting saved.', 'success', 2000);
    } else if (!res.sudo) {
        tsToast(res.data.error || 'Could not change the setting.', 'error', 7000);
    }
    loadTsStatus();
}

async function tsToggleConnected(e) {
    const up = e.target.checked;
    if (!up) {
        e.target.checked = true;
        tsConfirm(
            'Disconnect from Tailscale?',
            'This device stays logged in but leaves the tailnet until you reconnect. If you are using this page over Tailscale, you will lose the connection.',
            'Disconnect',
            () => tsConnection('down'),
        );
        return;
    }
    tsConnection('up');
}

async function tsConnection(action) {
    tsBusy = true;
    tsEl('ts-connected').disabled = true;
    const res = await tsApi('/api/tailscale/connection', { action }, () => tsConnection(action));
    tsBusy = false;
    if (res.ok) {
        tsToast({ up: 'Connected.', down: 'Disconnected.', logout: 'Logged out.' }[action], 'success');
    } else if (!res.sudo) {
        tsToast(res.data.error || `Could not ${action}.`, 'error', 8000);
    }
    loadTsStatus();
}

async function tsStartDaemon() {
    const btn = tsEl('ts-daemon-start');
    btn.disabled = true;
    const action = tsStatus?.daemon === 'active' ? 'restart' : 'start';
    const res = await tsApi('/api/tailscale/daemon', { action }, tsStartDaemon);
    btn.disabled = false;
    if (res.ok) tsToast('tailscaled started.', 'success');
    else if (!res.sudo) tsToast(res.data.error || 'Could not start tailscaled.', 'error', 8000);
    loadTsStatus();
}

async function tsStartJob(url, body, retry) {
    const res = await tsApi(url, body, retry);
    if (res.ok) {
        tsJobShownId = null;
        showTsJob();
    } else if (!res.sudo) {
        tsToast(res.data.error || 'Could not start.', 'error', 8000);
        if (res.status === 409) showTsJob();
    }
}

function tsInstall() {
    tsStartJob('/api/tailscale/install', {}, tsInstall);
}

function tsUpdate() {
    const u = tsStatus?.update || {};
    tsConfirm(
        'Update Tailscale?',
        `Update from ${tsStatus?.version || '?'} to ${u.latest || 'the latest version'}.\n\nTailscale restarts during the update, so connections over Tailscale (possibly including this page) drop for a few seconds.`,
        'Update',
        () => tsStartJob('/api/tailscale/update', {}, tsUpdate),
    );
}

function tsLogin(withKey) {
    const body = { hostname: tsEl('ts-login-hostname').value.trim() };
    if (withKey) body.auth_key = tsEl('ts-auth-key').value.trim();
    tsStartJob('/api/tailscale/login', body, () => tsLogin(withKey));
    if (withKey) tsEl('ts-auth-key').value = '';
}

// ---------------------------------------------------------------- job modal

function showTsJob() {
    tsEl('ts-job-modal').hidden = false;
    pollTsJob();
}

async function pollTsJob() {
    clearTimeout(tsJobTimer);
    const res = await tsApi('/api/tailscale/job');
    const job = res.data || {};
    if (!job.kind) {
        tsEl('ts-job-modal').hidden = true;
        return;
    }
    renderTsJob(job);
    if (job.state === 'running') {
        tsJobTimer = setTimeout(pollTsJob, 1000);
        // A login job ends by itself once the browser approves; watch status meanwhile.
        if (job.kind === 'login') loadTsStatus();
    } else if (tsJobShownId !== job.id) {
        tsJobShownId = job.id;
        loadTsStatus();
        if (job.state === 'done' && job.kind === 'install') {
            tsToast('Tailscale installed. Now log in.', 'success', 6000);
        }
    }
}

function renderTsJob(job) {
    const running = job.state === 'running';
    tsEl('ts-job-title').innerHTML = TS_JOB_TITLES[job.kind] || 'Tailscale';

    const status = tsEl('ts-job-status');
    const last = [...(job.log || [])].reverse().find(l => l.trim()) || '';
    const labels = {
        running: `<i class="fas fa-circle-notch fa-spin"></i> ${job.kind === 'login' && job.login_url
            ? 'Waiting for you to approve this device in the browser…'
            : tsEscape(last.slice(0, 140) || 'Working…')}`,
        done: `<i class="fas fa-check-circle net-yes"></i> ${{ install: 'Tailscale is installed.', update: 'Tailscale is updated.', login: 'Logged in.' }[job.kind] || 'Done.'}`,
        failed: '<i class="fas fa-times-circle net-bad-text"></i> Failed - see the log below.',
        cancelled: '<i class="fas fa-ban net-warn-text"></i> Cancelled.',
    };
    status.innerHTML = labels[job.state] || '';

    const loginBox = tsEl('ts-job-login');
    const showLogin = job.kind === 'login' && running && job.login_url;
    loginBox.hidden = !showLogin;
    if (showLogin) {
        tsEl('ts-job-login-link').href = job.login_url;
        tsEl('ts-job-login-link').textContent = job.login_url;
        tsEl('ts-job-login-open').href = job.login_url;
    }

    const log = tsEl('ts-job-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = (job.log || []).join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
    if (job.state === 'failed') tsEl('ts-job-details').open = true;

    tsEl('ts-job-cancel').hidden = !running;
    tsEl('ts-job-close').hidden = running;
}
