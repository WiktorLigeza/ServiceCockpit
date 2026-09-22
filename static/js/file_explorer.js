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
let draggedItems = [];
let folderPreferences = {}; // Store folder colors and favorites
let uploadTargetPath = null;
let selectedColorFilters = new Set();
const archiveCache = new Map();
let selectedFiles = [];
let lastSelectedIndex = -1;
let visibleFiles = [];
let visibleFileMap = new Map();
let copiedFiles = [];

// Import modules
document.addEventListener('DOMContentLoaded', function() {
    initializeFileExplorer();
    setupEventListeners();
    setupCodeEditor();
    setupImageViewer();
    if (typeof setupVideoViewer === 'function') {
        setupVideoViewer();
    }
    if (typeof setupExecutableRunner === 'function') {
        setupExecutableRunner();
    }
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
            setupColorFilters();
            applyDirectoryColorFilter();
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

    const gridViewBtn = document.querySelector('.view-btn[data-view="grid"]');
    const listViewBtn = document.querySelector('.view-btn[data-view="list"]');
    if (gridViewBtn) gridViewBtn.classList.add('active');
    if (listViewBtn) listViewBtn.classList.remove('active');

    // Setup filter toggle buttons
    setupFilterButtons();

    const fileSearch = document.getElementById('file-search');
    if (fileSearch) {
        fileSearch.addEventListener('input', function(e) {
            nameFilter = e.target.value.toLowerCase();
            applyFilters();
        });
    }

    const directorySearch = document.getElementById('directory-search');
    if (directorySearch) {
        directorySearch.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            filterDirectoryTree(searchTerm);
        });
    }

    const currentPathDisplay = document.getElementById('current-path');
    if (currentPathDisplay) {
        currentPathDisplay.addEventListener('click', () => {
            copyCurrentPath();
        });
    }

    const editPathBtn = document.getElementById('edit-path-btn');
    if (editPathBtn) {
        editPathBtn.addEventListener('click', (e) => {
            e.preventDefault();
            enterPathEdit();
        });
    }

    const pathInput = document.getElementById('path-input');
    if (pathInput) {
        pathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                exitPathEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                exitPathEdit(false);
            }
        });
        pathInput.addEventListener('blur', () => {
            exitPathEdit(false);
        });
    }

    const newFolderBtn = document.getElementById('new-folder-btn');
    if (newFolderBtn) {
        newFolderBtn.addEventListener('click', createNewFolder);
    }

    const newFileBtn = document.getElementById('new-file-btn');
    if (newFileBtn) {
        newFileBtn.addEventListener('click', createNewFile);
    }
    
    // Add context menu to files container
    const filesContainer = document.getElementById('files-container');
    if (filesContainer) {
        filesContainer.addEventListener('contextmenu', (e) => {
            // Only show context menu if clicking on the container itself, not on a file item
            if (e.target === filesContainer || e.target.classList.contains('no-selection')) {
                e.preventDefault();
                showContainerContextMenu(e.clientX, e.clientY);
            }
        });

        // Enable OS drag-and-drop upload into the current folder.
        // If the user is currently hovering a folder (tree or list), externalFileDropTargetPath
        // will be set by the drag handlers and used as the destination.
        filesContainer.addEventListener('dragover', (e) => {
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                filesContainer.classList.add('drag-over');
            }
        });

        filesContainer.addEventListener('dragleave', (e) => {
            // Only clear when leaving the container (avoid flicker on child transitions)
            if (!filesContainer.contains(e.relatedTarget)) {
                filesContainer.classList.remove('drag-over');
            }
        });

        filesContainer.addEventListener('drop', async (e) => {
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                filesContainer.classList.remove('drag-over');

                const destinationPath = (typeof externalFileDropTargetPath === 'string' && externalFileDropTargetPath)
                    ? externalFileDropTargetPath
                    : currentPath;

                await uploadFiles(Array.from(e.dataTransfer.files), destinationPath);
            }
        });
    }

    window.addEventListener('dragover', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            e.preventDefault();
        }
    });

    window.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            e.preventDefault();
        }
    });
    
    // Setup file upload functionality
    setupFileUpload();

    if (typeof setupMultiSelection === 'function') {
        setupMultiSelection();
    }
}

