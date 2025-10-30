// Global state
let currentPath = '/home';
let selectedFile = null;
let viewMode = 'grid';
let allFiles = [];
let currentFilter = 'all';
let nameFilter = '';
let editorFile = null;
let currentZoom = 1;
let copiedFile = null;
let copiedFilePath = null;
let isCutOperation = false;
let draggedItem = null;

// Import modules
document.addEventListener('DOMContentLoaded', function() {
    initializeFileExplorer();
    setupEventListeners();
    setupCodeEditor();
    setupImageViewer();
    setupKeyboardShortcuts();
});

function initializeFileExplorer() {
    // Load the last visited path from localStorage
    const savedPath = localStorage.getItem('fileExplorerLastPath');
    if (savedPath) {
        currentPath = savedPath;
    }
    
    loadDirectory(currentPath);
    loadDirectoryTree('/');
    const filesContainer = document.getElementById('files-container');
    filesContainer.classList.add('grid-view');
}

function setupEventListeners() {
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

    document.querySelector('.view-btn[data-view="grid"]').classList.add('active');
    document.querySelector('.view-btn[data-view="list"]').classList.remove('active');

    document.getElementById('file-filter').addEventListener('change', function(e) {
        currentFilter = e.target.value;
        applyFilters();
    });

    document.getElementById('file-search').addEventListener('input', function(e) {
        nameFilter = e.target.value.toLowerCase();
        applyFilters();
    });

    document.getElementById('directory-search').addEventListener('input', function(e) {
        const searchTerm = e.target.value.toLowerCase();
        filterDirectoryTree(searchTerm);
    });

    document.getElementById('new-folder-btn').addEventListener('click', createNewFolder);
    document.getElementById('new-file-btn').addEventListener('click', createNewFile);
    
    // Add context menu to files container
    const filesContainer = document.getElementById('files-container');
    filesContainer.addEventListener('contextmenu', (e) => {
        // Only show context menu if clicking on the container itself, not on a file item
        if (e.target === filesContainer || e.target.classList.contains('no-selection')) {
            e.preventDefault();
            showContainerContextMenu(e.clientX, e.clientY);
        }
    });
    
    // Setup file upload functionality
    setupFileUpload();
}

// Utility Functions
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
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
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

// Directory and File Operations
async function loadDirectory(path) {
    currentPath = path;
    
    // Save the current path to localStorage
    localStorage.setItem('fileExplorerLastPath', path);
    
    document.getElementById('current-path').textContent = path;
    updateBreadcrumb(path);
    
    try {
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            allFiles = data.files;
            applyFilters();
            highlightActiveDirectory(path);
        } else {
            console.error('Error loading directory:', data.error);
            showError('Failed to load directory: ' + data.error);
            
            // If the saved path fails to load, fallback to /home and update localStorage
            if (path !== '/home') {
                localStorage.setItem('fileExplorerLastPath', '/home');
                loadDirectory('/home');
            }
        }
    } catch (error) {
        console.error('Error loading directory:', error);
        showError('Failed to load directory');
        
        // If the saved path fails to load, fallback to /home and update localStorage
        if (path !== '/home') {
            localStorage.setItem('fileExplorerLastPath', '/home');
            loadDirectory('/home');
        }
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

function applyFilters() {
    let filteredFiles = allFiles;
    
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
    
    if (nameFilter) {
        filteredFiles = filteredFiles.filter(f => 
            f.name.toLowerCase().includes(nameFilter)
        );
    }
    
    displayFiles(filteredFiles);
}

function displayFiles(files) {
    const container = document.getElementById('files-container');
    container.innerHTML = '';
    
    if (files.length === 0) {
        container.innerHTML = '<div class="no-selection"><i class="fas fa-folder-open"></i><p>No files match the filter</p></div>';
        return;
    }
    
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

// Directory Tree Functions
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
    
    // Make directory items drop targets
    item.addEventListener('dragover', handleDirectoryDragOver);
    item.addEventListener('drop', handleDirectoryDrop);
    item.addEventListener('dragleave', handleDirectoryDragLeave);
    
    const chevron = document.createElement('i');
    chevron.className = 'fas fa-chevron-right';
    
    const icon = document.createElement('i');
    icon.className = 'fas fa-folder file-icon folder';
    
    const name = document.createElement('span');
    name.textContent = dir.name;
    
    item.appendChild(chevron);
    item.appendChild(icon);
    item.appendChild(name);
    
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'directory-children';
    childrenContainer.style.display = 'none';
    
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
    
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        loadDirectory(dir.path);
    });
    
    // Context menu for directory tree items
    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showDirectoryContextMenu(e.clientX, e.clientY, dir);
    });
    
    wrapper.appendChild(item);
    wrapper.appendChild(childrenContainer);
    
    return wrapper;
}

function handleDirectoryDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    
    if (draggedItem) {
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.add('drag-over');
        return false;
    }
    
    e.dataTransfer.dropEffect = 'none';
    return false;
}

function handleDirectoryDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

async function handleDirectoryDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    if (e.preventDefault) {
        e.preventDefault();
    }
    
    e.currentTarget.classList.remove('drag-over');
    
    const targetPath = e.currentTarget.dataset.path;
    
    if (!draggedItem || draggedItem.path === targetPath) {
        return false;
    }
    
    try {
        const response = await fetch('/api/move', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source_path: draggedItem.path,
                destination_path: targetPath
            })
        });
        
        const data = await response.json();
        if (data.success) {
            showNotification('Moved successfully', 'success');
            loadDirectory(currentPath);
            reloadDirectoryInTree(currentPath);
        } else {
            showNotification('Failed to move: ' + data.error, 'error');
        }
    } catch (error) {
        showNotification('Failed to move: ' + error, 'error');
    }
    
    return false;
}

function showDirectoryContextMenu(x, y, dir) {
    // Remove existing context menu if any
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    
    const menuItems = [];
    
    if (copiedFile) {
        menuItems.push({ 
            icon: 'fa-paste', 
            text: 'Paste Here', 
            action: () => pasteToDirectory(dir.path) 
        });
    }
    
    menuItems.push({ 
        icon: 'fa-folder-open', 
        text: 'Open', 
        action: () => loadDirectory(dir.path) 
    });
    
    menuItems.forEach(item => {
        const menuItem = document.createElement('div');
        menuItem.className = 'context-menu-item';
        menuItem.innerHTML = `<i class="fas ${item.icon}"></i> ${item.text}`;
        menuItem.addEventListener('click', () => {
            item.action();
            menu.remove();
        });
        menu.appendChild(menuItem);
    });
    
    document.body.appendChild(menu);
    
    // Close menu on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        });
    }, 10);
}

async function pasteToDirectory(targetPath) {
    if (!copiedFile) return;
    
    try {
        const response = await fetch('/api/paste', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source_path: copiedFilePath,
                destination_path: targetPath,
                is_cut: isCutOperation
            })
        });
        
        const data = await response.json();
        if (data.success) {
            showNotification(
                isCutOperation ? 'Moved successfully' : 'Copied successfully',
                'success'
            );
            
            // Reset cut operation styling
            document.querySelectorAll('.file-item').forEach(item => {
                item.style.opacity = '1';
            });
            
            if (isCutOperation) {
                copiedFile = null;
                copiedFilePath = null;
                isCutOperation = false;
            }
            
            loadDirectory(currentPath);
            reloadDirectoryInTree(targetPath);
        } else {
            showNotification('Failed to paste: ' + data.error, 'error');
        }
    } catch (error) {
        showNotification('Failed to paste: ' + error, 'error');
    }
}

// File Copy/Cut/Paste Functions
function copyFile() {
    if (!selectedFile) return;
    
    copiedFile = selectedFile;
    copiedFilePath = selectedFile.path;
    isCutOperation = false;
    
    showNotification('Copied: ' + selectedFile.name, 'success');
}

function cutFile() {
    if (!selectedFile) return;
    
    copiedFile = selectedFile;
    copiedFilePath = selectedFile.path;
    isCutOperation = true;
    
    // Visual feedback for cut operation
    document.querySelectorAll('.file-item').forEach(item => {
        if (item.dataset.path === selectedFile.path) {
            item.style.opacity = '0.5';
        }
    });
    
    showNotification('Cut: ' + selectedFile.name, 'warning');
}

async function pasteFile() {
    if (!copiedFile) return;
    
    try {
        const response = await fetch('/api/paste', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source_path: copiedFilePath,
                destination_path: currentPath,
                is_cut: isCutOperation
            })
        });
        
        const data = await response.json();
        if (data.success) {
            showNotification(
                isCutOperation ? 'Moved successfully' : 'Copied successfully',
                'success'
            );
            
            // Reset cut operation styling
            document.querySelectorAll('.file-item').forEach(item => {
                item.style.opacity = '1';
            });
            
            if (isCutOperation) {
                copiedFile = null;
                copiedFilePath = null;
                isCutOperation = false;
            }
            
            loadDirectory(currentPath);
            reloadDirectoryInTree(currentPath);
        } else {
            showNotification('Failed to paste: ' + data.error, 'error');
        }
    } catch (error) {
        showNotification('Failed to paste: ' + error, 'error');
    }
}

