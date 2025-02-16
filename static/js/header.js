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
    // CPU Temperature
    const cpuTemp = document.querySelector('#cpu-temp');
    cpuTemp.querySelector('.metric-value').textContent = `${data.cpu_temp}°C`;
    cpuTemp.querySelector('i').style.color = getColorForValue(data.cpu_temp, 'cpu');

    // Memory Usage
    const memoryUsage = document.querySelector('#memory-usage');
    memoryUsage.querySelector('.metric-value').textContent = `${data.memory_percent}%`;
    memoryUsage.querySelector('i').style.color = getColorForValue(data.memory_percent, 'memory');

    // Storage Usage
    const storageUsage = document.querySelector('#storage-usage');
    storageUsage.querySelector('.metric-value').textContent = `${data.storage_percent}%`;
    storageUsage.querySelector('i').style.color = getColorForValue(data.storage_percent, 'storage');
}

// Socket.io connection
const socket = io();
window.socket = socket;
socket.on('update_metrics', updateMetrics);
