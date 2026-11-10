// GPU Manager page: NVIDIA driver setup wizard + live nvidia-smi stats.
let gpuStatus = null;
let gpuPlan = null;
let gpuChangeMode = false;      // wizard opened from "Change driver" while a driver is active
let gpuShowAllOptions = false;
let gpuStatsTimer = null;
let gpuConfirmAction = null;

const GPU_VISIBLE_OPTIONS = 4;
const gpuEl = id => document.getElementById(id);

const gpuJobModal = new JobModal({
    jobUrl: '/api/gpu/job',
    cancelUrl: '/api/gpu/job/cancel',
    titles: {
        install: '<i class="fas fa-download"></i> Installing the NVIDIA driver',
        remove: '<i class="fas fa-trash"></i> Removing the NVIDIA driver',
        persistence: '<i class="fas fa-thumbtack"></i> Persistence mode',
    },
    doneText: {
        install: 'Driver installed - reboot to start using it.',
        remove: 'Driver removed - reboot to switch back to nouveau.',
        persistence: 'Persistence mode changed.',
    },
    onFinish: job => {
        if (job.state === 'done' && job.kind !== 'persistence') gpuChangeMode = false;
        loadGpuStatus();
    },
});

document.addEventListener('DOMContentLoaded', () => {
    setupGpuListeners();
    loadGpuStatus(true);
});

// ---------------------------------------------------------------- helpers

function gpuEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function gpuApi(url, body = undefined, retry = null) {
    const opts = body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
    try {
        const resp = await fetch(url, { cache: 'no-store', ...opts });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 && data.error === 'sudo_required') {
            if (retry && window.showSudoModal) window.showSudoModal(data.message, retry);
            return { ok: false, sudo: true, data };
        }
        return { ok: resp.ok && data.success !== false, data };
    } catch (e) {
        return { ok: false, data: { error: String(e) } };
    }
}

function gpuShow(view) {
    ['gpu-loading', 'gpu-na-view', 'gpu-setup-view', 'gpu-reboot-view', 'gpu-app-view'].forEach(id => {
        gpuEl(id).hidden = id !== view;
    });
}

function gpuNum(value, digits = 0) {
    return value === null || value === undefined ? null : Number(value).toFixed(digits);
}

function gpuLevel(percent) {
    if (percent >= 90) return 'bad';
    if (percent >= 70) return 'warn';
    return 'ok';
}

function gpuHwHtml(gpus) {
    return (gpus || []).map(g => {
        const name = g.name || `NVIDIA GPU [${g.device_id}]`;
        const driver = g.driver
            ? `<span class="net-badge ${g.driver === 'nvidia' ? 'ok' : 'warn'}">${gpuEscape(g.driver)}</span>`
            : '<span class="net-badge bad">no driver</span>';
        return `<div class="gpu-hw">
            <i class="fas fa-microchip"></i>
            <div class="gpu-hw-main">
                <div class="gpu-hw-name">${gpuEscape(name)}</div>
                <div class="gpu-hw-sub">${gpuEscape(g.family)} · PCI ${gpuEscape(g.address)} · ${gpuEscape(g.device_id)}</div>
            </div>
            ${driver}
        </div>`;
    }).join('');
}

function gpuNotes(container, items, cls) {
    container.innerHTML = (items || []).map(t => `<div class="net-note ${cls}">${gpuEscape(t)}</div>`).join('');
}

// ---------------------------------------------------------------- listeners

