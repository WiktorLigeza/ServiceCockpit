// MQTT Explorer JavaScript
let socket;
let isConnected = false;
let isPaused = false;
let topicFrequencies = {};
let selectedTopic = null;
let messageCount = 0;
let knownTopics = new Set(); // Track known topics
let activeTab = 'history'; // Track active tab

const MAX_TOPIC_HISTORY = 50;
const topicCache = new Map(); // topic -> { history: [], current: null }

let topicTreeRoot = null;
const expandedNodes = new Set(); // folder path strings

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function() {
    initializeSocketIO();
    setupEventListeners();
    loadConnectionSettings();
});

function initializeSocketIO() {
    socket = io('/mqtt', {
        transports: ['websocket', 'polling']
    });

    socket.on('connect', function() {
        console.log('Connected to MQTT socket');
    });

    socket.on('mqtt_status', function(data) {
        updateConnectionStatus(data.connected, data.message);
    });

    socket.on('mqtt_topics', function(data) {
        updateTopicsList(data.topics);
    });

    socket.on('mqtt_message', function(data) {
        if (!isPaused) {
            handleNewMessage(data);
        }
        updateTopicFrequency(data.topic);
    });

    socket.on('mqtt_error', function(data) {
        showNotification('MQTT Error: ' + data.error, 'error');
    });
}

function setupEventListeners() {
    // Connection buttons
    document.getElementById('connect-btn').addEventListener('click', connectToMQTT);
    document.getElementById('disconnect-btn').addEventListener('click', disconnectFromMQTT);

    // Subscribe functionality
    document.getElementById('subscribe-btn').addEventListener('click', subscribeToTopic);
    document.getElementById('subscribe-topic').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            subscribeToTopic();
        }
    });

    // Publish functionality
    document.getElementById('publish-btn').addEventListener('click', publishMessage);

    // Message controls
    document.getElementById('clear-messages-btn').addEventListener('click', clearMessages);
    document.getElementById('pause-messages-btn').addEventListener('click', togglePauseMessages);
    document.getElementById('copy-current-btn').addEventListener('click', copyCurrentMessage);

    // Recent connections
    document.getElementById('mqtt-recent').addEventListener('change', function() {
        const value = (this.value || '').trim();
        if (!value) return;
        const [host, port] = value.split(':');
        if (host) document.getElementById('mqtt-host').value = host;
        if (port) document.getElementById('mqtt-port').value = port;
    });

    // Topics search
    document.getElementById('topics-search').addEventListener('input', filterTopics);
    
    // Tab functionality
    document.querySelectorAll('.tab-button:not(.control-button)').forEach(button => {
        button.addEventListener('click', function() {
            switchTab(this.dataset.tab);
        });
    });
}

async function loadConnectionSettings() {
    // Username is kept locally; host/port history comes from server-side config.json
    try {
        const resp = await fetch('/api/mqtt/connection_settings', { cache: 'no-store' });
        if (resp.ok) {
            const data = await resp.json();
            const connections = (data || {}).connections || {};
            const last = connections.last || { host: 'localhost', port: 1883 };
            const history = Array.isArray(connections.history) ? connections.history : [];

            document.getElementById('mqtt-host').value = last.host || 'localhost';
            document.getElementById('mqtt-port').value = last.port || 1883;
            populateRecentConnections(history, last);
        } else {
            populateRecentConnections([], { host: 'localhost', port: 1883 });
        }
    } catch (e) {
        populateRecentConnections([], { host: 'localhost', port: 1883 });
    }

    const settings = JSON.parse(localStorage.getItem('mqttSettings') || '{}');
    if (settings.username) document.getElementById('mqtt-username').value = settings.username;
}

function saveConnectionSettings() {
    const settings = {
        username: document.getElementById('mqtt-username').value
    };
    localStorage.setItem('mqttSettings', JSON.stringify(settings));
}

function populateRecentConnections(history, last) {
    const select = document.getElementById('mqtt-recent');
    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select recent…';
    select.appendChild(placeholder);

    const normalized = [];
    history.forEach(h => {
        if (!h || !h.host) return;
        const host = String(h.host);
        const port = parseInt(h.port) || 1883;
        normalized.push({ host, port });
    });

    // Ensure last is present
    if (last && last.host) {
        const lh = String(last.host);
        const lp = parseInt(last.port) || 1883;
        if (!normalized.some(x => x.host === lh && x.port === lp)) {
            normalized.push({ host: lh, port: lp });
        }
    }

    // Most recent last
    normalized.reverse().forEach(entry => {
        const opt = document.createElement('option');
        opt.value = `${entry.host}:${entry.port}`;
        opt.textContent = `${entry.host}:${entry.port}`;
        select.appendChild(opt);
    });

    // Select last
    if (last && last.host) {
        select.value = `${last.host}:${parseInt(last.port) || 1883}`;
    }
}

