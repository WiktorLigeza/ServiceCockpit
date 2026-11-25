// Header clock: shows the *device's* time (in the device's time zone), from the
// `clock` block in the metrics telemetry, ticking locally between updates.
// Clicking it opens the time zone / NTP dialog (backend: cockpit/features/clock.py).

(() => {
    let offsetMs = null;      // device epoch - browser epoch, measured at each telemetry update
    let utcOffsetMin = 0;     // device's offset from UTC
    let zone = '';
    let abbrev = '';
    let settings = null;      // last /api/time response

    const $ = id => document.getElementById(id);
    const pad = n => String(n).padStart(2, '0');

    // A Date whose UTC fields read as the device's local wall-clock time.
    function deviceWallClock() {
        return new Date(Date.now() + (offsetMs || 0) + utcOffsetMin * 60000);
    }

    function formatOffset(min) {
        const sign = min < 0 ? '-' : '+';
        const abs = Math.abs(min);
        return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }

    function dateText(d) {
        return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    }

    function render() {
        if (offsetMs === null) return;
        const d = deviceWallClock();
        const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        const hms = `${hm}:${pad(d.getUTCSeconds())}`;
        const timeEl = $('device-clock-time');
        if (timeEl && timeEl.textContent !== hm) timeEl.textContent = hm;

        const menu = $('device-clock-menu');
        if (menu) {
            const lines = [`Device time: ${hms}`, dateText(d), `${zone || 'Time zone unknown'} (${abbrev}, ${formatOffset(utcOffsetMin)})`];
            const drift = Math.round(offsetMs / 1000);
            if (Math.abs(drift) >= 3) {
                lines.push(`Device clock is ${Math.abs(drift)} s ${drift > 0 ? 'ahead of' : 'behind'} this computer`);
            }
            lines.push('Click to change the time zone or NTP servers');
            menu.textContent = lines.join('\n');
        }

        if (!$('clock-modal')?.hidden) {
            $('clock-now-time').textContent = hms;
            $('clock-now-date').textContent = dateText(d);
            $('clock-now-zone').textContent = `${zone || '?'} · ${abbrev} · ${formatOffset(utcOffsetMin)}`;
        }
    }

    function applyClock(clock) {
        if (!clock || typeof clock.epoch_ms !== 'number') return;
        offsetMs = clock.epoch_ms - Date.now();
        utcOffsetMin = clock.utc_offset_min || 0;
        zone = clock.timezone || '';
        abbrev = clock.abbrev || '';
        const item = $('device-clock');
        if (item) item.hidden = false;
        render();
    }

    window.updateDeviceClock = applyClock;
    setInterval(render, 1000);

    // ------------------------------------------------------------ dialog

    function showError(message) {
        const el = $('clock-error');
        el.textContent = message || '';
        el.style.display = message ? 'block' : 'none';
    }

    function fillZones(filter = '') {
        const list = $('clock-tz-list');
        const zones = settings?.timezones || [];
        const needle = filter.trim().toLowerCase().replace(/\s+/g, '_');
        const shown = needle ? zones.filter(z => z.toLowerCase().includes(needle)) : zones;
        list.innerHTML = shown.map(z => `<option value="${z}">${z.replace(/_/g, ' ')}</option>`).join('');
        if (shown.includes(settings?.timezone)) list.value = settings.timezone;
        else if (shown.length === 1) list.value = shown[0];
    }

    function renderSettings() {
        const s = settings;
        applyClock(s);
        fillZones($('clock-tz-search').value);

        const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const browserBtn = $('clock-tz-browser');
        browserBtn.hidden = !browserZone || browserZone === s.timezone || !s.timezones.includes(browserZone);
        browserBtn.textContent = `Use this browser's time zone (${browserZone})`;
        browserBtn.dataset.zone = browserZone;

        const ntp = $('clock-ntp');
        ntp.disabled = !s.timedatectl || !s.can_ntp;
        ntp.checked = !!s.ntp_enabled;
        $('clock-ntp-status').textContent = !s.timedatectl
            ? 'timedatectl is not available on this system.'
            : !s.can_ntp ? 'No NTP service is installed.'
            : s.ntp_enabled ? (s.ntp_synchronized ? 'Synchronized with a time server.' : 'Enabled, not synchronized yet.')
            : 'Off - the time can be set by hand.';
        $('clock-manual').hidden = !s.timedatectl || !!s.ntp_enabled;
        renderNtpServers(s.ntp_servers);
        renderNtpServer(s.ntp_server);
        $('clock-tz-save').disabled = !s.timedatectl;
    }

    const BACKEND_NAMES = { timesyncd: 'systemd-timesyncd', chrony: 'chrony' };

    function renderNtpServers(n) {
        const box = $('clock-ntp-servers');
        box.hidden = !n || !n.backend;
        if (box.hidden) return;
        $('clock-ntp-input').value = (n.servers || []).join(' ');
        $('clock-ntp-exclusive').checked = !!n.exclusive;
        $('clock-ntp-reset').disabled = !(n.servers || []).length;
        const lines = [`Client: ${BACKEND_NAMES[n.backend] || n.backend}`];
        if (!(n.servers || []).length) {
            const defaults = [...(n.link_servers || []), ...(n.default_servers || [])];
            lines.push(`Using the system defaults${defaults.length ? ` (${defaults.join(', ')})` : ''}.`);
        }
        if (n.current) lines.push(`Synchronizing with: ${n.current}${n.stratum != null ? ` · stratum ${n.stratum}` : ''}`);
        else if (settings?.ntp_enabled) lines.push('No server selected yet.');
        if (n.backend === 'chrony' && (n.sources || []).length) {
            lines.push(...n.sources.map(src =>
                `${src.state === '*' ? '★' : '·'} ${src.address}  stratum ${src.stratum ?? '?'}  offset ${src.offset_ms ?? '?'} ms`));
        }
        $('clock-ntp-info').textContent = lines.join('\n');
    }

    function ntpInputServers() {
        return $('clock-ntp-input').value.split(/[\s,;]+/).filter(Boolean);
    }

    function setTestResult(text, ok) {
        const el = $('clock-ntp-test-result');
        el.textContent = text;
        el.classList.toggle('ok', ok === true);
        el.classList.toggle('bad', ok === false);
    }

    async function testNtpServers() {
        const servers = ntpInputServers();
        if (!servers.length) {
            showError('Enter the address of your NTP server first.');
            return;
        }
        showError('');
        const btn = $('clock-ntp-test');
        btn.disabled = true;
        setTestResult(`Testing ${servers.join(', ')}...`);
        const results = await Promise.all(servers.map(async server => {
            try {
                const resp = await fetch('/api/time/ntp-test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ server }),
                });
                const d = await resp.json();
                return d.success
                    ? { ok: true, text: `✓ ${server} (${d.address}): stratum ${d.stratum}, offset ${d.offset_ms} ms, delay ${d.delay_ms} ms` }
                    : { ok: false, text: `✗ ${d.error || server + ': failed'}` };
            } catch (e) {
                return { ok: false, text: `✗ ${server}: ${e.message}` };
            }
        }));
        btn.disabled = false;
        setTestResult(results.map(r => r.text).join('\n'), results.every(r => r.ok));
    }

    async function saveNtpServers(servers) {
        const list = servers ?? ntpInputServers();
        const exclusive = $('clock-ntp-exclusive').checked;
        const btn = $('clock-ntp-save');
        btn.disabled = true;
        const data = await api('/api/time/ntp-servers', { servers: list, exclusive }, () => saveNtpServers(list));
        btn.disabled = false;
        if (data) {
            settings = data.settings;
            setTestResult(list.length ? 'Saved. The NTP client was restarted and will sync with the new server(s).' : 'Restored the default servers.', true);
            renderSettings();
            // The client needs a few seconds to pick the new server; refresh the status.
            setTimeout(async () => {
                if ($('clock-modal').hidden) return;
                const fresh = await api('/api/time');
                if (fresh) { settings = fresh; renderNtpServers(fresh.ntp_servers); }
            }, 5000);
        }
    }

    // ---- this device as an NTP server (chrony)

    let serverJob = null;

    function serverJobModal() {
        if (!serverJob && window.JobModal) {
            serverJob = new JobModal({
                jobUrl: '/api/time/job',
                cancelUrl: '/api/time/job/cancel',
                titles: { 'ntp-server': '<i class="far fa-clock"></i> Setting up the NTP server',
                          'ntp-server-off': '<i class="far fa-clock"></i> Turning the NTP server off' },
                doneText: { 'ntp-server': 'This device now serves time to your network.',
                            'ntp-server-off': 'The NTP server is off.' },
                onFinish: async () => {
                    const fresh = await api('/api/time');
                    if (fresh) { settings = fresh; renderSettings(); }
                },
            });
        }
        return serverJob;
    }

    function renderNtpServer(srv) {
        const section = $('clock-server-section');
        section.hidden = !srv || (!srv.chrony_installed && !srv.can_install);
        if (section.hidden) return;
        const box = $('clock-server-enabled');
        box.checked = !!srv.enabled;
        $('clock-server-allow').value = (srv.enabled ? srv.allow : (srv.suggested || []).slice(0, 1))
            .map(a => a === 'all' ? 'all' : a).join(' ');
        $('clock-server-local').checked = !!srv.local_stratum;
        updateServerForm();

        const lines = [];
        if (srv.enabled) {
            lines.push(`Serving time to ${srv.allow.map(a => a === 'all' ? 'everyone' : a).join(', ')} · ` +
                (srv.listening ? 'listening on UDP 123 ✓' : 'NOT listening on UDP 123 ✗'));
        } else if (!srv.chrony_installed) {
            lines.push('Needs chrony - it will be installed and replace systemd-timesyncd (the NTP servers above are kept).');
        }
        if (!srv.firewall) lines.push('No firewall is installed, so nothing blocks port 123.');
        else if (!srv.firewall_active) lines.push(`Firewall (${srv.firewall}) is off - the rule is added for when you turn it on.`);
        else lines.push(`Firewall (${srv.firewall}) is on.`);
        $('clock-server-status').textContent = lines.join('\n');
        $('clock-server-fw').disabled = !srv.firewall;
        if (srv.job === 'running') serverJobModal()?.show();
    }

    function updateServerForm() {
        const srv = settings?.ntp_server || {};
        const want = $('clock-server-enabled').checked;
        $('clock-server-form').hidden = !want && !srv.enabled;
        ['clock-server-allow', 'clock-server-local'].forEach(id => { $(id).disabled = !want; });
        $('clock-server-apply').textContent = !want ? 'Turn NTP server off'
            : srv.enabled ? 'Apply' : (srv.chrony_installed ? 'Start NTP server' : 'Install chrony and start');
        $('clock-server-apply').classList.toggle('danger', !want);
    }

    async function applyNtpServer() {
        const enabled = $('clock-server-enabled').checked;
        const body = {
            enabled,
            allow: $('clock-server-allow').value,
            local_stratum: $('clock-server-local').checked,
            open_firewall: $('clock-server-fw').checked,
        };
        if (enabled && !body.allow.trim()) {
            showError('Enter the network allowed to use this server, e.g. 192.168.0.0/24.');
            return;
        }
        showError('');
        const modal = serverJobModal();
        if (!modal) return;
        const res = await modal.start('/api/time/ntp-server', body, applyNtpServer);
        if (!res.ok && res.error) showError(res.error);
    }

    async function api(url, body, retry) {
        showError('');
        const resp = await fetch(url, body === undefined ? {} : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 && data.error === 'sudo_required') {
            if (window.showSudoModal) window.showSudoModal(data.message, retry);
            return null;
        }
        if (!resp.ok || data.success === false) {
            showError(data.error || `Request failed (${resp.status})`);
            return null;
        }
        return data;
    }

    async function openDialog() {
        const modal = $('clock-modal');
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        showError('');
        setTestResult('');
        $('clock-tz-search').value = '';
        render();
        const data = await api('/api/time');
        if (!data) return;
        settings = data;
        renderSettings();
        $('clock-tz-search').focus();
    }

    function closeDialog() {
        const modal = $('clock-modal');
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
    }

    async function saveZone(zoneName) {
        const chosen = zoneName || $('clock-tz-list').value;
        if (!chosen) {
            showError('Pick a time zone from the list.');
            return;
        }
        const btn = $('clock-tz-save');
        btn.disabled = true;
        const data = await api('/api/time/timezone', { timezone: chosen }, () => saveZone(chosen));
        btn.disabled = false;
        if (data) {
            settings = data.settings;
            $('clock-tz-search').value = '';
            renderSettings();
        }
    }

    async function setNtp(enabled) {
        const data = await api('/api/time/ntp', { enabled }, () => setNtp(enabled));
        if (data) {
            settings = data.settings;
        }
        if (settings) renderSettings();  // also resets the checkbox if it failed
    }

    async function setManualTime() {
        const value = $('clock-manual-time').value;
        if (!value) {
            showError('Pick a date and time.');
            return;
        }
        const data = await api('/api/time/set', { time: value }, setManualTime);
        if (data) {
            settings = data.settings;
            renderSettings();
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const item = $('device-clock');
        if (!item) return;
        item.addEventListener('click', openDialog);
        document.querySelectorAll('[data-clock-close]').forEach(el => el.addEventListener('click', closeDialog));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !$('clock-modal').hidden && $('sudo-modal')?.style.display !== 'block') closeDialog();
        });
        $('clock-tz-search').addEventListener('input', e => fillZones(e.target.value));
        $('clock-tz-search').addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                $('clock-tz-list').focus();
            }
            if (e.key === 'Enter') saveZone();
        });
        $('clock-tz-list').addEventListener('dblclick', () => saveZone());
        $('clock-tz-list').addEventListener('keydown', e => { if (e.key === 'Enter') saveZone(); });
        $('clock-tz-save').addEventListener('click', () => saveZone());
        $('clock-tz-browser').addEventListener('click', e => saveZone(e.target.dataset.zone));
        $('clock-ntp').addEventListener('change', e => setNtp(e.target.checked));
        $('clock-manual-set').addEventListener('click', setManualTime);
        $('clock-ntp-test').addEventListener('click', testNtpServers);
        $('clock-ntp-save').addEventListener('click', () => saveNtpServers());
        $('clock-ntp-reset').addEventListener('click', () => saveNtpServers([]));
        $('clock-ntp-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveNtpServers(); });
        $('clock-server-enabled').addEventListener('change', updateServerForm);
        $('clock-server-apply').addEventListener('click', applyNtpServer);
        $('clock-manual').addEventListener('focusin', () => {
            // Pre-fill with the device's current time.
            const input = $('clock-manual-time');
            if (!input.value) input.value = deviceWallClock().toISOString().slice(0, 19);
        });
    });
})();