function setupGpuListeners() {
    gpuEl('gpu-install-btn').addEventListener('click', gpuInstall);
    gpuEl('gpu-refresh-options').addEventListener('click', () => loadGpuPlan(true));
    gpuEl('gpu-options-more').addEventListener('click', () => {
        gpuShowAllOptions = !gpuShowAllOptions;
        renderGpuOptions();
    });
    gpuEl('gpu-setup-back').addEventListener('click', () => {
        gpuChangeMode = false;
        renderGpu();
    });
    gpuEl('gpu-change-btn').addEventListener('click', gpuOpenWizard);
    gpuEl('gpu-reboot-change').addEventListener('click', gpuOpenWizard);
    gpuEl('gpu-remove-btn').addEventListener('click', gpuRemove);
    gpuEl('gpu-reboot-remove').addEventListener('click', gpuRemove);
    gpuEl('gpu-reboot-btn').addEventListener('click', () => {
        gpuConfirm('Reboot now?', 'The device restarts and this page loses its connection for a minute or two.',
                   'Reboot', () => window.requestReboot && window.requestReboot());
    });
    gpuEl('gpu-persistence').addEventListener('change', gpuSetPersistence);

    gpuEl('gpu-confirm-cancel').addEventListener('click', () => { gpuEl('gpu-confirm-modal').hidden = true; });
    gpuEl('gpu-confirm-ok').addEventListener('click', () => {
        gpuEl('gpu-confirm-modal').hidden = true;
        const action = gpuConfirmAction;
        gpuConfirmAction = null;
        if (action) action();
    });
}

function gpuConfirm(title, message, okText, action) {
    gpuEl('gpu-confirm-title').textContent = title;
    gpuEl('gpu-confirm-message').textContent = message;
    gpuEl('gpu-confirm-ok').textContent = okText;
    gpuConfirmAction = action;
    gpuEl('gpu-confirm-modal').hidden = false;
}

// ---------------------------------------------------------------- status

async function loadGpuStatus(initial = false) {
    const res = await gpuApi('/api/gpu/status');
    if (!res.data || res.data.applicable === undefined) {
        gpuShow('gpu-na-view');
        gpuEl('gpu-na-title').textContent = 'Could not read the GPU status';
        gpuEl('gpu-na-text').textContent = res.data?.error || '';
        return;
    }
    gpuStatus = res.data;
    if (initial && gpuStatus.job?.state === 'running') gpuJobModal.show();
    renderGpu();
}

function renderGpu() {
    const s = gpuStatus;
    if (!s.applicable) {
        gpuStopStats();
        gpuShow('gpu-na-view');
        gpuEl('gpu-na-title').textContent = s.jetson ? 'NVIDIA Jetson' : 'No NVIDIA GPU found';
        gpuEl('gpu-na-text').textContent = s.jetson
            ? 'The Jetson GPU driver comes with JetPack - update it with the system updates, not from here.'
            : 'This device has no discrete NVIDIA graphics card.';
        return;
    }
    if (s.state === 'none' || gpuChangeMode) {
        gpuStopStats();
        renderGpuWizard();
        return;
    }
    if (s.state === 'reboot') {
        gpuStopStats();
        gpuShow('gpu-reboot-view');
        gpuEl('gpu-reboot-text').textContent = s.reason;
        gpuEl('gpu-reboot-hw').innerHTML = gpuHwHtml(s.gpus);
        const warn = [];
        if (s.secure_boot && s.method !== 'ubuntu') {
            warn.push('Secure Boot is on: if the boot screen asks to "Enroll MOK", choose it and enter the password set during installation, or the driver will not load.');
        }
        gpuNotes(gpuEl('gpu-reboot-warnings'), warn, 'warn');
        return;
    }
    renderGpuApp();
}

// ---------------------------------------------------------------- wizard

function gpuOpenWizard() {
    gpuChangeMode = true;
    renderGpu();
}

function renderGpuWizard() {
    const s = gpuStatus;
    gpuShow('gpu-setup-view');
    const active = s.state !== 'none';
    gpuEl('gpu-setup-title').textContent = active ? 'Change the NVIDIA driver' : 'NVIDIA GPU detected';
    gpuEl('gpu-setup-text').textContent = active
        ? `Installed now: ${s.userspace_version || s.module_version || 'unknown'}. Pick another driver branch to switch to it.`
        : (s.nouveau_bound
            ? 'The GPU is using the open-source nouveau driver: no CUDA, no NVENC and much lower performance. Install the NVIDIA driver to use it fully.'
            : 'No driver is handling this GPU yet. Install the NVIDIA driver to use it.');
    gpuEl('gpu-setup-back').hidden = !active;
    gpuEl('gpu-setup-hw').innerHTML = gpuHwHtml(s.gpus);
    if (!gpuPlan) loadGpuPlan(false);
    else renderGpuOptions();
}