// Breadcrumb Functions
function updateBreadcrumb(path) {
    const breadcrumb = document.getElementById('breadcrumb-nav');
    const parts = path.split('/').filter(p => p);
    
    let html = '<span class="breadcrumb-item" data-path="/" onclick="loadDirectory(\'/\')">root</span>';
    let currentPath = '';
    
    parts.forEach(part => {
        currentPath += '/' + part;
        html += `<span class="breadcrumb-item" data-path="${currentPath}" onclick="loadDirectory('${currentPath}')">${part}</span>`;
    });
    
    breadcrumb.innerHTML = html;
    
    // Add drag and drop to breadcrumb items
    document.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.addEventListener('dragover', handleBreadcrumbDragOver);
        item.addEventListener('drop', handleBreadcrumbDrop);
        item.addEventListener('dragleave', handleBreadcrumbDragLeave);
        
        // Right-click context menu for breadcrumb
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const targetPath = item.dataset.path;
            showBreadcrumbContextMenu(e.clientX, e.clientY, targetPath);
        });
    });
}

function handleBreadcrumbDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    
    if (draggedItem) {
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.add('breadcrumb-drag-over');
        return false;
    }
    
    e.dataTransfer.dropEffect = 'none';
    return false;
}

function handleBreadcrumbDragLeave(e) {
    e.currentTarget.classList.remove('breadcrumb-drag-over');
}

async function handleBreadcrumbDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    if (e.preventDefault) {
        e.preventDefault();
    }
    
    e.currentTarget.classList.remove('breadcrumb-drag-over');
    
    const targetPath = e.currentTarget.dataset.path;
    
    if (!draggedItem || draggedItem.path === targetPath) {
        return false;
    }
    
    try {
        const response = await fetch('/api/move', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source_path: draggedItem.path,
                destination_path: targetPath
            })
        });
        
        const data = await response.json();
        if (data.success) {
            showNotification('Moved successfully', 'success');
            loadDirectory(currentPath);
            reloadDirectoryInTree(currentPath);
        } else {
            showNotification('Failed to move: ' + data.error, 'error');
        }
    } catch (error) {
        showNotification('Failed to move: ' + error, 'error');
    }
    
    return false;
}

function showBreadcrumbContextMenu(x, y, targetPath) {
    // Remove existing context menu if any
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    
    const menuItems = [];
    
    if (copiedFile) {
        menuItems.push({ 
            icon: 'fa-paste', 
            text: 'Paste Here', 
            action: () => pasteToDirectory(targetPath) 
        });
    }
    
    menuItems.push({ 
        icon: 'fa-folder-open', 
        text: 'Open', 
        action: () => loadDirectory(targetPath) 
    });
    
    menuItems.forEach(item => {
        const menuItem = document.createElement('div');
        menuItem.className = 'context-menu-item';
        menuItem.innerHTML = `<i class="fas ${item.icon}"></i> ${item.text}`;
        menuItem.addEventListener('click', () => {
            item.action();
            menu.remove();
        });
        menu.appendChild(menuItem);
    });
    
    document.body.appendChild(menu);
    
    // Close menu on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        });
    }, 10);
}

// Image Viewer Functions
function openImageViewer(file) {
    const viewerWindow = document.getElementById('image-viewer-window');
    const viewerImg = document.getElementById('image-viewer-img');
    const viewerTitle = document.getElementById('image-viewer-title');
    const imageInfo = document.getElementById('image-info');
    
    currentZoom = 1;
    viewerImg.style.transform = `scale(${currentZoom})`;
    viewerImg.src = `/api/download?path=${encodeURIComponent(file.path)}`;
    viewerTitle.textContent = file.name;
    imageInfo.textContent = `Size: ${formatFileSize(file.size)}`;
    
    viewerWindow.style.display = 'flex';
    
    viewerImg.onload = function() {
        imageInfo.textContent = `Size: ${formatFileSize(file.size)} | Dimensions: ${this.naturalWidth}x${this.naturalHeight}px`;
    };
}

function closeImageViewer() {
    const viewerWindow = document.getElementById('image-viewer-window');
    viewerWindow.style.display = 'none';
    currentZoom = 1;
}

