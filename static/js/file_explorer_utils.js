// Inserts soft line-break opportunities (<wbr>) into a filename at natural
// boundaries - after '.', '-', '_', and before a camelCase capital - instead
// of letting the browser break mid-word wherever it likes. This is the same
// approach VS Code and GitHub use for long filenames/identifiers.
function appendBreakableText(parentEl, text) {
    if (!text) return;
    let buffer = '';
    const flush = () => {
        if (buffer) {
            parentEl.appendChild(document.createTextNode(buffer));
            buffer = '';
        }
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const prev = text[i - 1];

        if (prev && /[a-z0-9]/.test(prev) && /[A-Z]/.test(ch)) {
            // camelCase boundary: break *before* the capital.
            flush();
            parentEl.appendChild(document.createElement('wbr'));
        }

        buffer += ch;

        if (ch === '.' || ch === '-' || ch === '_') {
            // Natural separators: break *after* them.
            flush();
            parentEl.appendChild(document.createElement('wbr'));
        }
    }
    flush();
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileIcon(file) {
    if (file.is_directory) return 'fa-folder';

    if (canInspectAsExecutable(file)) return 'fa-terminal';
    
    const ext = file.name.split('.').pop().toLowerCase();
    if (isVideoFile(ext)) return 'fa-file-video';
    const iconMap = {
        'js': 'fa-file-code',
        'py': 'fa-file-code',
        'html': 'fa-file-code',
        'css': 'fa-file-code',
        'json': 'fa-file-code',
        'txt': 'fa-file-alt',
        'md': 'fa-file-alt',
        'pdf': 'fa-file-pdf',
        'png': 'fa-file-image',
        'jpg': 'fa-file-image',
        'jpeg': 'fa-file-image',
        'gif': 'fa-file-image',
        'zip': 'fa-file-archive',
        'tar': 'fa-file-archive',
        'gz': 'fa-file-archive'
    };
    
    return iconMap[ext] || 'fa-file';
}

function canInspectAsExecutable(file) {
    return !!file.is_executable || file.name.toLowerCase().endsWith('.exe');
}

function getFileIconClass(file) {
    if (file.is_directory) return 'folder';
    
    const ext = file.name.split('.').pop().toLowerCase();
    const classMap = {
        'js': 'js',
        'py': 'py',
        'html': 'html',
        'css': 'css',
        'json': 'json',
        'txt': 'txt',
        'png': 'image',
        'jpg': 'image',
        'jpeg': 'image',
        'gif': 'image'
    };
    
    return classMap[ext] || 'default';
}

function isImageFile(ext) {
    return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext);
}

function isTextFile(ext) {
    const textExtensions = ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'py', 
                           'cpp', 'c', 'h', 'sh', 'bash', 'java', 'php', 'sql', 
                           'yml', 'yaml', 'conf', 'cfg', 'ini', 'log'];
    return textExtensions.includes(ext);
}

function isVideoFile(ext) {
    return ['mp4', 'webm', 'ogv', 'mov', 'm4v'].includes(ext);
}

function getLanguageFromExtension(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const languageMap = {
        'py': 'Python',
        'js': 'JavaScript',
        'html': 'HTML',
        'css': 'CSS',
        'json': 'JSON',
        'cpp': 'C++',
        'c': 'C',
        'h': 'C/C++ Header',
        'sh': 'Bash',
        'bash': 'Bash',
        'java': 'Java',
        'php': 'PHP',
        'sql': 'SQL',
        'xml': 'XML',
        'md': 'Markdown',
        'txt': 'Text',
        'yml': 'YAML',
        'yaml': 'YAML'
    };
    return languageMap[ext] || 'Text';
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);
    
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

function showError(message) {
    const container = document.getElementById('files-container');
    container.innerHTML = `
        <div class="no-selection">
            <i class="fas fa-exclamation-triangle" style="color: #dc3545;"></i>
            <p>${message}</p>
        </div>
    `;
}

function getPageZoom() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--page-zoom');
    const zoom = parseFloat(value);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function positionContextMenu(menu, x, y) {
    const zoom = getPageZoom();
    const viewportWidth = window.innerWidth / zoom;
    const viewportHeight = window.innerHeight / zoom;
    const padding = 8;

    const menuWidth = menu.offsetWidth || 0;
    const menuHeight = menu.offsetHeight || 0;

    let left = x / zoom;
    let top = y / zoom;

    if (left + menuWidth + padding > viewportWidth) {
        left = Math.max(padding, viewportWidth - menuWidth - padding);
    }

    if (top + menuHeight + padding > viewportHeight) {
        top = Math.max(padding, viewportHeight - menuHeight - padding);
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}
