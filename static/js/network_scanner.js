// Network page: LAN scanner popup (backend: cockpit/features/network/scanner.py).
// Uses netApi / netEscape / netToast from network.js.

let scanDevices = [];
let scanPings = {};          // ip -> last ping result
let scanSort = { key: 'ip', desc: false };
let scanFilter = '';
let scanTimer = null;
let scanRunning = false;

const scanEl = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
    scanEl('net-scan-open').addEventListener('click', openScanner);
    scanEl('net-scan-close').addEventListener('click', closeScanner);
    scanEl('net-scan-modal').addEventListener('click', e => {
        if (e.target.id === 'net-scan-modal') closeScanner();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !scanEl('net-scan-modal').hidden) closeScanner();
    });
    scanEl('net-scan-subnet').addEventListener('change', e => {
        scanEl('net-scan-custom').hidden = e.target.value !== 'custom';
        if (e.target.value === 'custom') scanEl('net-scan-custom').focus();
    });
    scanEl('net-scan-custom').addEventListener('keydown', e => { if (e.key === 'Enter') startScan(); });
    scanEl('net-scan-start').addEventListener('click', () => (scanRunning ? cancelScan() : startScan()));
    scanEl('net-scan-pingall').addEventListener('click', pingAll);
    scanEl('net-scan-search').addEventListener('input', e => {
        scanFilter = e.target.value.trim().toLowerCase();
        renderScanRows();
    });
    document.querySelectorAll('.net-scan-table th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            scanSort = { key, desc: scanSort.key === key ? !scanSort.desc : false };
            renderScanRows();
        });
    });
    scanEl('net-scan-rows').addEventListener('click', e => {
        const copy = e.target.closest('[data-copy]');
        if (copy) return scanCopy(copy.dataset.copy);
        const btn = e.target.closest('[data-ping]');
        if (btn) pingOne(btn.dataset.ping, btn);
    });
});

// ---------------------------------------------------------------- open / state

async function openScanner() {
    scanEl('net-scan-modal').hidden = false;
    const res = await netApi('/api/network/scan');
    if (!res.ok && res.status !== 200) {
        netToast(res.data.error || 'Could not read the scanner state.', 'error');
        return;
    }
    fillSubnets(res.data.subnets || [], res.data.scan || {});
    applyScanState(res.data.scan || {});
}

function closeScanner() {
    scanEl('net-scan-modal').hidden = true;
    // A running scan keeps going on the server; reopening picks it up again.
    clearTimeout(scanTimer);
}

function fillSubnets(subnets, state) {
    const select = scanEl('net-scan-subnet');
    const previous = select.value;
    select.innerHTML = subnets.map(s =>
        `<option value="${netEscape(s.cidr)}">${netEscape(s.cidr)} · ${netEscape(s.iface)} (${s.hosts} addresses)</option>`
    ).join('') + '<option value="custom">Custom subnet…</option>';
    const wanted = state.cidr || previous;
    if (wanted && [...select.options].some(o => o.value === wanted)) {
        select.value = wanted;
    } else if (wanted && wanted !== 'custom') {
        select.value = 'custom';
        scanEl('net-scan-custom').value = wanted;
    }
    scanEl('net-scan-custom').hidden = select.value !== 'custom';
}

