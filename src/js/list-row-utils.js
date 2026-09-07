// File list row helpers
function shouldSuppressFolderRowNavigation(e) {
    if (selectionMode) return true;
    return !!e.target.closest('.list-checkbox, label');
}

function bindFolderRowNavigation(folderEl, path) {
    if (!folderEl || !path) return;
    folderEl.onclick = function(e) {
        if (shouldSuppressFolderRowNavigation(e)) return;
        window.loadFiles(path);
    };
}

function clearFolderRowNavigation(folderEl) {
    if (!folderEl) return;
    folderEl.onclick = null;
    folderEl.removeAttribute('onclick');
}

function escapePathForHtmlAttr(path) {
    return String(path || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}
function escapeHtmlText(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function getListRowPath(row) {
    return row && row.dataset ? (row.dataset.path || '') : '';
}
window.getListRowPath = getListRowPath;
window.escapePathForHtmlAttr = escapePathForHtmlAttr;
window.escapeHtmlText = escapeHtmlText;
window.bindFolderRowNavigation = bindFolderRowNavigation;
window.clearFolderRowNavigation = clearFolderRowNavigation;

function setupFileListDelegation() {
    const fileList = document.getElementById('fileList');
    if (!fileList || fileList._fileListDelegationBound) return;
    fileList._fileListDelegationBound = true;

    fileList.addEventListener('change', function(e) {
        const cb = e.target.closest('.list-checkbox');
        if (!cb || !fileList.contains(cb)) return;
        const row = cb.closest('.file-item, .folder-item');
        const path = cb.dataset.path || getListRowPath(row);
        toggleItemSelection(path, cb.dataset.type || 'file', cb.checked, cb.id);
    });

    fileList.addEventListener('click', function(e) {
        if (selectionMode) {
            const row = e.target.closest('.file-item, .folder-item');
            if (row && fileList.contains(row) && !e.target.closest('.list-checkbox, label')) {
                e.stopPropagation();
            }
        }
    }, true);
}

window.setupFileListDelegation = setupFileListDelegation;
