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
    
    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showDirectoryContextMenu(e.clientX, e.clientY, dir);
    });
    
    wrapper.appendChild(item);
    wrapper.appendChild(childrenContainer);
    
    return wrapper;
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

function reloadDirectoryInTree(path) {
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
    
    document.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.addEventListener('dragover', handleBreadcrumbDragOver);
        item.addEventListener('drop', handleBreadcrumbDrop);
        item.addEventListener('dragleave', handleBreadcrumbDragLeave);
        
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const targetPath = item.dataset.path;
            showBreadcrumbContextMenu(e.clientX, e.clientY, targetPath);
        });
    });
}
