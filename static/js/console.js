document.addEventListener('DOMContentLoaded', () => {
    const consoleWindow = document.getElementById('consoleWindow');
    const consoleHeader = document.getElementById('consoleHeader');
    const minimizeConsole = document.getElementById('minimizeConsole');
    const consoleInput = document.getElementById('consoleInput');
    const consoleContent = document.getElementById('consoleContent');
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 100;
    let yOffset = 100;

    // Set initial position
    setTranslate(xOffset, yOffset, consoleWindow);

    // Dragging functionality
    consoleHeader.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    function dragStart(e) {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
        if (e.target === consoleHeader || e.target.parentNode === consoleHeader) {
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
            setTranslate(currentX, currentY, consoleWindow);
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

    // Minimize functionality
    minimizeConsole.addEventListener('click', () => {
        consoleWindow.style.display = 'none';
    });

    // Add WebSocket handling
    const consoleSocket = io({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000
    });const socket = io();
    
    consoleSocket.on('connect', () => {
        consoleSocket.emit('join_console');
    });

    consoleSocket.on('console_output', (data) => {
        appendToConsole(data.output);
    });

    // Update command input handling
    consoleInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const command = consoleInput.value;
            if (command.trim() === 'clear') {
                consoleContent.innerHTML = '';
            } else if (command.trim() === 'help') {
                consoleSocket.emit('console_help');
            } else {
                appendToConsole(`$ ${command}`);
                consoleSocket.emit('console_command', { command: command });
            }
            consoleInput.value = '';
        }
    });

    function appendToConsole(text) {
        const div = document.createElement('div');
        div.textContent = text;
        consoleContent.appendChild(div);
        consoleContent.scrollTop = consoleContent.scrollHeight;
    }

    // Add console history functionality
    let commandHistory = [];
    let historyIndex = -1;

    consoleInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex < commandHistory.length - 1) {
                historyIndex++;
                consoleInput.value = commandHistory[commandHistory.length - 1 - historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                consoleInput.value = commandHistory[commandHistory.length - 1 - historyIndex];
            } else if (historyIndex === 0) {
                historyIndex = -1;
                consoleInput.value = '';
            }
        }
    });

    consoleInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const command = consoleInput.value.trim();
            if (command) {
                commandHistory.push(command);
                if (commandHistory.length > 50) commandHistory.shift();
                historyIndex = -1;
            }
        }
    });
});
