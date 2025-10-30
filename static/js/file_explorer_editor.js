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
    
    editorContent.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            saveFile();
            return;
        }
        
        if (e.key === 'Tab') {
            e.preventDefault();
            
            const start = editorContent.selectionStart;
            const end = editorContent.selectionEnd;
            const value = editorContent.value;
            
            if (e.shiftKey) {
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
                if (start === end) {
                    editorContent.value = value.substring(0, start) + '    ' + value.substring(end);
                    editorContent.selectionStart = editorContent.selectionEnd = start + 4;
                } else {
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
            
            editorContent.dispatchEvent(new Event('input'));
        }
    });
}
