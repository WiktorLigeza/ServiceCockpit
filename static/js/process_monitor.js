document.addEventListener('DOMContentLoaded', () => {
    const processMonitorCard = document.getElementById('process-monitor-card');
    const processMonitorBtn = document.getElementById('monitor-process-btn');
    const processPidInput = document.getElementById('process-pid');
    const btnCloseProcess = document.querySelector('.btn-close-process');

    // Chart instances
    let cpuChart = null;
    let memoryChart = null;
    let networkChart = null;

    // Data arrays for charts
    const cpuData = [];
    const memoryData = [];
    const networkConnData = [];
    const ioReadData = [];
    const ioWriteData = [];
    const timestamps = [];

    // Previous values for calculating rates
    let prevIoRead = 0;
    let prevIoWrite = 0;
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
                const networkCtx = document.getElementById('network-usage-chart').getContext('2d');

                console.log("Got chart contexts:", cpuCtx, memoryCtx, networkCtx);

                // Destroy existing charts if they exist
                if (cpuChart) cpuChart.destroy();
                if (memoryChart) memoryChart.destroy();
                if (networkChart) networkChart.destroy();

                console.log("Creating CPU chart...");
                // Create new charts
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
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                beginAtZero: true,
                                max: 100
                            }
                        },
                        animation: {
                            duration: 0 // Disable animation for better performance
                        },
                        plugins: {
                            title: {
                                display: true,
                                text: 'CPU Usage'
                            }
                        }
                    }
                });
                
                console.log("Creating memory chart...");
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
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        },
                        animation: {
                            duration: 0 // Disable animation for better performance
                        },
                        plugins: {
                            title: {
                                display: true,
                                text: 'Memory Usage'
                            }
                        }
                    }
                });
                
                console.log("Creating network chart...");
                networkChart = new Chart(networkCtx, {
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
                            },
                            {
                                label: 'I/O Read Rate (KB/s)',
                                data: [],
                                borderColor: 'rgb(75, 192, 192)',
                                tension: 0.1,
                                fill: false
                            },
                            {
                                label: 'I/O Write Rate (KB/s)',
                                data: [],
                                borderColor: 'rgb(255, 159, 64)',
                                tension: 0.1,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        },
                        animation: {
                            duration: 0 // Disable animation for better performance
                        },
                        plugins: {
                            title: {
                                display: true,
                                text: 'Network & I/O Activity'
                            }
                        }
                    }
                });
                console.log("Charts created successfully!");
                
                // Clear data arrays
                cpuData.length = 0;
                memoryData.length = 0;
                networkConnData.length = 0;
                ioReadData.length = 0;
                ioWriteData.length = 0;
                timestamps.length = 0;
                
                // Reset previous values
                prevIoRead = 0;
                prevIoWrite = 0;
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

    // Calculate IO rates
    function calculateIORates(data) {
        const currentTime = data.timestamp;
        
        // Calculate rates for first-time execution
        if (prevTimestamp === 0) {
            prevTimestamp = currentTime;
            prevIoRead = data.io_read_bytes;
            prevIoWrite = data.io_write_bytes;
            return { readRate: 0, writeRate: 0 };
        }
        
        // Calculate time difference in seconds
        const timeDiff = currentTime - prevTimestamp;
        if (timeDiff <= 0) return { readRate: 0, writeRate: 0 };
        
        // Calculate IO rates in KB/s
        const readRate = (data.io_read_bytes - prevIoRead) / timeDiff / 1024;
        const writeRate = (data.io_write_bytes - prevIoWrite) / timeDiff / 1024;
        
        // Update previous values
        prevTimestamp = currentTime;
        prevIoRead = data.io_read_bytes;
        prevIoWrite = data.io_write_bytes;
        
        return {
            readRate: readRate > 0 ? readRate : 0,
            writeRate: writeRate > 0 ? writeRate : 0
        };
    }

    // Update charts with new data
    function updateCharts(data) {
        if (!data) return;
        
        console.log("Updating charts with new data:", data);
        
        // Format timestamp
        const date = new Date(data.timestamp * 1000);
        const timeString = date.toLocaleTimeString();
        
        // Calculate IO rates
        const ioRates = calculateIORates(data);
        
        // Add new data
        timestamps.push(timeString);
        cpuData.push(data.cpu_percent);
        memoryData.push(data.memory_rss / (1024 * 1024)); // Convert to MB
        networkConnData.push(data.network_connections);
        ioReadData.push(ioRates.readRate.toFixed(2));
        ioWriteData.push(ioRates.writeRate.toFixed(2));
        
        // Limit data points
        if (timestamps.length > MAX_DATA_POINTS) {
            timestamps.shift();
            cpuData.shift();
            memoryData.shift();
            networkConnData.shift();
            ioReadData.shift();
            ioWriteData.shift();
        }
        
        // Make sure charts are initialized
        if (!cpuChart || !memoryChart || !networkChart) {
            console.warn("Charts not initialized, attempting to initialize...");
            initCharts();
            return; // Wait for next update cycle
        }
        
        try {
            // Update CPU chart
            cpuChart.data.labels = timestamps;
            cpuChart.data.datasets[0].data = cpuData;
            cpuChart.update('none'); // Use 'none' mode for better performance
            
            // Update memory chart
            memoryChart.data.labels = timestamps;
            memoryChart.data.datasets[0].data = memoryData;
            memoryChart.update('none');
            
            // Update network chart - includes connections and IO
            networkChart.data.labels = timestamps;
            networkChart.data.datasets[0].data = networkConnData;
            networkChart.data.datasets[1].data = ioReadData;
            networkChart.data.datasets[2].data = ioWriteData;
            networkChart.update('none');
            
            // Update card title with process name and more info
            const cardHeader = processMonitorCard.querySelector('.infocard-header');
            cardHeader.innerHTML = `Process Monitor: ${data.process_name} (PID: ${currentPid}) - Status: ${data.status}
                <div class="infocard-controls">
                    <button class="btn-close-process"><i class="fas fa-times"></i></button>
                </div>`;
            
            // Reattach close button event
            document.querySelector('.btn-close-process').addEventListener('click', () => {
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
                            updateCharts(newData);
                        });
                    }, MONITOR_INTERVAL);
                }
            });
        }, 200);
    }

    // Stop monitoring
    function stopMonitoring() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
        }
        currentPid = null;
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

    // Close button handler
    btnCloseProcess.addEventListener('click', () => {
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