async function loadGpuPlan(refresh) {
    gpuEl('gpu-options').innerHTML = '<div class="setup-muted"><i class="fas fa-circle-notch fa-spin"></i> Finding drivers for this GPU…</div>';
    gpuEl('gpu-install-btn').disabled = true;
    const res = await gpuApi(`/api/gpu/drivers${refresh ? '?refresh=1' : ''}`);
    gpuPlan = res.data || { supported: false, options: [], warnings: ['Could not read the driver list.'] };
    renderGpuOptions();
}

function renderGpuOptions() {
    const p = gpuPlan;
    const checked = document.querySelector('input[name="gpu-option"]:checked')?.value;
    const options = p.options || [];
    const visible = gpuShowAllOptions ? options : options.slice(0, GPU_VISIBLE_OPTIONS);
    // Keep a selection the user made even if it is in the hidden part.
    const selected = options.find(o => o.id === checked)?.id || options.find(o => o.recommended)?.id || options[0]?.id;
    if (selected && !visible.find(o => o.id === selected)) visible.push(options.find(o => o.id === selected));

    gpuEl('gpu-plan-meta').innerHTML = p.method_label
        ? `<span class="net-badge info">${gpuEscape(p.distro)}</span> <span class="setup-muted">via ${gpuEscape(p.method_label)}</span>`
        : (p.distro ? `<span class="net-badge">${gpuEscape(p.distro)}</span>` : '');
    gpuNotes(gpuEl('gpu-plan-warnings'), p.warnings, 'warn');
    gpuEl('gpu-plan-notes').innerHTML = (p.notes || []).map(n => `<div>${gpuEscape(n)}</div>`).join('');
    gpuEl('gpu-manual-link').href = p.manual_url || 'https://www.nvidia.com/en-us/drivers/';

    gpuEl('gpu-options').innerHTML = visible.length ? visible.map(o => `
        <label class="setup-option">
            <input type="radio" name="gpu-option" value="${gpuEscape(o.id)}" ${o.id === selected ? 'checked' : ''}>
            <span>
                <span class="setup-option-title">${gpuEscape(o.title)}${o.recommended ? ' <span class="setup-tag">recommended</span>' : ''}</span>
                <span class="setup-option-text d-block">${gpuEscape(o.text)}</span>
            </span>
        </label>`).join('')
        : '<div class="setup-muted">No automatic install available - use the manual download below.</div>';

    const more = gpuEl('gpu-options-more');
    more.hidden = options.length <= GPU_VISIBLE_OPTIONS;
    more.textContent = gpuShowAllOptions ? 'Show fewer drivers' : `Show all ${options.length} drivers`;
    gpuEl('gpu-install-btn').disabled = !p.supported || !options.length;
    gpuEl('gpu-setup-error').textContent = '';
}

async function gpuInstall() {
    const option = document.querySelector('input[name="gpu-option"]:checked')?.value;
    if (!option) {
        gpuEl('gpu-setup-error').textContent = 'Choose a driver first.';
        return;
    }
    const res = await gpuJobModal.start('/api/gpu/install', { option }, gpuInstall);
    if (!res.ok && !res.sudo) gpuEl('gpu-setup-error').textContent = res.error || 'Could not start the installation.';
}

function gpuRemove() {
    gpuConfirm('Remove the NVIDIA driver?',
        'All NVIDIA driver packages are uninstalled and the GPU goes back to the open-source nouveau driver after a reboot. CUDA programs will stop working.',
        'Remove', async () => {
            const res = await gpuJobModal.start('/api/gpu/remove', {}, gpuRemove);
            if (!res.ok && !res.sudo && res.error) alert(res.error);
        });
}

