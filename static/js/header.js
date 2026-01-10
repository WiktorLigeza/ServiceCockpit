function getColorForValue(value, type) {
    let startColor, endColor;
    
    switch(type) {
        case 'cpu':
            startColor = [51, 153, 255];  // Blue
            endColor = [255, 51, 51];     // Red
            value = (value - 30) / 50;    // Scale 30-80°C to 0-1
            break;
        case 'memory':
        case 'storage':
            startColor = [46, 204, 113];  // Green
            endColor = [231, 76, 60];     // Red
            value = value / 100;
            break;
        case 'cpu_usage':
            startColor = [46, 204, 113];  // Green
            endColor = [231, 76, 60];     // Red
            value = value / 100;
            break;
    }
    
    value = Math.max(0, Math.min(1, value));
    
    const color = startColor.map((start, i) => {
        const end = endColor[i];
        return Math.round(start + (end - start) * value);
    });
    
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function getCpuClassForPercent(value) {
    const v = Number(value) || 0;
    if (v >= 90) return 'cpu-hot';
    if (v >= 70) return 'cpu-warn';
    return 'cpu-ok';
}

function getCpuColorForPercent(value) {
    const v = Number(value) || 0;
    if (v >= 90) return 'rgb(231, 76, 60)';
    if (v >= 70) return 'rgb(255, 165, 0)';
    return 'rgb(46, 204, 113)';
}

function _getCpuMenuEls() {
    return {
        wrapper: document.getElementById('cpu-usage'),
        menu: document.getElementById('cpu-menu'),
        list: document.getElementById('cpu-menu-list')
    };
}

function renderCpuMenu(perCore) {
    const { list } = _getCpuMenuEls();
    if (!list) return;
    list.innerHTML = '';

    const cores = Array.isArray(perCore) ? perCore : [];
    if (!cores.length) {
        const row = document.createElement('div');
        row.className = 'cpu-core-row';
        row.textContent = 'No per-core data';
        list.appendChild(row);
        return;
    }

    cores.forEach((percent, idx) => {
        const row = document.createElement('div');
        row.className = 'cpu-core-row';

        const label = document.createElement('div');
        label.className = 'cpu-core-label';
        label.textContent = `Core ${idx}`;

        const value = document.createElement('div');
        const cls = getCpuClassForPercent(percent);
        value.className = `cpu-core-value ${cls}`;
        value.textContent = `${percent}%`;

        row.appendChild(label);
        row.appendChild(value);
        list.appendChild(row);
    });
}

function updateMetrics(data) {
    console.log('Updating metrics:', data);
    
    // CPU Temperature
    const cpuTemp = document.querySelector('#cpu-temp');
    cpuTemp.querySelector('.metric-value').textContent = `${data.cpu_temp}°C`;
    cpuTemp.querySelector('i').style.color = getColorForValue(data.cpu_temp, 'cpu');
    const cpuTempMenu = cpuTemp.querySelector('.metric-menu-content');
    if (cpuTempMenu) cpuTempMenu.textContent = `CPU Temperature: ${data.cpu_temp}°C`;

    // CPU Usage (summed across cores)
    const cpuUsage = document.querySelector('#cpu-usage');
    if (cpuUsage && data && typeof data.cpu_percent !== 'undefined') {
        const overall = Number(data.cpu_percent) || 0;
        cpuUsage.querySelector('.metric-value').textContent = `${overall}%`;
        cpuUsage.querySelector('i').style.color = getCpuColorForPercent(overall);

        const perCore = Array.isArray(data.cpu_percent_per_core) ? data.cpu_percent_per_core : [];
        renderCpuMenu(perCore);
    }

    // Memory Usage
    const memoryUsage = document.querySelector('#memory-usage');
    memoryUsage.querySelector('.metric-value').textContent = `${data.memory_percent}%`;
    memoryUsage.querySelector('i').style.color = getColorForValue(data.memory_percent, 'memory');
    const memoryMenu = memoryUsage.querySelector('.metric-menu-content');
    if (memoryMenu) {
        memoryMenu.textContent =
            `Memory: ${data.memory_used}GB used / ${data.memory_total}GB total\n` +
            `(${data.memory_free}GB free)`;
    }

    // Storage Usage
    const storageUsage = document.querySelector('#storage-usage');
    storageUsage.querySelector('.metric-value').textContent = `${data.storage_percent}%`;
    storageUsage.querySelector('i').style.color = getColorForValue(data.storage_percent, 'storage');
    const storageMenu = storageUsage.querySelector('.metric-menu-content');
    if (storageMenu) {
        storageMenu.textContent =
            `Storage: ${data.storage_used}GB used / ${data.storage_total}GB total\n` +
            `(${data.storage_free}GB free)`;
    }
}

// --- Sudo modal + privileged actions (shared across pages) ---
let sudoPendingRetry = null;

function _getGearMenuEls() {
    return {
        wrapper: document.getElementById('header-gear'),
        menu: document.getElementById('gear-menu')
    };
}

function _getMoreMenuEls() {
    return {
        wrapper: document.getElementById('header-more'),
        menu: document.getElementById('more-menu')
    };
}

function hideGearMenu() {
    const { menu } = _getGearMenuEls();
    if (menu) menu.style.display = 'none';
}

function hideMoreMenu() {
    const { menu } = _getMoreMenuEls();
    if (menu) menu.style.display = 'none';
}

function toggleGearMenu(ev) {
    ev?.stopPropagation?.();
    const { menu } = _getGearMenuEls();
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
}

function toggleMoreMenu(ev) {
    ev?.stopPropagation?.();
    const { menu } = _getMoreMenuEls();
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
}

function _getSudoModalEls() {
    return {
        modal: document.getElementById('sudo-modal'),
        form: document.getElementById('sudo-modal-form'),
        password: document.getElementById('sudo-modal-password'),
        message: document.getElementById('sudo-modal-message'),
        error: document.getElementById('sudo-modal-error')
    };
}

function showSudoModal(message = null, retryFn = null) {
    const { modal, password, message: msgEl, error } = _getSudoModalEls();
    if (!modal) return;

    if (typeof retryFn === 'function') {
        sudoPendingRetry = retryFn;
    }

    if (msgEl && message) {
        msgEl.textContent = message;
    }
    if (error) {
        error.style.display = 'none';
        error.textContent = '';
    }

    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        try {
            password?.focus();
        } catch (_) {}
    }, 0);
}

