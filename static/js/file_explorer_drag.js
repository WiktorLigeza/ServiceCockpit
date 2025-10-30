function handleDragStart(e) {
    draggedItem = {
        path: e.currentTarget.dataset.path,
        isDirectory: e.currentTarget.dataset.isDirectory === 'true'
    };
    
    e.currentTarget.style.opacity = '0.5';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.currentTarget.innerHTML);
}

function handleDragEnd(e) {
    e.currentTarget.style.opacity = '1';
    
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    
    const targetItem = e.currentTarget;
    const isDirectory = targetItem.dataset.isDirectory === 'true';
    
    if (isDirectory && draggedItem && draggedItem.path !== targetItem.dataset.path) {
        e.dataTransfer.dropEffect = 'move';
        targetItem.classList.add('drag-over');
        return false;
    }
    
    e.dataTransfer.dropEffect = 'none';
    return false;
}

function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

async function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    e.currentTarget.classList.remove('drag-over');
    
    const targetPath = e.currentTarget.dataset.path;
    const isTargetDirectory = e.currentTarget.dataset.isDirectory === 'true';
    
    if (!isTargetDirectory || !draggedItem) {
        return false;
    }
    
    if (draggedItem.path === targetPath) {
        showNotification('Cannot move a folder into itself', 'error');
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
