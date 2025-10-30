let currentPath = '/home';
let selectedFile = null;
let viewMode = 'grid'; // Changed from 'list' to 'grid'
let allFiles = [];
let currentFilter = 'all';
let nameFilter = '';
let editorFile = null;

document.addEventListener('DOMContentLoaded', function() {
    initializeFileExplorer();
    setupEventListeners();
    setupCodeEditor();
});

function initializeFileExplorer() {
    loadDirectory(currentPath);
    loadDirectoryTree('/');
    // Set grid view as default
    const filesContainer = document.getElementById('files-container');
    filesContainer.classList.add('grid-view');
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

    // Set grid button as active by default
    document.querySelector('.view-btn[data-view="grid"]').classList.add('active');
    document.querySelector('.view-btn[data-view="list"]').classList.remove('active');

    // Filter change
    document.getElementById('file-filter').addEventListener('change', function(e) {
        currentFilter = e.target.value;
        applyFilters();
    });

    // Name search
    document.getElementById('file-search').addEventListener('input', function(e) {
        nameFilter = e.target.value.toLowerCase();
        applyFilters();
    });

    // Directory search
    document.getElementById('directory-search').addEventListener('input', function(e) {
        const searchTerm = e.target.value.toLowerCase();
        filterDirectoryTree(searchTerm);
    });

    // New folder button
    document.getElementById('new-folder-btn').addEventListener('click', createNewFolder);
    
    // New file button
    document.getElementById('new-file-btn').addEventListener('click', createNewFile);
}

function filterDirectoryTree(searchTerm) {
    const allDirItems = document.querySelectorAll('.directory-item');
    allDirItems.forEach(item => {
        const name = item.querySelector('span').textContent.toLowerCase();
        if (name.includes(searchTerm)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function applyFilters() {
    let filteredFiles = allFiles;
    
    // Apply type filter
    switch(currentFilter) {
        case 'folders':
            filteredFiles = filteredFiles.filter(f => f.is_directory);
            break;
        case 'files':
            filteredFiles = filteredFiles.filter(f => !f.is_directory);
            break;
        case 'images':
            filteredFiles = filteredFiles.filter(f => {
                const ext = f.name.split('.').pop().toLowerCase();
                return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'].includes(ext);
            });
            break;
        case 'code':
            filteredFiles = filteredFiles.filter(f => {
                const ext = f.name.split('.').pop().toLowerCase();
                return ['js', 'py', 'html', 'css', 'json', 'xml', 'php', 'java', 'cpp', 'c', 'h', 'sh'].includes(ext);
            });
            break;
        case 'documents':
            filteredFiles = filteredFiles.filter(f => {
                const ext = f.name.split('.').pop().toLowerCase();
                return ['txt', 'pdf', 'doc', 'docx', 'md', 'rtf', 'odt'].includes(ext);
            });
            break;
    }
    
    // Apply name filter
    if (nameFilter) {
        filteredFiles = filteredFiles.filter(f => 
            f.name.toLowerCase().includes(nameFilter)
        );
    }
    
    displayFiles(filteredFiles);
}

async function loadDirectory(path) {
    currentPath = path;
    document.getElementById('current-path').textContent = path;
    updateBreadcrumb(path);
    
    try {
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            allFiles = data.files;
            applyFilters();
            // Update active directory in tree
            highlightActiveDirectory(path);
        } else {
            console.error('Error loading directory:', data.error);
            showError('Failed to load directory: ' + data.error);
        }
    } catch (error) {
        console.error('Error loading directory:', error);
        showError('Failed to load directory');
    }
}

function highlightActiveDirectory(path) {
    document.querySelectorAll('.directory-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.path === path) {
            item.classList.add('active');
        }
    });
}

function displayFiles(files) {
    const container = document.getElementById('files-container');
    container.innerHTML = '';
    
    if (files.length === 0) {
        container.innerHTML = '<div class="no-selection"><i class="fas fa-folder-open"></i><p>No files match the filter</p></div>';
        return;
    }
    
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
    
    const sizeElement = document.createElement('span');
    
    if (file.is_directory) {
        sizeElement.innerHTML = `<button class="btn-inspect" onclick="event.stopPropagation(); inspectFolder('${file.path}', this)"><i class="fas fa-search"></i> Inspect</button>`;
    } else {
        sizeElement.textContent = formatFileSize(file.size);
    }
    
    meta.appendChild(chmod);
    meta.appendChild(sizeElement);
    
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
            openFileInEditor(file);
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

async function loadDirectoryTree(path, parentElement = null) {
    try {
        const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            const container = parentElement || document.getElementById('directory-tree-container');
            if (!parentElement) {
                container.innerHTML = '';
            }
            
            data.directories.forEach(dir => {
                const dirItem = createDirectoryTreeItem(dir);
                container.appendChild(dirItem);
            });
        }
    } catch (error) {
        console.error('Error loading directory tree:', error);
    }
}

function createDirectoryTreeItem(dir) {
    const wrapper = document.createElement('div');
    
    const item = document.createElement('div');
    item.className = 'directory-item';
    item.dataset.path = dir.path;
    
    const chevron = document.createElement('i');
    chevron.className = 'fas fa-chevron-right';
    
    const icon = document.createElement('i');
    icon.className = 'fas fa-folder file-icon folder';
    
    const name = document.createElement('span');
    name.textContent = dir.name;
    
    item.appendChild(chevron);
    item.appendChild(icon);
    item.appendChild(name);
    
    // Create children container
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'directory-children';
    childrenContainer.style.display = 'none';
    
    // Toggle children on chevron click
    chevron.addEventListener('click', async (e) => {
        e.stopPropagation();
        item.classList.toggle('expanded');
        
        if (item.classList.contains('expanded')) {
            if (childrenContainer.children.length === 0) {
                await loadDirectoryTree(dir.path, childrenContainer);
            }
            childrenContainer.style.display = 'block';
        } else {
            childrenContainer.style.display = 'none';
        }
    });
    
    // Load directory on item click
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        loadDirectory(dir.path);
    });
    
    wrapper.appendChild(item);
    wrapper.appendChild(childrenContainer);
    
    return wrapper;
}

