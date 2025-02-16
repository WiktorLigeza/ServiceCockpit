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
    }
    
    value = Math.max(0, Math.min(1, value));
    
    const color = startColor.map((start, i) => {
        const end = endColor[i];
        return Math.round(start + (end - start) * value);
    });
    
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function updateMetrics(data) {
    console.log('Updating metrics:', data);
    
    // CPU Temperature
    const cpuTemp = document.querySelector('#cpu-temp');
    cpuTemp.querySelector('.metric-value').textContent = `${data.cpu_temp}°C`;
    cpuTemp.querySelector('i').style.color = getColorForValue(data.cpu_temp, 'cpu');
    cpuTemp.querySelector('.tooltip').textContent = `CPU Temperature: ${data.cpu_temp}°C`;

    // Memory Usage
    const memoryUsage = document.querySelector('#memory-usage');
    memoryUsage.querySelector('.metric-value').textContent = `${data.memory_percent}%`;
    memoryUsage.querySelector('i').style.color = getColorForValue(data.memory_percent, 'memory');
    memoryUsage.querySelector('.tooltip').textContent = 
        `Memory: ${data.memory_used}GB used / ${data.memory_total}GB total\n` +
        `(${data.memory_free}GB free)`;

    // Storage Usage
    const storageUsage = document.querySelector('#storage-usage');
    storageUsage.querySelector('.metric-value').textContent = `${data.storage_percent}%`;
    storageUsage.querySelector('i').style.color = getColorForValue(data.storage_percent, 'storage');
    storageUsage.querySelector('.tooltip').textContent = 
        `Storage: ${data.storage_used}GB used / ${data.storage_total}GB total\n` +
        `(${data.storage_free}GB free)`;
}

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
    ['cpu-temp', 'memory-usage', 'storage-usage'].forEach(id => {
        const element = document.querySelector(`#${id}`);
        element.querySelector('.metric-value').textContent = 'Loading...';
        element.querySelector('i').style.color = '#808080'; // Gray color for loading state
    });
});

headerSocket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    ['cpu-temp', 'memory-usage', 'storage-usage'].forEach(id => {
        const element = document.querySelector(`#${id}`);
        element.querySelector('.metric-value').textContent = 'Connection error';
        element.querySelector('i').style.color = '#ff0000';
    });
});

headerSocket.on('reconnect', (attemptNumber) => {
    console.log('Reconnected after', attemptNumber, 'attempts');
});