function setupFilterButtons() {
    // Remove old select if exists
    const oldFilter = document.getElementById('file-filter');
    if (oldFilter) {
        oldFilter.remove();
    }

    // Find the filter container or create one
    let filterContainer = document.getElementById('filter-buttons');
    if (!filterContainer) {
        // Try to find a suitable parent container
        const fileSearch = document.getElementById('file-search');
        if (fileSearch && fileSearch.parentElement) {
            filterContainer = document.createElement('div');
            filterContainer.id = 'filter-buttons';
            filterContainer.className = 'filter-buttons';
            fileSearch.parentElement.insertBefore(filterContainer, fileSearch);
        } else {
            return; // Can't setup filters without a container
        }
    }

    // Clear existing buttons
    filterContainer.innerHTML = '';

    // Define filter buttons with icons
    const filters = [
        { value: 'all', icon: 'fa-th', title: 'All Files' },
        { value: 'folders', icon: 'fa-folder', title: 'Folders Only' },
        { value: 'files', icon: 'fa-file', title: 'Files Only' },
        { value: 'images', icon: 'fa-image', title: 'Images' },
        { value: 'executables', icon: 'fa-terminal', title: 'Executables' },
        { value: 'code', icon: 'fa-code', title: 'Code Files' },
        { value: 'documents', icon: 'fa-file-alt', title: 'Documents' }
    ];

    filters.forEach(filter => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn';
        btn.dataset.filter = filter.value;
        btn.title = filter.title;
        btn.innerHTML = `<i class="fas ${filter.icon}"></i>`;
        
        if (filter.value === 'all') {
            btn.classList.add('active');
        }

        btn.addEventListener('click', function() {
            // Remove active class from all filter buttons
            filterContainer.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            this.classList.add('active');
            // Update filter and apply
            currentFilter = this.dataset.filter;
            applyFilters();
        });

        filterContainer.appendChild(btn);
    });
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

    if (file.is_executable) return 'fa-terminal';
    
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

function setupColorFilters() {
    const container = document.getElementById('color-filter-buttons');
    if (!container) return;
    container.innerHTML = '';

    const palette = [
        { color: '#ff6b6b', name: 'Red' },
        { color: '#4ecdc4', name: 'Teal' },
        { color: '#45b7d1', name: 'Blue' },
        { color: '#96ceb4', name: 'Green' },
        { color: '#ffeaa7', name: 'Yellow' },
        { color: '#fd79a8', name: 'Pink' },
        { color: '#a29bfe', name: 'Purple' },
        { color: '#e17055', name: 'Orange' }
    ];

    palette.forEach(entry => {
        const btn = document.createElement('button');
        btn.className = 'color-filter-btn';
        btn.style.color = entry.color;
        btn.title = entry.name;
        btn.dataset.color = entry.color;
        btn.addEventListener('click', () => {
            if (selectedColorFilters.has(entry.color)) {
                selectedColorFilters.delete(entry.color);
                btn.classList.remove('active');
            } else {
                selectedColorFilters.add(entry.color);
                btn.classList.add('active');
            }
            applyDirectoryColorFilter();
        });
        container.appendChild(btn);
    });
}

