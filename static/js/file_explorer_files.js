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

    visibleFiles = files;
    visibleFileMap = new Map(files.map(file => [file.path, file]));
    resetSelection();
    
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
    
    files.forEach((file, index) => {
        const fileItem = createFileItem(file, index);
        container.appendChild(fileItem);
    });
}

function selectFile(element, file) {
    if (!element || !file) return;
    const paths = new Set([file.path]);
    setSelectionByPaths(paths, file.path);
}

function createFileItem(file, index) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = file.path;
    item.dataset.isDirectory = file.is_directory;
    item.dataset.index = String(index);
    
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
    
    item.addEventListener('click', (e) => {
        handleFileItemSelection(e, item, file);
    });
    
    item.addEventListener('dblclick', () => {
        if (file.is_directory) {
            loadDirectory(file.path);
            return;
        }
        const ext = file.name.split('.').pop().toLowerCase();
        if (canInspectAsExecutable(file)) {
            openFileInEditor(file);
        } else if (isImageFile(ext)) {
            openImageViewer(file);
        } else if (isTextFile(ext)) {
            openFileInEditor(file);
        }
    });
    
    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const currentPaths = new Set(selectedFiles.map(f => f.path));
        currentPaths.add(file.path);
        setSelectionByPaths(currentPaths, file.path);
        showContextMenu(e.clientX, e.clientY, file);
    });
    
    return item;
}

function resetSelection() {
    selectedFiles = [];
    selectedFile = null;
    lastSelectedIndex = -1;
    updateSelectionDetails();
}

function updateSelectionDetails() {
    const container = document.getElementById('file-details-container');
    if (!container) return;

    if (selectedFiles.length === 1) {
        displayFileDetails(selectedFiles[0]);
        return;
    }

    if (selectedFiles.length > 1) {
        const dirCount = selectedFiles.filter(f => f.is_directory).length;
        const fileCount = selectedFiles.length - dirCount;
        const totalSize = selectedFiles
            .filter(f => !f.is_directory)
            .reduce((acc, f) => acc + (f.size || 0), 0);

        container.innerHTML = `
            <div class="detail-section">
                <h3><i class="fas fa-layer-group"></i> ${selectedFiles.length} items selected</h3>
                <div class="detail-row">
                    <span class="detail-label">Files:</span>
                    <span class="detail-value">${fileCount}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Folders:</span>
                    <span class="detail-value">${dirCount}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Total size:</span>
                    <span class="detail-value">${formatFileSize(totalSize)}</span>
                </div>
            </div>
        `;
        return;
    }

    displayCurrentFolderDetails();
}

async function displayCurrentFolderDetails() {
    const container = document.getElementById('file-details-container');
    if (!container) return;

    const path = currentPath || '/';
    const name = path.split('/').filter(Boolean).pop() || '/';

    try {
        const response = await fetch(`/api/file-details?path=${encodeURIComponent(path)}`);
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `
                <div class="no-selection">
                    <i class="fas fa-folder-open"></i>
                    <p>${path}</p>
                </div>
            `;
            return;
        }

        const details = data.details;
        container.innerHTML = `
            <div class="detail-section">
                <h3><i class="fas fa-folder"></i> ${name}</h3>
                <div class="detail-row">
                    <span class="detail-label">Type:</span>
                    <span class="detail-value">Directory</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Path:</span>
                    <span class="detail-value">${path}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Size:</span>
                    <span class="detail-value" id="detail-size">
                        <button class="btn btn-sm btn-info" onclick="inspectFolderDetails('${path}')">
                            <i class="fas fa-search"></i> Calculate Size
                        </button>
                    </span>
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
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="no-selection">
                <i class="fas fa-folder-open"></i>
                <p>${path}</p>
            </div>
        `;
    }
}

function setSelectionByPaths(paths, primaryPath) {
    const items = Array.from(document.querySelectorAll('.file-item'));
    items.forEach(item => {
        const isSelected = paths.has(item.dataset.path);
        item.classList.toggle('selected', isSelected);
    });

    selectedFiles = [];
    items.forEach(item => {
        if (paths.has(item.dataset.path)) {
            const file = visibleFileMap.get(item.dataset.path);
            if (file) selectedFiles.push(file);
        }
    });

    const primary = primaryPath ? visibleFileMap.get(primaryPath) : null;
    selectedFile = primary || selectedFiles[selectedFiles.length - 1] || null;

    const primaryItem = selectedFile
        ? document.querySelector(`.file-item[data-path="${CSS.escape(selectedFile.path)}"]`)
        : null;
    lastSelectedIndex = primaryItem ? Number(primaryItem.dataset.index || -1) : -1;

    updateSelectionDetails();
}