async function createNewFolder() {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
        try {
            const response = await fetch('/api/create-folder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    path: currentPath,
                    name: folderName
                })
            });
            
            const data = await response.json();
            if (data.success) {
                loadDirectory(currentPath);
                // Reload parent directory in tree
                const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
                reloadDirectoryInTree(parentPath);
            } else {
                alert('Failed to create folder: ' + data.error);
            }
        } catch (error) {
            alert('Failed to create folder: ' + error);
        }
    }
}

function reloadDirectoryInTree(path) {
    // Find the directory item and reload its children
    const dirItems = document.querySelectorAll('.directory-item');
    dirItems.forEach(item => {
        if (item.dataset.path === path && item.classList.contains('expanded')) {
            const childrenContainer = item.parentElement.querySelector('.directory-children');
            if (childrenContainer) {
                childrenContainer.innerHTML = '';
                loadDirectoryTree(path, childrenContainer);
            }
        }
    });
}

async function createNewFile() {
    const fileName = prompt('Enter file name:');
    if (fileName) {
        try {
            const response = await fetch('/api/create-file', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    path: currentPath,
                    name: fileName
                })
            });
            
            const data = await response.json();
            if (data.success) {
                loadDirectory(currentPath);
            } else {
                alert('Failed to create file: ' + data.error);
            }
        } catch (error) {
            alert('Failed to create file: ' + error);
        }
    }
}

function openFile(file) {
    openFileInEditor(file);
}

