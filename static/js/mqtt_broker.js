// MQTT Explorer: local broker (Mosquitto) detection, setup wizard and settings.
// Uses connectToMQTT() / showNotification() from mqtt_explorer.js.

const MQ_SKIP_KEY = 'mqttBrokerWizardSkipped';
let mqBroker = null;
let mqPendingLogin = null;   // username/password chosen in the wizard, used to auto-connect

const mqEl = id => document.getElementById(id);

const MQ_MODE_LABELS = {
    local: 'this device only',
    network: 'local network, no password',
    password: 'local network, with password',
};

const mqJobModal = new JobModal({
    jobUrl: '/api/mqtt/broker/job',
    cancelUrl: '/api/mqtt/broker/job/cancel',
    titles: {
        install: '<i class="fas fa-download"></i> Installing Mosquitto',
        configure: '<i class="fas fa-sliders-h"></i> Configuring Mosquitto',
        start: '<i class="fas fa-play"></i> Starting Mosquitto',
        restart: '<i class="fas fa-redo"></i> Restarting Mosquitto',
        stop: '<i class="fas fa-stop"></i> Stopping Mosquitto',
    },
    doneText: {
        install: 'Mosquitto is installed and running.',
        configure: 'Settings applied - Mosquitto restarted.',
        start: 'Mosquitto is running.',
        restart: 'Mosquitto restarted.',
        stop: 'Mosquitto stopped.',
    },
    onFinish: job => mqAfterJob(job),
});

document.addEventListener('DOMContentLoaded', () => {
    mqSetupListeners();
    mqLoadBroker(true);
});

function mqSkipped() {
    try { return localStorage.getItem(MQ_SKIP_KEY) === '1'; } catch (_) { return false; }
}

function mqSetSkipped(value) {
    try {
        if (value) localStorage.setItem(MQ_SKIP_KEY, '1');
        else localStorage.removeItem(MQ_SKIP_KEY);
    } catch (_) { /* ignore */ }
}

function mqNotify(message, type = 'success') {
    if (typeof showNotification === 'function') showNotification(message, type);
}

// ---------------------------------------------------------------- forms

function mqModeForm(name) {
    const mode = document.querySelector(`input[name="${name}"]:checked`)?.value || 'local';
    const fields = document.querySelector(`[data-fields-for="${name}"]`);
    return {
        mode,
        username: fields.querySelector('[data-field=username]').value.trim(),
        password: fields.querySelector('[data-field=password]').value,
    };
}

function mqBindModeForm(name) {
    const fields = document.querySelector(`[data-fields-for="${name}"]`);
    document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
        radio.addEventListener('change', () => { fields.hidden = mqModeForm(name).mode !== 'password'; });
    });
}

function mqSetMode(name, mode, username) {
    const radio = document.querySelector(`input[name="${name}"][value="${mode || 'local'}"]`);
    if (radio) radio.checked = true;
    const fields = document.querySelector(`[data-fields-for="${name}"]`);
    fields.hidden = (mode || 'local') !== 'password';
    if (username) fields.querySelector('[data-field=username]').value = username;
}

function mqCheckForm(form, errorEl) {
    errorEl.textContent = '';
    if (form.mode !== 'password') return true;
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(form.username)) {
        errorEl.textContent = 'Choose a username (letters, digits, . _ - @).';
        return false;
    }
    if (form.password.length < 6) {
        errorEl.textContent = 'Choose a password with at least 6 characters.';
        return false;
    }
    return true;
}

// ---------------------------------------------------------------- listeners

function mqSetupListeners() {
    mqBindModeForm('mq-mode');
    mqBindModeForm('mq-manage-mode');

    mqEl('mq-setup-go').addEventListener('click', mqSetupGo);
    mqEl('mq-setup-skip').addEventListener('click', () => {
        mqSetSkipped(true);
        mqShowWizard(false);
    });
    mqEl('mq-broker-btn').addEventListener('click', () => {
        // Nothing running here yet -> the setup wizard; otherwise the settings dialog.
        if (mqBroker && !mqBroker.broker_running) {
            mqSetSkipped(false);
            mqShowWizard(true);
        } else {
            mqOpenManage();
        }
    });

    mqEl('mq-manage-close').addEventListener('click', () => { mqEl('mq-broker-modal').hidden = true; });
    mqEl('mq-manage-apply').addEventListener('click', mqApplyManage);
    document.querySelectorAll('#mq-manage-service [data-service]').forEach(btn => {
        btn.addEventListener('click', () => mqService(btn.dataset.service));
    });
}

// ---------------------------------------------------------------- status

async function mqLoadBroker(initial = false) {
    try {
        const resp = await fetch('/api/mqtt/broker', { cache: 'no-store' });
        if (!resp.ok) return;
        mqBroker = await resp.json();
    } catch (_) {
        return;
    }
    mqRenderBroker();
    if (initial) {
        if (mqBroker.job?.state === 'running') mqJobModal.show();
        // Offer setup when nothing listens on 1883 here - unless the user skipped it.
        mqShowWizard(!mqBroker.broker_running && !mqSkipped());
    }
}

