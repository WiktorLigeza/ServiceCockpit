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
    addServiceForm.addEventListener('submit', (event) => {
        event.preventDefault();
        updateServicePreview()
        // Log the service file content to the console (for now)
        console.log(servicePreview.value);
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
