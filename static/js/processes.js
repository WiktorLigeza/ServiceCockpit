let processFavorites = new Set();
let lastProcessesData = [];
let selectedPid = null;

const uiState = {
    all: {
        status: 'both',
        sortKey: 'cpu',
        sortDir: 'desc'
    },
    favorites: {
        status: 'both',
        sortKey: 'cpu',
        sortDir: 'desc'
    }
};

// Chart instances
let cpuChart = null;
let memoryChart = null;
let threadsChart = null;
let networkConnChart = null;
let networkTrafficChart = null;

// Data arrays for charts
const cpuData = [];
const memoryData = [];
const threadsData = [];
const networkConnData = [];
const networkTrafficData = [];
const timestamps = [];

// Max/min values
let cpuMax = 0;
let cpuMin = Number.MAX_VALUE;
let memoryMax = 0;
let memoryMin = Number.MAX_VALUE;
let threadsMax = 0;
let threadsMin = Number.MAX_VALUE;
let networkConnMax = 0;
let networkConnMin = Number.MAX_VALUE;
let networkTrafficMax = 0;
let networkTrafficMin = Number.MAX_VALUE;

const MAX_DATA_POINTS = 60;
const MONITOR_INTERVAL = 1000;
let monitoringInterval = null;
let currentPid = null;

function fmtMB(bytes) {
    if (!Number.isFinite(bytes)) return '0.0';
    return (bytes / (1024 * 1024)).toFixed(1);
}

function escapeHtml(str) {
    return (str ?? '').toString()
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function normalizeStatus(status) {
    return (status || '').toString().toLowerCase();
}

function statusGroup(status) {
    const s = normalizeStatus(status);
    if (s === 'running') return 'running';
    // psutil can report: sleeping, disk-sleep
    if (s === 'sleeping' || s === 'disk-sleep') return 'sleeping';
    return 'idle';
}

function statusDotClass(status) {
    const group = statusGroup(status);
    if (group === 'running') return 'active';
    if (group === 'sleeping') return 'sleeping';
    return 'inactive';
}

function sortValue(proc, key) {
    if (key === 'cpu') return Number(proc.cpu_percent) || 0;
    if (key === 'mem') return Number(proc.memory_rss) || 0;
    if (key === 'net') return Number(proc.network_connections) || 0;
    return 0;
}

async function loadProcessFavorites() {
    try {
        const response = await fetch('/api/process_favorites');
        const data = await response.json();
        processFavorites = new Set(data.favorites || []);
    } catch (error) {
        console.error('Error loading process favorites:', error);
        processFavorites = new Set();
    }
}

async function saveProcessFavorites() {
    try {
        await fetch('/api/process_favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: Array.from(processFavorites) })
        });
    } catch (error) {
        console.error('Error saving process favorites:', error);
    }
}

async function toggleProcessFavorite(event, processName) {
    event.stopPropagation();
    if (processFavorites.has(processName)) {
        processFavorites.delete(processName);
    } else {
        processFavorites.add(processName);
    }
    await saveProcessFavorites();
    renderProcesses(lastProcessesData);
}