function connectToMQTT() {
    const host = document.getElementById('mqtt-host').value || 'localhost';
    const port = parseInt(document.getElementById('mqtt-port').value) || 1883;
    const username = document.getElementById('mqtt-username').value || '';
    const password = document.getElementById('mqtt-password').value || '';

    saveConnectionSettings();

    // Update UI immediately (server also persists this)
    try {
        const recent = document.getElementById('mqtt-recent');
        const val = `${host}:${port}`;
        if (![...recent.options].some(o => o.value === val)) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            recent.appendChild(opt);
        }
        recent.value = val;
    } catch (e) {
        // ignore
    }

    socket.emit('mqtt_connect', {
        host: host,
        port: port,
        username: username,
        password: password
    });

    document.getElementById('connect-btn').disabled = true;
    updateConnectionStatus(false, 'Connecting...');
}

function disconnectFromMQTT() {
    socket.emit('mqtt_disconnect');
    document.getElementById('disconnect-btn').style.display = 'none';
    document.getElementById('connect-btn').style.display = 'inline-block';
    document.getElementById('connect-btn').disabled = false;
    updateConnectionStatus(false, 'Disconnected');
    clearTopics();
    clearMessages();
}

function updateConnectionStatus(connected, message) {
    isConnected = connected;
    const statusElement = document.getElementById('connection-status');
    const connectBtn = document.getElementById('connect-btn');
    const disconnectBtn = document.getElementById('disconnect-btn');

    if (connected) {
        statusElement.innerHTML = '<i class="fas fa-circle" style="color: green;"></i> Connected';
        statusElement.className = 'connection-status connected';
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'inline-block';
        connectBtn.disabled = false;
    } else {
        statusElement.innerHTML = '<i class="fas fa-circle" style="color: red;"></i> ' + (message || 'Disconnected');
        statusElement.className = 'connection-status disconnected';
        connectBtn.style.display = 'inline-block';
        disconnectBtn.style.display = 'none';
        connectBtn.disabled = false;
    }
}

function subscribeToTopic() {
    if (!isConnected) {
        showNotification('Please connect to MQTT broker first', 'error');
        return;
    }

    const topic = document.getElementById('subscribe-topic').value.trim();
    if (!topic) {
        showNotification('Please enter a topic to subscribe to', 'error');
        return;
    }

    socket.emit('mqtt_subscribe', { topic: topic });
    document.getElementById('subscribe-topic').value = '';
    showNotification('Subscribed to: ' + topic, 'success');
}

function publishMessage() {
    if (!isConnected) {
        showNotification('Please connect to MQTT broker first', 'error');
        return;
    }

    const topic = document.getElementById('publish-topic').value.trim();
    const payload = document.getElementById('publish-payload').value;
    const qos = parseInt(document.getElementById('publish-qos').value);
    const retain = document.getElementById('publish-retain').checked;

    if (!topic) {
        showNotification('Please enter a topic to publish to', 'error');
        return;
    }

    socket.emit('mqtt_publish', {
        topic: topic,
        payload: payload,
        qos: qos,
        retain: retain
    });

    showNotification('Message published to: ' + topic, 'success');
}

function updateTopicsList(topics) {
    // Backward compatibility: previous name
    updateTopicsTree(topics);
}

function getTopicState(topic) {
    if (!topicCache.has(topic)) {
        topicCache.set(topic, { history: [], current: null });
    }
    return topicCache.get(topic);
}

function updateTopicsTree(topics) {
    const container = document.getElementById('topics-container');
    const list = Array.isArray(topics) ? topics : [];

    if (list.length === 0) {
        container.innerHTML = '<div class="no-topics">No topics discovered yet</div>';
        knownTopics.clear();
        topicTreeRoot = null;
        return;
    }

    let changed = false;
    list.forEach(t => {
        if (!knownTopics.has(t)) {
            knownTopics.add(t);
            changed = true;
        }
    });

    if (!changed && topicTreeRoot) {
        // Still update frequencies in-place (DOM updates happen elsewhere)
        return;
    }

    topicTreeRoot = buildTopicTree([...knownTopics]);
    renderTopicTree(container, topicTreeRoot);
    applyTopicFilter();
}