function handleFileItemSelection(e, item, file) {
    const index = Number(item.dataset.index || 0);
    const isToggle = e.ctrlKey || e.metaKey;
    const isRange = e.shiftKey;

    if (isRange && lastSelectedIndex !== -1) {
        const items = Array.from(document.querySelectorAll('.file-item'));
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        const paths = new Set(isToggle ? selectedFiles.map(f => f.path) : []);
        for (let i = start; i <= end; i += 1) {
            const path = items[i]?.dataset.path;
            if (path) paths.add(path);
        }
        setSelectionByPaths(paths, file.path);
        return;
    }

    if (isToggle) {
        const paths = new Set(selectedFiles.map(f => f.path));
        if (paths.has(file.path)) {
            paths.delete(file.path);
        } else {
            paths.add(file.path);
        }
        setSelectionByPaths(paths, file.path);
        return;
    }

    setSelectionByPaths(new Set([file.path]), file.path);
}

function setupMultiSelection() {
    const container = document.getElementById('files-container');
    if (!container) return;

    let selectionBox = null;
    let startX = 0;
    let startY = 0;
    let isSelecting = false;
    let baseSelection = new Set();

    function updateSelectionBox(currentX, currentY) {
        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        if (selectionBox) {
            selectionBox.style.left = `${left}px`;
            selectionBox.style.top = `${top}px`;
            selectionBox.style.width = `${width}px`;
            selectionBox.style.height = `${height}px`;
        }

        const paths = new Set(baseSelection);
        const items = Array.from(document.querySelectorAll('.file-item'));
        items.forEach(item => {
            const rect = item.getBoundingClientRect();
            const intersects = rect.right >= left && rect.left <= left + width && rect.bottom >= top && rect.top <= top + height;
            if (intersects) {
                paths.add(item.dataset.path);
            }
        });

        const primaryPath = paths.size ? Array.from(paths).pop() : null;
        setSelectionByPaths(paths, primaryPath);
    }

    container.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.file-item')) return;

        isSelecting = true;
        const pos = typeof getPointerPosition === 'function'
            ? getPointerPosition(e)
            : { x: e.clientX, y: e.clientY };
        startX = pos.x;
        startY = pos.y;

        const keepExisting = e.shiftKey || e.ctrlKey || e.metaKey;
        baseSelection = new Set(keepExisting ? selectedFiles.map(f => f.path) : []);

        selectionBox = document.createElement('div');
        selectionBox.className = 'selection-box';
        document.body.appendChild(selectionBox);
        updateSelectionBox(startX, startY);
    });

    document.addEventListener('mousemove', (e) => {
        if (!isSelecting) return;
        const pos = typeof getPointerPosition === 'function'
            ? getPointerPosition(e)
            : { x: e.clientX, y: e.clientY };
        updateSelectionBox(pos.x, pos.y);
    });

    document.addEventListener('mouseup', () => {
        if (!isSelecting) return;
        isSelecting = false;
        if (selectionBox) {
            selectionBox.remove();
            selectionBox = null;
        }
    });
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
                        <span class="detail-label">Chmod:</span>
                        <span class="detail-value">
                            <div class="chmod-editor">
                                <div class="chmod-grid" aria-label="Set read, write and execute permissions">
                                    <span></span><span>Read</span><span>Write</span><span>Execute</span>
                                    <span>Owner</span>
                                    <input type="checkbox" data-permission-bit="0400" aria-label="Owner read">
                                    <input type="checkbox" data-permission-bit="0200" aria-label="Owner write">
                                    <input type="checkbox" data-permission-bit="0100" aria-label="Owner execute">
                                    <span>Group</span>
                                    <input type="checkbox" data-permission-bit="0040" aria-label="Group read">
                                    <input type="checkbox" data-permission-bit="0020" aria-label="Group write">
                                    <input type="checkbox" data-permission-bit="0010" aria-label="Group execute">
                                    <span>Others</span>
                                    <input type="checkbox" data-permission-bit="0004" aria-label="Others read">
                                    <input type="checkbox" data-permission-bit="0002" aria-label="Others write">
                                    <input type="checkbox" data-permission-bit="0001" aria-label="Others execute">
                                </div>
                                <div class="chmod-control">
                                    <input type="text" id="chmod-input" class="form-control chmod-input" inputmode="numeric" maxlength="4" placeholder="e.g. 644" aria-label="Permission mode in octal">
                                    <button class="btn btn-sm btn-info" onclick="applyChmod(selectedFile.path)">
                                        <i class="fas fa-key"></i> Apply
                                    </button>
                                </div>
                                <div class="chmod-preview">
                                    <span>Mode <code id="chmod-mode-preview"></code></span>
                                    <code id="chmod-symbolic-preview"></code>
                                </div>
                            </div>
                        </span>
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
                    ` : `
                        <button class="btn btn-sm btn-primary" onclick="createArchive('zip', selectedFile.path, currentPath)">
                            <i class="fas fa-file-archive"></i> Create ZIP
                        </button>
                        <button class="btn btn-sm btn-primary" onclick="createArchive('targz', selectedFile.path, currentPath)">
                            <i class="fas fa-file-archive"></i> Create tar.gz
                        </button>
                        ${archiveCache?.has?.(selectedFile.path) ? `
                            <button class="btn btn-sm btn-success" onclick="downloadLatestArchive(selectedFile.path)">
                                <i class="fas fa-download"></i> Download Archive
                            </button>
                        ` : ''}
                    `}
                    <button class="btn btn-sm btn-warning" onclick="renameFile()">
                        <i class="fas fa-edit"></i> Rename
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteFile()">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                </div>
            `;
            initializeChmodControls(file.permissions);
        }
    } catch (error) {
        console.error('Error loading file details:', error);
    }
}

