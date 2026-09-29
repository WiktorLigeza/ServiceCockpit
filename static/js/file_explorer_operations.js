function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'c' && (selectedFile || (selectedFiles && selectedFiles.length))) {
            e.preventDefault();
            copyFile();
        }
        
        if (e.ctrlKey && e.key === 'x' && (selectedFile || (selectedFiles && selectedFiles.length))) {
            e.preventDefault();
            cutFile();
        }
        
        if (e.ctrlKey && e.key === 'v' && (copiedFile || (copiedFiles && copiedFiles.length))) {
            e.preventDefault();
            pasteFile();
        }
    });
}

function copyFile() {
    const targets = (selectedFiles && selectedFiles.length) ? selectedFiles : (selectedFile ? [selectedFile] : []);
    if (targets.length === 0) return;

    copiedFiles = targets.map(item => ({ path: item.path, is_directory: item.is_directory, name: item.name }));
    copiedFile = targets[0] || null;
    copiedFilePath = copiedFile ? copiedFile.path : null;
    isCutOperation = false;

    showNotification(`Copied: ${targets.length} item(s)`, 'success');
}

function cutFile() {
    const targets = (selectedFiles && selectedFiles.length) ? selectedFiles : (selectedFile ? [selectedFile] : []);
    if (targets.length === 0) return;

    copiedFiles = targets.map(item => ({ path: item.path, is_directory: item.is_directory, name: item.name }));
    copiedFile = targets[0] || null;
    copiedFilePath = copiedFile ? copiedFile.path : null;
    isCutOperation = true;

    document.querySelectorAll('.file-item').forEach(item => {
        if (copiedFiles.find(f => f.path === item.dataset.path)) {
            item.style.opacity = '0.5';
        }
    });
    
    showNotification(`Cut: ${targets.length} item(s)`, 'warning');
}

async function pasteFile() {
    if (!copiedFile && (!copiedFiles || copiedFiles.length === 0)) return;

    const targets = (copiedFiles && copiedFiles.length)
        ? copiedFiles
        : (copiedFile ? [{ path: copiedFilePath, is_directory: copiedFile.is_directory, name: copiedFile.name }] : []);
    if (targets.length === 0) return;
    
    await pasteItemsToDirectory(targets, currentPath);
}

async function pasteToDirectory(targetPath) {
    if (!copiedFile && (!copiedFiles || copiedFiles.length === 0)) return;

    const targets = (copiedFiles && copiedFiles.length)
        ? copiedFiles
        : (copiedFile ? [{ path: copiedFilePath, is_directory: copiedFile.is_directory, name: copiedFile.name }] : []);
    if (targets.length === 0) return;
    
    await pasteItemsToDirectory(targets, targetPath);
}

function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Leave shortcuts alone while typing (path bar, search, editor, rename prompts)
        if (isTypingTarget(e.target)) return;
        // Let the browser copy text the user highlighted on the page
        if (window.getSelection && String(window.getSelection())) return;

        // Cmd on Mac, Ctrl on Windows/Linux
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();

        if (mod && key === 'c' && getSelectedTargets().length) {
            e.preventDefault();
            copyFile();
        } else if (mod && key === 'x' && getSelectedTargets().length) {
            e.preventDefault();
            cutFile();
        } else if (mod && key === 'v' && copiedFiles.length) {
            e.preventDefault();
            pasteFile();
        } else if (mod && key === 'a') {
            e.preventDefault();
            setSelectionByPaths(new Set(visibleFiles.map(f => f.path)));
        } else if ((key === 'delete' || (mod && key === 'backspace')) && getSelectedTargets().length) {
            // Delete key, or Cmd+Backspace on Mac
            e.preventDefault();
            deleteSelectedFiles();
        } else if (key === 'escape' && selectedFiles.length) {
            setSelectionByPaths(new Set());
        }
    });
}

function getSelectedTargets() {
    return selectedFiles.length ? selectedFiles : (selectedFile ? [selectedFile] : []);
}

function setClipboard(isCut) {
    const targets = getSelectedTargets();
    if (targets.length === 0) return 0;

    copiedFiles = targets.map(item => ({ path: item.path, is_directory: item.is_directory, name: item.name }));
    copiedFile = copiedFiles[0];
    copiedFilePath = copiedFile.path;
    isCutOperation = isCut;
    updateCutStyling();
    return targets.length;
}

