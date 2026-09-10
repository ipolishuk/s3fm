// Bootstrap listeners
function getUploadBasePath() {
    let basePath = (currentPath || '').trim().replace(/\/+$/, '');
    if (basePath !== '') basePath += '/';
    return basePath;
}
window.getUploadBasePath = getUploadBasePath;

window.__transferUploadOnSuccess = async function () {
    if (typeof window.resetSelectionAfterMultiFileAction === 'function') {
        await window.resetSelectionAfterMultiFileAction();
        return;
    }
    if (window.fileSearch && window.fileSearch.mode && typeof window.performSearch === 'function') {
        await window.performSearch(window.fileSearch.query);
    } else if (typeof window.loadFiles === 'function') {
        await window.loadFiles(currentPath || '');
    }
};

// Обновляем функцию checkAuthentication
document.addEventListener('DOMContentLoaded', function() {
    if (typeof window.setupUploadDropdown === "function") window.setupUploadDropdown();
    if (typeof window.setupFileContextMenu === "function") window.setupFileContextMenu();
    if (typeof window.setupSettingsContextMenu === "function") window.setupSettingsContextMenu();
    if (typeof window.setupFileDropZone === "function") window.setupFileDropZone();
    if (typeof window.setupUserMenuDropdown === "function") window.setupUserMenuDropdown();
    if (typeof window.setupFilesPaginationControls === 'function') {
        window.setupFilesPaginationControls();
    }
    // Показываем основной тулбар сразу вместе с content-panel,
    // до завершения загрузки/рендера списка бакетов.
    window.setMainToolbarLocked(true);
    window.renderHomeBreadcrumb();
    // Avoid "select a bucket" flash on refresh of /bucket/... — show spinner until list loads
    if (/^\/bucket\//.test(window.location.pathname)) {
        var bootFileList = document.getElementById('fileList');
        if (bootFileList) {
            bootFileList.innerHTML =
                '<div class="empty-state">' +
                '<i class="fa-solid fa-spinner fa-spin empty-state-icon"></i>' +
                '</div>';
        }
    }
    window.checkAuthentication().then(authenticated => {
        if (authenticated) {
            if (typeof window.initBucketSettingsModal === 'function') {
                window.initBucketSettingsModal();
            }
            window.setupSettingsPanel();
            if (typeof window.setupHelpPanel === 'function') {
                window.setupHelpPanel();
            }
            if (!currentBucket) window.setMainToolbarLocked(true);
            // Buckets already awaited in checkAuthentication — init URL immediately
            window.initializeFromURL();
        }
    });
    const bucketSearchInput = document.getElementById('bucketSearchInput');
    if (bucketSearchInput) {
        bucketSearchInput.addEventListener('input', function() {
            const clearBtn = document.getElementById('clearBucketSearchBtn');
            if (clearBtn) clearBtn.classList.toggle('hidden', !bucketSearchInput.value.trim());
            window.displayBuckets();
        });
    }
    const fileInput = document.getElementById('fileInput');
    fileInput.setAttribute('multiple', 'multiple');

    // Shift+клик: диапазон — включить, если конечный чекбокс был выключен; снять выделение с диапазона, если был включён
    window.setupFileListDelegation();
    const fileList = document.getElementById('fileList');
    if (fileList) {
        fileList.addEventListener('mousedown', function(e) {
            if (!selectionMode) return;
            if (!e.shiftKey) return;
            const row = e.target.closest('.file-item, .folder-item');
            const cb = row ? row.querySelector('.list-checkbox') : e.target.closest('.list-checkbox');
            if (cb && window.handleShiftRangeSelection(cb)) {
                e.preventDefault();
            }
        });
        // После Shift+клика подавляем следующий click по той же строке; pending всегда сбрасываем, иначе «залипает» обработчик
        fileList.addEventListener('click', function(e) {
            if (!window.pendingShiftRangeClickTarget) return;
            const anchor = window.pendingShiftRangeClickTarget;
            const clickedRow = e.target.closest('.file-item, .folder-item');
            const targetRow = anchor && anchor.closest ? anchor.closest('.file-item, .folder-item') : null;
            if (clickedRow && targetRow && clickedRow === targetRow) {
                e.preventDefault();
                e.stopPropagation();
            }
            window.pendingShiftRangeClickTarget = null;
        }, true);
    }
});