function createProcessCard(proc, container = 'all') {
    const name = proc.name || 'unknown';
    const pid = proc.pid;
    const isFavorite = processFavorites.has(name);
    const statusText = normalizeStatus(proc.status || '');
    const dotClass = statusDotClass(statusText);

    if (container === 'favorites' && !isFavorite) return '';

    const selectedClass = pid === selectedPid ? 'selected-service' : '';

    return `
        <div class="service-card ${selectedClass}" data-pid="${pid}" data-name="${escapeHtml(name)}">
            <div class="card">
                <button class="star-btn" onclick='toggleProcessFavorite(event, ${JSON.stringify(name)})' title="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                    <i class="${isFavorite ? 'fas' : 'far'} fa-star"></i>
                </button>
                <div class="card-body" onclick="selectProcess(${pid})">
                    <h5 class="card-title">
                        <span class="status-dot ${dotClass}" title="${escapeHtml(statusText || 'unknown')}"></span>
                        ${escapeHtml(name)} <span style="opacity: 0.8; font-size: 0.9rem;">(PID: ${pid})</span>
                    </h5>
                    <div class="btn-group w-100" role="group" aria-label="Process actions">
                        <button class="btn btn-sm btn-info" onclick="showProcessInfo(event, ${pid})" title="Process Info">
                            <i class="fas fa-info"></i>
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="killProcess(event, ${pid})" title="Kill process">
                            <i class="fas fa-skull-crossbones"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function _setInfocardText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value ?? '';
}

function _formatCmdlineForInfo(cmdline) {
    if (!cmdline) return '';
    if (Array.isArray(cmdline)) return cmdline.filter(Boolean).join(' ');
    return cmdline.toString();
}

function hideInfocard() {
    const infocard = document.getElementById('infocard');
    if (!infocard) return;
    infocard.classList.add('hidden');
}

function showInfocard() {
    const infocard = document.getElementById('infocard');
    if (!infocard) return;
    infocard.classList.remove('hidden');

    // If never positioned, place it near center.
    if (!infocard.dataset.positioned) {
        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 800;
        const rect = infocard.getBoundingClientRect();
        const left = Math.max(20, Math.round((vw - rect.width) / 2));
        const top = Math.max(80, Math.round((vh - rect.height) / 4));
        infocard.style.left = `${left}px`;
        infocard.style.top = `${top}px`;
        infocard.dataset.positioned = '1';
    }
}

async function showProcessInfo(event, pid) {
    event?.stopPropagation?.();

    const title = document.getElementById('infocard-title');
    if (title) title.textContent = 'Process Info';

    const serviceSection = document.getElementById('service-info-section');
    const processSection = document.getElementById('process-info-section');
    if (serviceSection) serviceSection.style.display = 'none';
    if (processSection) processSection.style.display = 'flex';

    // Clear placeholders quickly
    _setInfocardText('proc-info-name', 'Loading...');
    _setInfocardText('proc-info-pid', String(pid));
    _setInfocardText('proc-info-ppid', '');
    _setInfocardText('proc-info-user', '');
    _setInfocardText('proc-info-status', '');
    _setInfocardText('proc-info-exe', '');
    _setInfocardText('proc-info-cwd', '');
    _setInfocardText('proc-info-cmdline', '');
    _setInfocardText('proc-info-cpu', '');
    _setInfocardText('proc-info-mem', '');
    _setInfocardText('proc-info-threads', '');
    _setInfocardText('proc-info-started', '');
    _setInfocardText('proc-info-connections', '');

    showInfocard();

    try {
        const resp = await fetch(`/api/process_info/${pid}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            _setInfocardText('proc-info-name', 'Failed to load');
            return;
        }

        _setInfocardText('proc-info-name', data.name || 'unknown');
        _setInfocardText('proc-info-pid', data.pid ?? pid);
        _setInfocardText('proc-info-ppid', data.ppid ?? 'N/A');
        _setInfocardText('proc-info-user', data.username || 'N/A');
        _setInfocardText('proc-info-status', data.status || 'N/A');
        _setInfocardText('proc-info-exe', data.exe || 'N/A');
        _setInfocardText('proc-info-cwd', data.cwd || 'N/A');
        _setInfocardText('proc-info-cmdline', _formatCmdlineForInfo(data.cmdline) || 'N/A');
        _setInfocardText('proc-info-cpu', Number(data.cpu_percent ?? 0).toFixed(1));
        _setInfocardText('proc-info-mem', `${fmtMB(data.memory_rss || 0)} MB`);
        _setInfocardText('proc-info-threads', data.threads ?? 'N/A');
        _setInfocardText('proc-info-started', _formatStarted(data.create_time));
        _setInfocardText('proc-info-connections', data.network_connections ?? 'N/A');
    } catch (e) {
        console.error('Failed to load process info:', e);
        _setInfocardText('proc-info-name', 'Failed to load');
    }
}

function initInfocardBehavior() {
    const infocard = document.getElementById('infocard');
    if (!infocard) return;

    const closeBtn = infocard.querySelector('.btn-close');
    closeBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        hideInfocard();
    });

    const header = infocard.querySelector('.infocard-header');
    if (!header) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMove = (clientX, clientY) => {
        if (!dragging) return;
        infocard.style.left = `${Math.max(0, clientX - offsetX)}px`;
        infocard.style.top = `${Math.max(0, clientY - offsetY)}px`;
        infocard.dataset.positioned = '1';
    };

    header.addEventListener('mousedown', (e) => {
        // Only left click
        if (e.button !== 0) return;
        dragging = true;
        const rect = infocard.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    });

    const onMouseMove = (e) => onMove(e.clientX, e.clientY);
    const onMouseUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };
}

