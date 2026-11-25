// Network page: "Firewall" tab - ufw / firewalld on/off, default policy and rules.
// Backend: cockpit/features/network/firewall.py. Uses netApi / netCall / netConfirm /
// netEscape from network.js and JobModal (job_modal.js) for installing a firewall.

let fwData = null;
let fwInstallModal = null;

async function loadNetFirewall() {
    const box = document.getElementById('net-firewall');
    const { ok, status, data } = await netApi('/api/network/firewall');
    if (status === 401 && data.error === 'sudo_required') {
        box.innerHTML = `<div class="net-empty">Reading the firewall needs the sudo password.<br><br>
            <button class="btn btn-sm btn-primary" id="net-fw-unlock"><i class="fas fa-key"></i> Enter password</button></div>`;
        document.getElementById('net-fw-unlock').onclick = () =>
            typeof showSudoModal === 'function' && showSudoModal(data.message || 'Sudo password required.', loadNetFirewall);
        return;
    }
    if (!ok) {
        box.innerHTML = `<div class="net-empty">${netEscape(data.error || 'Could not read the firewall')}</div>`;
        return;
    }
    fwData = data;
    renderNetFirewall();
}

function fwInstaller() {
    if (!fwInstallModal && window.JobModal) {
        fwInstallModal = new JobModal({
            jobUrl: '/api/network/firewall/job',
            cancelUrl: '/api/network/firewall/job/cancel',
            titles: { install: '<i class="fas fa-shield-alt"></i> Installing a firewall' },
            doneText: { install: 'Installed. Add your rules, then turn the firewall on.' },
            onFinish: () => loadNetFirewall(),
        });
    }
    return fwInstallModal;
}

async function installNetFirewall() {
    const res = await fwInstaller()?.start('/api/network/firewall/install', {}, installNetFirewall);
    if (res && !res.ok && res.error) netToast(res.error, 'error', 8000);
}

function fwPortText(r) {
    if (!r.port) return '<span class="net-muted">all ports</span>';
    return netEscape(r.port) + (typeof WELL_KNOWN_PORTS !== 'undefined' && WELL_KNOWN_PORTS[r.port]
        ? `<span class="net-muted"> ${netEscape(WELL_KNOWN_PORTS[r.port])}</span>` : '');
}

