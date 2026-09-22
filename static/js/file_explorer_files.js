// file_explorer.js (loaded after this file) redefines loadDirectory,
// highlightActiveDirectory, applyFilters, displayFiles, and createFileItem -
// this is the only function from the original split that's still the live
// definition (nothing in file_explorer.js redeclares it).
//
// Single-selection only: `selectedFiles` (plural, checked by drag/menu/
// operations code elsewhere) is never populated with more than one item
// anywhere in this codebase, so there is no multi-select to preserve here.
function selectFile(element, file) {
    if (!element || !file) return;

    document.querySelectorAll('#files-container .file-item.selected').forEach((el) => {
        el.classList.remove('selected');
    });
    element.classList.add('selected');

    selectedFile = file;
    selectedFiles = [file];
}