function _bytesToHuman(bytes) {
    const b = Number(bytes) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = b;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(2)} ${units[i]}`;
}

function _formatStarted(ts) {
    if (!ts) return 'N/A';
    const d = new Date(ts * 1000);
    if (Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString();
}

function _setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value ?? '-';
}

function _setStatusDot(status) {
    const dot = document.getElementById('process-meta-status-dot');
    if (!dot) return;
    dot.classList.remove('active', 'sleeping', 'inactive');
    dot.classList.add(statusDotClass(status));
    dot.title = (status || 'unknown').toString();
}

function _formatCmdline(cmdline) {
    if (!cmdline) return '-';
    if (Array.isArray(cmdline)) return cmdline.filter(Boolean).join(' ') || '-';
    return cmdline.toString();
}

function updateProcessMeta(proc, opts = {}) {
    if (!proc) return;
    _setStatusDot(proc.status);
    _setText('process-meta-name', proc.name || 'unknown');
    _setText('process-meta-pid', proc.pid ?? '-');
    _setText('process-meta-user', proc.username || 'N/A');
    _setText('process-meta-status', proc.status || 'N/A');
    _setText('process-meta-exe', proc.exe || 'N/A');
    _setText('process-meta-cwd', proc.cwd || 'N/A');
    _setText('process-meta-cmdline', _formatCmdline(proc.cmdline));

    if (opts.started !== undefined) _setText('process-meta-started', opts.started);
    if (opts.threads !== undefined) _setText('process-meta-threads', opts.threads);
    if (opts.conns !== undefined) _setText('process-meta-conns', opts.conns);
}

async function hydrateProcessMetaFromInfo(pid) {
    try {
        const resp = await fetch(`/api/process_info/${pid}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) return;

        _setText('process-meta-started', _formatStarted(data.create_time));
        if (data.cwd) _setText('process-meta-cwd', data.cwd);
        if (data.exe) _setText('process-meta-exe', data.exe);
        if (data.cmdline) _setText('process-meta-cmdline', _formatCmdline(data.cmdline));
    } catch (e) {
        console.error('Failed to hydrate process meta:', e);
    }
}

