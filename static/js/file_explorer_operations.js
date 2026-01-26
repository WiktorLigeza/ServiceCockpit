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
    
    try {
        for (const item of targets) {
            const response = await fetch('/api/paste', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    source_path: item.path,
                    destination_path: currentPath,
                    is_cut: isCutOperation
                })
            });
            const data = await response.json();
            if (!data.success) {
                showNotification('Failed to paste: ' + data.error, 'error');
                return;
            }
        }

        showNotification(
            isCutOperation ? 'Moved successfully' : 'Copied successfully',
            'success'
        );
        
        document.querySelectorAll('.file-item').forEach(item => {
            item.style.opacity = '1';
        });
        
        if (isCutOperation) {
            copiedFile = null;
            copiedFilePath = null;
            copiedFiles = [];
            isCutOperation = false;
        }
        
        loadDirectory(currentPath);
        reloadDirectoryInTree(currentPath);
    } catch (error) {
        showNotification('Failed to paste: ' + error, 'error');
    }
}

async function pasteToDirectory(targetPath) {
    if (!copiedFile && (!copiedFiles || copiedFiles.length === 0)) return;

    const targets = (copiedFiles && copiedFiles.length)
        ? copiedFiles
        : (copiedFile ? [{ path: copiedFilePath, is_directory: copiedFile.is_directory, name: copiedFile.name }] : []);
    if (targets.length === 0) return;
    
    try {
        for (const item of targets) {
            const response = await fetch('/api/paste', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    source_path: item.path,
                    destination_path: targetPath,
                    is_cut: isCutOperation
                })
            });
            const data = await response.json();
            if (!data.success) {
                showNotification('Failed to paste: ' + data.error, 'error');
                return;
            }
        }

        showNotification(
            isCutOperation ? 'Moved successfully' : 'Copied successfully',
            'success'
        );
        
        document.querySelectorAll('.file-item').forEach(item => {
            item.style.opacity = '1';
        });
        
        if (isCutOperation) {
            copiedFile = null;
            copiedFilePath = null;
            copiedFiles = [];
            isCutOperation = false;
        }
        
        loadDirectory(currentPath);
        reloadDirectoryInTree(targetPath);
    } catch (error) {
        showNotification('Failed to paste: ' + error, 'error');
    }
}

async function deleteSelectedFiles() {
    const targets = (selectedFiles && selectedFiles.length) ? selectedFiles : (selectedFile ? [selectedFile] : []);
    if (targets.length === 0) return;

    const hasDir = targets.some(item => item.is_directory);
    const message = hasDir
        ? `Delete ${targets.length} items (including folders)? This cannot be undone.`
        : `Delete ${targets.length} files? This cannot be undone.`;

    if (!confirm(message)) return;

    for (const item of targets) {
        const response = await fetch('/api/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: item.path,
                is_directory: item.is_directory
            })
        });
        const data = await response.json();
        if (!data.success) {
            showNotification('Failed to delete: ' + data.error, 'error');
            return;
        }
    }

    showNotification('Deleted selection', 'success');
    loadDirectory(currentPath);
    reloadDirectoryInTree(currentPath);
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
