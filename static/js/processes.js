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
let networkConnChart = null;
let networkTrafficChart = null;

// Data arrays for charts
const cpuData = [];
const memoryData = [];
const networkConnData = [];
const networkTrafficData = [];
const timestamps = [];

// Max/min values
let cpuMax = 0;
let cpuMin = Number.MAX_VALUE;
let memoryMax = 0;
let memoryMin = Number.MAX_VALUE;
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
    return 'other';
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
    const exePath = proc.exe || '';

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
                    <div style="opacity: 0.9; font-size: 0.9rem; margin-bottom: 0.5rem;">
                        <div>User: ${escapeHtml(proc.username || 'N/A')} | Status: ${escapeHtml(statusText || 'N/A')}</div>
                        <div>CPU: ${(proc.cpu_percent ?? 0).toFixed(1)}% | Mem: ${fmtMB(proc.memory_rss || 0)} MB</div>
                        <div>Path: ${escapeHtml(exePath || 'N/A')}</div>
                    </div>
                    <div class="btn-group w-100">
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

function _showInfocardProcessSection() {
    const title = document.getElementById('infocard-title');
    const svc = document.getElementById('service-info-section');
    const proc = document.getElementById('process-info-section');
    if (title) title.textContent = 'Process Info';
    if (svc) svc.style.display = 'none';
    if (proc) proc.style.display = 'block';
}

async function showProcessInfo(event, pid) {
    event?.stopPropagation?.();

    const infocard = document.getElementById('infocard');
    if (!infocard) return;

    infocard.classList.remove('hidden');
    _showInfocardProcessSection();

    try {
        const resp = await fetch(`/api/process_info/${pid}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            alert(data.error || 'Failed to load process info');
            return;
        }

        document.getElementById('proc-info-name').textContent = data.name || 'N/A';
        document.getElementById('proc-info-pid').textContent = data.pid ?? 'N/A';
        document.getElementById('proc-info-ppid').textContent = data.ppid ?? 'N/A';
        document.getElementById('proc-info-user').textContent = data.username || 'N/A';
        document.getElementById('proc-info-status').textContent = data.status || 'N/A';
        document.getElementById('proc-info-exe').textContent = data.exe || 'N/A';
        document.getElementById('proc-info-cwd').textContent = data.cwd || 'N/A';
        document.getElementById('proc-info-cmdline').textContent = (data.cmdline || []).join(' ') || 'N/A';
        document.getElementById('proc-info-cpu').textContent = `${Number(data.cpu_percent || 0).toFixed(1)}`;
        document.getElementById('proc-info-mem').textContent = _bytesToHuman(data.memory_rss || 0);
        document.getElementById('proc-info-threads').textContent = data.threads ?? 'N/A';
        document.getElementById('proc-info-started').textContent = _formatStarted(data.create_time);
        document.getElementById('proc-info-connections').textContent = data.network_connections ?? '0';
    } catch (e) {
        console.error('Process info failed:', e);
        alert('Failed to load process info');
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
        return name.includes(q) || username.includes(q) || pid.includes(q);
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
    const graphs = document.getElementById('process-graphs');
    if (!selectedPid) {
        empty.style.display = 'block';
        graphs.style.display = 'none';
        document.getElementById('process-title').textContent = 'Process Metrics';
    } else {
        empty.style.display = 'none';
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
    const networkConnCtx = document.getElementById('network-conn-chart')?.getContext('2d');
    const networkTrafficCtx = document.getElementById('network-traffic-chart')?.getContext('2d');

    if (!cpuCtx || !memoryCtx || !networkConnCtx || !networkTrafficCtx) {
        console.error('Chart canvases not found');
        return;
    }

    if (cpuChart) cpuChart.destroy();
    if (memoryChart) memoryChart.destroy();
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
    networkConnData.length = 0;
    networkTrafficData.length = 0;
    timestamps.length = 0;

    cpuMax = 0;
    cpuMin = Number.MAX_VALUE;
    memoryMax = 0;
    memoryMin = Number.MAX_VALUE;
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
    if (!data || !cpuChart || !memoryChart || !networkConnChart || !networkTrafficChart) return;

    const date = new Date(data.timestamp * 1000);
    const timeString = date.toLocaleTimeString();

    const memoryMB = data.memory_rss / (1024 * 1024);
    const networkRate = data.network_traffic;

    cpuMax = Math.max(cpuMax, data.cpu_percent);
    cpuMin = data.cpu_percent < cpuMin ? data.cpu_percent : cpuMin;

    memoryMax = Math.max(memoryMax, memoryMB);
    memoryMin = memoryMB < memoryMin ? memoryMB : memoryMin;

    networkConnMax = Math.max(networkConnMax, data.network_connections);
    networkConnMin = data.network_connections < networkConnMin ? data.network_connections : networkConnMin;

    networkTrafficMax = Math.max(networkTrafficMax, networkRate);
    networkTrafficMin = networkRate < networkTrafficMin ? networkRate : networkTrafficMin;

    timestamps.push(timeString);
    cpuData.push(data.cpu_percent);
    memoryData.push(memoryMB);
    networkConnData.push(data.network_connections);
    networkTrafficData.push(Number(networkRate).toFixed(2));

    if (timestamps.length > MAX_DATA_POINTS) {
        timestamps.shift();
        cpuData.shift();
        memoryData.shift();
        networkConnData.shift();
        networkTrafficData.shift();
    }

    cpuChart.data.labels = timestamps;
    cpuChart.data.datasets[0].data = cpuData;
    cpuChart.options.plugins.title.text = `CPU Usage (Min: ${cpuMin.toFixed(1)}%, Max: ${cpuMax.toFixed(1)}%)`;
    cpuChart.update('none');

    memoryChart.data.labels = timestamps;
    memoryChart.data.datasets[0].data = memoryData;
    memoryChart.options.plugins.title.text = `Memory Usage (Min: ${memoryMin.toFixed(1)}MB, Max: ${memoryMax.toFixed(1)}MB)`;
    memoryChart.update('none');

    networkConnChart.data.labels = timestamps;
    networkConnChart.data.datasets[0].data = networkConnData;
    networkConnChart.options.plugins.title.text = `Network Connections (Min: ${networkConnMin}, Max: ${networkConnMax})`;
    networkConnChart.update('none');

    networkTrafficChart.data.labels = timestamps;
    networkTrafficChart.data.datasets[0].data = networkTrafficData;
    networkTrafficChart.options.plugins.title.text = `Network Traffic (Min: ${networkTrafficMin.toFixed(1)}KB/s, Max: ${networkTrafficMax.toFixed(1)}KB/s)`;
    networkTrafficChart.update('none');
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

    // Info card close button (Processes page also uses it)
    const infocard = document.getElementById('infocard');
    const closeBtn = infocard?.querySelector('.btn-close');
    closeBtn?.addEventListener('click', () => infocard.classList.add('hidden'));
});