function applyFiltersAndSort(items, searchValue, statusFilterValue, sortKey, sortDir) {
    const q = (searchValue || '').trim().toLowerCase();
    const statusFilter = (statusFilterValue || 'both').toLowerCase();

    const direction = (sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const filtered = items.filter(p => {
        if (statusFilter !== 'both') {
            const group = statusGroup(p.status);
            if (group !== statusFilter) return false;
        }

        if (!q) return true;
        const name = (p.name || '').toLowerCase();
        const username = (p.username || '').toLowerCase();
        const pid = String(p.pid || '');
        const exe = (p.exe || '').toLowerCase();
        const cwd = (p.cwd || '').toLowerCase();
        const cmdline = Array.isArray(p.cmdline)
            ? p.cmdline.join(' ').toLowerCase()
            : (p.cmdline || '').toString().toLowerCase();
        return (
            name.includes(q) ||
            username.includes(q) ||
            pid.includes(q) ||
            exe.includes(q) ||
            cwd.includes(q) ||
            cmdline.includes(q)
        );
    });

    const key = (sortKey || 'cpu').toLowerCase();
    filtered.sort((a, b) => {
        const av = sortValue(a, key);
        const bv = sortValue(b, key);
        if (av !== bv) return (av < bv ? -1 : 1) * direction;
        // tie-breaker: name then pid for stability
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return (a.pid || 0) - (b.pid || 0);
    });
    return filtered;
}

function setActiveControls(scope) {
    const state = uiState[scope];
    if (!state) return;

    // Status buttons
    document.querySelectorAll(`.filter-btn[data-scope="${scope}"][data-status]`).forEach(btn => {
        const isActive = (btn.getAttribute('data-status') || 'both') === state.status;
        btn.classList.toggle('active', isActive);
    });

    // Sort buttons + arrow direction
    document.querySelectorAll(`.filter-btn[data-scope="${scope}"][data-sort]`).forEach(btn => {
        const sort = btn.getAttribute('data-sort');
        const isActive = sort === state.sortKey;
        btn.classList.toggle('active', isActive);

        const arrow = btn.querySelector('[data-sort-dir]');
        if (!arrow) return;
        if (!isActive) {
            arrow.style.display = 'none';
            return;
        }
        arrow.style.display = 'inline-block';
        arrow.classList.remove('fa-arrow-up', 'fa-arrow-down');
        arrow.classList.add(state.sortDir === 'asc' ? 'fa-arrow-up' : 'fa-arrow-down');
    });
}

function wireControls() {
    document.querySelectorAll('.filter-btn[data-scope][data-status]').forEach(btn => {
        btn.addEventListener('click', () => {
            const scope = btn.getAttribute('data-scope');
            const status = btn.getAttribute('data-status') || 'both';
            if (!uiState[scope]) return;
            uiState[scope].status = status;
            setActiveControls(scope);
            renderProcesses(lastProcessesData);
        });
    });

    document.querySelectorAll('.filter-btn[data-scope][data-sort]').forEach(btn => {
        btn.addEventListener('click', () => {
            const scope = btn.getAttribute('data-scope');
            const sortKey = btn.getAttribute('data-sort') || 'cpu';
            if (!uiState[scope]) return;

            if (uiState[scope].sortKey === sortKey) {
                uiState[scope].sortDir = uiState[scope].sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                uiState[scope].sortKey = sortKey;
                uiState[scope].sortDir = 'desc';
            }

            setActiveControls(scope);
            renderProcesses(lastProcessesData);
        });
    });
}

function renderProcesses(processes) {
    const allContainer = document.getElementById('processes-container');
    const favContainer = document.getElementById('processes-favorites-container');
    const allSearch = document.getElementById('processesSearchInput');
    const favSearch = document.getElementById('processFavoritesSearchInput');

    const filteredAll = applyFiltersAndSort(
        processes,
        allSearch?.value,
        uiState.all.status,
        uiState.all.sortKey,
        uiState.all.sortDir
    );

    const filteredFav = applyFiltersAndSort(
        processes.filter(p => processFavorites.has(p.name || 'unknown')),
        favSearch?.value,
        uiState.favorites.status,
        uiState.favorites.sortKey,
        uiState.favorites.sortDir
    );

    allContainer.innerHTML = filteredAll.map(p => createProcessCard(p, 'all')).join('') || '<div style="padding: 1rem; color: #dadada;">No processes found</div>';
    favContainer.innerHTML = filteredFav.map(p => createProcessCard(p, 'favorites')).join('') || '<div style="padding: 1rem; color: #dadada;">No favorites yet</div>';
}

async function fetchProcesses() {
    try {
        const response = await fetch('/api/processes');
        const data = await response.json();
        if (!response.ok || !data.success) {
            console.error('Failed to fetch processes', data);
            return;
        }
        lastProcessesData = data.processes || [];
        renderProcesses(lastProcessesData);

        // If selected PID disappeared, stop monitoring.
        if (selectedPid && !lastProcessesData.some(p => p.pid === selectedPid)) {
            stopMonitoring();
            selectedPid = null;
            updateDetailsEmptyState();
            renderProcesses(lastProcessesData);
        }
    } catch (error) {
        console.error('Error fetching processes:', error);
    }
}

function updateDetailsEmptyState() {
    const empty = document.getElementById('process-details-empty');
    const meta = document.getElementById('process-meta');
    const graphs = document.getElementById('process-graphs');
    if (!selectedPid) {
        empty.style.display = 'block';
        if (meta) meta.style.display = 'none';
        graphs.style.display = 'none';
        document.getElementById('process-title').textContent = 'Process Metrics';

        _setText('process-meta-name', '-');
        _setText('process-meta-pid', '-');
        _setText('process-meta-user', '-');
        _setText('process-meta-status', '-');
        _setText('process-meta-started', '-');
        _setText('process-meta-exe', '-');
        _setText('process-meta-cwd', '-');
        _setText('process-meta-cmdline', '-');
        _setText('process-meta-threads', '-');
        _setText('process-meta-conns', '-');
    } else {
        empty.style.display = 'none';
        if (meta) meta.style.display = 'block';
        graphs.style.display = 'flex';
    }
}

async function selectProcess(pid) {
    const proc = lastProcessesData.find(p => p.pid === pid);
    selectedPid = pid;
    renderProcesses(lastProcessesData);

    updateDetailsEmptyState();

    if (!proc) {
        stopMonitoring();
        return;
    }

    document.getElementById('process-title').textContent = `Process Metrics: ${proc.name || 'unknown'} (PID: ${pid})`;

    updateProcessMeta(proc, { started: '-', threads: '-', conns: '-' });
    hydrateProcessMetaFromInfo(pid);

    stopMonitoring();
    startMonitoring(pid);
}

async function killProcess(event, pid) {
    event.stopPropagation();

    try {
        const resp = await fetch('/api/process/kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pid })
        });
        const data = await resp.json().catch(() => ({}));

        if (resp.status === 401 && data && data.error === 'sudo_required') {
            if (typeof window.showSudoModal === 'function') {
                window.showSudoModal(data.message || 'Sudo password required to kill this process.', () => killProcess({ stopPropagation() {} }, pid));
            } else {
                alert(data.message || 'Sudo required');
            }
            return;
        }

        if (!resp.ok || !data.success) {
            alert(data.error || 'Failed to kill process');
            return;
        }

        // If we killed the selected process, stop monitoring and reset.
        if (selectedPid === pid) {
            stopMonitoring();
            selectedPid = null;
            updateDetailsEmptyState();
        }

        await fetchProcesses();
    } catch (e) {
        console.error('Kill process failed:', e);
        alert('Failed to kill process');
    }
}