function buildTopicTree(topics) {
    const root = { children: new Map(), topic: null };
    topics.forEach(fullTopic => {
        const parts = String(fullTopic).split('/').filter(p => p.length > 0);
        let node = root;
        let path = '';
        parts.forEach((part, idx) => {
            path = path ? `${path}/${part}` : part;
            if (!node.children.has(part)) {
                node.children.set(part, { children: new Map(), topic: null, path });
            }
            node = node.children.get(part);
            if (idx === parts.length - 1) {
                node.topic = fullTopic;
            }
        });
    });
    return root;
}

function renderTopicTree(container, root) {
    container.innerHTML = '';
    const tree = document.createElement('div');
    tree.className = 'topics-tree';
    container.appendChild(tree);

    const children = [...root.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    children.forEach(([name, node]) => {
        renderTopicNode(tree, name, node, 0);
    });
}

function renderTopicNode(parent, name, node, depth) {
    const hasChildren = node.children && node.children.size > 0;
    const hasLeaf = !!node.topic;

    // Render folder row when it has children (even if it is also a leaf)
    if (hasChildren) {
        const folderRow = document.createElement('div');
        folderRow.className = 'topic-node folder';
        folderRow.dataset.nodePath = node.path;
        folderRow.style.paddingLeft = `${15 + depth * 16}px`;
        const expanded = expandedNodes.has(node.path) || depth === 0;
        if (expanded) expandedNodes.add(node.path);
        folderRow.innerHTML = `
            <span class="node-caret"><i class="fas ${expanded ? 'fa-caret-down' : 'fa-caret-right'}"></i></span>
            <span class="node-label">${escapeHtml(name)}</span>
        `;
        folderRow.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleNodeExpanded(node.path);
        });
        parent.appendChild(folderRow);

        if (hasLeaf) {
            parent.appendChild(createLeafRow(node.topic, depth + 1, name));
        }

        if (expanded) {
            const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            sortedChildren.forEach(([childName, childNode]) => {
                renderTopicNode(parent, childName, childNode, depth + 1);
            });
        }
        return;
    }

    // Leaf only
    if (hasLeaf) {
        parent.appendChild(createLeafRow(node.topic, depth, name));
    }
}

function toggleNodeExpanded(path) {
    if (expandedNodes.has(path)) {
        expandedNodes.delete(path);
    } else {
        expandedNodes.add(path);
    }
    const container = document.getElementById('topics-container');
    if (topicTreeRoot) {
        renderTopicTree(container, topicTreeRoot);
        applyTopicFilter();
    }
}

function createLeafRow(topic, depth, labelFallback) {
    const row = document.createElement('div');
    row.className = 'topic-node leaf';
    row.dataset.topic = topic;
    row.style.paddingLeft = `${15 + depth * 16}px`;

    const frequency = topicFrequencies[topic] || { count: 0, rate: 0 };
    const idSafe = topic.replace(/[^a-zA-Z0-9]/g, '_');

    row.innerHTML = `
        <span class="node-caret"></span>
        <span class="node-label">${escapeHtml(topic)}</span>
        <span class="topic-frequency" id="freq-${idSafe}">${frequency.rate.toFixed(1)} msg/s</span>
    `;
    if (selectedTopic === topic) {
        row.classList.add('active');
    }
    row.addEventListener('click', () => selectTopic(topic));
    return row;
}

function selectTopic(topic) {
    // Update active highlights
    document.querySelectorAll('[data-topic]').forEach(item => {
        item.classList.remove('active');
    });
    const topicElement = document.querySelector(`[data-topic="${cssEscape(topic)}"]`);
    if (topicElement) topicElement.classList.add('active');

    selectedTopic = topic;
    document.getElementById('selected-topic-name').textContent = `- ${topic}`;
    
    // Auto-fill publish topic
    document.getElementById('publish-topic').value = topic;

    renderSelectedTopicFromCache();
}

