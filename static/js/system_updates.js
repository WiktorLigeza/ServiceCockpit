// Sidebar "System updates": badge with the number of pending OS updates, and a
// dialog to check / upgrade (backend: cockpit/features/system_updates.py).

(() => {
    let status = null;
    let pendingAction = null;
    const $ = id => document.getElementById(id);
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const CONFIRM_TEXT = {
        'upgrade': s => `Install ${s.count} update${s.count === 1 ? '' : 's'} with ${s.manager}? Services that are updated may restart briefly. This cannot be cancelled once it starts.`,
        'full-upgrade': s => `Full upgrade with ${s.manager}: installs all updates and may also add or remove packages to resolve changed dependencies (for example a new kernel). This cannot be cancelled once it starts.`,
        'autoremove': s => `Remove packages that were installed as dependencies and are no longer needed (${s.manager})?`,
    };

    const jobModal = new JobModal({
        jobUrl: '/api/system/updates/job',
        cancelUrl: '/api/system/updates/job/cancel',
        titles: {
            'refresh': '<i class="fas fa-sync-alt"></i> Checking for updates',
            'upgrade': '<i class="fas fa-box-open"></i> Installing updates',
            'full-upgrade': '<i class="fas fa-box-open"></i> Full system upgrade',
            'autoremove': '<i class="fas fa-broom"></i> Removing unused packages',
        },
        doneText: {
            'refresh': 'Package lists are up to date.',
            'upgrade': 'Updates installed.',
            'full-upgrade': 'System upgraded.',
            'autoremove': 'Unused packages removed.',
        },
        onFinish: () => load(true),
    });

    function ago(seconds) {
        if (!seconds) return 'never';
        const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
        if (s < 90) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 172800) return `${Math.round(s / 3600)} h ago`;
        return `${Math.round(s / 86400)} days ago`;
    }

    function renderBadge() {
        const n = status?.count || 0;
        const count = $('sidebar-sysupdate-count');
        const dot = $('sidebar-sysupdate-dot');
        const item = $('sidebar-sysupdate-item');
        if (!count) return;
        count.hidden = n === 0;
        count.textContent = n > 99 ? '99+' : n;
        dot.hidden = !(status?.reboot?.required);
        dot.title = status?.reboot?.required ? 'Reboot recommended' : '';
        item.title = n ? `${n} system update${n === 1 ? '' : 's'} available${status.security ? ` (${status.security} security)` : ''}`
            : status?.reboot?.required ? 'System is up to date - reboot recommended' : 'System updates';
    }

    function renderDialog() {
        if (!status || $('sysupd-modal').hidden) return;
        const s = status;
        $('sysupd-os').textContent = `${s.os} · ${s.manager || 'no package manager'} · kernel ${s.reboot.kernel}`;

        const listsAge = s.lists_updated ? `package lists from ${ago(s.lists_updated)}` : 'package lists never downloaded';
        $('sysupd-summary').innerHTML = s.error
            ? `<span class="sec">${esc(s.error)}</span>`
            : s.count
                ? `<strong>${s.count}</strong> update${s.count === 1 ? '' : 's'} available` +
                  (s.security ? ` · <span class="sec">${s.security} security</span>` : '') +
                  ` <span class="sysupd-os">· ${listsAge}</span>`
                : `<span class="ok">Up to date</span> <span class="sysupd-os">· ${listsAge}</span>`;

        const reboot = $('sysupd-reboot');
        reboot.hidden = !s.reboot.required;
        reboot.innerHTML = s.reboot.required
            ? `<i class="fas fa-redo"></i> Reboot recommended: ${s.reboot.reasons.map(esc).join('; ')}. Use Reboot in the sidebar when convenient.`
            : '';

        $('sysupd-list').innerHTML = s.count ? `<table>
            <thead><tr><th>Package</th><th>Installed</th><th>New</th><th>From</th></tr></thead>
            <tbody>${[...s.packages].sort((a, b) => (b.security - a.security) || a.name.localeCompare(b.name)).map(p => `<tr>
                <td>${esc(p.name)}${p.security ? '<span class="sysupd-tag">security</span>' : ''}</td>
                <td class="old">${esc(p.current || '—')}</td>
                <td class="ver">${esc(p.available)}</td>
                <td>${esc(p.origin || '')}</td>
            </tr>`).join('')}</tbody></table>` : '';

        const running = s.job?.state === 'running';
        const buttons = Object.entries(s.actions || {}).map(([action, label]) => {
            const primary = action === 'upgrade' && s.count;
            // Full upgrade stays available: it can pick up held-back packages a plain upgrade skips.
            const disabled = running || (action === 'upgrade' && !s.count);
            const text = action === 'upgrade' && s.count ? `${label} (${s.count})` : label;
            return `<button type="button" class="sudo-modal-btn${primary ? ' primary' : ''}" data-sysupd-action="${action}" ${disabled ? 'disabled' : ''}>${esc(text)}</button>`;
        }).join('');
        $('sysupd-actions').innerHTML = buttons;
    }

    async function load(fresh = false) {
        try {
            const resp = await fetch(`/api/system/updates${fresh ? '?fresh=1' : ''}`);
            if (!resp.ok) return;
            status = await resp.json();
        } catch (_) {
            return;
        }
        renderBadge();
        renderDialog();
        if (status.job?.state === 'running' && !$('sysupd-modal').hidden && jobModal.el?.hidden !== false) {
            jobModal.show();
        }
    }

    function showError(message) {
        const el = $('sysupd-error');
        el.textContent = message || '';
        el.style.display = message ? 'block' : 'none';
    }

    function askAction(action) {
        showError('');
        if (action === 'refresh') return run(action);
        pendingAction = action;
        $('sysupd-confirm-text').textContent = (CONFIRM_TEXT[action] || (() => `Run ${action}?`))(status);
        $('sysupd-confirm').hidden = false;
    }

    async function run(action) {
        $('sysupd-confirm').hidden = true;
        pendingAction = null;
        const res = await jobModal.start('/api/system/updates/run', { action }, () => run(action));
        if (!res.ok && !res.sudo) showError(res.error || 'Could not start.');
        load();
    }

    function open() {
        const modal = $('sysupd-modal');
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        $('sysupd-confirm').hidden = true;
        showError('');
        renderDialog();
        load();
    }

    function close() {
        const modal = $('sysupd-modal');
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
    }

    document.addEventListener('DOMContentLoaded', () => {
        const item = $('sidebar-sysupdate-item');
        if (!item) return;
        item.addEventListener('click', open);
        document.querySelectorAll('[data-sysupd-close]').forEach(el => el.addEventListener('click', close));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !$('sysupd-modal').hidden && $('sudo-modal')?.style.display !== 'block'
                && jobModal.el?.hidden !== false) close();
        });
        $('sysupd-actions').addEventListener('click', e => {
            const btn = e.target.closest('[data-sysupd-action]');
            if (btn && !btn.disabled) askAction(btn.dataset.sysupdAction);
        });
        $('sysupd-confirm-no').addEventListener('click', () => {
            $('sysupd-confirm').hidden = true;
            pendingAction = null;
        });
        $('sysupd-confirm-yes').addEventListener('click', () => pendingAction && run(pendingAction));

        load();
        setInterval(() => { if (!document.hidden) load(); }, 10 * 60 * 1000);
    });
})();