// ===== Charts (adapted from process_monitor.js) =====
function initCharts() {
    const cpuCtx = document.getElementById('cpu-usage-chart')?.getContext('2d');
    const memoryCtx = document.getElementById('memory-usage-chart')?.getContext('2d');
    const threadsCtx = document.getElementById('threads-chart')?.getContext('2d');
    const networkConnCtx = document.getElementById('network-conn-chart')?.getContext('2d');
    const networkTrafficCtx = document.getElementById('network-traffic-chart')?.getContext('2d');

    if (!cpuCtx || !memoryCtx || !threadsCtx || !networkConnCtx || !networkTrafficCtx) {
        console.error('Chart canvases not found');
        return;
    }

    if (cpuChart) cpuChart.destroy();
    if (memoryChart) memoryChart.destroy();
    if (threadsChart) threadsChart.destroy();
    if (networkConnChart) networkConnChart.destroy();
    if (networkTrafficChart) networkTrafficChart.destroy();

    const darkThemeOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: {
            legend: { labels: { color: 'white' } },
            title: { color: 'white' }
        },
        scales: {
            x: {
                ticks: { color: 'white' },
                grid: { color: 'rgba(255, 255, 255, 0.1)' }
            },
            y: {
                ticks: { color: 'white' },
                grid: { color: 'rgba(255, 255, 255, 0.1)' }
            }
        }
    };

    cpuChart = new Chart(cpuCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'CPU Usage (%)', data: [], borderColor: 'rgb(75, 192, 192)', tension: 0.1, fill: false }] },
        options: {
            ...darkThemeOptions,
            scales: { ...darkThemeOptions.scales, y: { ...darkThemeOptions.scales.y, beginAtZero: true, max: 100 } },
            plugins: { ...darkThemeOptions.plugins, title: { ...darkThemeOptions.plugins.title, display: true, text: 'CPU Usage (Min: 0%, Max: 0%)' } }
        }
    });

    memoryChart = new Chart(memoryCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Memory Usage (MB)', data: [], borderColor: 'rgb(255, 99, 132)', tension: 0.1, fill: false }] },
        options: {
            ...darkThemeOptions,
            scales: { ...darkThemeOptions.scales, y: { ...darkThemeOptions.scales.y, beginAtZero: true } },
            plugins: { ...darkThemeOptions.plugins, title: { ...darkThemeOptions.plugins.title, display: true, text: 'Memory Usage (Min: 0MB, Max: 0MB)' } }
        }
    });

    threadsChart = new Chart(threadsCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Threads', data: [], borderColor: 'rgb(153, 102, 255)', tension: 0.1, fill: false }] },
        options: {
            ...darkThemeOptions,
            scales: { ...darkThemeOptions.scales, y: { ...darkThemeOptions.scales.y, beginAtZero: true } },
            plugins: { ...darkThemeOptions.plugins, title: { ...darkThemeOptions.plugins.title, display: true, text: 'Threads (Min: 0, Max: 0)' } }
        }
    });

    networkConnChart = new Chart(networkConnCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Network Connections', data: [], borderColor: 'rgb(54, 162, 235)', tension: 0.1, fill: false }] },
        options: {
            ...darkThemeOptions,
            scales: { ...darkThemeOptions.scales, y: { ...darkThemeOptions.scales.y, beginAtZero: true } },
            plugins: { ...darkThemeOptions.plugins, title: { ...darkThemeOptions.plugins.title, display: true, text: 'Network Connections (Min: 0, Max: 0)' } }
        }
    });

    networkTrafficChart = new Chart(networkTrafficCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Network Traffic (KB/s)', data: [], borderColor: 'rgb(255, 159, 64)', tension: 0.1, fill: false }] },
        options: {
            ...darkThemeOptions,
            scales: { ...darkThemeOptions.scales, y: { ...darkThemeOptions.scales.y, beginAtZero: true } },
            plugins: { ...darkThemeOptions.plugins, title: { ...darkThemeOptions.plugins.title, display: true, text: 'Network Traffic (Min: 0KB/s, Max: 0KB/s)' } }
        }
    });

    cpuData.length = 0;
    memoryData.length = 0;
    threadsData.length = 0;
    networkConnData.length = 0;
    networkTrafficData.length = 0;
    timestamps.length = 0;

    cpuMax = 0;
    cpuMin = Number.MAX_VALUE;
    memoryMax = 0;
    memoryMin = Number.MAX_VALUE;
    threadsMax = 0;
    threadsMin = Number.MAX_VALUE;
    networkConnMax = 0;
    networkConnMin = Number.MAX_VALUE;
    networkTrafficMax = 0;
    networkTrafficMin = Number.MAX_VALUE;
}

