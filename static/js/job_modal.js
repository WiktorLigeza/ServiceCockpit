// Progress dialog for a backend BackgroundJob (cockpit/core/jobs.py): shows the
// current step, an optional link (e.g. a login URL), the live log, and
// Cancel / Close. Styles: css/setup_wizard.css.
//
//   const modal = new JobModal({
//       jobUrl: '/api/x/job', cancelUrl: '/api/x/job/cancel',
//       titles: { install: 'Installing X' },          // per job kind (HTML allowed)
//       doneText: { install: 'X is installed.' },
//       linkText: 'Open this link to continue:',      // shown when job.link is set
//       linkButton: 'Open', waitingText: 'Waiting…',  // status line while a link is shown
//       onFinish: job => {},                          // once, when the job ends
//       onPoll: job => {},                            // on every poll while running
//   });
//   modal.start('/api/x/install', body, retryFn);    // POST, then show progress
//   modal.show();                                    // attach to a job already running

class JobModal {
    constructor(options) {
        this.opts = options;
        this.timer = null;
        this.finishedId = null;
        this.el = null;
    }

    static escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    build() {
        if (this.el) return;
        const el = document.createElement('div');
        el.className = 'job-modal';
        el.hidden = true;
        el.innerHTML = `
            <div class="job-modal-card" role="dialog" aria-modal="true">
                <div class="job-modal-title"></div>
                <div class="job-modal-status"></div>
                <div class="job-modal-link" hidden>
                    <div class="job-modal-link-text"></div>
                    <a class="job-modal-link-url" href="#" target="_blank" rel="noopener"></a>
                    <div class="job-modal-link-actions">
                        <a class="btn btn-primary btn-sm job-modal-link-open" href="#" target="_blank" rel="noopener"></a>
                        <button type="button" class="btn btn-outline-light btn-sm job-modal-link-copy"><i class="fas fa-copy"></i> Copy link</button>
                    </div>
                </div>
                <details class="job-modal-details">
                    <summary>Show log</summary>
                    <pre class="job-modal-log"></pre>
                </details>
                <div class="job-modal-actions">
                    <button type="button" class="btn btn-secondary btn-sm job-modal-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary btn-sm job-modal-close" hidden>Close</button>
                </div>
            </div>`;
        document.body.appendChild(el);
        this.el = el;
        const q = sel => el.querySelector(sel);
        this.$ = {
            title: q('.job-modal-title'), status: q('.job-modal-status'), link: q('.job-modal-link'),
            linkText: q('.job-modal-link-text'), linkUrl: q('.job-modal-link-url'), linkOpen: q('.job-modal-link-open'),
            details: q('.job-modal-details'), log: q('.job-modal-log'),
            cancel: q('.job-modal-cancel'), close: q('.job-modal-close'),
        };
        this.$.linkText.textContent = this.opts.linkText || 'Open this link to continue:';
        this.$.linkOpen.innerHTML = `<i class="fas fa-external-link-alt"></i> ${JobModal.escape(this.opts.linkButton || 'Open link')}`;
        this.$.close.addEventListener('click', () => this.hide());
        this.$.cancel.addEventListener('click', async () => {
            this.$.cancel.disabled = true;
            await fetch(this.opts.cancelUrl, { method: 'POST' }).catch(() => {});
            this.$.cancel.disabled = false;
            this.poll();
        });
        q('.job-modal-link-copy').addEventListener('click', () => this.copy(this.$.linkUrl.href));
    }

    async copy(text) {
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
        } catch (_) { /* ignore */ }
    }

    // POST to start a job. Returns {ok, error}; on success the dialog opens.
    async start(url, body = {}, retry = null) {
        let resp, data;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            data = await resp.json().catch(() => ({}));
        } catch (e) {
            return { ok: false, error: String(e) };
        }
        if (resp.status === 401 && data.error === 'sudo_required') {
            if (retry && window.showSudoModal) window.showSudoModal(data.message, retry);
            return { ok: false, sudo: true };
        }
        if (!resp.ok || data.success === false) {
            // 409 usually means another task is running - show it.
            if (resp.status === 409) this.show();
            return { ok: false, error: data.error || `Request failed (${resp.status})` };
        }
        this.finishedId = null;
        this.show();
        return { ok: true };
    }

    show() {
        this.build();
        this.el.hidden = false;
        this.poll();
    }

    hide() {
        clearTimeout(this.timer);
        if (this.el) this.el.hidden = true;
    }

    async poll() {
        clearTimeout(this.timer);
        let job = {};
        try {
            job = await (await fetch(this.opts.jobUrl)).json();
        } catch (_) {
            this.timer = setTimeout(() => this.poll(), 2000);
            return;
        }
        if (!job.kind) {
            this.hide();
            return;
        }
        this.render(job);
        if (job.state === 'running') {
            this.timer = setTimeout(() => this.poll(), 1000);
            if (this.opts.onPoll) this.opts.onPoll(job);
        } else if (this.finishedId !== job.id) {
            this.finishedId = job.id;
            if (this.opts.onFinish) this.opts.onFinish(job);
        }
    }

    render(job) {
        const running = job.state === 'running';
        const titles = this.opts.titles || {};
        const done = this.opts.doneText || {};
        this.$.title.innerHTML = titles[job.kind] || 'Working';

        const last = [...(job.log || [])].reverse().find(l => l.trim()) || '';
        const runningText = job.link && this.opts.waitingText
            ? this.opts.waitingText
            : JobModal.escape(last.slice(0, 160) || 'Working…');
        this.$.status.innerHTML = {
            running: `<i class="fas fa-circle-notch fa-spin"></i> <span>${runningText}</span>`,
            done: `<i class="fas fa-check-circle job-ok"></i> <span>${JobModal.escape(done[job.kind] || 'Done.')}</span>`,
            failed: '<i class="fas fa-times-circle job-bad"></i> <span>Failed - see the log below.</span>',
            cancelled: '<i class="fas fa-ban job-warn"></i> <span>Cancelled.</span>',
        }[job.state] || '';

        const showLink = running && !!job.link;
        this.$.link.hidden = !showLink;
        if (showLink) {
            this.$.linkUrl.href = job.link;
            this.$.linkUrl.textContent = job.link;
            this.$.linkOpen.href = job.link;
        }

        const log = this.$.log;
        const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.textContent = (job.log || []).join('\n');
        if (atBottom) log.scrollTop = log.scrollHeight;
        if (job.state === 'failed') this.$.details.open = true;

        // Package upgrades and the like must not be interrupted - no Cancel for them.
        this.$.cancel.hidden = !running || job.cancellable === false;
        this.$.close.hidden = running;
    }
}

window.JobModal = JobModal;
