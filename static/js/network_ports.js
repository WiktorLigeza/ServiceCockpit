// Network page: "Ports" tab - sockets in use and the processes that own them.
// Backend: GET /api/network/ports (cockpit/core/sockets.py). PIDs link to the Processes page.
// Uses netApi / netEscape from network.js.

let portsData = [];
let portsPrivileged = true;
let portsView = 'listening';
let portsProto = 'all';
let portsSearch = '';
let portsTimer = null;

const WELL_KNOWN_PORTS = {
    20: 'FTP data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 68: 'DHCP client',
    69: 'TFTP', 80: 'HTTP', 110: 'POP3', 111: 'RPC', 123: 'NTP', 137: 'NetBIOS', 138: 'NetBIOS', 139: 'SMB',
    143: 'IMAP', 161: 'SNMP', 323: 'chrony', 443: 'HTTPS', 445: 'SMB', 502: 'Modbus', 546: 'DHCPv6',
    547: 'DHCPv6', 554: 'RTSP', 631: 'CUPS', 853: 'DNS over TLS', 1883: 'MQTT', 1900: 'SSDP', 2049: 'NFS',
    2137: 'Cockpit', 3306: 'MySQL', 3389: 'RDP', 4840: 'OPC UA', 5000: 'HTTP alt', 5353: 'mDNS',
    5355: 'LLMNR', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 8080: 'HTTP alt', 8123: 'Home Assistant',
    8443: 'HTTPS alt', 8883: 'MQTT/TLS', 9090: 'Prometheus', 9100: 'Printer', 27017: 'MongoDB', 41641: 'Tailscale',
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('net-ports-chips').addEventListener('click', e => {
        const chip = e.target.closest('[data-ports-view]');
        if (!chip) return;
        portsView = chip.dataset.portsView;
        document.querySelectorAll('#net-ports-chips .net-chip').forEach(c => c.classList.toggle('active', c === chip));
        renderNetPorts();
    });
    document.getElementById('net-ports-proto').addEventListener('click', e => {
        const chip = e.target.closest('[data-ports-proto]');
        if (!chip) return;
        portsProto = chip.dataset.portsProto;
        document.querySelectorAll('#net-ports-proto .net-chip').forEach(c => c.classList.toggle('active', c === chip));
        renderNetPorts();
    });
    document.getElementById('net-ports-search').addEventListener('input', e => {
        portsSearch = e.target.value.trim().toLowerCase();
        renderNetPorts();
    });
});

async function loadNetPorts() {
    clearTimeout(portsTimer);
    const { ok, data } = await netApi('/api/network/ports');
    if (ok) {
        portsData = data.sockets || [];
        portsPrivileged = !!data.privileged;
        renderNetPorts();
    } else if (!portsData.length) {
        document.getElementById('net-ports').innerHTML = `<div class="net-empty">${netEscape(data.error || 'Could not read sockets')}</div>`;
    }
    // Refresh while the tab is open (the server caches for a few seconds).
    if (netActiveTab === 'ports' && !document.hidden) portsTimer = setTimeout(loadNetPorts, 5000);
}

function stopNetPorts() {
    clearTimeout(portsTimer);
}

function formatAddr(addr, iface) {
    if (addr === '0.0.0.0' || addr === '*') return 'all IPv4';
    if (addr === '::') return 'all IPv6';
    if (addr === '127.0.0.1' || addr === '::1') return `${addr} (local only)`;
    return iface ? `${addr}%${iface}` : addr;
}

function portLabel(port) {
    const name = WELL_KNOWN_PORTS[port];
    return name ? `<span class="net-muted"> ${netEscape(name)}</span>` : '';
}

function processesHtml(procs) {
    if (!procs.length) {
        return `<span class="net-muted" title="${portsPrivileged ? 'Kernel socket or process already gone' : 'Owned by another user'}">—</span>`;
    }
    return procs.map(p => `<div class="net-ports-proc">${netEscape(p.name)}
        <a class="net-pid-link" href="/processes?pid=${p.pid}" title="Show process ${p.pid} on the Processes page">${p.pid}</a></div>`).join('');
}

// In the "Listening" view, merge sockets that differ only by address (0.0.0.0 + :: etc).
function groupListening(sockets) {
    const groups = new Map();
    for (const s of sockets) {
        const key = `${s.proto}|${s.local_port}|${s.processes.map(p => p.pid).join(',')}`;
        const g = groups.get(key) || { ...s, addrs: [] };
        const addr = formatAddr(s.local_addr, s.iface);
        if (!g.addrs.includes(addr)) g.addrs.push(addr);
        groups.set(key, g);
    }
    return [...groups.values()];
}

function renderNetPorts() {
    document.getElementById('net-ports-unprivileged').hidden = portsPrivileged;
    let rows = portsData.filter(s =>
        (portsView === 'all' || (portsView === 'listening' ? s.listening : !s.listening))
        && (portsProto === 'all' || s.proto === portsProto));
    if (portsSearch) {
        rows = rows.filter(s => [s.local_addr, s.local_port, s.peer_addr, s.peer_port, s.state, s.proto,
            WELL_KNOWN_PORTS[s.local_port], ...s.processes.flatMap(p => [p.name, p.pid])]
            .some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(portsSearch)));
    }

    const box = document.getElementById('net-ports');
    const listening = portsView === 'listening';
    if (listening) rows = groupListening(rows);
    rows.sort((a, b) => (a.local_port ?? 0) - (b.local_port ?? 0) || a.proto.localeCompare(b.proto));

    document.getElementById('net-ports-summary').textContent =
        `${rows.length} ${listening ? 'listening ports' : 'sockets'} shown · ${portsData.filter(s => s.listening).length} listening, ` +
        `${portsData.filter(s => !s.listening).length} connections in total`;

    if (!rows.length) {
        box.innerHTML = '<div class="net-empty">Nothing matches.</div>';
        return;
    }
    const head = listening
        ? '<tr><th>Proto</th><th>Port</th><th>Listening on</th><th>Process / PID</th></tr>'
        : '<tr><th>Proto</th><th>Local</th><th>Remote</th><th>State</th><th>Process / PID</th></tr>';
    const body = rows.map(s => listening
        ? `<tr>
            <td>${s.proto.toUpperCase()}</td>
            <td class="num">${s.local_port ?? '?'}${portLabel(s.local_port)}</td>
            <td>${s.addrs.map(netEscape).join(', ')}</td>
            <td>${processesHtml(s.processes)}</td>
        </tr>`
        : `<tr>
            <td>${s.proto.toUpperCase()}</td>
            <td class="num">${netEscape(formatAddr(s.local_addr, s.iface))}:${s.local_port ?? '?'}${portLabel(s.local_port)}</td>
            <td class="num">${s.peer_port === null ? '<span class="net-muted">—</span>' : `${netEscape(s.peer_addr)}:${s.peer_port}${portLabel(s.peer_port)}`}</td>
            <td>${netEscape(s.state)}</td>
            <td>${processesHtml(s.processes)}</td>
        </tr>`).join('');
    box.innerHTML = `<div class="net-table-wrap"><table class="net-table net-ports-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