function renderNetFirewall() {
    const d = fwData;
    const box = document.getElementById('net-firewall');
    if (d.job === 'running') fwInstaller()?.show();

    if (!d.backend) {
        box.innerHTML = `
            <div class="net-note warn">No firewall is installed - every listening port is reachable from the network.</div>
            ${d.can_install
                ? `<button class="btn btn-sm btn-primary" id="net-fw-install"><i class="fas fa-download"></i> Install firewall</button>
                   <div class="net-muted net-hint">Installs ufw (Debian/Ubuntu/Arch) or firewalld (Fedora/RHEL/openSUSE). It stays off until you turn it on.</div>`
                : '<div class="net-muted">No supported package manager found - install ufw or firewalld by hand.</div>'}`;
        const btn = document.getElementById('net-fw-install');
        if (btn) btn.onclick = installNetFirewall;
        return;
    }

    const isUfw = d.backend === 'ufw';
    const policySelect = (dir, value) => `
        <label>${dir === 'incoming' ? 'Incoming' : 'Outgoing'}
            <select class="form-control form-control-sm" data-fw-policy="${dir}">
                ${['allow', 'deny', 'reject'].map(p => `<option value="${p}" ${p === value ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
        </label>`;

    const rules = d.rules || [];
    const rows = rules.map((r, i) => `
        <tr>
            <td class="net-fw-action-${netEscape(r.action)}">${netEscape(r.action.toUpperCase())}</td>
            <td class="num">${fwPortText(r)}</td>
            <td>${netEscape(r.proto === 'any' ? 'TCP + UDP' : r.proto.toUpperCase())}</td>
            <td>${netEscape(r.source === 'any' ? 'anywhere' : r.source)}</td>
            <td class="net-muted">${netEscape(r.comment)}</td>
            <td class="actions"><button class="btn btn-sm btn-outline-danger" data-fw-delete="${i}" title="Delete rule"><i class="fas fa-trash"></i></button></td>
        </tr>`).join('');

    box.innerHTML = `
        <div class="net-fw-head">
            <label class="net-toggle">
                <input type="checkbox" id="net-fw-enabled" ${d.active ? 'checked' : ''}>
                <span class="net-toggle-track"></span>
                <span>Firewall ${d.active ? 'on' : 'off'}</span>
            </label>
            <span class="net-badge info">${netEscape(d.backend)}</span>
            ${d.zone ? `<span class="net-muted">zone: ${netEscape(d.zone)}</span>` : ''}
            ${isUfw ? `<div class="net-fw-policies">${policySelect('incoming', d.policy_in)}${policySelect('outgoing', d.policy_out)}</div>` : ''}
            <button class="btn btn-sm btn-outline-light" id="net-fw-refresh" title="Reload"><i class="fas fa-sync-alt"></i></button>
        </div>
        ${!d.active ? `<div class="net-note warn">The firewall is off - all ports are open. ${isUfw ? 'Rules below are kept and apply once it is turned on.' : ''}</div>` : ''}
        ${d.error ? `<div class="net-note bad">${netEscape(d.error)}</div>` : ''}

        <div class="net-subtitle">Add rule</div>
        <form class="net-fw-form" id="net-fw-form" autocomplete="off">
            <div><label for="net-fw-action">Action</label>
                <select class="form-control form-control-sm" id="net-fw-action">
                    <option value="allow">allow</option><option value="deny">deny</option><option value="reject">reject</option>
                    ${isUfw ? '<option value="limit" title="Allow, but block an address after 6 connections in 30 s">limit</option>' : ''}
                </select></div>
            <div><label for="net-fw-port">Port / range</label>
                <input class="form-control form-control-sm" id="net-fw-port" placeholder="e.g. 123 or 6000:6010"></div>
            <div><label for="net-fw-proto">Protocol</label>
                <select class="form-control form-control-sm" id="net-fw-proto">
                    <option value="tcp">TCP</option><option value="udp">UDP</option><option value="any">both</option>
                </select></div>
            <div><label for="net-fw-source">From</label>
                <input class="form-control form-control-sm" id="net-fw-source" placeholder="anywhere, or 192.168.0.0/24"></div>
            <div><label for="net-fw-comment">Comment</label>
                <input class="form-control form-control-sm" id="net-fw-comment" maxlength="60" ${isUfw ? '' : 'disabled placeholder="ufw only"'}></div>
            <button class="btn btn-sm btn-primary" type="submit"><i class="fas fa-plus"></i> Add</button>
        </form>
        <div class="net-fw-presets">
            <span class="net-muted">Quick fill:</span>
            ${(d.presets || []).map(([label, port, proto]) =>
                `<button class="btn btn-sm btn-outline-info" data-fw-preset="${netEscape(port)}|${proto}|${netEscape(label)}">${netEscape(label)}</button>`).join('')}
        </div>

        <div class="net-subtitle">Rules <span class="net-count">${rules.length}</span></div>
        ${rules.length
            ? `<div class="net-table-wrap"><table class="net-table">
                <thead><tr><th>Action</th><th>Port</th><th>Protocol</th><th>From</th><th>Comment</th><th></th></tr></thead>
                <tbody>${rows}</tbody></table></div>`
            : '<div class="net-empty">No rules yet.</div>'}
        <div class="net-muted net-hint">Turning the firewall on or tightening it is rolled back automatically after 30 s unless you confirm - so you cannot lock yourself out of this page.</div>`;

    document.getElementById('net-fw-refresh').onclick = loadNetFirewall;
    document.getElementById('net-fw-enabled').onchange = e => toggleNetFirewall(e.target.checked);
    box.querySelectorAll('[data-fw-policy]').forEach(sel => {
        sel.onchange = () => setNetFirewallPolicy(sel.dataset.fwPolicy, sel.value);
    });
    box.querySelectorAll('[data-fw-preset]').forEach(btn => {
        btn.onclick = () => {
            const [port, proto, label] = btn.dataset.fwPreset.split('|');
            document.getElementById('net-fw-action').value = 'allow';
            document.getElementById('net-fw-port').value = port;
            document.getElementById('net-fw-proto').value = proto;
            if (isUfw) document.getElementById('net-fw-comment').value = label;
            document.getElementById('net-fw-source').focus();
        };
    });
    box.querySelectorAll('[data-fw-delete]').forEach(btn => {
        btn.onclick = () => deleteNetFirewallRule(rules[+btn.dataset.fwDelete]);
    });
    document.getElementById('net-fw-form').onsubmit = e => {
        e.preventDefault();
        addNetFirewallRule();
    };
}

function toggleNetFirewall(enabled) {
    const d = fwData;
    if (!enabled) {
        netConfirm('Turn the firewall off?', 'All ports will be reachable from the network.', async () => {
            await netCall('/api/network/firewall/enable', { enabled: false }, { done: 'Firewall off' });
            loadNetFirewall();
        }, 'Turn off');
        renderNetFirewall();  // reset the switch until confirmed
        return;
    }
    const msg = d.backend === 'ufw'
        ? `Incoming connections not allowed by a rule will be ${d.policy_in === 'allow' ? 'accepted (incoming policy is "allow")' : 'blocked'}. ` +
          `Rules for ServiceCockpit (TCP ${d.cockpit_port}) and SSH (TCP 22) are added first if missing. ` +
          'If this page loses its connection, the firewall turns itself off again after 30 s.'
        : `firewalld will be started with its default zone; TCP ${d.cockpit_port} is opened for ServiceCockpit. ` +
          'If this page loses its connection, it is stopped again after 30 s.';
    netConfirm('Turn the firewall on?', msg, async () => {
        await netCall('/api/network/firewall/enable', { enabled: true }, { busy: 'Turning the firewall on…', done: 'Firewall on' });
        loadNetFirewall();
    }, 'Turn on', false);
    renderNetFirewall();
}

async function setNetFirewallPolicy(direction, policy) {
    await netCall('/api/network/firewall/policy', { direction, policy }, { done: `Default ${direction} policy: ${policy}` });
    loadNetFirewall();
}

async function addNetFirewallRule() {
    const body = {
        action: document.getElementById('net-fw-action').value,
        port: document.getElementById('net-fw-port').value.trim(),
        proto: document.getElementById('net-fw-proto').value,
        source: document.getElementById('net-fw-source').value.trim() || 'any',
        comment: document.getElementById('net-fw-comment').value.trim(),
    };
    const data = await netCall('/api/network/firewall/rules', body, { busy: '', done: 'Rule added' });
    if (data) loadNetFirewall();
}

function deleteNetFirewallRule(rule) {
    if (!rule) return;
    const risky = fwData.active && rule.action !== 'deny' && rule.action !== 'reject'
        && (rule.port === String(fwData.cockpit_port) || rule.port === '22');
    netConfirm('Delete rule?',
        `${rule.text}${risky ? '\n\nThis rule may be what lets you reach this page or SSH. If the page stops responding, the rule is restored after 30 s.' : ''}`,
        async () => {
            await netCall('/api/network/firewall/rules/delete', { id: rule.id }, { busy: '', done: 'Rule deleted' });
            loadNetFirewall();
        }, 'Delete');
}