function initializeChmodControls(permissions) {
    const symbolicPreview = document.getElementById('chmod-symbolic-preview');
    if (symbolicPreview) symbolicPreview.dataset.typeCharacter = permissions?.[0] || '-';
    const bits = Array.from(document.querySelectorAll('.chmod-grid input[data-permission-bit]'));
    bits.forEach((checkbox, index) => {
        checkbox.checked = permissions?.[index + 1] !== '-';
        checkbox.addEventListener('change', updateChmodFromCheckboxes);
    });

    const input = document.getElementById('chmod-input');
    if (!input) return;
    const specialBits = ((permissions?.[3] === 's' || permissions?.[3] === 'S') ? 4 : 0)
        + ((permissions?.[6] === 's' || permissions?.[6] === 'S') ? 2 : 0)
        + ((permissions?.[9] === 't' || permissions?.[9] === 'T') ? 1 : 0);
    const regularMode = permissionModeFromCheckboxes();
    input.value = specialBits ? `${specialBits}${regularMode}` : regularMode;
    input.addEventListener('input', updateChmodFromInput);
    updateChmodPreview(permissions?.[0] || '-');
}

function permissionModeFromCheckboxes() {
    const bits = Array.from(document.querySelectorAll('.chmod-grid input[data-permission-bit]'));
    const digits = [];
    for (let group = 0; group < 3; group += 1) {
        let value = 0;
        for (let permission = 0; permission < 3; permission += 1) {
            if (bits[group * 3 + permission]?.checked) value += [4, 2, 1][permission];
        }
        digits.push(value);
    }
    return digits.join('');
}

