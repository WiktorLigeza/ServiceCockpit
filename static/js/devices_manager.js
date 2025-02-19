document.addEventListener('DOMContentLoaded', function() {
    const devicesManagerBtn = document.getElementById('devices-manager-btn');
    const devicesManagerCard = document.getElementById('devices-manager-card');
    const devicesList = document.getElementById('devices-list');
    const infocardHeader = devicesManagerCard.querySelector('.infocard-header');
    const closeDevicesWindow = devicesManagerCard.querySelector('.btn-close-devices');

    if (closeDevicesWindow) {
        closeDevicesWindow.addEventListener('click', function(event) {
            event.preventDefault();
            devicesManagerCard.style.display = 'none';
        });
    }



    // Function to fetch devices data from the server
    function fetchDevices() {
        fetch('/api/devices')
            .then(response => response.json())
            .then(devices => {
                // Populate the list with device data
                devices.forEach(device => {
                    const listItem = document.createElement('li');
                    listItem.innerHTML = `
                        <strong>${device.name}</strong><br>
                        Type: ${device.type}<br>
                        MAC: ${device.mac}
                    `;
                    devicesList.appendChild(listItem);
                });
            })
            .catch(error => {
                console.error('Error fetching devices:', error);
                devicesList.innerHTML = '<li>Error loading devices.</li>';
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