function applyScanState(state) {
    scanRunning = !!state.running;
    scanDevices = state.devices || [];

    const btn = scanEl('net-scan-start');
    btn.className = `btn btn-sm ${scanRunning ? 'btn-outline-warning' : 'btn-primary'}`;
    btn.innerHTML = scanRunning ? '<i class="fas fa-stop"></i> Stop' : '<i class="fas fa-search"></i> Scan';
    scanEl('net-scan-pingall').disabled = scanRunning || !scanDevices.length;

    const progress = scanEl('net-scan-progress');
    progress.hidden = !scanRunning;
    if (scanRunning) {
        const pct = state.total ? Math.round(100 * state.done / state.total) : 0;
        scanEl('net-scan-bar-fill').style.width = `${pct}%`;
        scanEl('net-scan-phase').textContent = `${state.phase || 'Scanning'}… ${state.done}/${state.total}`;
    }

    const summary = scanEl('net-scan-summary');
    if (state.error && state.error !== 'Cancelled') {
        summary.innerHTML = `<span class="net-bad-text">${netEscape(state.error)}</span>`;
    } else if (state.finished && state.cidr) {
        const secs = Math.round(state.finished - state.started);
        const arpOnly = scanDevices.filter(d => !d.responds_to_ping).length;
        summary.textContent = `${scanDevices.length} devices on ${state.cidr} · scanned in ${secs}s` +
            (state.error === 'Cancelled' ? ' (stopped early)' : '') +
            (arpOnly ? ` · ${arpOnly} did not answer ping (seen in the ARP table; some may have left)` : '') +
            (state.vendors ? '' : ' · vendor list unavailable (no internet?)');
    } else if (scanRunning) {
        summary.textContent = `Scanning ${state.cidr}…`;
    } else {
        summary.textContent = '';
    }

    renderScanRows();
    clearTimeout(scanTimer);
    if (scanRunning && !scanEl('net-scan-modal').hidden) {
        scanTimer = setTimeout(pollScan, 700);
    }
}

async function pollScan() {
    const res = await netApi('/api/network/scan');
    if (res.status === 200) applyScanState(res.data.scan || {});
}

// ---------------------------------------------------------------- actions

async function startScan() {
    let cidr = scanEl('net-scan-subnet').value;
    if (cidr === 'custom') cidr = scanEl('net-scan-custom').value.trim();
    if (!cidr) {
        netToast('Enter a subnet like 192.168.1.0/24.', 'error');
        return;
    }
    scanPings = {};
    const res = await netApi('/api/network/scan', { cidr });
    if (!res.ok) {
        netToast(res.data.error || 'Could not start the scan.', 'error', 6000);
        return;
    }
    pollScan();
}

async function cancelScan() {
    await netApi('/api/network/scan/cancel', {});
    pollScan();
}

async function pingOne(ip, btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
    const res = await netApi('/api/network/scan/ping', { ips: [ip], count: 4 });
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-satellite-dish"></i>';
    if (!res.ok) {
        netToast(res.data.error || 'Ping failed.', 'error');
        return;
    }
    const r = res.data.results[0];
    scanPings[ip] = r;
    renderScanRows();
    netToast(r.alive
        ? `${ip}: ${r.received}/${r.sent} replies, avg ${r.avg} ms (min ${r.min}, max ${r.max})`
        : `${ip}: no reply (${r.sent} sent)`, r.alive ? 'success' : 'error', 5000);
}

async function pingAll() {
    const btn = scanEl('net-scan-pingall');
    const ips = visibleDevices().map(d => d.ip);
    if (!ips.length) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Pinging…';
    ips.forEach(ip => { scanPings[ip] = { pending: true }; });
    renderScanRows();
    const res = await netApi('/api/network/scan/ping', { ips, count: 3 });
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Ping all';
    if (!res.ok) {
        ips.forEach(ip => delete scanPings[ip]);
        netToast(res.data.error || 'Ping failed.', 'error');
    } else {
        res.data.results.forEach(r => { scanPings[r.ip] = r; });
        const up = res.data.results.filter(r => r.alive).length;
        netToast(`${up} of ${ips.length} devices answered.`, 'success');
    }
    renderScanRows();
}

async function scanCopy(text) {
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
        netToast(`Copied ${text}`, 'success', 1500);
    } catch (_) {
        netToast('Could not copy', 'error');
    }
}

// ---------------------------------------------------------------- table