async function fetchProcessMetrics(pid) {
    try {
        const response = await fetch(`/api/process_metrics/${pid}`);
        const data = await response.json();
        if (!data.success) {
            return null;
        }
        return data;
    } catch (error) {
        console.error('Error fetching process metrics:', error);
        return null;
    }
}

function updateCharts(data) {
    if (!data || !cpuChart || !memoryChart || !threadsChart || !networkConnChart || !networkTrafficChart) return;

    const date = new Date(data.timestamp * 1000);
    const timeString = date.toLocaleTimeString();

    const memoryMB = data.memory_rss / (1024 * 1024);
    const networkRate = data.network_traffic;
    const threads = Number.isFinite(Number(data.threads)) ? Number(data.threads) : 0;

    cpuMax = Math.max(cpuMax, data.cpu_percent);
    cpuMin = data.cpu_percent < cpuMin ? data.cpu_percent : cpuMin;

    memoryMax = Math.max(memoryMax, memoryMB);
    memoryMin = memoryMB < memoryMin ? memoryMB : memoryMin;

    threadsMax = Math.max(threadsMax, threads);
    threadsMin = threads < threadsMin ? threads : threadsMin;

    networkConnMax = Math.max(networkConnMax, data.network_connections);
    networkConnMin = data.network_connections < networkConnMin ? data.network_connections : networkConnMin;

    networkTrafficMax = Math.max(networkTrafficMax, networkRate);
    networkTrafficMin = networkRate < networkTrafficMin ? networkRate : networkTrafficMin;

    timestamps.push(timeString);
    cpuData.push(data.cpu_percent);
    memoryData.push(memoryMB);
    threadsData.push(threads);
    networkConnData.push(data.network_connections);
    networkTrafficData.push(Number(networkRate).toFixed(2));

    if (timestamps.length > MAX_DATA_POINTS) {
        timestamps.shift();
        cpuData.shift();
        memoryData.shift();
        threadsData.shift();
        networkConnData.shift();
        networkTrafficData.shift();
    }

    // Use numeric index labels instead of timestamps
    const indexLabels = Array.from({ length: timestamps.length }, (_, i) => i);

    cpuChart.data.labels = indexLabels;
    cpuChart.data.datasets[0].data = cpuData;
    cpuChart.options.plugins.title.text = `CPU Usage (Min: ${cpuMin.toFixed(1)}%, Max: ${cpuMax.toFixed(1)}%)`;
    cpuChart.options.scales.x.ticks.display = false;
    cpuChart.update('none');

    memoryChart.data.labels = indexLabels;
    memoryChart.data.datasets[0].data = memoryData;
    memoryChart.options.plugins.title.text = `Memory Usage (Min: ${memoryMin.toFixed(1)}MB, Max: ${memoryMax.toFixed(1)}MB)`;
    memoryChart.options.scales.x.ticks.display = false;
    memoryChart.update('none');

    threadsChart.data.labels = indexLabels;
    threadsChart.data.datasets[0].data = threadsData;
    threadsChart.options.plugins.title.text = `Threads (Min: ${threadsMin === Number.MAX_VALUE ? 0 : threadsMin}, Max: ${threadsMax})`;
    threadsChart.options.scales.x.ticks.display = false;
    threadsChart.update('none');

    networkConnChart.data.labels = indexLabels;
    networkConnChart.data.datasets[0].data = networkConnData;
    networkConnChart.options.plugins.title.text = `Network Connections (Min: ${networkConnMin}, Max: ${networkConnMax})`;
    networkConnChart.options.scales.x.ticks.display = false;
    networkConnChart.update('none');

    networkTrafficChart.data.labels = indexLabels;
    networkTrafficChart.data.datasets[0].data = networkTrafficData;
    networkTrafficChart.options.plugins.title.text = `Network Traffic (Min: ${networkTrafficMin.toFixed(1)}KB/s, Max: ${networkTrafficMax.toFixed(1)}KB/s)`;
    networkTrafficChart.options.scales.x.ticks.display = false;
    networkTrafficChart.update('none');

    // Update live meta (threads + conn count)
    if (selectedPid && currentPid && selectedPid === currentPid) {
        _setText('process-meta-threads', threads);
        _setText('process-meta-conns', data.network_connections ?? '-');
    }
}

