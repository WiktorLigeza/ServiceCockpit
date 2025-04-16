document.addEventListener('DOMContentLoaded', () => {
    const processMonitorCard = document.getElementById('process-monitor-card');
    const processMonitorBtn = document.getElementById('monitor-process-btn');
    const processPidInput = document.getElementById('process-pid');
    const btnCloseProcess = document.querySelector('.btn-close-process');

    // Chart instances
    let cpuChart = null;
    let memoryChart = null;
    let networkConnChart = null;
    let networkTrafficChart = null;

    // Data arrays for charts
    const cpuData = [];
    const memoryData = [];
    const networkConnData = [];
    const networkTrafficData = [];
    const timestamps = [];

    // Max/min values
    let cpuMax = 0;
    let cpuMin = Number.MAX_VALUE;
    let memoryMax = 0;
    let memoryMin = Number.MAX_VALUE;
    let networkConnMax = 0;
    let networkConnMin = Number.MAX_VALUE;
    let networkTrafficMax = 0;
    let networkTrafficMin = Number.MAX_VALUE;

    // Previous values for calculating rates
    let prevNetBytes = 0;
    let prevTimestamp = 0;

    // Max data points to show in charts
    const MAX_DATA_POINTS = 60;

    // Monitoring interval (ms)
    const MONITOR_INTERVAL = 1000;

    // Currently monitored PID
    let currentPid = null;

    // Monitoring interval reference
    let monitoringInterval = null;

    // Initialize charts - modified to handle hidden elements
    function initCharts() {
        console.log("Initializing charts...");
        
        // Make sure the container is visible for Chart.js to properly render
        processMonitorCard.classList.remove('hidden');
        
        // Small delay to ensure DOM is ready after removing 'hidden'
        setTimeout(() => {
            try {
                const cpuCtx = document.getElementById('cpu-usage-chart').getContext('2d');
                const memoryCtx = document.getElementById('memory-usage-chart').getContext('2d');
                const networkConnCtx = document.getElementById('network-conn-chart').getContext('2d');
                const networkTrafficCtx = document.getElementById('network-traffic-chart').getContext('2d');

                // Destroy existing charts if they exist
                if (cpuChart) cpuChart.destroy();
                if (memoryChart) memoryChart.destroy();
                if (networkConnChart) networkConnChart.destroy();
                if (networkTrafficChart) networkTrafficChart.destroy();

                // Common chart options for dark theme
                const darkThemeOptions = {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 0 // Disable animation for better performance
                    },
                    plugins: {
                        legend: {
                            labels: {
                                color: 'white' // White text for legend labels
                            }
                        },
                        title: {
                            color: 'white' // White text for title
                        }
                    },
                    scales: {
                        x: {
                            ticks: {
                                color: 'white' // White text for x-axis ticks
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)' // Lighter grid lines
                            }
                        },
                        y: {
                            ticks: {
                                color: 'white' // White text for y-axis ticks
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)' // Lighter grid lines
                            }
                        }
                    }
                };

                // Create CPU chart
                cpuChart = new Chart(cpuCtx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [{
                            label: 'CPU Usage (%)',
                            data: [],
                            borderColor: 'rgb(75, 192, 192)',
                            tension: 0.1,
                            fill: false
                        }]
                    },
                    options: {
                        ...darkThemeOptions,
                        scales: {
                            ...darkThemeOptions.scales,
                            y: {
                                ...darkThemeOptions.scales.y,
                                beginAtZero: true,
                                max: 100
                            }
                        },
                        plugins: {
                            ...darkThemeOptions.plugins,
                            title: {
                                ...darkThemeOptions.plugins.title,
                                display: true,
                                text: 'CPU Usage (Min: 0%, Max: 0%)'
                            }
                        }
                    }
                });
                
                // Create memory chart
                memoryChart = new Chart(memoryCtx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [{
                            label: 'Memory Usage (MB)',
                            data: [],
                            borderColor: 'rgb(255, 99, 132)',
                            tension: 0.1,
                            fill: false
                        }]
                    },
                    options: {
                        ...darkThemeOptions,
                        scales: {
                            ...darkThemeOptions.scales,
                            y: {
                                ...darkThemeOptions.scales.y,
                                beginAtZero: true
                            }
                        },
                        plugins: {
                            ...darkThemeOptions.plugins,
                            title: {
                                ...darkThemeOptions.plugins.title,
                                display: true,
                                text: 'Memory Usage (Min: 0MB, Max: 0MB)'
                            }
                        }
                    }
                });
                
                // Create network connections chart
                networkConnChart = new Chart(networkConnCtx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [
                            {
                                label: 'Network Connections',
                                data: [],
                                borderColor: 'rgb(54, 162, 235)',
                                tension: 0.1,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        ...darkThemeOptions,
                        scales: {
                            ...darkThemeOptions.scales,
                            y: {
                                ...darkThemeOptions.scales.y,
                                beginAtZero: true
                            }
                        },
                        plugins: {
                            ...darkThemeOptions.plugins,
                            title: {
                                ...darkThemeOptions.plugins.title,
                                display: true,
                                text: 'Network Connections (Min: 0, Max: 0)'
                            }
                        }
                    }
                });
                
                // Create network traffic chart
                networkTrafficChart = new Chart(networkTrafficCtx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [
                            {
                                label: 'Network Traffic (KB/s)',
                                data: [],
                                borderColor: 'rgb(255, 159, 64)',
                                tension: 0.1,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        ...darkThemeOptions,
                        scales: {
                            ...darkThemeOptions.scales,
                            y: {
                                ...darkThemeOptions.scales.y,
                                beginAtZero: true
                            }
                        },
                        plugins: {
                            ...darkThemeOptions.plugins,
                            title: {
                                ...darkThemeOptions.plugins.title,
                                display: true,
                                text: 'Network Traffic (Min: 0KB/s, Max: 0KB/s)'
                            }
                        }
                    }
                });
                
                console.log("Charts created successfully!");
                
                // Clear data arrays
                cpuData.length = 0;
                memoryData.length = 0;
                networkConnData.length = 0;
                networkTrafficData.length = 0;
                timestamps.length = 0;
                
                // Reset max/min values
                cpuMax = 0;
                cpuMin = Number.MAX_VALUE;
                memoryMax = 0;
                memoryMin = Number.MAX_VALUE;
                networkConnMax = 0;
                networkConnMin = Number.MAX_VALUE;
                networkTrafficMax = 0;
                networkTrafficMin = Number.MAX_VALUE;
                
                // Reset previous values
                prevNetBytes = 0;
                prevTimestamp = 0;
            } catch (error) {
                console.error("Error initializing charts:", error);
            }
        }, 100); // Small delay for DOM to update
    }

    // Fetch process metrics
    async function fetchProcessMetrics(pid) {
        try {
            const response = await fetch(`/api/process_metrics/${pid}`);
            const data = await response.json();
            
            if (!data.success) {
                if (!data.process_exists) {
                    stopMonitoring();
                    alert(`Process with PID ${pid} does not exist.`);
                } else {
                    console.error('Error fetching process metrics:', data.error);
                }
                return null;
            }
            
            return data;
        } catch (error) {
            console.error('Error fetching process metrics:', error);
            return null;
        }
    }

    // Calculate network traffic rate in KB/s
    function calculateNetworkRate(data) {
        const currentTime = data.timestamp;
        const currentNetBytes = data.io_read_bytes + data.io_write_bytes; // Total network bytes
        
        // First-time execution
        if (prevTimestamp === 0) {
            prevTimestamp = currentTime;
            prevNetBytes = currentNetBytes;
            return 0;
        }
        
        // Calculate time difference in seconds
        const timeDiff = currentTime - prevTimestamp;
        if (timeDiff <= 0) return 0;
        
        // Calculate network rate in KB/s
        const netRate = (currentNetBytes - prevNetBytes) / timeDiff / 1024;
        
        // Update previous values
        prevTimestamp = currentTime;
        prevNetBytes = currentNetBytes;
        
        return netRate > 0 ? netRate : 0;
    }

    // Update charts with new data
    function updateCharts(data) {
        if (!data) return;
        
        // Format timestamp
        const date = new Date(data.timestamp * 1000);
        const timeString = date.toLocaleTimeString();
        
        // Calculate network traffic rate
        const networkRate = calculateNetworkRate(data);
        
        // Convert memory to MB
        const memoryMB = data.memory_rss / (1024 * 1024);
        
        // Update max/min values
        cpuMax = Math.max(cpuMax, data.cpu_percent);
        cpuMin = data.cpu_percent < cpuMin ? data.cpu_percent : cpuMin;
        
        memoryMax = Math.max(memoryMax, memoryMB);
        memoryMin = memoryMB < memoryMin ? memoryMB : memoryMin;
        
        networkConnMax = Math.max(networkConnMax, data.network_connections);
        networkConnMin = data.network_connections < networkConnMin ? data.network_connections : networkConnMin;
        
        networkTrafficMax = Math.max(networkTrafficMax, networkRate);
        networkTrafficMin = networkRate < networkTrafficMin ? networkRate : networkTrafficMin;
        
        // Add new data
        timestamps.push(timeString);
        cpuData.push(data.cpu_percent);
        memoryData.push(memoryMB);
        networkConnData.push(data.network_connections);
        networkTrafficData.push(networkRate.toFixed(2));
        
        // Limit data points
        if (timestamps.length > MAX_DATA_POINTS) {
            timestamps.shift();
            cpuData.shift();
            memoryData.shift();
            networkConnData.shift();
            networkTrafficData.shift();
        }
        
        // Make sure charts are initialized
        if (!cpuChart || !memoryChart || !networkConnChart || !networkTrafficChart) {
            console.warn("Charts not initialized, attempting to initialize...");
            initCharts();
            return; // Wait for next update cycle
        }
        
        try {
            // Update CPU chart
            cpuChart.data.labels = timestamps;
            cpuChart.data.datasets[0].data = cpuData;
            cpuChart.options.plugins.title.text = `CPU Usage (Min: ${cpuMin.toFixed(1)}%, Max: ${cpuMax.toFixed(1)}%)`;
            cpuChart.update('none');
            
            // Update memory chart
            memoryChart.data.labels = timestamps;
            memoryChart.data.datasets[0].data = memoryData;
            memoryChart.options.plugins.title.text = `Memory Usage (Min: ${memoryMin.toFixed(1)}MB, Max: ${memoryMax.toFixed(1)}MB)`;
            memoryChart.update('none');
            
            // Update network connections chart
            networkConnChart.data.labels = timestamps;
            networkConnChart.data.datasets[0].data = networkConnData;
            networkConnChart.options.plugins.title.text = `Network Connections (Min: ${networkConnMin}, Max: ${networkConnMax})`;
            networkConnChart.update('none');
            
            // Update network traffic chart
            networkTrafficChart.data.labels = timestamps;
            networkTrafficChart.data.datasets[0].data = networkTrafficData;
            networkTrafficChart.options.plugins.title.text = `Network Traffic (Min: ${networkTrafficMin.toFixed(1)}KB/s, Max: ${networkTrafficMax.toFixed(1)}KB/s)`;
            networkTrafficChart.update('none');
            
            // Update card title with process name and more info
            const cardHeader = processMonitorCard.querySelector('.infocard-header');
            cardHeader.innerHTML = `Process Monitor: ${data.process_name} (PID: ${currentPid}) - Status: ${data.status}
                <div class="infocard-controls">
                    <button class="btn-close-process"><i class="fas fa-times"></i></button>
                </div>`;
            
            // Re-attach close button event since we replaced the header HTML
            document.querySelector('#process-monitor-card .btn-close-process').addEventListener('click', () => {
                console.log("Close button clicked");
                processMonitorCard.classList.add('hidden');
                stopMonitoring();
            });
        } catch (error) {
            console.error("Error updating charts:", error);
        }
    }

    // Start monitoring process
    function startMonitoring(pid) {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
        }
        
        currentPid = pid;
        processMonitorCard.classList.remove('hidden');
        
        // Wait a bit for the card to be visible before initializing charts
        setTimeout(() => {
            initCharts();
            
            // Fetch initial data
            fetchProcessMetrics(pid).then(data => {
                if (data) {
                    updateCharts(data);
                    
                    // Start interval for continuous monitoring
                    monitoringInterval = setInterval(() => {
                        fetchProcessMetrics(pid).then(newData => {
                            if (newData) {
                                updateCharts(newData);
                            } else {
                                console.log("Process no longer available");
                                stopMonitoring();
                                processMonitorCard.classList.add('hidden');
                            }
                        });
                    }, MONITOR_INTERVAL);
                }
            });
        }, 200);
    }

    // Stop monitoring
    function stopMonitoring() {
        console.log("Stopping process monitoring");
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
        }
        
        // Clean up charts
        if (cpuChart) {
            cpuChart.destroy();
            cpuChart = null;
        }
        if (memoryChart) {
            memoryChart.destroy();
            memoryChart = null;
        }
        if (networkConnChart) {
            networkConnChart.destroy();
            networkConnChart = null;
        }
        if (networkTrafficChart) {
            networkTrafficChart.destroy();
            networkTrafficChart = null;
        }
        
        currentPid = null;
        console.log("Monitoring stopped");
    }

    // Monitor button click handler
    processMonitorBtn.addEventListener('click', () => {
        const pid = parseInt(processPidInput.value, 10);
        if (isNaN(pid) || pid <= 0) {
            alert('Please enter a valid PID');
            return;
        }
        
        startMonitoring(pid);
    });

    // Close button handler - attach only once during initialization
    btnCloseProcess.addEventListener('click', () => {
        console.log("Main close button clicked");
        processMonitorCard.classList.add('hidden');
        stopMonitoring();
    });

    // Make card draggable
    const processHeader = processMonitorCard.querySelector('.infocard-header');
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 100;
    let yOffset = 100;

    // Set initial position
    setTranslate(xOffset, yOffset, processMonitorCard);

    processHeader.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    function dragStart(e) {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
        if (e.target === processHeader || (e.target.parentNode && e.target.parentNode === processHeader)) {
            isDragging = true;
        }
    }

    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            xOffset = currentX;
            yOffset = currentY;
            setTranslate(currentX, currentY, processMonitorCard);
        }
    }

    function dragEnd(e) {
        initialX = currentX;
        initialY = currentY;
        isDragging = false;
    }

    function setTranslate(xPos, yPos, el) {
        el.style.transform = `translate(${xPos}px, ${yPos}px)`;
    }

    console.log("Process monitor initialized and ready for use");
});