function mqRenderBroker() {
    const b = mqBroker;
    const line = mqEl('mq-broker');
    line.hidden = false;
    let cls = 'off';
    let text;
    let button = 'Manage';

    if (b.broker_running && !b.other_broker) {
        cls = 'ok';
        const access = b.mode ? MQ_MODE_LABELS[b.mode] : (b.local_only ? 'this device only' : 'network');
        text = `Local broker: Mosquitto ${b.version || ''} · running · ${access}`;
    } else if (b.broker_running) {
        cls = 'ok';
        text = `Local broker running on port ${b.port}${b.installed ? '' : ' (not Mosquitto)'}`;
        button = b.installed ? 'Manage' : '';
    } else if (b.installed) {
        cls = 'warn';
        text = `Mosquitto ${b.version || ''} is installed but not running`;
        button = 'Start';
    } else {
        text = 'No local broker on this device';
        button = 'Set up';
    }
    line.className = `mq-broker ${cls}`;
    mqEl('mq-broker-text').textContent = text;
    mqEl('mq-broker-text').title = text;
    mqEl('mq-broker-btn').hidden = !button;
    mqEl('mq-broker-btn').textContent = button;
}

function mqShowWizard(show) {
    const b = mqBroker || {};
    mqEl('mq-setup').hidden = !show;
    mqEl('mqtt-main').classList.toggle('mq-setup-mode', show);
    if (!show) return;

    const installed = !!b.installed;
    mqEl('mq-setup-title').textContent = installed
        ? 'Mosquitto is installed but not running'
        : 'No MQTT broker on this device';
    mqEl('mq-setup-text').textContent = installed
        ? 'Start the local broker, or skip and connect to a broker on another machine.'
        : 'MQTT Explorer needs a broker to talk to. Install Mosquitto here, or skip and connect to a broker on another machine.';
    mqEl('mq-setup-install').hidden = installed;
    mqEl('mq-setup-go').innerHTML = installed
        ? '<i class="fas fa-play"></i> Start Mosquitto'
        : '<i class="fas fa-download"></i> Install Mosquitto';

    const go = mqEl('mq-setup-go');
    go.disabled = !installed && !b.package_manager;
    mqEl('mq-setup-note').textContent = installed
        ? 'Needs your sudo password.'
        : b.package_manager
            ? `Installs the mosquitto package with ${b.package_manager}. Needs internet access and your sudo password.`
            : 'No supported package manager found (apt, dnf, yum, zypper, pacman, apk) - install Mosquitto manually.';
}

// ---------------------------------------------------------------- actions

async function mqSetupGo() {
    if (mqBroker?.installed) {
        return mqService('start');
    }
    const form = mqModeForm('mq-mode');
    if (!mqCheckForm(form, mqEl('mq-setup-error'))) return;
    mqPendingLogin = form.mode === 'password' ? { username: form.username, password: form.password } : {};
    const res = await mqJobModal.start('/api/mqtt/broker/install', form, mqSetupGo);
    if (!res.ok && !res.sudo) mqEl('mq-setup-error').textContent = res.error || 'Could not start the installation.';
}

async function mqService(action) {
    const res = await mqJobModal.start('/api/mqtt/broker/service', { action }, () => mqService(action));
    if (res.ok) {
        mqEl('mq-broker-modal').hidden = true;
        if (action !== 'stop') mqPendingLogin = mqPendingLogin || {};
    } else if (!res.sudo) {
        mqNotify(res.error || `Could not ${action} Mosquitto.`, 'error');
    }
}

function mqOpenManage() {
    const b = mqBroker || {};
    mqSetMode('mq-manage-mode', b.mode || (b.local_only ? 'local' : null) || 'local', b.username);
    const access = b.mode ? MQ_MODE_LABELS[b.mode] : (b.local_only ? 'this device only (Mosquitto default)' : 'custom configuration');
    mqEl('mq-manage-summary').textContent =
        `Mosquitto ${b.version || ''} · ${b.service || 'unknown'} · ${access}. Listening: ` +
        ((b.listeners || []).map(l => `${l.address}:${l.port}`).join(', ') || 'nothing');
    mqEl('mq-manage-error').textContent = '';
    const running = b.service === 'active';
    mqEl('mq-manage-service').querySelector('[data-service=start]').hidden = running;
    mqEl('mq-manage-service').querySelector('[data-service=restart]').hidden = !running;
    mqEl('mq-manage-service').querySelector('[data-service=stop]').hidden = !running;
    mqEl('mq-broker-modal').hidden = false;
}

async function mqApplyManage() {
    const form = mqModeForm('mq-manage-mode');
    if (!mqCheckForm(form, mqEl('mq-manage-error'))) return;
    mqPendingLogin = form.mode === 'password' ? { username: form.username, password: form.password } : {};
    const res = await mqJobModal.start('/api/mqtt/broker/configure', form, mqApplyManage);
    if (res.ok) {
        mqEl('mq-broker-modal').hidden = true;
    } else if (!res.sudo) {
        mqEl('mq-manage-error').textContent = res.error || 'Could not apply the settings.';
    }
}

async function mqAfterJob(job) {
    await mqLoadBroker();
    const login = mqPendingLogin;
    mqPendingLogin = null;
    if (job.state !== 'done' || !mqBroker?.broker_running) return;

    mqSetSkipped(false);
    mqShowWizard(false);
    if (job.kind === 'stop' || !login) return;

    // Point the connection form at the new local broker and connect.
    mqEl('mqtt-host').value = 'localhost';
    mqEl('mqtt-port').value = mqBroker.port || 1883;
    if (login.username !== undefined) {
        mqEl('mqtt-username').value = login.username || '';
        mqEl('mqtt-password').value = login.password || '';
    }
    if (typeof connectToMQTT === 'function') {
        if (typeof disconnectFromMQTT === 'function' && document.getElementById('disconnect-btn')?.style.display !== 'none') {
            disconnectFromMQTT();
        }
        connectToMQTT();
    }
    mqNotify('Connecting to the local Mosquitto broker…', 'success');
}