function setupImageViewer() {
    const viewerWindow = document.getElementById('image-viewer-window');
    const header = viewerWindow.querySelector('.image-viewer-header');
    let isDragging = false;
    let currentX, currentY, initialX, initialY;
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        if (e.target.classList.contains('image-viewer-close')) return;
        initialX = e.clientX - viewerWindow.offsetLeft;
        initialY = e.clientY - viewerWindow.offsetTop;
        isDragging = true;
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            viewerWindow.style.left = currentX + 'px';
            viewerWindow.style.top = currentY + 'px';
            viewerWindow.style.transform = 'none';
        }
    }
    
    function dragEnd() {
        isDragging = false;
    }
    
    document.querySelector('.image-viewer-close').addEventListener('click', closeImageViewer);
    
    document.getElementById('zoom-in').addEventListener('click', () => {
        currentZoom = Math.min(currentZoom + 0.25, 5);
        document.getElementById('image-viewer-img').style.transform = `scale(${currentZoom})`;
    });
    
    document.getElementById('zoom-out').addEventListener('click', () => {
        currentZoom = Math.max(currentZoom - 0.25, 0.25);
        document.getElementById('image-viewer-img').style.transform = `scale(${currentZoom})`;
    });
    
    document.getElementById('zoom-reset').addEventListener('click', () => {
        currentZoom = 1;
        document.getElementById('image-viewer-img').style.transform = `scale(${currentZoom})`;
    });
}

// Code Editor Functions
async function openFileInEditor(file) {
    if (file.is_directory) return;
    
    editorFile = file;
    const editorWindow = document.getElementById('code-editor-window');
    const editorContent = document.getElementById('editor-content');
    const editorTitle = document.getElementById('editor-title');
    const editorInfo = document.getElementById('editor-info');
    
    try {
        const response = await fetch(`/api/read-file?path=${encodeURIComponent(file.path)}`);
        const data = await response.json();
        
        if (data.success) {
            editorContent.value = data.content;
            editorTitle.innerHTML = `<i class="fas fa-code"></i> ${file.name} <span class="editor-language-badge">${getLanguageFromExtension(file.name)}</span>`;
            editorInfo.textContent = `Lines: ${data.content.split('\n').length} | Size: ${formatFileSize(file.size)}`;
            editorWindow.style.display = 'flex';
            
            applySyntaxHighlighting(file.name);
            
            editorContent.addEventListener('input', () => {
                const lines = editorContent.value.split('\n').length;
                editorInfo.textContent = `Lines: ${lines} | Modified`;
            });
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
    
    editorContent.className = 'editor-textarea';
    if (['js', 'py', 'cpp', 'c', 'h', 'sh', 'bash', 'html', 'css', 'json'].includes(ext)) {
        editorContent.classList.add(`syntax-${ext}`);
    }
}

async function saveFile() {
    if (!editorFile) return;
    
    const editorContent = document.getElementById('editor-content');
    const editorInfo = document.getElementById('editor-info');
    const content = editorContent.value;
    
    editorInfo.textContent = 'Saving...';
    
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
            const lines = content.split('\n').length;
            editorInfo.textContent = `Saved successfully! | Lines: ${lines}`;
            setTimeout(() => {
                editorInfo.textContent = `Lines: ${lines} | Ready`;
            }, 2000);
            loadDirectory(currentPath);
        } else {
            editorInfo.textContent = 'Save failed!';
            alert('Failed to save file: ' + data.error);
        }
    } catch (error) {
        editorInfo.textContent = 'Save failed!';
        alert('Failed to save file: ' + error);
    }
}

function closeEditor() {
    const editorWindow = document.getElementById('code-editor-window');
    editorWindow.style.display = 'none';
    editorFile = null;
}

