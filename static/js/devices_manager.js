document.addEventListener('DOMContentLoaded', function() {
    const devicesManagerBtn = document.getElementById('devices-manager-btn');
    const devicesManagerCard = document.getElementById('devices-manager-card');
    const devicesTableBody = document.getElementById('devices-table-body');
    const infocardHeader = devicesManagerCard.querySelector('.infocard-header');
    const closeDevicesWindow = document.getElementById('btn-close-devices');

    closeDevicesWindow.addEventListener('click', function(event) {
        event.preventDefault();
        devicesManagerCard.classList.toggle('hidden');
    });


    devicesManagerBtn.addEventListener('click', function(event) {
        event.preventDefault();
        devicesManagerCard.classList.toggle('hidden');
    });

    // Function to fetch devices data from the server
    function fetchDevices() {
        fetch('/api/devices')
            .then(response => response.json())
            .then(devices => {
                // Populate the table with device data
                devices.forEach(device => {
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${device.type}</td>
                        <td>${device.name}</td>
                        <td>${device.mac}</td>
                    `;
                    devicesTableBody.appendChild(row);
                });
            })
            .catch(error => {
                console.error('Error fetching devices:', error);
                devicesTableBody.innerHTML = '<tr><td colspan="3">Error loading devices.</td></tr>';
            });
    }

    // Call fetchDevices when the page loads
    fetchDevices();

    // Drag window functionality
    let isDragging = false;
    let offsetX, offsetY;

    infocardHeader.addEventListener('mousedown', function(e) {
        isDragging = true;
        offsetX = e.clientX - devicesManagerCard.offsetLeft;
        offsetY = e.clientY - devicesManagerCard.offsetTop;
        devicesManagerCard.style.cursor = 'grabbing';
    });

    document.addEventListener('mouseup', function() {
        isDragging = false;
        devicesManagerCard.style.cursor = 'grab';
    });

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;

        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;

        devicesManagerCard.style.left = x + 'px';
        devicesManagerCard.style.top = y + 'px';
    });
});
