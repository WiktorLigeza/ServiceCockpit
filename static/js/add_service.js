document.addEventListener('DOMContentLoaded', () => {
    const addServiceForm = document.getElementById('add-service-form');
    const servicePreview = document.getElementById('servicePreview');
    const addServiceCard = document.getElementById('add-service-card');
    const infocardHeader = addServiceCard.querySelector('.infocard-header'); // Select the infocard header

    function generateServiceConfig(formData) {
        return `[Unit]
Description=${formData.serviceDescription}
After=network-online.target

[Service]
Type=${formData.serviceType}
User=${formData.serviceUser}
ExecStart=${formData.execPath} ${formData.serviceParams}
Restart=${formData.restartPolicy}
RestartSec=${formData.restartSec}s
Environment="HOME=/home/${formData.serviceUser}"

[Install]
WantedBy=default.target`;
    }

    function updateServicePreview() {
        const formData = {
            serviceName: document.getElementById('serviceName').value,
            serviceDescription: document.getElementById('serviceDescription').value,
            serviceType: document.getElementById('serviceType').value,
            serviceUser: document.getElementById('serviceUser').value,
            execPath: document.getElementById('execPath').value,
            serviceParams: document.getElementById('serviceParams').value,
            restartPolicy: document.getElementById('restartPolicy').value,
            restartSec: document.getElementById('restartSec').value
        };
        servicePreview.value = generateServiceConfig(formData);
    }

    // Update preview on input change
    addServiceForm.addEventListener('input', updateServicePreview);


    // Handle form submission
    document.getElementById("submit-service").addEventListener('click', (event) => {
        event.preventDefault();
        updateServicePreview();
        console.log("Service preview:", servicePreview.value);

        const formData = {
            serviceName: document.getElementById('serviceName').value,
            serviceContent: servicePreview.value
        };

        fetch('/api/create_service', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Service created successfully:', data.message);
                // Optionally, display a success message to the user
            } else {
                console.error('Failed to create service:', data.message);
                // Optionally, display an error message to the user
            }
        })
        .catch(error => {
            console.error('Error creating service:', error);
            // Optionally, display an error message to the user
        });

        addServiceCard.classList.add('hidden');
    });

    // Close button functionality
    const closeBtn = addServiceCard.querySelector('.btn-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            addServiceCard.classList.add('hidden');
        });
    }

    // Dragging functionality for infocard
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 100;
    let yOffset = 100;

    // Set initial position
    setTranslate(xOffset, yOffset, addServiceCard);

    infocardHeader.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    function dragStart(e) {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
        if (e.target === infocardHeader || e.target.parentNode === infocardHeader) {
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
            setTranslate(currentX, currentY, addServiceCard);
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
});
