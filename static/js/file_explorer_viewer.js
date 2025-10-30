function openImageViewer(file) {
    const viewerWindow = document.getElementById('image-viewer-window');
    const viewerImg = document.getElementById('image-viewer-img');
    const viewerTitle = document.getElementById('image-viewer-title');
    const imageInfo = document.getElementById('image-info');
    
    currentZoom = 1;
    viewerImg.style.transform = `scale(${currentZoom})`;
    viewerImg.src = `/api/download?path=${encodeURIComponent(file.path)}`;
    viewerTitle.textContent = file.name;
    imageInfo.textContent = `Size: ${formatFileSize(file.size)}`;
    
    viewerWindow.style.display = 'flex';
    
    viewerImg.onload = function() {
        imageInfo.textContent = `Size: ${formatFileSize(file.size)} | Dimensions: ${this.naturalWidth}x${this.naturalHeight}px`;
    };
}

function closeImageViewer() {
    const viewerWindow = document.getElementById('image-viewer-window');
    viewerWindow.style.display = 'none';
    currentZoom = 1;
}

function setupImageViewer() {
    const viewerWindow = document.getElementById('image-viewer-window');
    const header = viewerWindow.querySelector('.image-viewer-header');
    let isDragging = false;
    let currentX, currentY, initialX, initialY;
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        if (e.target.classList.contains('image-viewer-close')) return;
        initialX = e.clientX - viewerWindow.offsetLeft;
        initialY = e.clientY - viewerWindow.offsetTop;
        isDragging = true;
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            viewerWindow.style.left = currentX + 'px';
            viewerWindow.style.top = currentY + 'px';
            viewerWindow.style.transform = 'none';
        }
    }
    
    function dragEnd() {
        isDragging = false;
    }
    
    document.querySelector('.image-viewer-close').addEventListener('click', closeImageViewer);
    
    document.getElementById('zoom-in').addEventListener('click', () => {
        currentZoom = Math.min(currentZoom + 0.25, 5);
        document.getElementById('image-viewer-img').style.transform = `scale(${currentZoom})`;
    });
    
    document.getElementById('zoom-out').addEventListener('click', () => {
        currentZoom = Math.max(currentZoom - 0.25, 0.25);
        document.getElementById('image-viewer-img').style.transform = `scale(${currentZoom})`;
    });
    
    document.getElementById('zoom-reset').addEventListener('click', () => {
        currentZoom = 1;
        document.getElementById('image-viewer-img').style.transform = `scale(${currentZoom})`;
    });
}