function hideSudoModal() {
    const { modal, password, error } = _getSudoModalEls();
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    if (password) password.value = '';
    if (error) {
        error.style.display = 'none';
        error.textContent = '';
    }
}

async function submitSudoPassword(password) {
    const resp = await fetch('/api/sudo/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
}

async function requestReboot() {
    try {
        const resp = await fetch('/api/reboot', { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 && data && data.error === 'sudo_required') {
            showSudoModal(data.message || 'Sudo password required to reboot.', requestReboot);
            return;
        }
        if (!resp.ok) {
            alert(data?.error || 'Failed to reboot');
            return;
        }
        // If reboot succeeds the connection will drop shortly; keep UI simple.
        alert('Rebooting...');
    } catch (e) {
        console.error('Reboot request failed:', e);
        alert('Failed to reboot');
    }
}

// Expose for inline onclick in header.html
window.showSudoModal = showSudoModal;
window.hideSudoModal = hideSudoModal;
window.requestReboot = requestReboot;
window.toggleGearMenu = toggleGearMenu;
window.hideGearMenu = hideGearMenu;
window.toggleMoreMenu = toggleMoreMenu;
window.hideMoreMenu = hideMoreMenu;

// Socket.io connection with better error handling
const headerSocket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 20000
});

headerSocket.on('update_metrics', updateMetrics);

headerSocket.on('connect', () => {
    // Show loading state for system stats
    ['cpu-temp', 'cpu-usage', 'memory-usage', 'storage-usage'].forEach(id => {
        const element = document.querySelector(`#${id}`);
        if (!element) return;
        element.querySelector('.metric-value').textContent = 'Loading...';
        element.querySelector('i').style.color = '#808080'; // Gray color for loading state
    });
});

headerSocket.on('connect_error', (error) => {
    console.error('-:', error);
    ['cpu-temp', 'cpu-usage', 'memory-usage', 'storage-usage'].forEach(id => {
        const element = document.querySelector(`#${id}`);
        if (!element) return;
        element.querySelector('.metric-value').textContent = 'N/A';
        element.querySelector('i').style.color = '#ff0000';
    });
});

headerSocket.on('reconnect', (attemptNumber) => {
    console.log('Reconnected after', attemptNumber, 'attempts');
});

