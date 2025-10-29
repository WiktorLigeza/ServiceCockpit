// MQTT Explorer JavaScript
let socket;
let isConnected = false;
let isPaused = false;
let topicFrequencies = {};
let selectedTopic = null;
let messageCount = 0;

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

    // Topics search
    document.getElementById('topics-search').addEventListener('input', filterTopics);
}

function loadConnectionSettings() {
    // Load saved connection settings from localStorage
    const settings = JSON.parse(localStorage.getItem('mqttSettings') || '{}');
    if (settings.host) document.getElementById('mqtt-host').value = settings.host;
    if (settings.port) document.getElementById('mqtt-port').value = settings.port;
    if (settings.username) document.getElementById('mqtt-username').value = settings.username;
}

function saveConnectionSettings() {
    const settings = {
        host: document.getElementById('mqtt-host').value,
        port: document.getElementById('mqtt-port').value,
        username: document.getElementById('mqtt-username').value
    };
    localStorage.setItem('mqttSettings', JSON.stringify(settings));
}

function connectToMQTT() {
    const host = document.getElementById('mqtt-host').value || 'localhost';
    const port = parseInt(document.getElementById('mqtt-port').value) || 1883;
    const username = document.getElementById('mqtt-username').value || '';
    const password = document.getElementById('mqtt-password').value || '';

    saveConnectionSettings();

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
    const container = document.getElementById('topics-container');
    container.innerHTML = '';

    if (topics.length === 0) {
        container.innerHTML = '<div class="no-topics">No topics discovered yet</div>';
        return;
    }

    topics.forEach(topic => {
        const topicElement = createTopicElement(topic);
        container.appendChild(topicElement);
    });
}

function createTopicElement(topic) {
    const div = document.createElement('div');
    div.className = 'topic-item';
    div.dataset.topic = topic;

    const frequency = topicFrequencies[topic] || { count: 0, rate: 0 };
    
    div.innerHTML = `
        <span class="topic-name">${topic}</span>
        <span class="topic-frequency" id="freq-${topic.replace(/[^a-zA-Z0-9]/g, '_')}">
            ${frequency.rate.toFixed(1)} msg/s
        </span>
    `;

    div.addEventListener('click', () => selectTopic(topic));
    return div;
}

function selectTopic(topic) {
    // Remove active class from all topics
    document.querySelectorAll('.topic-item').forEach(item => {
        item.classList.remove('active');
    });

    // Add active class to selected topic
    const topicElement = document.querySelector(`[data-topic="${topic}"]`);
    if (topicElement) {
        topicElement.classList.add('active');
    }

    selectedTopic = topic;
    document.getElementById('selected-topic-name').textContent = `- ${topic}`;
    
    // Auto-fill publish topic
    document.getElementById('publish-topic').value = topic;
}

function handleNewMessage(data) {
    const container = document.getElementById('messages-container');
    
    // Remove "no messages" placeholder
    const noMessages = container.querySelector('.no-messages');
    if (noMessages) {
        noMessages.remove();
    }

    const messageElement = createMessageElement(data);
    container.appendChild(messageElement);

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;

    // Limit number of messages to prevent memory issues
    messageCount++;
    if (messageCount > 1000) {
        const firstMessage = container.querySelector('.message-item');
        if (firstMessage) {
            firstMessage.remove();
            messageCount--;
        }
    }
}

function createMessageElement(data) {
    const div = document.createElement('div');
    div.className = 'message-item new';

    const timestamp = new Date(data.timestamp).toLocaleTimeString();
    
    // Try to parse as JSON
    let payload = data.payload;
    let payloadClass = '';
    
    try {
        const parsed = JSON.parse(data.payload);
        payload = JSON.stringify(parsed, null, 2);
        payloadClass = 'json';
    } catch (e) {
        // Not JSON, keep as is
        payloadClass = '';
    }

    div.innerHTML = `
        <div class="message-header">
            <span class="message-topic">${data.topic}</span>
            <span class="message-timestamp">${timestamp}</span>
        </div>
        <div class="message-payload ${payloadClass}">${escapeHtml(payload)}</div>
    `;

    // Remove animation class after animation completes
    setTimeout(() => {
        div.classList.remove('new');
    }, 300);

    return div;
}

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

function clearMessages() {
    const container = document.getElementById('messages-container');
    container.innerHTML = '<div class="no-messages">Subscribe to a topic to see messages</div>';
    messageCount = 0;
}

function clearTopics() {
    const container = document.getElementById('topics-container');
    container.innerHTML = '<div class="no-topics">Connect to MQTT broker to see topics</div>';
    topicFrequencies = {};
}

function togglePauseMessages() {
    isPaused = !isPaused;
    const btn = document.getElementById('pause-messages-btn');
    
    if (isPaused) {
        btn.innerHTML = '<i class="fas fa-play"></i> Resume';
        btn.className = 'btn btn-success';
    } else {
        btn.innerHTML = '<i class="fas fa-pause"></i> Pause';
        btn.className = 'btn btn-secondary';
    }
}

function filterTopics() {
    const searchTerm = document.getElementById('topics-search').value.toLowerCase();
    const topicItems = document.querySelectorAll('.topic-item');

    topicItems.forEach(item => {
        const topicName = item.dataset.topic.toLowerCase();
        if (topicName.includes(searchTerm)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
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