function handleNewMessage(data) {
    if (!data || !data.topic) return;

    // Always cache messages (pause only affects live UI updates)
    const state = getTopicState(data.topic);
    state.history.push(data);
    if (state.history.length > MAX_TOPIC_HISTORY) state.history.shift();
    state.current = data;

    // Update UI only for selected topic
    if (!selectedTopic || data.topic !== selectedTopic) return;
    if (isPaused) return;

    addToHistory(data);
    updateCurrentMessage(data);
}

function addToHistory(data) {
    const container = document.getElementById('messages-container');
    
    // Remove "no messages" placeholder
    const noMessages = container.querySelector('.no-messages, .select-topic-message');
    if (noMessages) {
        noMessages.remove();
        // Initialize container with pre-allocated space
        initializeHistoryContainer(container);
    }

    // Enforce limit based on cache (source of truth)
    if (selectedTopic) {
        const state = getTopicState(selectedTopic);
        if (state.history.length > MAX_TOPIC_HISTORY) {
            state.history = state.history.slice(-MAX_TOPIC_HISTORY);
        }
    }

    // If DOM exceeds limit, drop oldest nodes
    while (container.querySelectorAll('.message-item').length >= MAX_TOPIC_HISTORY) {
        const firstMessage = container.querySelector('.message-item');
        if (!firstMessage) break;
        firstMessage.remove();
    }

    const messageElement = createHistoryMessageElement(data);
    container.appendChild(messageElement);

    // Auto-scroll to bottom only if user is near bottom
    const isNearBottom = container.scrollTop >= container.scrollHeight - container.clientHeight - 100;
    if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

function initializeHistoryContainer(container) {
    // No-op: keep full-height layout managed by CSS
}

function createHistoryMessageElement(data) {
    const div = document.createElement('div');
    div.className = 'message-item history-message';

    const timestamp = new Date(data.timestamp).toLocaleTimeString();
    
    // Try to parse as JSON for better formatting
    let payload = data.payload;
    let payloadClass = '';
    
    try {
        const parsed = JSON.parse(data.payload);
        payload = JSON.stringify(parsed, null, 2);
        payloadClass = 'json';
    } catch (e) {
        payloadClass = '';
    }

    div.innerHTML = `
        <div class="message-header">
            <span class="message-timestamp">${timestamp}</span>
        </div>
        <div class="message-payload ${payloadClass}">${escapeHtml(payload)}</div>
    `;

    return div;
}

function updateCurrentMessage(data) {
    const container = document.getElementById('current-message-container');
    
    // Remove "no messages" placeholder
    const noMessages = container.querySelector('.no-messages, .select-topic-message');
    if (noMessages) {
        noMessages.remove();
    }

    const state = selectedTopic ? getTopicState(selectedTopic) : null;
    const previousMessage = state ? state.current : null;
    if (state) state.current = data;

    const messageElement = createCurrentMessageElement(data, previousMessage);
    container.innerHTML = '';
    container.appendChild(messageElement);
}

function createCurrentMessageElement(data, previousMessage) {
    const div = document.createElement('div');
    div.className = 'current-message';

    const timestamp = new Date(data.timestamp).toLocaleTimeString();
    
    let payload = data.payload;
    let payloadHtml = '';
    
    try {
        const parsed = JSON.parse(data.payload);
        
        if (previousMessage) {
            try {
                const previousParsed = JSON.parse(previousMessage.payload);
                payloadHtml = createJsonDiff(previousParsed, parsed);
            } catch (e) {
                payloadHtml = createFormattedJson(parsed, false);
            }
        } else {
            payloadHtml = createFormattedJson(parsed, false);
        }
    } catch (e) {
        // Not JSON, show as plain text
        if (previousMessage && previousMessage.payload !== data.payload) {
            payloadHtml = `<div class="text-payload changed-text">${escapeHtml(payload)}</div>`;
        } else {
            payloadHtml = `<div class="text-payload">${escapeHtml(payload)}</div>`;
        }
    }

    div.innerHTML = `
        <div class="current-payload">${payloadHtml}</div>
         <div class="current-message-header">
            <span class="current-timestamp">${timestamp}</span>
        </div>
    `;

    return div;
}

function createFormattedJson(obj, showChanges = false) {
    return `<pre class="json-formatted">${formatJsonWithSyntaxHighlighting(obj, 0, showChanges)}</pre>`;
}

function formatJsonWithSyntaxHighlighting(obj, indent = 0, isChanged = false) {
    const spaces = '  '.repeat(indent);
    const changeClass = isChanged ? ' json-changed' : '';
    
    if (obj === null) {
        return `<span class="json-null${changeClass}">null</span>`;
    }
    
    if (typeof obj === 'string') {
        return `<span class="json-string${changeClass}">"${escapeHtml(obj)}"</span>`;
    }
    
    if (typeof obj === 'number') {
        return `<span class="json-number${changeClass}">${obj}</span>`;
    }
    
    if (typeof obj === 'boolean') {
        return `<span class="json-boolean${changeClass}">${obj}</span>`;
    }
    
    if (Array.isArray(obj)) {
        if (obj.length === 0) {
            return `<span class="json-bracket${changeClass}">[]</span>`;
        }
        
        let result = `<span class="json-bracket${changeClass}">[</span>\n`;
        obj.forEach((item, index) => {
            result += spaces + '  ' + formatJsonWithSyntaxHighlighting(item, indent + 1, isChanged);
            if (index < obj.length - 1) {
                result += '<span class="json-comma">,</span>';
            }
            result += '\n';
        });
        result += spaces + `<span class="json-bracket${changeClass}">]</span>`;
        return result;
    }
    
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return `<span class="json-bracket${changeClass}">{}</span>`;
        }
        
        let result = `<span class="json-bracket${changeClass}">{</span>\n`;
        keys.forEach((key, index) => {
            result += spaces + '  ';
            result += `<span class="json-key${changeClass}">"${escapeHtml(key)}"</span>`;
            result += '<span class="json-colon">: </span>';
            result += formatJsonWithSyntaxHighlighting(obj[key], indent + 1, isChanged);
            if (index < keys.length - 1) {
                result += '<span class="json-comma">,</span>';
            }
            result += '\n';
        });
        result += spaces + `<span class="json-bracket${changeClass}">}</span>`;
        return result;
    }
    
    return escapeHtml(String(obj));
}