async function gpuSetPersistence(e) {
    const enabled = e.target.checked;
    const res = await gpuJobModal.start('/api/gpu/persistence', { enabled }, () => {
        gpuEl('gpu-persistence').checked = enabled;
        gpuSetPersistence({ target: { checked: enabled } });
    });
    if (!res.ok) e.target.checked = !enabled;
}

// ---------------------------------------------------------------- manager (driver active)

function renderGpuApp() {
    const s = gpuStatus;
    gpuShow('gpu-app-view');
    gpuEl('gpu-drv-version').textContent = s.module_version || '—';
    gpuEl('gpu-drv-module').textContent = s.module_flavour === 'open' ? 'Open (nvidia-open)'
        : s.module_flavour === 'proprietary' ? 'Proprietary' : '—';
    gpuEl('gpu-drv-distro').textContent = s.distro || '—';
    gpuEl('gpu-drv-sb').textContent = s.secure_boot === null || s.secure_boot === undefined ? 'unknown' : (s.secure_boot ? 'on' : 'off');
    gpuEl('gpu-app-hw').innerHTML = gpuHwHtml(s.gpus);
    gpuEl('gpu-change-btn').hidden = !s.method;
    gpuEl('gpu-remove-btn').hidden = !s.method;
    gpuStartStats();
}

function gpuStartStats() {
    if (gpuStatsTimer) return;
    const tick = async () => {
        await loadGpuStats();
        if (gpuStatsTimer !== null) gpuStatsTimer = setTimeout(tick, document.hidden ? 10000 : 2000);
    };
    gpuStatsTimer = 0;
    tick();
}

function gpuStopStats() {
    if (gpuStatsTimer) clearTimeout(gpuStatsTimer);
    gpuStatsTimer = null;
}

async function loadGpuStats() {
    const res = await gpuApi('/api/gpu/stats');
    const d = res.data || {};
    const err = gpuEl('gpu-smi-error');
    if (!d.ok) {
        err.hidden = false;
        err.innerHTML = `nvidia-smi: ${gpuEscape(d.error || 'not responding')}` +
            (/mismatch/i.test(d.error || '') ? '<br>The driver was updated - reboot to load the new version.' : '');
        gpuEl('gpu-cards').innerHTML = '<div class="net-panel"><div class="net-empty">No live data.</div></div>';
        return;
    }
    err.hidden = true;
    gpuEl('gpu-drv-cuda').textContent = d.cuda_version || '—';
    if (d.gpus.length) {
        const pm = d.gpus.every(g => g.persistence_mode === 'Enabled');
        if (document.activeElement !== gpuEl('gpu-persistence')) gpuEl('gpu-persistence').checked = pm;
    }
    renderGpuCards(d.gpus);
    renderGpuProcs(d.processes, d.gpus);
}

function gpuBar(label, percent, text) {
    if (percent === null || percent === undefined || isNaN(percent)) {
        return `<div class="gpu-meter"><div class="gpu-meter-head"><span>${label}</span><span>${text ?? 'n/a'}</span></div>
            <div class="gpu-bar"><div class="gpu-bar-fill none" style="width:0"></div></div></div>`;
    }
    const p = Math.max(0, Math.min(100, percent));
    return `<div class="gpu-meter"><div class="gpu-meter-head"><span>${label}</span><span>${text}</span></div>
        <div class="gpu-bar"><div class="gpu-bar-fill ${gpuLevel(p)}" style="width:${p}%"></div></div></div>`;
}

