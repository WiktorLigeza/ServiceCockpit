document.addEventListener('DOMContentLoaded', () => {
    const addServiceForm = document.getElementById('add-service-form');
    const servicePreview = document.getElementById('servicePreview');
    const addServiceCard = document.getElementById('add-service-card');
    const infocardHeader = addServiceCard.querySelector('.infocard-header'); // Select the infocard header
    const serviceNameInput = document.getElementById('serviceName');
    const execPathInput = document.getElementById('execPath');
    let inspectExecPathButton = document.getElementById('inspect-exec-path');
    if (!inspectExecPathButton && execPathInput) {
        inspectExecPathButton = document.createElement('button');
        inspectExecPathButton.type = 'button';
        inspectExecPathButton.className = 'btn btn-outline-info';
        inspectExecPathButton.title = 'Open this executable in the File Explorer editor';
        inspectExecPathButton.setAttribute('aria-label', inspectExecPathButton.title);
        inspectExecPathButton.hidden = true;
        inspectExecPathButton.innerHTML = '<i class="fas fa-file-code"></i>';
        execPathInput.insertAdjacentElement('afterend', inspectExecPathButton);
    }
    const serviceFormTitle = document.getElementById('service-form-title');
    const submitButton = document.getElementById('submit-service');
    let editingService = null;
    let originalUnitContent = '';
    const changedFields = new Set();

    function generateServiceConfig(formData) {
        const description = formData.serviceDescription ? `Description=${formData.serviceDescription}\n` : '';
        return `[Unit]
${description}After=network-online.target

[Service]
Type=${formData.serviceType}
User=${formData.serviceUser}
${formData.workingDirectory ? `WorkingDirectory=${formData.workingDirectory}\n` : ''}ExecStart=${formData.execPath}${formData.serviceParams ? ` ${formData.serviceParams}` : ''}
Restart=${formData.restartPolicy}
RestartSec=${formData.restartSec}s
${formData.serviceUser ? `Environment="HOME=/home/${formData.serviceUser}"\n` : ''}

[Install]
WantedBy=default.target`;
    }

    function updateUnitDirective(content, section, key, value) {
        const lines = content.split('\n');
        let currentSection = '';
        let sectionIndex = -1;
        const directiveIndexes = [];
        lines.forEach((line, index) => {
            const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
            if (headerMatch) {
                currentSection = headerMatch[1];
                if (currentSection === section && sectionIndex === -1) sectionIndex = index;
            } else if (currentSection === section && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
                directiveIndexes.push(index);
            }
        });

        if (directiveIndexes.length) {
            if (value) directiveIndexes.forEach(index => { lines[index] = `${key}=${value}`; });
            else directiveIndexes.reverse().forEach(index => lines.splice(index, 1));
        } else if (value && sectionIndex !== -1) {
            lines.splice(sectionIndex + 1, 0, `${key}=${value}`);
        }
        return lines.join('\n');
    }

    function readDirective(content, section, key) {
        let activeSection = '';
        for (const line of content.split('\n')) {
            const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
            if (headerMatch) activeSection = headerMatch[1];
            else if (activeSection === section) {
                const directiveMatch = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
                if (directiveMatch) return directiveMatch[1].trim();
            }
        }
        return '';
    }

    function formDataFromContent(content) {
        const execStart = readDirective(content, 'Service', 'ExecStart');
        const commandMatch = execStart.match(/^(?:[-+!:@]?["']?)([^\s"']+|"[^"]+"|'[^']+')/);
        const execPath = commandMatch ? commandMatch[1].replace(/^['"]|['"]$/g, '') : '';
        const serviceParams = commandMatch ? execStart.slice(commandMatch[0].length).trim() : '';
        const restartSec = readDirective(content, 'Service', 'RestartSec').replace(/s$/, '');
        return {
            serviceDescription: readDirective(content, 'Unit', 'Description'),
            serviceType: readDirective(content, 'Service', 'Type') || 'simple',
            serviceUser: readDirective(content, 'Service', 'User') || '',
            execPath,
            serviceParams,
            restartPolicy: readDirective(content, 'Service', 'Restart') || 'no',
            restartSec: restartSec || '1',
            workingDirectory: readDirective(content, 'Service', 'WorkingDirectory')
        };
    }

    function getFormData() {
        return {
            serviceDescription: document.getElementById('serviceDescription').value,
            serviceType: document.getElementById('serviceType').value,
            serviceUser: document.getElementById('serviceUser').value,
            execPath: document.getElementById('execPath').value,
            serviceParams: document.getElementById('serviceParams').value,
            restartPolicy: document.getElementById('restartPolicy').value,
            restartSec: document.getElementById('restartSec').value,
            workingDirectory: document.getElementById('workingDirectory').value
        };
    }

    function updateServicePreview() {
        const formData = getFormData();
        if (!editingService) {
            servicePreview.value = generateServiceConfig(formData);
            return;
        }

        let content = originalUnitContent;
        if (changedFields.has('serviceDescription')) {
            content = updateUnitDirective(content, 'Unit', 'Description', formData.serviceDescription);
        }
        if (changedFields.has('serviceType')) {
            content = updateUnitDirective(content, 'Service', 'Type', formData.serviceType);
        }
        if (changedFields.has('serviceUser')) {
            content = updateUnitDirective(content, 'Service', 'User', formData.serviceUser);
        }
        if (changedFields.has('workingDirectory')) {
            content = updateUnitDirective(content, 'Service', 'WorkingDirectory', formData.workingDirectory);
        }
        if (changedFields.has('execPath') || changedFields.has('serviceParams')) {
            content = updateUnitDirective(content, 'Service', 'ExecStart', `${formData.execPath}${formData.serviceParams ? ` ${formData.serviceParams}` : ''}`);
        }
        if (changedFields.has('restartPolicy')) {
            content = updateUnitDirective(content, 'Service', 'Restart', formData.restartPolicy);
        }
        if (changedFields.has('restartSec')) {
            content = updateUnitDirective(content, 'Service', 'RestartSec', `${formData.restartSec}s`);
        }
        servicePreview.value = content;
    }

    function updateExecutableAction() {
        if (inspectExecPathButton && execPathInput) {
            inspectExecPathButton.hidden = !execPathInput.value.trim();
        }
    }

    addServiceForm.addEventListener('input', (event) => {
        if (editingService && event.target.id) changedFields.add(event.target.id);
        updateExecutableAction();
        updateServicePreview();
    });

    if (inspectExecPathButton) {
        inspectExecPathButton.addEventListener('click', () => {
            const path = execPathInput.value.trim();
            if (!path) return;
            window.open(`/file_explorer?open=${encodeURIComponent(path)}`, '_blank');
        });
    }

    window.openServiceEditor = (serviceName, unitContent) => {
        editingService = serviceName;
        originalUnitContent = unitContent;
        changedFields.clear();
        if (serviceFormTitle) serviceFormTitle.textContent = `Edit Service: ${serviceName}`;
        submitButton.textContent = 'Save Changes';
        serviceNameInput.value = serviceName.replace(/\.service$/, '');
        serviceNameInput.disabled = true;
        const values = formDataFromContent(unitContent);
        Object.entries(values).forEach(([key, value]) => {
            const input = document.getElementById(key);
            if (input) input.value = value;
        });
        document.getElementById('execPath').required = !!values.execPath;
        updateExecutableAction();
        servicePreview.value = unitContent;
        addServiceCard.classList.remove('hidden');
    };

    function resetServiceForm() {
        editingService = null;
        originalUnitContent = '';
        changedFields.clear();
        if (serviceFormTitle) serviceFormTitle.textContent = 'Add New Service';
        submitButton.textContent = 'Create Service';
        serviceNameInput.disabled = false;
        document.getElementById('execPath').required = true;
        addServiceForm.reset();
        updateExecutableAction();
        updateServicePreview();
    }

    document.getElementById('submit-service').addEventListener('click', async (event) => {
        event.preventDefault();
        updateServicePreview();
        if (!addServiceForm.reportValidity()) return;
        submitButton.disabled = true;
        try {
            const response = editingService
                ? await fetch(`/api/service/${encodeURIComponent(editingService)}/unit`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: servicePreview.value})
                })
                : await fetch('/api/create_service', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        serviceName: serviceNameInput.value,
                        serviceContent: servicePreview.value
                    })
                });
            const data = await response.json();
            if (!response.ok || !data.success) {
                if (response.status === 401 && typeof window.showSudoModal === 'function') {
                    window.showSudoModal(data.message || 'Sudo password required.');
                }
                throw new Error(data.message || data.error || 'Unable to save service');
            }
            addServiceCard.classList.add('hidden');
            resetServiceForm();
        } catch (error) {
            alert(error.message);
        } finally {
            submitButton.disabled = false;
        }
    });

    // Close button functionality
    const closeBtn = addServiceCard.querySelector('.btn-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            addServiceCard.classList.add('hidden');
            resetServiceForm();
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
        const pos = typeof getPointerPosition === 'function'
            ? getPointerPosition(e)
            : (() => {
                const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-zoom')) || 1;
                return { x: e.clientX / zoom, y: e.clientY / zoom };
            })();
        initialX = pos.x - xOffset;
        initialY = pos.y - yOffset;
        if (e.target === infocardHeader || e.target.parentNode === infocardHeader) {
            isDragging = true;
        }
    }

    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            const pos = typeof getPointerPosition === 'function'
                ? getPointerPosition(e)
                : (() => {
                    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-zoom')) || 1;
                    return { x: e.clientX / zoom, y: e.clientY / zoom };
                })();
            currentX = pos.x - initialX;
            currentY = pos.y - initialY;
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