function setupCodeEditor() {
    const editorWindow = document.getElementById('code-editor-window');
    const header = editorWindow.querySelector('.editor-header');
    const editorContent = document.getElementById('editor-content');
    let isDragging = false;
    let currentX, currentY, initialX, initialY;
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        if (e.target.classList.contains('editor-close')) return;
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
            editorWindow.style.transform = 'none';
        }
    }
    
    function dragEnd() {
        isDragging = false;
        editorWindow.style.cursor = 'default';
    }
    
    document.querySelector('.editor-close').addEventListener('click', closeEditor);
    document.getElementById('save-file-btn').addEventListener('click', saveFile);
    
    // Handle Tab key for indentation
    editorContent.addEventListener('keydown', (e) => {
        // Save with Ctrl+S
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            saveFile();
            return;
        }
        
        // Tab key handling
        if (e.key === 'Tab') {
            e.preventDefault();
            
            const start = editorContent.selectionStart;
            const end = editorContent.selectionEnd;
            const value = editorContent.value;
            
            if (e.shiftKey) {
                // Shift+Tab: Remove indentation
                const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                const beforeLine = value.substring(0, lineStart);
                const line = value.substring(lineStart, value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start));
                const afterLine = value.substring(lineStart + line.length);
                
                if (line.startsWith('    ')) {
                    editorContent.value = beforeLine + line.substring(4) + afterLine;
                    editorContent.selectionStart = start - 4;
                    editorContent.selectionEnd = end - 4;
                } else if (line.startsWith('\t')) {
                    editorContent.value = beforeLine + line.substring(1) + afterLine;
                    editorContent.selectionStart = start - 1;
                    editorContent.selectionEnd = end - 1;
                }
            } else {
                // Tab: Add indentation
                if (start === end) {
                    // No selection: insert tab at cursor
                    editorContent.value = value.substring(0, start) + '    ' + value.substring(end);
                    editorContent.selectionStart = editorContent.selectionEnd = start + 4;
                } else {
                    // Selection: indent all selected lines
                    const beforeSelection = value.substring(0, start);
                    const selectedText = value.substring(start, end);
                    const afterSelection = value.substring(end);
                    
                    const lineStart = beforeSelection.lastIndexOf('\n') + 1;
                    const lineEnd = end + (afterSelection.indexOf('\n') === -1 ? afterSelection.length : afterSelection.indexOf('\n'));
                    
                    const linesToIndent = value.substring(lineStart, lineEnd);
                    const indentedLines = linesToIndent.split('\n').map(line => '    ' + line).join('\n');
                    
                    editorContent.value = value.substring(0, lineStart) + indentedLines + value.substring(lineEnd);
                    editorContent.selectionStart = start + 4;
                    editorContent.selectionEnd = end + (indentedLines.length - linesToIndent.length);
                }
            }
            
            // Trigger input event for line count update
            editorContent.dispatchEvent(new Event('input'));
        }
    });
}

// Folder and File Creation
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

// File Download, Rename, and Delete
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

// Folder Size Inspection
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

// File Details Display
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
                            <button class="btn btn-sm btn-info" onclick="event.stopPropagation(); inspectFolderDetails('${file.path}', this)">
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

// Container context menu functions
function showContainerContextMenu(x, y) {
    // Remove existing context menu if any
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    
    const menuItems = [];
    
    // Add paste option if there's something copied
    if (copiedFile) {
        menuItems.push({ 
            icon: 'fa-paste', 
            text: 'Paste Here', 
            action: () => pasteFile()
        });
        menuItems.push({ type: 'separator' });
    }
    
    menuItems.push({ 
        icon: 'fa-folder-plus', 
        text: 'New Folder', 
        action: createNewFolder 
    });
    
    menuItems.push({ 
        icon: 'fa-file-plus', 
        text: 'New File', 
        action: createNewFile 
    });
    
    menuItems.push({ type: 'separator' });
    
    menuItems.push({ 
        icon: 'fa-upload', 
        text: 'Upload Files', 
        action: triggerFileUpload 
    });
    
    menuItems.forEach(item => {
        if (item.type === 'separator') {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            menu.appendChild(separator);
        } else {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            menuItem.innerHTML = `<i class="fas ${item.icon}"></i> ${item.text}`;
            menuItem.addEventListener('click', () => {
                item.action();
                menu.remove();
            });
            menu.appendChild(menuItem);
        }
    });
    
    document.body.appendChild(menu);
    
    // Close menu on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        });
    }, 10);
}

function setupFileUpload() {
    // Create hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'hidden-file-input';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    
    // Handle file selection
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        showNotification(`Uploading ${files.length} file(s)...`, 'info');
        
        for (const file of files) {
            await uploadFile(file);
        }
        
        // Reload directory to show uploaded files
        loadDirectory(currentPath);
        
        // Reset file input
        fileInput.value = '';
    });
}

function triggerFileUpload() {
    const fileInput = document.getElementById('hidden-file-input');
    if (fileInput) {
        fileInput.click();
    }
}

async function uploadFile(file) {
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', currentPath);
        
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (data.success) {
            showNotification(`Uploaded: ${file.name}`, 'success');
        } else {
            showNotification(`Failed to upload ${file.name}: ${data.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Failed to upload ${file.name}: ${error}`, 'error');
    }
}

// Keyboard Shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Copy: Ctrl+C
        if (e.ctrlKey && e.key === 'c' && selectedFile) {
            e.preventDefault();
            copyFile();
        }
        
        // Cut: Ctrl+X
        if (e.ctrlKey && e.key === 'x' && selectedFile) {
            e.preventDefault();
            cutFile();
        }
        
        // Paste: Ctrl+V
        if (e.ctrlKey && e.key === 'v' && copiedFile) {
            e.preventDefault();
            pasteFile();
        }
    });
}
