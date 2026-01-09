let processFavorites = new Set();
let lastProcessesData = [];
let selectedPid = null;

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

    if (container === 'favorites' && !isFavorite) return '';

    const selectedClass = pid === selectedPid ? 'selected-service' : '';

    return `
        <div class="service-card ${selectedClass}" data-pid="${pid}" data-name="${escapeHtml(name)}">
            <div class="card">
                <button class="star-btn" onclick='toggleProcessFavorite(event, ${JSON.stringify(name)})' title="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                    <i class="${isFavorite ? 'fas' : 'far'} fa-star"></i>
                </button>
                <div class="card-body" onclick="selectProcess(${pid})">
                    <h5 class="card-title">${escapeHtml(name)} <span style="opacity: 0.8; font-size: 0.9rem;">(PID: ${pid})</span></h5>
                    <div style="opacity: 0.9; font-size: 0.9rem; margin-bottom: 0.5rem;">
                        <div>User: ${escapeHtml(proc.username || 'N/A')} | Status: ${escapeHtml(proc.status || 'N/A')}</div>
                        <div>CPU: ${(proc.cpu_percent ?? 0).toFixed(1)}% | Mem: ${fmtMB(proc.memory_rss || 0)} MB</div>
                    </div>
                    <div class="btn-group w-100">
                        <button class="btn btn-sm btn-danger" onclick="killProcess(event, ${pid})" title="Kill process">
                            <i class="fas fa-skull-crossbones"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function applySearchFilter(items, searchValue) {
    const q = (searchValue || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter(p => {
        const name = (p.name || '').toLowerCase();
        const username = (p.username || '').toLowerCase();
        const pid = String(p.pid || '');
        return name.includes(q) || username.includes(q) || pid.includes(q);
    });
}

function renderProcesses(processes) {
    const allContainer = document.getElementById('processes-container');
    const favContainer = document.getElementById('processes-favorites-container');
    const allSearch = document.getElementById('processesSearchInput');
    const favSearch = document.getElementById('processFavoritesSearchInput');

    const filteredAll = applySearchFilter(processes, allSearch?.value);
    const filteredFav = applySearchFilter(processes.filter(p => processFavorites.has(p.name || 'unknown')), favSearch?.value);

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

    await loadProcessFavorites();

    const allSearch = document.getElementById('processesSearchInput');
    const favSearch = document.getElementById('processFavoritesSearchInput');

    allSearch?.addEventListener('input', () => renderProcesses(lastProcessesData));
    favSearch?.addEventListener('input', () => renderProcesses(lastProcessesData));

    await fetchProcesses();
    updateDetailsEmptyState();

    setInterval(fetchProcesses, 3000);
});