async function openFileInEditor(file) {
    if (file.is_directory) return;
    
    editorFile = file;
    const editorWindow = document.getElementById('code-editor-window');
    const editorContent = document.getElementById('editor-content');
    const editorTitle = document.getElementById('editor-title');
    
    try {
        const response = await fetch(`/api/read-file?path=${encodeURIComponent(file.path)}`);
        const data = await response.json();
        
        if (data.success) {
            editorContent.value = data.content;
            editorTitle.textContent = file.name;
            editorWindow.style.display = 'flex';
            
            // Apply syntax highlighting based on file extension
            applySyntaxHighlighting(file.name);
        } else {
            alert('Failed to open file: ' + data.error);
        }
    } catch (error) {
        alert('Failed to open file: ' + error);
    }
}

function applySyntaxHighlighting(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const editorContent = document.getElementById('editor-content');
    
    // Simple syntax highlighting by adding class
    editorContent.className = 'editor-textarea';
    if (['js', 'py', 'cpp', 'c', 'h', 'sh', 'bash', 'html', 'css', 'json'].includes(ext)) {
        editorContent.classList.add(`syntax-${ext}`);
    }
}

async function saveFile() {
    if (!editorFile) return;
    
    const editorContent = document.getElementById('editor-content');
    const content = editorContent.value;
    
    try {
        const response = await fetch('/api/write-file', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: editorFile.path,
                content: content
            })
        });
        
        const data = await response.json();
        if (data.success) {
            alert('File saved successfully!');
            loadDirectory(currentPath); // Refresh file list
        } else {
            alert('Failed to save file: ' + data.error);
        }
    } catch (error) {
        alert('Failed to save file: ' + error);
    }
}

function closeEditor() {
    const editorWindow = document.getElementById('code-editor-window');
    editorWindow.style.display = 'none';
    editorFile = null;
}

function downloadFile() {
    if (selectedFile) {
        window.location.href = `/api/download?path=${encodeURIComponent(selectedFile.path)}`;
    }
}

async function renameFile() {
    if (selectedFile) {
        const newName = prompt('Enter new name:', selectedFile.name);
        if (newName && newName !== selectedFile.name) {
            try {
                const response = await fetch('/api/rename', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        old_path: selectedFile.path,
                        new_name: newName
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    loadDirectory(currentPath);
                    if (selectedFile.is_directory) {
                        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
                        reloadDirectoryInTree(parentPath);
                    }
                    selectedFile = null;
                    document.getElementById('file-details-container').innerHTML = `
                        <div class="no-selection">
                            <i class="fas fa-file-alt"></i>
                            <p>Select a file or folder to view details</p>
                        </div>
                    `;
                } else {
                    alert('Failed to rename: ' + data.error);
                }
            } catch (error) {
                alert('Failed to rename: ' + error);
            }
        }
    }
}

