function showContextMenu(x, y, file) {
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.visibility = 'hidden';
    
    const isMulti = Array.isArray(selectedFiles) && selectedFiles.length > 1;
    const isInSelection = isMulti ? selectedFiles.some(item => item.path === file.path) : false;

    const menuItems = [];

    if (isMulti && isInSelection) {
        const selectionPaths = selectedFiles.map(item => item.path);
        menuItems.push(
            { icon: 'fa-copy', text: `Copy (${selectedFiles.length})`, action: copyFile },
            { icon: 'fa-cut', text: `Cut (${selectedFiles.length})`, action: cutFile }
        );

        menuItems.push({ type: 'separator' });
        menuItems.push({
            icon: 'fa-file-archive',
            text: 'Download selection (zip)',
            action: () => createArchiveMulti('zip', selectionPaths, currentPath, true),
        });
        menuItems.push({
            icon: 'fa-file-archive',
            text: 'Archive selection (zip)',
            action: () => createArchiveMulti('zip', selectionPaths, currentPath, false),
        });
        menuItems.push({
            icon: 'fa-file-archive',
            text: 'Archive selection (tar.gz)',
            action: () => createArchiveMulti('targz', selectionPaths, currentPath, false),
        });

        menuItems.push({ type: 'separator' });
        menuItems.push({ icon: 'fa-trash', text: 'Delete selection', action: deleteSelectedFiles, className: 'danger' });
    } else {
        menuItems.push(
            { icon: 'fa-copy', text: 'Copy', action: copyFile },
            { icon: 'fa-cut', text: 'Cut', action: cutFile }
        );
    }
    
    if ((copiedFile || (copiedFiles && copiedFiles.length)) && file.is_directory) {
        menuItems.push({ 
            icon: 'fa-paste', 
            text: 'Paste Here', 
            action: () => pasteToDirectory(file.path) 
        });
    }
    
    if (!(isMulti && isInSelection)) {
        menuItems.push({ icon: 'fa-edit', text: 'Rename', action: renameFile });
        
        if (!file.is_directory) {
            menuItems.push({ icon: 'fa-download', text: 'Download', action: downloadFile });
            
            const ext = file.name.split('.').pop().toLowerCase();
            if (isTextFile(ext)) {
                menuItems.push({ icon: 'fa-edit', text: 'Edit', action: () => openFileInEditor(selectedFile) });
            }
        }
        
        menuItems.push({ icon: 'fa-trash', text: 'Delete', action: deleteFile, className: 'danger' });
    }
    
    menuItems.forEach(item => {
        if (item.type === 'separator') {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            menu.appendChild(separator);
            return;
        }
        const menuItem = document.createElement('div');
        menuItem.className = 'context-menu-item' + (item.className ? ' ' + item.className : '');
        menuItem.innerHTML = `<i class="fas ${item.icon}"></i> ${item.text}`;
        menuItem.addEventListener('click', () => {
            item.action();
            menu.remove();
        });
        menu.appendChild(menuItem);
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

function showDirectoryContextMenu(x, y, dir) {
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

function showBreadcrumbContextMenu(x, y, targetPath) {
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.visibility = 'hidden';
    
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
