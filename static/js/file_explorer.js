let currentPath = '/home';
let selectedFile = null;
let viewMode = 'list';

document.addEventListener('DOMContentLoaded', function() {
    initializeFileExplorer();
    setupEventListeners();
});

function initializeFileExplorer() {
    loadDirectory(currentPath);
    loadDirectoryTree('/');
}

function setupEventListeners() {
    // View mode toggle
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            viewMode = this.dataset.view;
            const filesContainer = document.getElementById('files-container');
            if (viewMode === 'grid') {
                filesContainer.classList.add('grid-view');
            } else {
                filesContainer.classList.remove('grid-view');
            }
        });
    });

    // New folder button
    document.getElementById('new-folder-btn').addEventListener('click', createNewFolder);
    
    // New file button
    document.getElementById('new-file-btn').addEventListener('click', createNewFile);
}

async function loadDirectory(path) {
    currentPath = path;
    document.getElementById('current-path').textContent = path;
    updateBreadcrumb(path);
    
    try {
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            displayFiles(data.files);
        } else {
            console.error('Error loading directory:', data.error);
        }
    } catch (error) {
        console.error('Error loading directory:', error);
    }
}

function displayFiles(files) {
    const container = document.getElementById('files-container');
    container.innerHTML = '';
    
    // Sort: folders first, then files
    files.sort((a, b) => {
        if (a.is_directory !== b.is_directory) {
            return b.is_directory - a.is_directory;
        }
        return a.name.localeCompare(b.name);
    });
    
    files.forEach(file => {
        const fileItem = createFileItem(file);
        container.appendChild(fileItem);
    });
}

function createFileItem(file) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = file.path;
    item.dataset.isDirectory = file.is_directory;
    
    const icon = document.createElement('i');
    icon.className = `fas ${getFileIcon(file)} file-icon ${getFileIconClass(file)}`;
    
    const info = document.createElement('div');
    info.className = 'file-info';
    
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name;
    
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    
    const chmod = document.createElement('span');
    chmod.className = 'file-chmod';
    chmod.textContent = file.permissions;
    
    const size = document.createElement('span');
    size.textContent = formatFileSize(file.size);
    
    meta.appendChild(chmod);
    meta.appendChild(size);
    
    info.appendChild(name);
    info.appendChild(meta);
    
    item.appendChild(icon);
    item.appendChild(info);
    
    item.addEventListener('click', () => {
        if (file.is_directory) {
            loadDirectory(file.path);
        } else {
            selectFile(item, file);
        }
    });
    
    item.addEventListener('dblclick', () => {
        if (!file.is_directory) {
            openFile(file);
        }
    });
    
    return item;
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

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function selectFile(element, file) {
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    element.classList.add('selected');
    selectedFile = file;
    displayFileDetails(file);
}

async function displayFileDetails(file) {
    const container = document.getElementById('file-details-container');
    
    try {
        const response = await fetch(`/api/file-details?path=${encodeURIComponent(file.path)}`);
        const data = await response.json();
        
        if (data.success) {
            container.innerHTML = `
                <div class="detail-section">
                    <h3><i class="fas ${getFileIcon(file)}"></i> ${file.name}</h3>
                    <div class="detail-row">
                        <span class="detail-label">Type:</span>
                        <span class="detail-value">${file.is_directory ? 'Directory' : 'File'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Size:</span>
                        <span class="detail-value">${formatFileSize(file.size)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Permissions:</span>
                        <span class="detail-value">${file.permissions}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Owner:</span>
                        <span class="detail-value">${data.details.owner}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Modified:</span>
                        <span class="detail-value">${new Date(data.details.modified * 1000).toLocaleString()}</span>
                    </div>
                </div>
                <div class="file-actions">
                    <button class="btn btn-sm btn-primary" onclick="downloadFile()">
                        <i class="fas fa-download"></i> Download
                    </button>
                    <button class="btn btn-sm btn-warning" onclick="renameFile()">
                        <i class="fas fa-edit"></i> Rename
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteFile()">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading file details:', error);
    }
}

function updateBreadcrumb(path) {
    const breadcrumb = document.getElementById('breadcrumb-nav');
    const parts = path.split('/').filter(p => p);
    
    let html = '<span class="breadcrumb-item" onclick="loadDirectory(\'/\')">root</span>';
    let currentPath = '';
    
    parts.forEach(part => {
        currentPath += '/' + part;
        html += `<span class="breadcrumb-item" onclick="loadDirectory('${currentPath}')">${part}</span>`;
    });
    
    breadcrumb.innerHTML = html;
}

async function loadDirectoryTree(path, parentElement = null) {
    // Implementation for directory tree navigation
    // Similar to file list but shows only directories
}

function createNewFolder() {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
        // Implementation for creating new folder
    }
}

function createNewFile() {
    const fileName = prompt('Enter file name:');
    if (fileName) {
        // Implementation for creating new file
    }
}

function openFile(file) {
    // Implementation for opening/editing files
}

function downloadFile() {
    if (selectedFile) {
        window.location.href = `/api/download?path=${encodeURIComponent(selectedFile.path)}`;
    }
}

function renameFile() {
    if (selectedFile) {
        const newName = prompt('Enter new name:', selectedFile.name);
        if (newName) {
            // Implementation for renaming
        }
    }
}

function deleteFile() {
    if (selectedFile && confirm(`Delete ${selectedFile.name}?`)) {
        // Implementation for deleting
    }
}