async function deleteFile() {
    if (selectedFile) {
        const isDirectory = selectedFile.is_directory;
        const warningMsg = isDirectory 
            ? `Are you sure you want to delete the folder "${selectedFile.name}" and all its contents? This action cannot be undone!`
            : `Are you sure you want to delete "${selectedFile.name}"?`;
        
        if (confirm(warningMsg)) {
            try {
                const response = await fetch('/api/delete', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        path: selectedFile.path,
                        is_directory: isDirectory
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    loadDirectory(currentPath);
                    if (isDirectory) {
                        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
                        reloadDirectoryInTree(parentPath);
                    }
                    selectedFile = null;
                    document.getElementById('file-details-container').innerHTML = `
                        <div class="no-selection">
                            <i class="fas fa-file-alt"></i>
                            <p>Select a file or folder to view details</p>
                        </div>
                    `;
                } else {
                    alert('Failed to delete: ' + data.error);
                }
            } catch (error) {
                alert('Failed to delete: ' + error);
            }
        }
    }
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

async function inspectFolder(path, buttonElement) {
    const originalHTML = buttonElement.innerHTML;
    buttonElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating...';
    buttonElement.disabled = true;
    
    try {
        const response = await fetch(`/api/folder-size?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            buttonElement.parentElement.innerHTML = `<span class="folder-size">${data.size_display}</span>`;
        } else {
            buttonElement.innerHTML = `<span style="color: #dc3545;">Error</span>`;
            setTimeout(() => {
                buttonElement.innerHTML = originalHTML;
                buttonElement.disabled = false;
            }, 2000);
        }
    } catch (error) {
        console.error('Error inspecting folder:', error);
        buttonElement.innerHTML = `<span style="color: #dc3545;">Error</span>`;
        setTimeout(() => {
            buttonElement.innerHTML = originalHTML;
            buttonElement.disabled = false;
        }, 2000);
    }
}

async function displayFileDetails(file) {
    const container = document.getElementById('file-details-container');
    
    try {
        const response = await fetch(`/api/file-details?path=${encodeURIComponent(file.path)}`);
        const data = await response.json();
        
        if (data.success) {
            const details = data.details;
            
            let sizeHTML = '';
            if (file.is_directory) {
                sizeHTML = `
                    <div class="detail-row">
                        <span class="detail-label">Size:</span>
                        <span class="detail-value" id="detail-size">
                            <button class="btn btn-sm btn-info" onclick="inspectFolderDetails('${file.path}')">
                                <i class="fas fa-search"></i> Calculate Size
                            </button>
                        </span>
                    </div>
                `;
            } else {
                sizeHTML = `
                    <div class="detail-row">
                        <span class="detail-label">Size:</span>
                        <span class="detail-value">${formatFileSize(file.size)}</span>
                    </div>
                `;
            }
            
            container.innerHTML = `
                <div class="detail-section">
                    <h3><i class="fas ${getFileIcon(file)}"></i> ${file.name}</h3>
                    <div class="detail-row">
                        <span class="detail-label">Type:</span>
                        <span class="detail-value">${file.is_directory ? 'Directory' : 'File'}</span>
                    </div>
                    ${sizeHTML}
                    <div class="detail-row">
                        <span class="detail-label">Permissions:</span>
                        <span class="detail-value">${file.permissions}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Owner:</span>
                        <span class="detail-value">${details.owner}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Created:</span>
                        <span class="detail-value">${new Date(details.created * 1000).toLocaleString()}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Modified:</span>
                        <span class="detail-value">${new Date(details.modified * 1000).toLocaleString()}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Accessed:</span>
                        <span class="detail-value">${new Date(details.accessed * 1000).toLocaleString()}</span>
                    </div>
                </div>
                <div class="file-actions">
                    ${!file.is_directory ? `
                        <button class="btn btn-sm btn-primary" onclick="downloadFile()">
                            <i class="fas fa-download"></i> Download
                        </button>
                        <button class="btn btn-sm btn-info" onclick="openFileInEditor(selectedFile)">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                    ` : ''}
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

async function inspectFolderDetails(path) {
    const sizeElement = document.getElementById('detail-size');
    sizeElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating...';
    
    try {
        const response = await fetch(`/api/folder-size?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            sizeElement.innerHTML = `<span class="folder-size">${data.size_display}</span>`;
        } else {
            sizeElement.innerHTML = `<span style="color: #dc3545;">Error: ${data.error}</span>`;
        }
    } catch (error) {
        console.error('Error inspecting folder:', error);
        sizeElement.innerHTML = `<span style="color: #dc3545;">Error calculating size</span>`;
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

// Code Editor Functions
function setupCodeEditor() {
    const editorWindow = document.getElementById('code-editor-window');
    const header = editorWindow.querySelector('.editor-header');
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        if (e.target.classList.contains('editor-close') || e.target.classList.contains('editor-minimize')) return;
        
        initialX = e.clientX - editorWindow.offsetLeft;
        initialY = e.clientY - editorWindow.offsetTop;
        isDragging = true;
        editorWindow.style.cursor = 'move';
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            
            editorWindow.style.left = currentX + 'px';
            editorWindow.style.top = currentY + 'px';
        }
    }
    
    function dragEnd() {
        isDragging = false;
        editorWindow.style.cursor = 'default';
    }
    
    // Close button
    document.querySelector('.editor-close').addEventListener('click', closeEditor);
    
    // Save button
    document.getElementById('save-file-btn').addEventListener('click', saveFile);
}
