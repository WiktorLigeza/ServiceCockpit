function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileIcon(file) {
    if (file.is_directory) return 'fa-folder';
    
    const ext = file.name.split('.').pop().toLowerCase();
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
