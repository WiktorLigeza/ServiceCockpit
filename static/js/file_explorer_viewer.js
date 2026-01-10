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

function openVideoViewer(file) {
    const viewerWindow = document.getElementById('video-viewer-window');
    const videoEl = document.getElementById('video-viewer-video');
    const viewerTitle = document.getElementById('video-viewer-title');
    const videoInfo = document.getElementById('video-info');

    viewerTitle.textContent = file.name;
    videoInfo.textContent = `Size: ${formatFileSize(file.size)}`;

    // Reset + load
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    videoEl.src = `/api/download?path=${encodeURIComponent(file.path)}`;

    viewerWindow.style.display = 'flex';

    videoEl.onloadedmetadata = () => {
        const duration = isFinite(videoEl.duration) ? `${Math.round(videoEl.duration)}s` : 'Unknown';
        videoInfo.textContent = `Size: ${formatFileSize(file.size)} | Duration: ${duration}`;
    };
}

function closeVideoViewer() {
    const viewerWindow = document.getElementById('video-viewer-window');
    const videoEl = document.getElementById('video-viewer-video');
    try {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
    } catch (e) {
        // ignore
    }
    viewerWindow.style.display = 'none';
}

function setupVideoViewer() {
    const viewerWindow = document.getElementById('video-viewer-window');
    if (!viewerWindow) return;

    const header = viewerWindow.querySelector('.video-viewer-header');
    let isDragging = false;
    let currentX, currentY, initialX, initialY;

    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    function dragStart(e) {
        if (e.target.classList.contains('video-viewer-close')) return;
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

    const closeBtn = viewerWindow.querySelector('.video-viewer-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeVideoViewer);
    }
}