function updateCutStyling() {
    const cutPaths = new Set(isCutOperation ? copiedFiles.map(f => f.path) : []);
    document.querySelectorAll('.file-item').forEach(item => {
        item.style.opacity = cutPaths.has(item.dataset.path) ? '0.5' : '1';
    });
}

function copyFile() {
    const count = setClipboard(false);
    if (count) showNotification(`Copied ${count} item(s)`, 'success');
}

function cutFile() {
    const count = setClipboard(true);
    if (count) showNotification(`Cut ${count} item(s)`, 'warning');
}

async function pasteFile() {
    await pasteToDirectory(currentPath);
}

async function pasteToDirectory(targetPath) {
    if (!copiedFiles.length) return;
    await pasteItemsToDirectory(copiedFiles.slice(), targetPath);
}

async function pasteItemsToDirectory(targets, targetPath, conflictAction = 'ask') {
    try {
        const wasCutOperation = isCutOperation;
        const response = await fetch('/api/paste', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_paths: targets.map(item => item.path),
                destination_path: targetPath,
                is_cut: isCutOperation,
                conflict_action: conflictAction
            })
        });
        const data = await response.json();

        if (response.status === 409 && Array.isArray(data.conflicts)) {
            const conflictNames = data.conflicts
                .map(conflict => conflict.destination.split(/[\\/]/).pop())
                .join('\n');
            const replace = confirm(
                `These destination items already exist:\n${conflictNames}\n\n` +
                'Choose OK to replace the existing items, or Cancel to keep both.'
            );
            await pasteItemsToDirectory(targets, targetPath, replace ? 'replace' : 'keep_both');
            return;
        }

        const completedPaths = new Set(data.completed_paths || []);

        if (wasCutOperation && completedPaths.size) {
            copiedFiles = copiedFiles.filter(item => !completedPaths.has(item.path));
            copiedFile = copiedFiles[0] || null;
            copiedFilePath = copiedFile ? copiedFile.path : null;
            if (!copiedFiles.length) isCutOperation = false;
        }

        if (!data.success) {
            const completedCount = completedPaths.size;
            const failedNames = (data.errors || [])
                .map(error => error.path.split(/[\\/]/).pop())
                .join(', ');
            const error = data.error || 'One or more items could not be pasted';
            showNotification(
                `${completedCount}/${targets.length} items pasted. ${failedNames ? `Failed: ${failedNames}. ` : ''}${error}`,
                'error'
            );
        } else {
            const verb = wasCutOperation ? 'Moved' : 'Copied';
            showNotification(`${verb} ${completedPaths.size} item(s) successfully`, 'success');
        }
        await loadDirectory(currentPath);
        reloadDirectoryInTree(targetPath);
    } catch (error) {
        showNotification('Failed to paste: ' + error, 'error');
    }
}

async function deleteSelectedFiles() {
    const targets = getSelectedTargets().slice();
    if (targets.length === 0) return;

    const hasDir = targets.some(item => item.is_directory);
    let message;
    if (targets.length === 1) {
        message = hasDir
            ? `Delete the folder "${targets[0].name}" and all its contents? This cannot be undone.`
            : `Delete "${targets[0].name}"? This cannot be undone.`;
    } else {
        message = `Delete ${targets.length} items${hasDir ? ' (including folders and their contents)' : ''}? This cannot be undone.`;
    }
    if (!confirm(message)) return;

    try {
        const response = await fetch('/api/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({paths: targets.map(item => item.path)})
        });
        const data = await response.json();
        if (!data.success) {
            showNotification(`${(data.deleted_paths || []).length} item(s) deleted; ${data.error || 'Some items could not be deleted'}`, 'error');
        } else {
            showNotification(`Deleted ${targets.length} item(s)`, 'success');
        }
    } catch (error) {
        showNotification('Failed to delete: ' + error, 'error');
        return;
    }

    await loadDirectory(currentPath);
    if (hasDir) reloadDirectoryInTree(currentPath);
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
                if (typeof openFileInEditor === 'function') {
                    openFileInEditor({
                        name: fileName,
                        path: `${currentPath}/${fileName}`.replace('//', '/'),
                        is_directory: false,
                        is_executable: false,
                        size: 0
                    });
                }
            } else {
                alert('Failed to create file: ' + data.error);
            }
        } catch (error) {
            alert('Failed to create file: ' + error);
        }
    }
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
    await deleteSelectedFiles();
}