function updateChmodPreview(typeCharacter = null) {
    const mode = document.getElementById('chmod-input')?.value || '';
    const modePreview = document.getElementById('chmod-mode-preview');
    const symbolicPreview = document.getElementById('chmod-symbolic-preview');
    typeCharacter = typeCharacter || symbolicPreview?.dataset.typeCharacter || '-';
    if (!/^[0-7]{3,4}$/.test(mode)) {
        if (modePreview) modePreview.textContent = 'Invalid mode';
        if (symbolicPreview) symbolicPreview.textContent = '';
        return;
    }

    const permissions = mode.slice(-3).split('').map(digit => Number.parseInt(digit, 8));
    const specialBits = mode.length === 4 ? Number.parseInt(mode[0], 8) : 0;
    const symbolic = permissions.map(value => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`).join('').split('');
    if (specialBits & 4) symbolic[2] = permissions[0] & 1 ? 's' : 'S';
    if (specialBits & 2) symbolic[5] = permissions[1] & 1 ? 's' : 'S';
    if (specialBits & 1) symbolic[8] = permissions[2] & 1 ? 't' : 'T';
    if (modePreview) modePreview.textContent = mode;
    if (symbolicPreview) symbolicPreview.textContent = `${typeCharacter}${symbolic.join('')}`;
}

function updateChmodFromCheckboxes() {
    const input = document.getElementById('chmod-input');
    if (input) {
        const specialBits = /^[0-7]{4}$/.test(input.value) ? input.value[0] : '';
        input.value = `${specialBits}${permissionModeFromCheckboxes()}`;
    }
    updateChmodPreview();
}

function updateChmodFromInput() {
    const input = document.getElementById('chmod-input');
    if (!input) return;
    if (/^[0-7]{3,4}$/.test(input.value)) {
        const values = input.value.slice(-3).split('').map(digit => Number.parseInt(digit, 8));
        document.querySelectorAll('.chmod-grid input[data-permission-bit]').forEach((checkbox, index) => {
            checkbox.checked = !!(values[Math.floor(index / 3)] & [4, 2, 1][index % 3]);
        });
    }
    updateChmodPreview();
}

async function inspectFolder(path, buttonElement) {
    const originalHTML = buttonElement.innerHTML;
    buttonElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating...';
    buttonElement.disabled = true;
    
    try {
        const response = await fetch(`/api/folder-size?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (data.success) {
            buttonElement.parentElement.innerHTML = `
                <div class="folder-size-block">
                    <span class="folder-size">${data.size_display}</span>
                    ${renderFolderCounts(data)}
                </div>
            `;
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
            sizeElement.innerHTML = `
                <div class="folder-size-block">
                    <span class="folder-size">${data.size_display}</span>
                    ${renderFolderCounts(data)}
                </div>
            `;
        } else {
            sizeElement.innerHTML = `<span style="color: #dc3545;">Error: ${data.error}</span>`;
        }
    } catch (error) {
        console.error('Error inspecting folder:', error);
        sizeElement.innerHTML = `<span style="color: #dc3545;">Error calculating size</span>`;
    }
}

function renderFolderCounts(data) {
    if (!data) return '';
    const total = Number(data.total_items ?? 0);
    const dirs = Number(data.dir_count ?? 0);
    const files = Number(data.file_count ?? 0);
    const parts = [];

    if (total || dirs || files) {
        parts.push(`<div class="folder-counts">Items: ${total} (Folders: ${dirs}, Files: ${files})</div>`);
    }

    const extList = Array.isArray(data.extensions_sorted) ? data.extensions_sorted : [];
    if (extList.length > 0) {
        const top = extList.slice(0, 8).map(([ext, count]) => `${count} ${ext}`);
        const more = extList.length > 8 ? ` +${extList.length - 8} more` : '';
        parts.push(`<div class="folder-types">Types: ${top.join(', ')}${more}</div>`);
    }

    return parts.length ? `<div class="folder-summary">${parts.join('')}</div>` : '';
}

async function applyChmod(path) {
    const input = document.getElementById('chmod-input');
    if (!input) return;
    const mode = (input.value || '').trim();
    if (!mode) {
        showNotification('Enter a chmod value (e.g. 644)', 'warning');
        return;
    }
    try {
        const resp = await fetch('/api/chmod', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, mode }),
        });
        const data = await resp.json();
        if (!data.success) {
            showNotification(`Chmod failed: ${data.error || 'unknown'}`, 'error');
            return;
        }
        showNotification('Permissions updated', 'success');
        loadDirectory(currentPath);
        if (selectedFile && selectedFile.path === path) {
            selectedFile.permissions = data.permissions || selectedFile.permissions;
            displayFileDetails(selectedFile);
        }
    } catch (e) {
        showNotification(`Chmod failed: ${e}`, 'error');
    }
}
