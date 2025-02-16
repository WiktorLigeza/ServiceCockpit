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
        
        // Check for color markers
        if (text.startsWith('[ERROR]')) {
            div.classList.add('console-error');
            text = text.replace('[ERROR]', '');
        } else if (text.startsWith('[SUCCESS]')) {
            div.classList.add('console-success');
            text = text.replace('[SUCCESS]', '');
        } else if (text.startsWith('[WARNING]')) {
            div.classList.add('console-warning');
            text = text.replace('[WARNING]', '');
        } else if (text.startsWith('[INFO]')) {
            div.classList.add('console-info');
            text = text.replace('[INFO]', '');
        }

        // Handle ANSI color codes
        const colorMap = {
            '\x1b[31m': 'console-error',     // Red
            '\x1b[32m': 'console-success',   // Green
            '\x1b[33m': 'console-warning',   // Yellow
            '\x1b[34m': 'console-info',      // Blue
            '\x1b[0m': ''                    // Reset
        };

        let colorClass = '';
        for (const [code, className] of Object.entries(colorMap)) {
            if (text.includes(code)) {
                colorClass = className;
                text = text.replace(code, '');
            }
        }

        if (colorClass) {
            div.classList.add(colorClass);
        }

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