function applyDirectoryColorFilter() {
    const items = document.querySelectorAll('.directory-item');
    if (selectedColorFilters.size === 0) {
        items.forEach(item => {
            item.style.display = 'flex';
        });
        renderSavedFoldersByColor(false);
        return;
    }

    items.forEach(item => {
        const color = item.dataset.color || '';
        if (color && selectedColorFilters.has(color)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });

    renderSavedFoldersByColor(true);
}

function renderSavedFoldersByColor(enabled) {
    const treeContainer = document.getElementById('directory-tree-container');
    if (!treeContainer) return;

    let section = document.getElementById('saved-folders-section');
    if (!section) {
        section = document.createElement('div');
        section.id = 'saved-folders-section';
        section.className = 'saved-folders-section';
        treeContainer.prepend(section);
    }

    if (!enabled) {
        section.style.display = 'none';
        section.innerHTML = '';
        return;
    }

    const entries = Object.entries(folderPreferences || {})
        .filter(([, prefs]) => prefs && prefs.color && selectedColorFilters.has(prefs.color));

    section.style.display = 'block';
    section.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'saved-folders-header';
    header.textContent = 'Saved folders (filtered)';
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'saved-folders-list';

    entries
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([path, prefs]) => {
            const item = document.createElement('div');
            item.className = 'directory-item saved-folder-item';
            item.dataset.path = path;
            item.dataset.color = prefs.color;

            const icon = document.createElement('i');
            icon.className = 'fas fa-folder file-icon folder';
            icon.style.color = prefs.color;

            const name = document.createElement('span');
            const parts = path.split('/').filter(Boolean);
            name.textContent = parts.length ? parts[parts.length - 1] : path;

            item.appendChild(icon);
            item.appendChild(name);
            if (!enabled) {
                const pathLabel = document.createElement('span');
                pathLabel.className = 'saved-folder-path';
                pathLabel.textContent = path;
                item.appendChild(pathLabel);
            }

            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ok = await copyTextToClipboard(path);
                showNotification(ok ? 'Path copied' : 'Failed to copy path', ok ? 'success' : 'error');
            });

            item.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                loadDirectory(path);
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showDirectoryContextMenu(e.clientX, e.clientY, { path, name: name.textContent });
            });

            list.appendChild(item);
        });

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'saved-folders-empty';
        empty.textContent = 'No saved folders for selected colors';
        list.appendChild(empty);
    }

    section.appendChild(list);
}

async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) {
        // fallback below
    }

    try {
        const temp = document.createElement('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
        return true;
    } catch (e) {
        return false;
    }
}

async function copyCurrentPath() {
    const path = currentPath || '';
    if (!path) return;
    const ok = await copyTextToClipboard(path);
    showNotification(ok ? 'Path copied' : 'Failed to copy path', ok ? 'success' : 'error');
}

function enterPathEdit() {
    const display = document.getElementById('current-path');
    const input = document.getElementById('path-input');
    const editBtn = document.getElementById('edit-path-btn');
    if (!display || !input) return;
    display.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';
    input.style.display = 'inline-block';
    input.value = currentPath;
    input.focus();
    input.select();
}