function renderGpuCards(gpus) {
    gpuEl('gpu-cards').innerHTML = gpus.map(g => {
        const memPct = g.memory_total ? (g.memory_used / g.memory_total) * 100 : null;
        const powPct = g.power_limit ? (g.power_draw / g.power_limit) * 100 : null;
        const temp = g.temperature_gpu;
        const clkPct = g.clocks_max_gr ? (g.clocks_gr / g.clocks_max_gr) * 100 : null;
        const kv = (k, v) => `<div class="net-kv"><span>${k}</span><span>${v ?? '—'}</span></div>`;
        const pcie = g.pcie_link_gen_current
            ? `Gen ${gpuNum(g.pcie_link_gen_current)} x${gpuNum(g.pcie_link_width_current)} (max Gen ${gpuNum(g.pcie_link_gen_max)} x${gpuNum(g.pcie_link_width_max)})`
            : null;
        return `<div class="net-panel gpu-card">
            <h2 class="section-title">
                <span class="gpu-card-title"><i class="fas fa-microchip"></i> ${gpuEscape(g.name)}</span>
                <span class="net-badge info">GPU ${gpuEscape(g.index)}</span>
                ${g.pstate ? `<span class="net-badge" title="Performance state (P0 = max)">${gpuEscape(g.pstate)}</span>` : ''}
            </h2>
            <div class="gpu-meters">
                ${gpuBar('Utilization', g.utilization_gpu, `${gpuNum(g.utilization_gpu) ?? '—'} %`)}
                ${gpuBar('Memory', memPct, `${gpuNum(g.memory_used) ?? '—'} / ${gpuNum(g.memory_total) ?? '—'} MiB`)}
                ${gpuBar('Temperature', temp, temp === null ? 'n/a' : `${gpuNum(temp)} °C`)}
                ${gpuBar('Power', powPct, g.power_draw === null ? 'n/a' : `${gpuNum(g.power_draw, 1)} / ${gpuNum(g.power_limit)} W`)}
                ${gpuBar('Fan', g.fan_speed, g.fan_speed === null ? 'n/a (passive)' : `${gpuNum(g.fan_speed)} %`)}
                ${gpuBar('Graphics clock', clkPct, g.clocks_gr === null ? 'n/a' : `${gpuNum(g.clocks_gr)} / ${gpuNum(g.clocks_max_gr)} MHz`)}
            </div>
            <div class="gpu-kv-grid">
                ${kv('Memory clock', g.clocks_mem === null ? null : `${gpuNum(g.clocks_mem)} / ${gpuNum(g.clocks_max_mem)} MHz`)}
                ${kv('PCIe link', pcie)}
                ${kv('Memory bus load', g.utilization_memory === null ? null : `${gpuNum(g.utilization_memory)} %`)}
                ${kv('Display attached', gpuEscape(g.display_active))}
                ${kv('Compute mode', gpuEscape(g.compute_mode))}
                ${kv('VBIOS', gpuEscape(g.vbios_version))}
                ${kv('PCI bus', gpuEscape(g.pci_bus_id))}
                ${kv('Max power', g.power_max_limit === null ? null : `${gpuNum(g.power_max_limit)} W`)}
            </div>
        </div>`;
    }).join('') || '<div class="net-panel"><div class="net-empty">nvidia-smi lists no GPUs.</div></div>';
}

function renderGpuProcs(procs, gpus) {
    gpuEl('gpu-proc-count').textContent = procs.length || '';
    if (!procs.length) {
        gpuEl('gpu-procs').innerHTML = '<div class="net-empty">No compute processes (CUDA / OpenCL) running.</div>';
        return;
    }
    const gpuIndex = bus => {
        const g = gpus.find(x => (x.pci_bus_id || '').toLowerCase() === (bus || '').toLowerCase());
        return g ? g.index : '?';
    };
    gpuEl('gpu-procs').innerHTML = `<table class="net-table">
        <thead><tr><th>PID</th><th>Process</th><th>GPU</th><th>Memory</th></tr></thead>
        <tbody>${procs.map(p => `<tr>
            <td><a class="net-pid-link" href="/processes?pid=${p.pid}" title="Show process ${p.pid} on the Processes page">${p.pid}</a></td>
            <td class="gpu-proc-name" title="${gpuEscape(p.name)}">${gpuEscape(p.name)}</td>
            <td>${gpuEscape(gpuIndex(p.bus_id))}</td>
            <td>${p.memory === null ? '—' : `${gpuNum(p.memory)} MiB`}</td>
        </tr>`).join('')}</tbody></table>`;
}