function startMonitoring(pid) {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }

    currentPid = pid;
    initCharts();

    fetchProcessMetrics(pid).then(data => {
        if (data) {
            updateCharts(data);
            monitoringInterval = setInterval(() => {
                fetchProcessMetrics(pid).then(newData => {
                    if (newData) {
                        updateCharts(newData);
                    } else {
                        stopMonitoring();
                        selectedPid = null;
                        updateDetailsEmptyState();
                    }
                });
            }, MONITOR_INTERVAL);
        }
    });
}

function stopMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }

    if (cpuChart) { cpuChart.destroy(); cpuChart = null; }
    if (memoryChart) { memoryChart.destroy(); memoryChart = null; }
    if (threadsChart) { threadsChart.destroy(); threadsChart = null; }
    if (networkConnChart) { networkConnChart.destroy(); networkConnChart = null; }
    if (networkTrafficChart) { networkTrafficChart.destroy(); networkTrafficChart = null; }

    currentPid = null;
}

document.addEventListener('DOMContentLoaded', async () => {
    // Expose handlers used in inline HTML onclick
    window.toggleProcessFavorite = toggleProcessFavorite;
    window.selectProcess = selectProcess;
    window.killProcess = killProcess;
    window.showProcessInfo = showProcessInfo;

    initInfocardBehavior();

    await loadProcessFavorites();

    const allSearch = document.getElementById('processesSearchInput');
    const favSearch = document.getElementById('processFavoritesSearchInput');

    // Setup icon controls (status + sort)
    wireControls();
    setActiveControls('all');
    setActiveControls('favorites');

    allSearch?.addEventListener('input', () => renderProcesses(lastProcessesData));
    favSearch?.addEventListener('input', () => renderProcesses(lastProcessesData));

    await fetchProcesses();
    updateDetailsEmptyState();

    setInterval(fetchProcesses, 3000);
});
