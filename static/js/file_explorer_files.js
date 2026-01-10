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

function selectFile(element, file) {
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    element.classList.add('selected');
    selectedFile = file;
    displayFileDetails(file);
}

function createFileItem(file) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = file.path;
    item.dataset.isDirectory = file.is_directory;
    
    item.draggable = true;
    
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
    
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragleave', handleDragLeave);
    
    item.addEventListener('click', () => {
        if (file.is_directory) {
            loadDirectory(file.path);
        } else {
            selectFile(item, file);
        }
    });
    
    item.addEventListener('dblclick', () => {
        if (!file.is_directory) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (isImageFile(ext)) {
                openImageViewer(file);
            } else if (isTextFile(ext)) {
                openFileInEditor(file);
            }
        }
    });
    
    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectFile(item, file);
        showContextMenu(e.clientX, e.clientY, file);
    });
    
    return item;
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
                        ${(() => {
                            const ext = file.name.split('.').pop().toLowerCase();
                            const buttons = [];
                            if (typeof isVideoFile === 'function' && isVideoFile(ext) && typeof openVideoViewer === 'function') {
                                buttons.push(`
                                    <button class="btn btn-sm btn-info" onclick="openVideoViewer(selectedFile)">
                                        <i class="fas fa-play"></i> Play
                                    </button>
                                `);
                            }
                            if (file.is_executable && typeof openExecutableRunner === 'function') {
                                buttons.push(`
                                    <button class="btn btn-sm btn-info" onclick="openExecutableRunner(selectedFile)">
                                        <i class="fas fa-terminal"></i> Run
                                    </button>
                                `);
                            }
                            if (typeof isTextFile === 'function' && isTextFile(ext)) {
                                buttons.push(`
                                    <button class="btn btn-sm btn-info" onclick="openFileInEditor(selectedFile)">
                                        <i class="fas fa-edit"></i> Edit
                                    </button>
                                `);
                            }
                            return buttons.join('');
                        })()}
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