function createJsonDiff(oldObj, newObj) {
    const diff = compareObjectsDetailed(oldObj, newObj);
    return `<pre class="json-formatted json-diff">${diff}</pre>`;
}

function compareObjectsDetailed(oldObj, newObj, indent = 0) {
    const spaces = '  '.repeat(indent);
    
    if (oldObj === null && newObj === null) {
        return '<span class="json-null">null</span>';
    }
    
    if (typeof oldObj !== typeof newObj || Array.isArray(oldObj) !== Array.isArray(newObj)) {
        return formatJsonWithSyntaxHighlighting(newObj, indent, true);
    }
    
    if (typeof newObj !== 'object' || newObj === null) {
        const isChanged = oldObj !== newObj;
        return formatJsonWithSyntaxHighlighting(newObj, indent, isChanged);
    }
    
    if (Array.isArray(newObj)) {
        if (newObj.length === 0 && (!oldObj || oldObj.length === 0)) {
            return '<span class="json-bracket">[]</span>';
        }
        
        const hasChanges = !oldObj || oldObj.length !== newObj.length || 
            newObj.some((item, index) => JSON.stringify(item) !== JSON.stringify(oldObj[index]));
        
        let result = `<span class="json-bracket${hasChanges ? ' json-changed' : ''}">[</span>\n`;
        newObj.forEach((item, index) => {
            const oldItem = oldObj && oldObj[index];
            result += spaces + '  ' + compareObjectsDetailed(oldItem, item, indent + 1);
            if (index < newObj.length - 1) {
                result += '<span class="json-comma">,</span>';
            }
            result += '\n';
        });
        result += spaces + `<span class="json-bracket${hasChanges ? ' json-changed' : ''}">]</span>`;
        return result;
    }
    
    // Handle objects
    const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
    const hasChanges = !oldObj || JSON.stringify(oldObj) !== JSON.stringify(newObj);
    
    if (allKeys.size === 0) {
        return '<span class="json-bracket">{}</span>';
    }
    
    let result = `<span class="json-bracket${hasChanges ? ' json-changed-subtle' : ''}">{</span>\n`;
    
    Array.from(allKeys).forEach((key, index) => {
        const oldValue = oldObj?.[key];
        const newValue = newObj?.[key];
        const keyChanged = JSON.stringify(oldValue) !== JSON.stringify(newValue);
        
        result += spaces + '  ';
        result += `<span class="json-key${keyChanged ? ' json-changed' : ''}">"${escapeHtml(key)}"</span>`;
        result += '<span class="json-colon">: </span>';
        
        if (newValue === undefined) {
            // Key was removed
            result += '<span class="json-removed">[REMOVED]</span>';
        } else {
            result += compareObjectsDetailed(oldValue, newValue, indent + 1);
        }
        
        if (index < allKeys.size - 1) {
            result += '<span class="json-comma">,</span>';
        }
        result += '\n';
    });
    
    result += spaces + `<span class="json-bracket${hasChanges ? ' json-changed-subtle' : ''}">}</span>`;
    return result;
}

