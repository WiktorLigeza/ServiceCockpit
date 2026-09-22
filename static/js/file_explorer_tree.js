// file_explorer.js (loaded after this file) redefines loadDirectoryTree,
// createDirectoryTreeItem, filterDirectoryTree, and reloadDirectoryInTree -
// this is the only function from the original split that's still the live
// definition (nothing in file_explorer.js redeclares it).
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