function ipNumber(ip) {
    return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function pingValue(d) {
    const p = scanPings[d.ip];
    if (p && !p.pending) return p.alive ? p.avg : Infinity;
    return d.ping ?? Infinity;
}

function visibleDevices() {
    const rows = scanDevices.filter(d => !scanFilter || [d.ip, d.name, d.mac, d.vendor, ...(d.ports || []).map(p => p.service)]
        .some(v => v && String(v).toLowerCase().includes(scanFilter)));
    const key = scanSort.key;
    const value = d => key === 'ip' ? ipNumber(d.ip)
        : key === 'ping' ? pingValue(d)
        : (d[key] || '￿').toLowerCase();
    rows.sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * (scanSort.desc ? -1 : 1));
    return rows;
}

function serviceBadge(d, p) {
    const web = { 80: 'http', 8080: 'http', 2137: 'http', 8123: 'http', 443: 'https' }[p.port];
    const label = netEscape(p.service);
    if (web) {
        const url = `${web}://${d.ip}${[80, 443].includes(p.port) ? '' : ':' + p.port}`;
        return `<a class="net-badge info" href="${url}" target="_blank" rel="noopener" title="Open ${url}">${label}</a>`;
    }
    return `<span class="net-badge" title="TCP ${p.port}">${label}</span>`;
}

function pingCell(d) {
    const p = scanPings[d.ip];
    if (p?.pending) return '<i class="fas fa-circle-notch fa-spin"></i>';
    if (p) {
        return p.alive
            ? `<span class="net-yes">${p.avg} ms</span>${p.loss ? ` <span class="net-warn-text">${p.loss}% loss</span>` : ''}`
            : '<span class="net-bad-text">no reply</span>';
    }
    if (d.ping !== null && d.ping !== undefined) return `${d.ping} ms`;
    return d.is_self ? '—' : '<span class="net-muted" title="Did not answer ping during the scan">—</span>';
}

function renderScanRows() {
    document.querySelectorAll('.net-scan-table th[data-sort]').forEach(th => {
        th.classList.toggle('sorted', th.dataset.sort === scanSort.key);
        th.classList.toggle('desc', th.dataset.sort === scanSort.key && scanSort.desc);
    });
    const tbody = scanEl('net-scan-rows');
    const rows = visibleDevices();
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="net-empty">${scanRunning ? 'Searching…'
            : scanDevices.length ? 'No devices match the filter.' : 'Pick a subnet and press Scan.'}</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(d => {
        const p = scanPings[d.ip];
        const down = p && !p.pending && !p.alive;
        const dot = down ? 'down' : d.responds_to_ping || (p && p.alive) ? '' : 'arp';
        const dotTitle = down ? 'No reply to the last ping' : dot === 'arp' ? 'No ping reply - seen in the ARP table' : 'Answers ping';
        const tags = [
            d.is_self ? '<span class="net-badge purple">this device</span>' : '',
            d.is_gateway ? '<span class="net-badge ok">gateway</span>' : '',
        ].join(' ');
        return `<tr>
            <td class="nowrap"><span class="net-scan-dot ${dot}" title="${dotTitle}"></span><code class="net-scan-copy" data-copy="${netEscape(d.ip)}" title="Copy">${netEscape(d.ip)}</code></td>
            <td>${d.name ? `${netEscape(d.name)}<span class="net-scan-name-src">${netEscape(d.name_source || '')}</span>` : '<span class="net-muted">—</span>'} ${tags}</td>
            <td class="nowrap">${d.mac ? `<code class="net-scan-copy" data-copy="${netEscape(d.mac)}" title="Copy">${netEscape(d.mac)}</code>` : '<span class="net-muted">—</span>'}</td>
            <td>${netEscape(d.vendor || '') || '<span class="net-muted">—</span>'}</td>
            <td><div class="net-scan-services">${(d.ports || []).map(port => serviceBadge(d, port)).join('')}</div></td>
            <td class="net-scan-ping">${pingCell(d)}</td>
            <td class="actions"><button class="btn btn-sm btn-outline-light" data-ping="${netEscape(d.ip)}" title="Ping 4 times"><i class="fas fa-satellite-dish"></i></button></td>
        </tr>`;
    }).join('');
}