function switchTab(tabName) {
    activeTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.tab-button:not(.control-button)').forEach(button => {
        button.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');

    // Re-render from cache so switching tabs never looks empty
    renderSelectedTopicFromCache();
}

function clearMessages() {
    const historyContainer = document.getElementById('messages-container');
    const currentContainer = document.getElementById('current-message-container');

    if (selectedTopic) {
        topicCache.set(selectedTopic, { history: [], current: null });
    }
    
    if (selectedTopic) {
        historyContainer.innerHTML = `<div class="no-messages">Waiting for messages from: ${selectedTopic}</div>`;
        currentContainer.innerHTML = `<div class="no-messages">Waiting for messages from: ${selectedTopic}</div>`;
    } else {
        historyContainer.innerHTML = '<div class="select-topic-message">Select a topic from the list to view messages</div>';
        currentContainer.innerHTML = '<div class="select-topic-message">Select a topic from the list to view current message</div>';
    }
    
    messageCount = 0;
}

function clearTopics() {
    const container = document.getElementById('topics-container');
    container.innerHTML = '<div class="no-topics">Connect to MQTT broker to see topics</div>';
    topicFrequencies = {};
    knownTopics.clear();
    selectedTopic = null;
    topicCache.clear();
    topicTreeRoot = null;
    expandedNodes.clear();
    document.getElementById('selected-topic-name').textContent = '';
    clearMessages();
}

function renderSelectedTopicFromCache() {
    const historyContainer = document.getElementById('messages-container');
    const currentContainer = document.getElementById('current-message-container');

    if (!selectedTopic) {
        historyContainer.innerHTML = '<div class="select-topic-message">Select a topic from the list to view messages</div>';
        currentContainer.innerHTML = '<div class="select-topic-message">Select a topic from the list to view current message</div>';
        return;
    }

    const state = getTopicState(selectedTopic);

    // History
    if (!state.history.length) {
        historyContainer.innerHTML = `<div class="no-messages">Waiting for messages from: ${selectedTopic}</div>`;
    } else {
        historyContainer.innerHTML = '';
        state.history.forEach(msg => {
            historyContainer.appendChild(createHistoryMessageElement(msg));
        });
        historyContainer.scrollTop = historyContainer.scrollHeight;
    }

    // Current
    if (!state.current) {
        currentContainer.innerHTML = `<div class="no-messages">Waiting for messages from: ${selectedTopic}</div>`;
    } else {
        const previous = state.history.length > 1 ? state.history[state.history.length - 2] : null;
        currentContainer.innerHTML = '';
        currentContainer.appendChild(createCurrentMessageElement(state.current, previous));
    }
}

// Clean up frequency calculations every 30 seconds
setInterval(() => {
    const now = Date.now();
    Object.keys(topicFrequencies).forEach(topic => {
        const freq = topicFrequencies[topic];
        // Remove old timestamps
        freq.timestamps = freq.timestamps.filter(ts => now - ts < 10000);
        freq.rate = freq.timestamps.length / 10;
        
        // Update display
        const freqElement = document.getElementById(`freq-${topic.replace(/[^a-zA-Z0-9]/g, '_')}`);
        if (freqElement) {
            freqElement.textContent = `${freq.rate.toFixed(1)} msg/s`;
        }
    });
}, 5000);

function updateTopicFrequency(topic) {
    const now = Date.now();
    
    if (!topicFrequencies[topic]) {
        topicFrequencies[topic] = {
            count: 0,
            lastUpdate: now,
            timestamps: []
        };
    }

    const freq = topicFrequencies[topic];
    freq.count++;
    freq.timestamps.push(now);

    // Keep only last 10 seconds of timestamps
    freq.timestamps = freq.timestamps.filter(ts => now - ts < 10000);
    
    // Calculate rate (messages per second)
    freq.rate = freq.timestamps.length / 10;
    freq.lastUpdate = now;

    // Update display
    const freqElement = document.getElementById(`freq-${topic.replace(/[^a-zA-Z0-9]/g, '_')}`);
    if (freqElement) {
        freqElement.textContent = `${freq.rate.toFixed(1)} msg/s`;
    }
}