// Закрытие при нажатии Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const confirmModal = document.getElementById('confirmModal');
        const createFolderModal = document.getElementById('createFolderModal');
        const copyObjectsModal = document.getElementById('copyObjectsModal');
        const moveObjectsModal = document.getElementById('moveObjectsModal');
        const addUserModal = document.getElementById('addUserModal');
        const addBucketModal = document.getElementById('addBucketModal');
        const bucketAccessModal = document.getElementById('bucketAccessModal');
        const cloudEditModal = document.getElementById('cloudEditModal');
        const userInfoModal = document.getElementById('userInfoModal');
        const fileInfoModal = document.getElementById('fileInfoModal');

        if (confirmModal.style.display === 'flex') {
            window.hideConfirmModal(false);
            // Снимаем фокус с активного элемента
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (createFolderModal.style.display === 'flex') {
            window.hideCreateFolderModal();
            // Снимаем фокус с активного элемента
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (copyObjectsModal && copyObjectsModal.style.display === 'flex') {
            window.hideCopyObjectsModal();
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (moveObjectsModal && moveObjectsModal.style.display === 'flex') {
            window.hideMoveObjectsModal();
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (addUserModal && addUserModal.style.display === 'flex') {
            // Используем существующую функцию для скрытия модального окна пользователя
            if (typeof window.hideAddUserModal === 'function') {
                window.hideAddUserModal();
            } else {
                addUserModal.style.display = 'none';
            }
            // Снимаем фокус с активного элемента
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (bucketAccessModal && bucketAccessModal.style.display === 'flex') {
            if (typeof window.hideBucketAccessModal === 'function') {
                window.hideBucketAccessModal();
            } else {
                bucketAccessModal.style.display = 'none';
                bucketAccessModal.classList.add('hidden');
            }
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (addBucketModal && addBucketModal.style.display === 'flex') {
            // Используем существующую функцию для скрытия модального окна бакета
            if (typeof window.hideAddBucketModal === 'function') {
                window.hideAddBucketModal();
            } else {
                addBucketModal.style.display = 'none';
            }
            // Снимаем фокус с активного элемента
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (cloudEditModal && cloudEditModal.style.display === 'flex') {
            if (typeof window.hideCloudEditModal === 'function') {
                window.hideCloudEditModal();
            } else {
                cloudEditModal.style.display = 'none';
            }
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (fileInfoModal && fileInfoModal.style.display === 'flex') {
            if (typeof window.hideFileInfoModal === 'function') {
                window.hideFileInfoModal();
            } else {
                fileInfoModal.style.display = 'none';
            }
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (document.getElementById('bulkAclModal')?.style.display === 'flex') {
            if (typeof window.hideBulkAclModal === 'function') {
                window.hideBulkAclModal();
            }
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (userInfoModal && userInfoModal.style.display === 'flex') {
            // Закрываем модальное окно информации о пользователе
            window.hideUserInfoModal();
            // Снимаем фокус с активного элемента
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (selectionMode) {
            window.toggleSelectionMode();
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }
        } else if (window.fileSearch.mode) {
            window.exitSearchMode();
            // Снимаем фокус с поля поиска
            const searchInput = document.getElementById('searchInput');
            if (searchInput && document.activeElement === searchInput) {
                searchInput.blur();
            }
        }
    }

    // Enter в модальном окне создания папки
    if (e.key === 'Enter' && document.getElementById('createFolderModal').style.display === 'flex') {
        window.createFolderSubmit();
    }
});
