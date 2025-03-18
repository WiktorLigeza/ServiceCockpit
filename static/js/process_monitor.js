document.addEventListener('DOMContentLoaded', function() {
    const processMonitorCard = document.getElementById('process-monitor-card');
    const monitorProcessBtn = document.getElementById('monitor-process-btn');
    const processPidInput = document.getElementById('process-pid');
    const infocardHeader = processMonitorCard.querySelector('.infocard-header');
    const closeProcessWindow = processMonitorCard.querySelector('.btn-close-process');

    if (closeProcessWindow) {
        closeProcessWindow.addEventListener('click', function(event) {
            event.preventDefault();
            processMonitorCard.style.display = 'none';
        });
    }

    // Function to initialize and update charts (using fake data for now)
    function initializeCharts() {
        const cpuChart = createChart('cpu-usage-chart', 'CPU Usage (%)');
        const memoryChart = createChart('memory-usage-chart', 'Memory Usage (MB)');
        const networkChart = createChart('network-usage-chart', 'Network Usage (KB/s)');

        // Function to update charts with fake data
        function updateCharts() {
            updateChart(cpuChart, Math.random() * 100);
            updateChart(memoryChart, Math.random() * 500);
            updateChart(networkChart, Math.random() * 1000);
        }

        // Update charts every 2 seconds (adjust as needed)
        setInterval(updateCharts, 2000);
    }

    // Function to create a chart
    function createChart(canvasId, label) {
        const ctx = document.getElementById(canvasId).getContext('2d');
        return new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: label,
                    data: [],
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1,
                    fill: false
                }]
            },
            options: {
                responsive: true,
                scales: {
                    x: {
                        display: false
                    },
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }

    // Function to update a chart with new data
    function updateChart(chart, newData) {
        chart.data.labels.push(''); // Add empty label for simplicity
        chart.data.datasets[0].data.push(newData);

        // Keep only the last 20 data points
        if (chart.data.labels.length > 20) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        chart.update();
    }

    // Monitor process button functionality
    monitorProcessBtn.addEventListener('click', function() {
        const pid = processPidInput.value;
        if (pid) {
            console.log('Monitoring process with PID:', pid);
            initializeCharts();
            // Add logic here to fetch and display real process data
        } else {
            alert('Please enter a PID to monitor.');
        }
    });

    // Drag window functionality
    let isDragging = false;
    let offsetX, offsetY;

    infocardHeader.addEventListener('mousedown', function(e) {
        isDragging = true;
        offsetX = e.clientX - processMonitorCard.offsetLeft;
        offsetY = e.clientY - processMonitorCard.offsetTop;
        processMonitorCard.style.cursor = 'grabbing';
    });

    document.addEventListener('mouseup', function() {
        isDragging = false;
        processMonitorCard.style.cursor = 'grab';
    });

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;

        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;

        processMonitorCard.style.left = x + 'px';
        processMonitorCard.style.top = y + 'px';
    });
});
