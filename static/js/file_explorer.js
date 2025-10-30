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
let folderPreferences = {}; // Store folder colors and favorites

// Import modules
document.addEventListener('DOMContentLoaded', function() {
    initializeFileExplorer();
    setupEventListeners();
    setupCodeEditor();
    setupImageViewer();
    setupKeyboardShortcuts();
});

function initializeFileExplorer() {
    // Load folder preferences from server
    loadFolderPreferences();
    
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

async function loadFolderPreferences() {
    try {
        const response = await fetch('/api/folder-preferences');
        const data = await response.json();
        if (data.success) {
            folderPreferences = data.preferences || {};
        }
    } catch (error) {
        console.error('Error loading folder preferences:', error);
        folderPreferences = {};
    }
}

async function saveFolderPreferences() {
    try {
        const response = await fetch('/api/folder-preferences', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ preferences: folderPreferences })
        });
        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('Error saving folder preferences:', error);
        return false;
    }
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
    
    // Sort: favorites first, then directories, then by name
    files.sort((a, b) => {
        const aIsFavorite = folderPreferences[a.path]?.favorite || false;
        const bIsFavorite = folderPreferences[b.path]?.favorite || false;
        
        if (aIsFavorite !== bIsFavorite) {
            return bIsFavorite - aIsFavorite;
        }
        
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
    
    // Apply folder color and favorite styling
    const prefs = folderPreferences[dir.path];
    if (prefs) {
        if (prefs.favorite) {
            item.classList.add('favorite-folder');
        }
    }
    
    // Make directory items drop targets
    item.addEventListener('dragover', handleDirectoryDragOver);
    item.addEventListener('drop', handleDirectoryDrop);
    item.addEventListener('dragleave', handleDirectoryDragLeave);
    
    const chevron = document.createElement('i');
    chevron.className = 'fas fa-chevron-right';
    
    const icon = document.createElement('i');
    icon.className = 'fas fa-folder file-icon folder';
    
    // Apply folder color to icon only
    if (prefs?.color) {
        icon.style.color = prefs.color;
    }
    
    const name = document.createElement('span');
    name.textContent = dir.name;
    
    // Add favorite star if folder is favorite
    if (prefs?.favorite) {
        const star = document.createElement('i');
        star.className = 'fas fa-star favorite-star';
        star.style.marginLeft = '5px';
        star.style.color = '#00ffcc';
        star.style.fontSize = '10px';
        name.appendChild(star);
    }
    
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
    
    const prefs = folderPreferences[dir.path] || {};
    
    // Toggle favorite
    menuItems.push({ 
        icon: prefs.favorite ? 'fa-star' : 'fa-star-o', 
        text: prefs.favorite ? 'Remove from Favorites' : 'Add to Favorites', 
        action: () => toggleFolderFavorite(dir.path),
        class: prefs.favorite ? 'favorite-active' : ''
    });
    
    // Set color submenu
    menuItems.push({ 
        icon: 'fa-palette', 
        text: 'Set Color', 
        submenu: [
            { color: '#ff6b6b', name: 'Red' },
            { color: '#4ecdc4', name: 'Teal' },
            { color: '#45b7d1', name: 'Blue' },
            { color: '#96ceb4', name: 'Green' },
            { color: '#ffeaa7', name: 'Yellow' },
            { color: '#fd79a8', name: 'Pink' },
            { color: '#a29bfe', name: 'Purple' },
            { color: '#fd79a8', name: 'Orange' },
            { color: null, name: 'Remove Color' }
        ]
    });
    
    menuItems.push({ type: 'separator' });
    
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
        if (item.type === 'separator') {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            menu.appendChild(separator);
        } else if (item.submenu) {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item context-menu-submenu';
            menuItem.innerHTML = `<i class="fas ${item.icon}"></i> ${item.text} <i class="fas fa-chevron-right" style="margin-left: auto;"></i>`;
            
            const submenu = document.createElement('div');
            submenu.className = 'context-submenu';
            
            item.submenu.forEach(subitem => {
                const subMenuItem = document.createElement('div');
                subMenuItem.className = 'context-menu-item';
                
                if (subitem.color) {
                    subMenuItem.innerHTML = `<span class="color-dot" style="background-color: ${subitem.color};"></span> ${subitem.name}`;
                } else {
                    subMenuItem.innerHTML = `<i class="fas fa-times"></i> ${subitem.name}`;
                }
                
                subMenuItem.addEventListener('click', () => {
                    setFolderColor(dir.path, subitem.color);
                    menu.remove();
                });
                submenu.appendChild(subMenuItem);
            });
            
            menuItem.appendChild(submenu);
            menu.appendChild(menuItem);
        } else {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item' + (item.class ? ' ' + item.class : '');
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

function toggleFolderFavorite(path) {
    if (!folderPreferences[path]) {
        folderPreferences[path] = {};
    }
    
    folderPreferences[path].favorite = !folderPreferences[path].favorite;
    
    // Save to server
    saveFolderPreferences();
    
    // Refresh displays
    loadDirectory(currentPath);
    reloadDirectoryInTree(path.substring(0, path.lastIndexOf('/')) || '/');
    
    showNotification(
        folderPreferences[path].favorite ? 'Added to favorites' : 'Removed from favorites',
        'success'
    );
}

function setFolderColor(path, color) {
    if (!folderPreferences[path]) {
        folderPreferences[path] = {};
    }
    
    if (color) {
        folderPreferences[path].color = color;
    } else {
        delete folderPreferences[path].color;
    }
    
    // Save to server
    saveFolderPreferences();
    
    // Refresh displays
    loadDirectory(currentPath);
    reloadDirectoryInTree(path.substring(0, path.lastIndexOf('/')) || '/');
    
    showNotification(
        color ? 'Folder color updated' : 'Folder color removed',
        'success'
    );
}

function createFileItem(file) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.path = file.path;
    
    // Apply folder preferences if it's a directory
    const prefs = folderPreferences[file.path];
    if (file.is_directory && prefs) {
        if (prefs.favorite) {
            fileItem.classList.add('favorite-folder');
        }
        if (prefs.color) {
            fileItem.classList.add('colored-folder');
        }
    }
    
    // Make items draggable
    fileItem.draggable = true;
    fileItem.addEventListener('dragstart', (e) => {
        draggedItem = file;
        e.dataTransfer.effectAllowed = 'move';
        fileItem.style.opacity = '0.5';
    });
    
    fileItem.addEventListener('dragend', (e) => {
        fileItem.style.opacity = '1';
        draggedItem = null;
    });
    
    // Make directory items drop targets
    if (file.is_directory) {
        fileItem.addEventListener('dragover', handleDirectoryDragOver);
        fileItem.addEventListener('drop', handleDirectoryDrop);
        fileItem.addEventListener('dragleave', handleDirectoryDragLeave);
    }
    
    const icon = document.createElement('i');
    icon.className = `fas ${getFileIcon(file)} file-icon ${getFileIconClass(file)}`;
    
    // Apply color to folder icon if set
    if (file.is_directory && prefs?.color) {
        icon.style.color = prefs.color;
    }
    
    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    
    const fileName = document.createElement('div');
    fileName.className = 'file-name';
    fileName.textContent = file.name;
    
    const fileMeta = document.createElement('div');
    fileMeta.className = 'file-meta';
    
    if (file.is_directory) {
        fileMeta.innerHTML = `
            <span class="file-chmod">${file.permissions}</span>
        `;
    } else {
        fileMeta.innerHTML = `
            <span>${formatFileSize(file.size)}</span>
            <span class="file-chmod">${file.permissions}</span>
        `;
    }
    
    fileInfo.appendChild(fileName);
    fileInfo.appendChild(fileMeta);
    
    fileItem.appendChild(icon);
    fileItem.appendChild(fileInfo);
    
    // Click handler
    fileItem.addEventListener('click', () => {
        document.querySelectorAll('.file-item').forEach(item => item.classList.remove('selected'));
        fileItem.classList.add('selected');
        selectedFile = file;
        displayFileDetails(file);
    });
    
    // Double-click handler
    fileItem.addEventListener('dblclick', () => {
        if (file.is_directory) {
            loadDirectory(file.path);
        } else {
            const ext = file.name.split('.').pop().toLowerCase();
            if (isImageFile(ext)) {
                openImageViewer(file);
            } else if (isTextFile(ext)) {
                openFileInEditor(file);
            } else {
                downloadFile();
            }
        }
    });
    
    // Context menu
    fileItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Select the item first
        document.querySelectorAll('.file-item').forEach(item => item.classList.remove('selected'));
        fileItem.classList.add('selected');
        selectedFile = file;
        displayFileDetails(file);
        
        showFileContextMenu(e.clientX, e.clientY, file);
    });
    
    return fileItem;
}