function exitPathEdit(commit = false) {
    const display = document.getElementById('current-path');
    const input = document.getElementById('path-input');
    const editBtn = document.getElementById('edit-path-btn');
    if (!display || !input) return;

    if (commit) {
        const nextPath = (input.value || '').trim();
        if (nextPath) {
            loadDirectory(nextPath);
        }
    }

    input.style.display = 'none';
    if (editBtn) editBtn.style.display = 'inline-flex';
    display.style.display = 'inline-block';
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
    
    const currentPathDisplay = document.getElementById('current-path');
    if (currentPathDisplay) currentPathDisplay.textContent = path;
    const pathInput = document.getElementById('path-input');
    if (pathInput) pathInput.value = path;
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
        case 'executables':
            filteredFiles = filteredFiles.filter(f => !f.is_directory && !!f.is_executable);
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

    visibleFiles = files;
    visibleFileMap = new Map(files.map(file => [file.path, file]));
    if (typeof resetSelection === 'function') {
        resetSelection();
    } else {
        selectedFiles = [];
        selectedFile = null;
    }
    
    if (files.length === 0) {
        container.innerHTML = '<div class="no-selection"><i class="fas fa-folder-open"></i><p>No files match the filter</p></div>';
        if (typeof updateSelectionDetails === 'function') {
            updateSelectionDetails();
        }
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
    
    files.forEach((file, index) => {
        const fileItem = createFileItem(file, index);
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

            applyDirectoryColorFilter();
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
        if (prefs.color) {
            item.classList.add('colored-folder');
            item.style.setProperty('--folder-color', prefs.color);
            item.dataset.color = prefs.color;
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
    appendBreakableText(name, dir.name);

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

    applyDirectoryColorFilter();
    
    return wrapper;
}

function _hasExternalFiles(e) {
    return !!(e && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0);
}

function handleDirectoryDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }

    if (_hasExternalFiles(e)) {
        if (typeof externalFileDropTargetPath !== 'undefined') {
            externalFileDropTargetPath = e.currentTarget.dataset.path;
        }
        e.dataTransfer.dropEffect = 'copy';
        e.currentTarget.classList.add('drag-over');
        return false;
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

    if (_hasExternalFiles(e) && typeof externalFileDropTargetPath !== 'undefined') {
        externalFileDropTargetPath = null;
    }
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

    if (_hasExternalFiles(e)) {
        const files = Array.from(e.dataTransfer.files);
        if (typeof externalFileDropTargetPath !== 'undefined') {
            externalFileDropTargetPath = null;
        }
        if (typeof uploadFiles === 'function') {
            await uploadFiles(files, targetPath);
        }
        return false;
    }
    
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
    menu.style.visibility = 'hidden';
    
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
        icon: 'fa-upload',
        text: 'Upload Here',
        action: () => triggerFileUpload(dir.path),
    });
    
    menuItems.push({
        icon: 'fa-folder-open',
        text: 'Open',
        action: () => loadDirectory(dir.path)
    });
    menuItems.push({
        icon: 'fa-terminal',
        text: 'Open Terminal Here',
        action: () => openTerminalAt(dir.path),
    });

    menuItems.push({ type: 'separator' });
    menuItems.push({
        icon: 'fa-file-archive',
        text: 'Create ZIP',
        action: () => createArchive('zip', dir.path, currentPath),
    });
    menuItems.push({
        icon: 'fa-file-archive',
        text: 'Create tar.gz',
        action: () => createArchive('targz', dir.path, currentPath),
    });
    if (archiveCache.has(dir.path)) {
        menuItems.push({
            icon: 'fa-download',
            text: 'Download Latest Archive',
            action: () => downloadLatestArchive(dir.path),
        });
    }
    
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
    if (typeof positionContextMenu === 'function') {
        positionContextMenu(menu, x, y);
    } else {
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }
    menu.style.visibility = 'visible';
    
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

function createFileItem(file, index) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.path = file.path;
    fileItem.dataset.isDirectory = file.is_directory;
    fileItem.dataset.index = String(index ?? 0);
    
    // Apply folder preferences if it's a directory
    const prefs = folderPreferences[file.path];
    if (file.is_directory && prefs) {
        if (prefs.favorite) {
            fileItem.classList.add('favorite-folder');
        }
        if (prefs.color) {
            fileItem.classList.add('colored-folder');
            fileItem.style.setProperty('--folder-color', prefs.color);
        }
    }
    
    // Make items draggable
    fileItem.draggable = true;
    fileItem.addEventListener('dragstart', handleDragStart);
    fileItem.addEventListener('dragend', handleDragEnd);
    fileItem.addEventListener('dragover', handleDragOver);
    fileItem.addEventListener('drop', handleDrop);
    fileItem.addEventListener('dragleave', handleDragLeave);
    
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
    appendBreakableText(fileName, file.name);
    
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
    fileItem.addEventListener('click', (e) => {
        if (typeof handleFileItemSelection === 'function') {
            handleFileItemSelection(e, fileItem, file);
        } else {
            selectFile(fileItem, file);
        }
    });
    
    // Double-click handler
    fileItem.addEventListener('dblclick', () => {
        if (file.is_directory) {
            loadDirectory(file.path);
            return;
        }
        const ext = file.name.split('.').pop().toLowerCase();
        if (isImageFile(ext)) {
            openImageViewer(file);
        } else if (isVideoFile(ext) && typeof openVideoViewer === 'function') {
            openVideoViewer(file);
        } else if (isTextFile(ext)) {
            openFileInEditor(file);
        } else {
            downloadFile();
        }
    });
    
    // Context menu
    fileItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const currentPaths = new Set(selectedFiles.map(f => f.path));
        currentPaths.add(file.path);
        if (typeof setSelectionByPaths === 'function') {
            setSelectionByPaths(currentPaths, file.path);
        } else {
            selectFile(fileItem, file);
        }
        
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
    menu.style.visibility = 'hidden';
    
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
        if (copiedFile) {
            menuItems.push({
                icon: 'fa-paste',
                text: 'Paste Here',
                action: () => pasteToDirectory(file.path),
            });
        }
        menuItems.push({
            icon: 'fa-upload',
            text: 'Upload Here',
            action: () => triggerFileUpload(file.path),
        });
        menuItems.push({
            icon: 'fa-folder-open',
            text: 'Open',
            action: () => loadDirectory(file.path)
        });
        menuItems.push({
            icon: 'fa-terminal',
            text: 'Open Terminal Here',
            action: () => openTerminalAt(file.path),
        });
        menuItems.push({ type: 'separator' });
        menuItems.push({
            icon: 'fa-file-archive',
            text: 'Create ZIP',
            action: () => createArchive('zip', file.path, currentPath),
        });
        menuItems.push({
            icon: 'fa-file-archive',
            text: 'Create tar.gz',
            action: () => createArchive('targz', file.path, currentPath),
        });
        if (archiveCache.has(file.path)) {
            menuItems.push({
                icon: 'fa-download',
                text: 'Download Latest Archive',
                action: () => downloadLatestArchive(file.path),
            });
        }
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
        if (isVideoFile(ext) && typeof openVideoViewer === 'function') {
            menuItems.push({
                icon: 'fa-play',
                text: 'Play',
                action: () => openVideoViewer(file)
            });
        }
        if (file.is_executable && typeof openExecutableRunner === 'function') {
            menuItems.push({
                icon: 'fa-terminal',
                text: 'Run',
                action: () => openExecutableRunner(file)
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
    menuItems.push({ type: 'separator' });
    menuItems.push({
        icon: 'fa-link',
        text: 'Copy Path',
        action: async () => {
            await copyTextToClipboard(file.path);
            showNotification('Path copied', 'success');
        },
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
    if (typeof positionContextMenu === 'function') {
        positionContextMenu(menu, x, y);
    } else {
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }
    menu.style.visibility = 'visible';
    
    // Close menu on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        });
    }, 10);
}

function downloadArchive(format, path) {
    if (!path) return;
    downloadLatestArchive(path);
}

function createArchiveJob(label) {
    const bar = document.getElementById('archive-jobs-bar');
    if (!bar) return null;
    const job = document.createElement('div');
    job.className = 'archive-job';
    job.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>${label}</span>`;
    bar.appendChild(job);
    return job;
}

async function createArchive(format, path, destinationPath) {
    if (!path) return;
    const fmt = format === 'targz' ? 'targz' : 'zip';
    const label = `Creating ${fmt} for ${path}`;
    const job = createArchiveJob(label);
    showNotification('Preparing archive...', 'info');
    try {
        const resp = await fetch('/api/archive/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, format: fmt, destination_path: destinationPath || currentPath }),
        });
        const data = await resp.json();
        if (!data.success) {
            showNotification(`Archive failed: ${data.error || 'unknown'}`, 'error');
            if (job) job.innerHTML = `<i class="fas fa-times"></i> <span>Archive failed</span>`;
            return;
        }
        const archive = data.archive;
        archiveCache.set(path, archive);
        showNotification('Archive created', 'success');
        if (job) {
            job.innerHTML = `
                <i class="fas fa-check"></i>
                <span>${archive.filename} ready</span>
                <button class="archive-download" title="Download">
                    <i class="fas fa-download"></i>
                </button>
            `;
            const btn = job.querySelector('.archive-download');
            btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                downloadLatestArchive(path);
            });
            setTimeout(() => job.remove(), 15000);
        }

        loadDirectory(currentPath);
        if (selectedFile && selectedFile.path === path) {
            displayFileDetails(selectedFile);
        }
    } catch (e) {
        showNotification(`Archive failed: ${e}`, 'error');
        if (job) job.innerHTML = `<i class="fas fa-times"></i> <span>Archive failed</span>`;
    }
}

async function createArchiveMulti(format, paths, destinationPath, autoDownload = false) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const fmt = format === 'targz' ? 'targz' : 'zip';
    const label = `Creating ${fmt} for selection (${paths.length})`;
    const job = createArchiveJob(label);
    showNotification('Preparing archive...', 'info');
    try {
        const resp = await fetch('/api/archive/create-multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths, format: fmt, destination_path: destinationPath || currentPath }),
        });
        const data = await resp.json();
        if (!data.success) {
            showNotification(`Archive failed: ${data.error || 'unknown'}`, 'error');
            if (job) job.innerHTML = `<i class="fas fa-times"></i> <span>Archive failed</span>`;
            return;
        }
        const archive = data.archive;
        archiveCache.set(archive.path, archive);
        showNotification('Archive created', 'success');
        if (job) {
            job.innerHTML = `
                <i class="fas fa-check"></i>
                <span>${archive.filename} ready</span>
                <button class="archive-download" title="Download">
                    <i class="fas fa-download"></i>
                </button>
            `;
            const btn = job.querySelector('.archive-download');
            btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                window.location.href = `/api/download?path=${encodeURIComponent(archive.path)}`;
            });
            setTimeout(() => job.remove(), 15000);
        }

        loadDirectory(currentPath);
        if (autoDownload && archive?.path) {
            window.location.href = `/api/download?path=${encodeURIComponent(archive.path)}`;
        }
    } catch (e) {
        showNotification(`Archive failed: ${e}`, 'error');
        if (job) job.innerHTML = `<i class="fas fa-times"></i> <span>Archive failed</span>`;
    }
}

function downloadLatestArchive(path) {
    const archive = archiveCache.get(path);
    if (!archive || !archive.path) {
        showNotification('No archive available. Create one first.', 'warning');
        return;
    }
    window.location.href = `/api/download?path=${encodeURIComponent(archive.path)}`;
}

function showContainerContextMenu(x, y) {
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.visibility = 'hidden';

    const menuItems = [];

    if (copiedFile || (copiedFiles && copiedFiles.length)) {
        menuItems.push({
            icon: 'fa-paste',
            text: 'Paste Here',
            action: () => pasteToDirectory(currentPath),
        });
    }

    menuItems.push({
        icon: 'fa-upload',
        text: 'Upload Here',
        action: () => triggerFileUpload(currentPath),
    });

    menuItems.push({ type: 'separator' });
    menuItems.push({
        icon: 'fa-folder-plus',
        text: 'New Folder',
        action: createNewFolder,
    });
    menuItems.push({
        icon: 'fa-file-plus',
        text: 'New File',
        action: createNewFile,
    });

    menuItems.push({ type: 'separator' });
    menuItems.push({
        icon: 'fa-file-archive',
        text: 'Create ZIP',
        action: () => createArchive('zip', currentPath, currentPath),
    });
    menuItems.push({
        icon: 'fa-file-archive',
        text: 'Create tar.gz',
        action: () => createArchive('targz', currentPath, currentPath),
    });
    if (archiveCache.has(currentPath)) {
        menuItems.push({
            icon: 'fa-download',
            text: 'Download Latest Archive',
            action: () => downloadLatestArchive(currentPath),
        });
    }

    menuItems.push({ type: 'separator' });
    menuItems.push({
        icon: 'fa-terminal',
        text: 'Open Terminal Here',
        action: () => openTerminalAt(currentPath),
    });
    menuItems.push({
        icon: 'fa-copy',
        text: 'Copy Path',
        action: copyCurrentPath,
    });
    menuItems.push({
        icon: 'fa-sync',
        text: 'Refresh',
        action: () => loadDirectory(currentPath),
    });

    menuItems.forEach(item => {
        if (item.type === 'separator') {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            menu.appendChild(separator);
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
    if (typeof positionContextMenu === 'function') {
        positionContextMenu(menu, x, y);
    } else {
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }
    menu.style.visibility = 'visible';

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

    // Wire upload button
    const uploadBtn = document.getElementById('upload-btn');
    if (uploadBtn) {
        uploadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            triggerFileUpload();
        });
    }
    
    // Handle file selection
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        const destinationPath = uploadTargetPath || currentPath;
        uploadTargetPath = null;

        await uploadFiles(files, destinationPath);
        
        // Reset file input
        fileInput.value = '';
    });
}

function triggerFileUpload(destinationPath = null) {
    const fileInput = document.getElementById('hidden-file-input');
    if (fileInput) {
        uploadTargetPath = destinationPath || currentPath;
        fileInput.click();
    }
}

async function uploadFiles(files, destinationPath) {
    if (!Array.isArray(files) || files.length === 0) return;
    showNotification(`Uploading ${files.length} file(s)...`, 'info');

    for (const file of files) {
        await uploadFile(file, destinationPath);
    }

    // Reload current directory view if it was the target.
    if (destinationPath === currentPath) {
        loadDirectory(currentPath);
    } else {
        // Best-effort refresh in the tree.
        try {
            reloadDirectoryInTree(destinationPath);
        } catch (e) {
            // ignore
        }
    }
}

async function uploadFile(file, destinationPath = currentPath) {
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', destinationPath);
        
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