function togglePauseMessages() {
    isPaused = !isPaused;
    const btn = document.getElementById('pause-messages-btn');
    
    if (isPaused) {
        btn.innerHTML = '<i class="fas fa-play"></i> Start';
        btn.classList.add('paused');
    } else {
        btn.innerHTML = '<i class="fas fa-pause"></i> Pause';
        btn.classList.remove('paused');
    }
}

function filterTopics() {
    applyTopicFilter();
}

function applyTopicFilter() {
    const searchTerm = (document.getElementById('topics-search').value || '').toLowerCase().trim();
    const leafNodes = document.querySelectorAll('.topic-node.leaf');
    const folderNodes = document.querySelectorAll('.topic-node.folder');

    if (!searchTerm) {
        leafNodes.forEach(n => n.classList.remove('hidden'));
        folderNodes.forEach(n => n.classList.remove('hidden'));
        return;
    }

    const visibleFolderPaths = new Set();
    leafNodes.forEach(leaf => {
        const topic = (leaf.dataset.topic || '').toLowerCase();
        const visible = topic.includes(searchTerm);
        leaf.classList.toggle('hidden', !visible);
        if (visible) {
            // Mark ancestor folders visible
            const parts = (leaf.dataset.topic || '').split('/').filter(Boolean);
            let path = '';
            for (let i = 0; i < parts.length - 1; i++) {
                path = path ? `${path}/${parts[i]}` : parts[i];
                visibleFolderPaths.add(path);
                expandedNodes.add(path); // auto-expand matching paths
            }
        }
    });

    folderNodes.forEach(folder => {
        const path = folder.dataset.nodePath || '';
        const visible = visibleFolderPaths.has(path);
        folder.classList.toggle('hidden', !visible);
    });

    // Re-render to apply expansions for search
    const container = document.getElementById('topics-container');
    if (topicTreeRoot) {
        renderTopicTree(container, topicTreeRoot);
        // re-apply filter without recursion explosion
        // (second pass only toggles visibility, expansions already applied)
        const secondTerm = (document.getElementById('topics-search').value || '').toLowerCase().trim();
        if (!secondTerm) return;
        applyTopicFilterSecondPass(secondTerm);
    }
}

function applyTopicFilterSecondPass(searchTerm) {
    const leafNodes = document.querySelectorAll('.topic-node.leaf');
    const folderNodes = document.querySelectorAll('.topic-node.folder');
    const visibleFolderPaths = new Set();

    leafNodes.forEach(leaf => {
        const topic = (leaf.dataset.topic || '').toLowerCase();
        const visible = topic.includes(searchTerm);
        leaf.classList.toggle('hidden', !visible);
        if (visible) {
            const parts = (leaf.dataset.topic || '').split('/').filter(Boolean);
            let path = '';
            for (let i = 0; i < parts.length - 1; i++) {
                path = path ? `${path}/${parts[i]}` : parts[i];
                visibleFolderPaths.add(path);
            }
        }
    });

    folderNodes.forEach(folder => {
        const path = folder.dataset.nodePath || '';
        const visible = visibleFolderPaths.has(path);
        folder.classList.toggle('hidden', !visible);
    });
}

function copyCurrentMessage() {
    if (!selectedTopic) {
        showNotification('Select a topic first', 'error');
        return;
    }
    const state = getTopicState(selectedTopic);
    if (!state.current) {
        showNotification('No current message to copy', 'error');
        return;
    }
    const text = state.current.payload ?? '';
    if (!text) {
        showNotification('Current message payload is empty', 'error');
        return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text))
            .then(() => showNotification('Copied current message', 'success'))
            .catch(() => fallbackCopy(String(text)));
    } else {
        fallbackCopy(String(text));
    }
}

function fallbackCopy(text) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showNotification('Copied current message', 'success');
    } catch (e) {
        showNotification('Copy failed', 'error');
    }
}

function cssEscape(value) {
    // Minimal CSS.escape replacement for attribute selectors
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function showNotification(message, type) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `alert alert-${type === 'error' ? 'danger' : 'success'} notification`;
    notification.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        z-index: 9999;
        min-width: 300px;
        animation: fadeIn 0.3s ease-out;
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.3s ease-out';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}