// If the backend tells us sudo is needed, open the modal.
headerSocket.on('sudo_required', (payload = {}) => {
    showSudoModal(payload.message || 'Sudo password required.');
});

// Add service functionality
document.addEventListener('DOMContentLoaded', () => {
    const addServiceBtn = document.getElementById('add-service-btn');
    const addServiceCard = document.getElementById('add-service-card');

    if (addServiceBtn && addServiceCard) {
        addServiceBtn.addEventListener('click', () => {
            addServiceCard.classList.remove('hidden');
        });
    }

    function updateSystemMetrics() {
        fetch('/system_metrics')
            .then(response => response.json())
            .then(data => {
                // Reuse the same renderer as the socket updates
                updateMetrics(data);

                const internetIcon = document.getElementById('internet-connection').querySelector('i');
                if (data.has_internet) {
                    internetIcon.classList.remove('disconnected');
                    internetIcon.classList.add('connected');
                } else {
                    internetIcon.classList.remove('connected');
                    internetIcon.classList.add('disconnected');
                }
            })
            .catch(error => {
                console.error('Error fetching system metrics:', error);
            });
    }

    fetch('/api/network_info')
        .then(response => response.json())
        .then(data => {
            document.querySelector('#my-ip .metric-value').textContent = data.ip_address;
            document.querySelector('#my-mac .metric-value').textContent = data.mac_address;

            const ipMenu = document.querySelector('#my-ip .metric-menu-content');
            if (ipMenu) ipMenu.textContent = `IP: ${data.ip_address}`;
            const macMenu = document.querySelector('#my-mac .metric-menu-content');
            if (macMenu) macMenu.textContent = `MAC: ${data.mac_address}`;
            
            // Change icon colors
            document.querySelector('#my-ip i').style.color = 'magenta';
            document.querySelector('#my-mac i').style.color = 'cyan';
        })
        .catch(error => {
            console.error('Error fetching network info:', error);
            document.querySelector('#my-ip .metric-value').textContent = 'N/A';
            document.querySelector('#my-mac .metric-value').textContent = 'N/A';

            const ipMenu = document.querySelector('#my-ip .metric-menu-content');
            if (ipMenu) ipMenu.textContent = 'IP: N/A';
            const macMenu = document.querySelector('#my-mac .metric-menu-content');
            if (macMenu) macMenu.textContent = 'MAC: N/A';
        });
    
    // Initial update
    updateSystemMetrics();

    // Update every 5 seconds
    setInterval(updateSystemMetrics, 5000);

    // Wire sudo modal form submit
    const { form, password, error } = _getSudoModalEls();
    if (form && password) {
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const pwd = (password.value || '').trim();
            if (!pwd) return;

            const result = await submitSudoPassword(pwd);
            if (!result.ok) {
                if (error) {
                    error.style.display = 'block';
                    error.textContent = result.data?.error || 'Invalid sudo password';
                }
                return;
            }

            hideSudoModal();
            const retry = sudoPendingRetry;
            sudoPendingRetry = null;
            if (typeof retry === 'function') {
                try { await retry(); } catch (_) {}
            }
        });
    }

    // Close gear menu on outside click
    document.addEventListener('click', (e) => {
        const { wrapper, menu } = _getGearMenuEls();
        if (!menu || !wrapper) return;
        if (menu.style.display === 'none') return;
        if (!wrapper.contains(e.target)) {
            hideGearMenu();
        }
    });

    // Close more menu on outside click
    document.addEventListener('click', (e) => {
        const { wrapper, menu } = _getMoreMenuEls();
        if (!menu || !wrapper) return;
        if (menu.style.display === 'none') return;
        if (!wrapper.contains(e.target)) {
            hideMoreMenu();
        }
    });

});

// Global fetch interceptor: if an API returns sudo_required, show the modal.
// This makes *any* privileged action consistently prompt for sudo.
(() => {
    if (!window.fetch) return;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const resp = await originalFetch(...args);
        if (resp && resp.status === 401) {
            try {
                const clone = resp.clone();
                const data = await clone.json();
                if (data && data.error === 'sudo_required') {
                    showSudoModal(data.message || 'Sudo password required.');
                }
            } catch (_) {
                // ignore JSON parse errors
            }
        }
        return resp;
    };
})();