function showFileContextMenu(x, y, file) {
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
    
    // Add folder-specific options for directories
    if (file.is_directory) {
        const prefs = folderPreferences[file.path] || {};
        
        menuItems.push({ 
            icon: prefs.favorite ? 'fa-star' : 'fa-star-o', 
            text: prefs.favorite ? 'Remove from Favorites' : 'Add to Favorites', 
            action: () => toggleFolderFavorite(file.path),
            class: prefs.favorite ? 'favorite-active' : ''
        });
        
        menuItems.push({ 
            icon: 'fa-palette', 
            text: 'Set Color', 
            submenu: [
                { color: '#ff6b6b', name: 'Red' },
                { color: '#4ecdc4', name: 'Teal' },
                { color: '#45b7d1', name: 'Blue' },
                { color: '#96ceb4', name: 'Green' },
                { color: '#ffeaa7', name: 'Yellow' },
                { color: '#fd79a8', name: 'Pink' },
                { color: '#a29bfe', name: 'Purple' },
                { color: '#e17055', name: 'Orange' },
                { color: null, name: 'Remove Color' }
            ]
        });
        
        menuItems.push({ type: 'separator' });
        menuItems.push({ 
            icon: 'fa-folder-open', 
            text: 'Open', 
            action: () => loadDirectory(file.path) 
        });
    } else {
        // File-specific options
        const ext = file.name.split('.').pop().toLowerCase();
        if (isTextFile(ext)) {
            menuItems.push({ 
                icon: 'fa-edit', 
                text: 'Edit', 
                action: () => openFileInEditor(file) 
            });
        }
        if (isImageFile(ext)) {
            menuItems.push({ 
                icon: 'fa-eye', 
                text: 'View', 
                action: () => openImageViewer(file) 
            });
        }
        menuItems.push({ 
            icon: 'fa-download', 
            text: 'Download', 
            action: downloadFile 
        });
    }
    
    menuItems.push({ type: 'separator' });
    menuItems.push({ 
        icon: 'fa-copy', 
        text: 'Copy', 
        action: copyFile 
    });
    menuItems.push({ 
        icon: 'fa-cut', 
        text: 'Cut', 
        action: cutFile 
    });
    
    menuItems.push({ type: 'separator' });
    menuItems.push({ 
        icon: 'fa-edit', 
        text: 'Rename', 
        action: renameFile 
    });
    menuItems.push({ 
        icon: 'fa-trash', 
        text: 'Delete', 
        action: deleteFile,
        class: 'danger'
    });
    
    menuItems.forEach(item => {
        if (item.type === 'separator') {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            menu.appendChild(separator);
        } else if (item.submenu) {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item context-menu-submenu';
            menuItem.innerHTML = `<i class="fas ${item.icon}"></i> ${item.text} <i class="fas fa-chevron-right" style="margin-left: auto;"></i>`;
            
            const submenu = document.createElement('div');
            submenu.className = 'context-submenu';
            
            item.submenu.forEach(subitem => {
                const subMenuItem = document.createElement('div');
                subMenuItem.className = 'context-menu-item';
                
                if (subitem.color) {
                    subMenuItem.innerHTML = `<span class="color-dot" style="background-color: ${subitem.color};"></span> ${subitem.name}`;
                } else {
                    subMenuItem.innerHTML = `<i class="fas fa-times"></i> ${subitem.name}`;
                }
                
                subMenuItem.addEventListener('click', () => {
                    setFolderColor(file.path, subitem.color);
                    menu.remove();
                });
                submenu.appendChild(subMenuItem);
            });
            
            menuItem.appendChild(submenu);
            menu.appendChild(menuItem);
        } else {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item' + (item.class ? ' ' + item.class : '');
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

function filterDirectoryTree(searchTerm) {
    const items = document.querySelectorAll('.directory-item');
    items.forEach(item => {
        const name = item.textContent.toLowerCase();
        if (name.includes(searchTerm)) {
            item.style.display = 'flex';
            // Show parent containers
            let parent = item.parentElement;
            while (parent) {
                if (parent.classList.contains('directory-children')) {
                    parent.style.display = 'block';
                }
                parent = parent.parentElement;
            }
        } else if (searchTerm === '') {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
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

function reloadDirectoryInTree(path) {
    // Find and reload the directory tree for the given path
    const parentPath = path === '/' ? '/' : path.substring(0, path.lastIndexOf('/')) || '/';
    loadDirectoryTree(parentPath);
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
