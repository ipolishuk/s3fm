/**
 * File-list and settings-row context menus (right-click + long-press on touch).
 * Depends on: I18N, userHasPermission / getActivePermissions bridges,
 * downloadFile, deleteObject, FilePreview, FileInfoModal, TransferObjects,
 * fit/resetDropdownMenuOverlay, settings row action helpers on window.
 */
(function (global) {
    'use strict';

    var LONG_PRESS_MS = 480;
    var LONG_PRESS_MOVE_PX = 12;
    var OUTSIDE_CLICK_IGNORE_MS = 500;

    function selectedItemsSet() {
        return global.selectedItems || new Set();
    }
    function isSelectionMode() {
        return !!global.selectionMode;
    }
    function listRowPath(row) {
        if (typeof global.getListRowPath === 'function') return global.getListRowPath(row) || '';
        return row && row.dataset ? (row.dataset.path || '') : '';
    }

    /**
     * Long-press on touch → open custom context menu (mobile has no reliable ПКМ).
     * findTarget(eventTarget) → element or null; onOpen({clientX, clientY}, target).
     */
    function bindContextMenuOpen(root, findTarget, onOpen, getIgnoreUntilSetter) {
        if (!root) return;

        var pressTimer = null;
        var startX = 0;
        var startY = 0;
        var pressTarget = null;
        var openedByTouch = false;

        function clearPress() {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            pressTarget = null;
        }

        function openFromPoint(clientX, clientY, target) {
            if (typeof getIgnoreUntilSetter === 'function') {
                getIgnoreUntilSetter(Date.now() + OUTSIDE_CLICK_IGNORE_MS);
            }
            onOpen({ clientX: clientX, clientY: clientY }, target);
        }

        root.addEventListener('contextmenu', function (e) {
            var target = findTarget(e.target);
            if (!target || !root.contains(target)) return;
            e.preventDefault();
            e.stopPropagation();
            clearPress();
            openFromPoint(e.clientX, e.clientY, target);
        });

        root.addEventListener('touchstart', function (e) {
            if (!e.touches || e.touches.length !== 1) {
                clearPress();
                return;
            }
            var target = findTarget(e.target);
            if (!target || !root.contains(target)) {
                clearPress();
                return;
            }
            // Don't steal taps on form controls (label OK — covers file name in selection mode)
            if (e.target.closest('input, button, a, select, textarea')) {
                clearPress();
                return;
            }
            var touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            clearPress();
            pressTarget = target;
            pressTimer = setTimeout(function () {
                pressTimer = null;
                var t = pressTarget;
                pressTarget = null;
                if (!t || !root.contains(t)) return;
                openedByTouch = true;
                openFromPoint(startX, startY, t);
                // Drop the flag if no click follows (some mobile browsers)
                setTimeout(function () { openedByTouch = false; }, OUTSIDE_CLICK_IGNORE_MS + 100);
            }, LONG_PRESS_MS);
        }, { passive: true });

        root.addEventListener('touchmove', function (e) {
            if (!pressTimer || !e.touches || !e.touches.length) return;
            var touch = e.touches[0];
            if (Math.abs(touch.clientX - startX) > LONG_PRESS_MOVE_PX ||
                Math.abs(touch.clientY - startY) > LONG_PRESS_MOVE_PX) {
                clearPress();
            }
        }, { passive: true });

        root.addEventListener('touchend', clearPress, { passive: true });
        root.addEventListener('touchcancel', clearPress, { passive: true });

        // Suppress the synthetic click that follows long-press (would close menu / navigate)
        root.addEventListener('click', function (e) {
            if (!openedByTouch) return;
            openedByTouch = false;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }

// Контекстное меню файла (ПКМ / long-press) — тот же dropdown overlay, что у upload
function setupFileContextMenu() {
    const container = document.getElementById('fileContextDropdown');
    const trigger = document.getElementById('fileContextTrigger');
    const menu = document.getElementById('fileContextMenu');
    const downloadItem = document.getElementById('fileContextDownload');
    const copyItem = document.getElementById('fileContextCopy');
    const moveItem = document.getElementById('fileContextMove');
    const deleteItem = document.getElementById('fileContextDelete');
    const previewItem = document.getElementById('fileContextPreview');
    const propertiesItem = document.getElementById('fileContextProperties');
    const editAclItem = document.getElementById('fileContextEditAcl');
    const fileList = document.getElementById('fileList');
    if (!container || !trigger || !menu || !fileList) return;

    let contextPath = '';
    let contextFileItem = null;
    let ignoreOutsideClickUntil = 0;

    function closeMenu() {
        container.classList.remove('open');
        contextPath = '';
        contextFileItem = null;
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(container);
        } else {
            menu.classList.add('hidden');
            trigger.setAttribute('aria-expanded', 'false');
        }
    }

    function isFolderRow(item, path) {
        if (item && item.classList && item.classList.contains('folder-item')) return true;
        return !!(path && String(path).endsWith('/'));
    }

    function contextTransferItem(path, isFolder) {
        return [{ path: path, type: isFolder ? 'folder' : 'file' }];
    }

    function getSelectedContextCounts() {
        let files = 0;
        let folders = 0;
        selectedItemsSet().forEach(function(itemKey) {
            try {
                const item = JSON.parse(itemKey);
                if (item.type === 'folder') folders++;
                else if (item.type === 'file') files++;
            } catch (e) { /* ignore */ }
        });
        return { files: files, folders: folders, total: files + folders };
    }

    function getSelectedContextItems() {
        const items = [];
        selectedItemsSet().forEach(function(itemKey) {
            try {
                const item = JSON.parse(itemKey);
                if (item && item.path) {
                    items.push({ path: item.path, type: item.type === 'folder' ? 'folder' : 'file' });
                }
            } catch (e) { /* ignore */ }
        });
        return items;
    }

    function getSingleSelectedFilePath() {
        const counts = getSelectedContextCounts();
        if (counts.files !== 1 || counts.folders !== 0) return '';
        const items = getSelectedContextItems();
        return items.length === 1 && items[0].type === 'file' ? items[0].path : '';
    }

    function updateMenuItemsState(fileItem, path) {
        const isFolder = isFolderRow(fileItem, path);
        const useSelection = isSelectionMode();
        const counts = useSelection
            ? getSelectedContextCounts()
            : { files: isFolder ? 0 : 1, folders: isFolder ? 1 : 0, total: 1 };
        const filesCount = counts.files;
        const foldersCount = counts.folders;
        const hasSelection = counts.total > 0;
        const singleFilePath = useSelection
            ? getSingleSelectedFilePath()
            : (isFolder ? '' : path);
        const singleFileOnly = !!singleFilePath;

        const canDeleteFiles = typeof global.userHasPermission === 'function'
            ? global.userHasPermission(filesCount === 1 ? 'delete_file' : 'delete_files_multi')
            : true;
        const canDeleteFolders = typeof global.userHasPermission === 'function'
            ? global.userHasPermission(foldersCount === 1 ? 'delete_folder' : 'delete_folder_multi')
            : true;
        let canDelete = hasSelection;
        if (filesCount >= 1 && !canDeleteFiles) canDelete = false;
        if (foldersCount >= 1 && !canDeleteFolders) canDelete = false;
        if (!useSelection) {
            canDelete = typeof global.userHasPermission === 'function'
                ? global.userHasPermission(isFolder ? 'delete_folder' : 'delete_file')
                : true;
        }
        if (deleteItem) {
            deleteItem.disabled = !canDelete;
            deleteItem.removeAttribute('title');
        }

        if (downloadItem) {
            if (useSelection) {
                const canDownloadFile = typeof global.userHasPermission === 'function'
                    ? (global.userHasPermission('download_file') || global.userHasPermission('download_files_multi'))
                    : true;
                const canDownloadMulti = typeof global.userHasPermission === 'function'
                    ? global.userHasPermission('download_files_multi')
                    : true;
                const canDownload = filesCount > 0 && (
                    filesCount === 1
                        ? canDownloadFile
                        : canDownloadMulti
                );
                downloadItem.disabled = !canDownload;
            } else if (isFolder) {
                const canDownloadFolder = typeof global.userHasPermission === 'function'
                    ? global.userHasPermission('download_folder')
                    : true;
                downloadItem.disabled = !canDownloadFolder;
            } else {
                const canDownloadFile = typeof global.userHasPermission === 'function'
                    ? (global.userHasPermission('download_file') || global.userHasPermission('download_files_multi'))
                    : true;
                downloadItem.disabled = !canDownloadFile;
            }
            downloadItem.removeAttribute('title');
        }

        if (copyItem) {
            const canCopy = typeof window.canCopySelected === 'function'
                ? window.canCopySelected(filesCount, foldersCount)
                : (typeof window.getCopyDisableReason === 'function'
                    ? !window.getCopyDisableReason(filesCount, foldersCount)
                    : true);
            copyItem.disabled = !canCopy;
            copyItem.removeAttribute('title');
        }

        if (moveItem) {
            const canMove = typeof window.canMoveSelected === 'function'
                ? window.canMoveSelected(filesCount, foldersCount)
                : (typeof window.getMoveDisableReason === 'function'
                    ? !window.getMoveDisableReason(filesCount, foldersCount)
                    : true);
            moveItem.disabled = !canMove;
            moveItem.removeAttribute('title');
        }

        if (previewItem) {
            if (!singleFileOnly) {
                previewItem.classList.add('hidden');
                previewItem.disabled = true;
            } else {
                previewItem.classList.remove('hidden');
                const canPreviewPerm = typeof global.userHasPermission === 'function'
                    ? global.userHasPermission('preview')
                    : true;
                const previewable = typeof window.isFilePreviewableByExtension === 'function'
                    ? window.isFilePreviewableByExtension(singleFilePath)
                    : true;
                previewItem.disabled = !(canPreviewPerm && previewable);
            }
            previewItem.removeAttribute('title');
        }

        if (propertiesItem) {
            if (!singleFileOnly) {
                propertiesItem.classList.add('hidden');
                propertiesItem.disabled = true;
            } else {
                propertiesItem.classList.remove('hidden');
                propertiesItem.disabled = false;
            }
            propertiesItem.removeAttribute('title');
        }

        if (editAclItem) {
            editAclItem.classList.remove('hidden');
            const canEditAcl = typeof global.userHasPermission === 'function'
                ? global.userHasPermission('edit_file_acl')
                : false;
            editAclItem.disabled = !(canEditAcl && hasSelection);
            editAclItem.removeAttribute('title');
        }
    }

    function openMenu(e, fileItem) {
        const path = listRowPath(fileItem);
        if (!path) return;

        contextPath = path;
        contextFileItem = fileItem;
        updateMenuItemsState(fileItem, path);
        const preloadPath = isSelectionMode() ? getSingleSelectedFilePath() : (isFolderRow(fileItem, path) ? '' : path);
        if (preloadPath && typeof window.preloadFileInfoForPath === 'function') {
            window.preloadFileInfoForPath(preloadPath);
        }

        trigger.style.left = e.clientX + 'px';
        trigger.style.top = e.clientY + 'px';
        ignoreOutsideClickUntil = Date.now() + OUTSIDE_CLICK_IGNORE_MS;

        document.dispatchEvent(new CustomEvent('dropdown:open', { detail: { source: 'file-context' } }));
        container.classList.add('open');
        menu.classList.remove('hidden');
        trigger.setAttribute('aria-expanded', 'true');
        if (typeof window.fitDropdownMenuOverlay === 'function') {
            window.fitDropdownMenuOverlay(container);
        }
    }

    bindContextMenuOpen(
        fileList,
        function (el) { return el.closest('.file-item, .folder-item'); },
        function (point, fileItem) { openMenu(point, fileItem); },
        function (until) { ignoreOutsideClickUntil = until; }
    );

    if (downloadItem) {
        downloadItem.addEventListener('click', function() {
            if (downloadItem.disabled) return;
            if (isSelectionMode()) {
                closeMenu();
                if (typeof global.downloadSelected === 'function') global.downloadSelected();
                return;
            }
            if (!contextPath) return;
            const path = contextPath;
            const folder = isFolderRow(contextFileItem, path);
            closeMenu();
            if (folder) {
                global.downloadFolderAsArchive(path);
            } else {
                global.downloadFile(path);
            }
        });
    }
    if (copyItem) {
        copyItem.addEventListener('click', function() {
            if (copyItem.disabled) return;
            if (isSelectionMode()) {
                const items = getSelectedContextItems();
                closeMenu();
                if (typeof window.showCopyObjectsModal === 'function') {
                    window.showCopyObjectsModal(items);
                }
                return;
            }
            if (!contextPath) return;
            const path = contextPath;
            const folder = isFolderRow(contextFileItem, path);
            closeMenu();
            if (typeof window.showCopyObjectsModal === 'function') {
                window.showCopyObjectsModal(contextTransferItem(path, folder));
            }
        });
    }
    if (moveItem) {
        moveItem.addEventListener('click', function() {
            if (moveItem.disabled) return;
            if (isSelectionMode()) {
                const items = getSelectedContextItems();
                closeMenu();
                if (typeof window.showMoveObjectsModal === 'function') {
                    window.showMoveObjectsModal(items);
                }
                return;
            }
            if (!contextPath) return;
            const path = contextPath;
            const folder = isFolderRow(contextFileItem, path);
            closeMenu();
            if (typeof window.showMoveObjectsModal === 'function') {
                window.showMoveObjectsModal(contextTransferItem(path, folder));
            }
        });
    }
    if (deleteItem) {
        deleteItem.addEventListener('click', function() {
            if (deleteItem.disabled) return;
            if (isSelectionMode()) {
                closeMenu();
                if (typeof global.deleteSelected === 'function') global.deleteSelected();
                return;
            }
            if (!contextPath) return;
            const path = contextPath;
            closeMenu();
            global.deleteObject(path);
        });
    }
    if (previewItem) {
        previewItem.addEventListener('click', function() {
            if (previewItem.disabled) return;
            const path = isSelectionMode() ? getSingleSelectedFilePath() : contextPath;
            closeMenu();
            if (!path || typeof window.openFilePreview !== 'function') return;
            window.openFilePreview(path);
        });
    }
    if (propertiesItem) {
        propertiesItem.addEventListener('click', function() {
            if (propertiesItem.disabled) return;
            const path = isSelectionMode() ? getSingleSelectedFilePath() : contextPath;
            const item = (!isSelectionMode() || (contextFileItem && listRowPath(contextFileItem) === path))
                ? contextFileItem
                : null;
            closeMenu();
            if (!path || typeof window.showFileInfoModal !== 'function') return;
            if (!item) {
                window.showFileInfoModal(path);
                return;
            }
            const sizeEl = item.querySelector('.file-size');
            const modEl = item.querySelector('.file-modified');
            window.showFileInfoModal(path, {
                size: item.dataset.size ? Number(item.dataset.size) : null,
                sizeLabel: sizeEl ? (sizeEl.textContent || '').trim() : null,
                lastModified: item.dataset.lastModified || null,
                modifiedLabel: modEl ? (modEl.textContent || '').trim() : null
            });
        });
    }
    if (editAclItem) {
        editAclItem.addEventListener('click', function() {
            if (editAclItem.disabled) return;
            if (isSelectionMode()) {
                const items = getSelectedContextItems();
                closeMenu();
                if (typeof window.showBulkAclModal === 'function') {
                    window.showBulkAclModal(items);
                }
                return;
            }
            if (!contextPath) return;
            const path = contextPath;
            const folder = isFolderRow(contextFileItem, path);
            closeMenu();
            if (typeof window.showBulkAclModal === 'function') {
                window.showBulkAclModal([{ path: path, type: folder ? 'folder' : 'file' }]);
            }
        });
    }

    document.addEventListener('click', function(e) {
        if (Date.now() < ignoreOutsideClickUntil) return;
        if (container.classList.contains('open') && !container.contains(e.target)) closeMenu();
    });

    // Клики по списку бакетов делают stopPropagation — document-listener их не видит
    var bucketsList = document.getElementById('bucketsList');
    if (bucketsList) {
        bucketsList.addEventListener('click', function () {
            if (container.classList.contains('open')) closeMenu();
        }, true);
    }

    document.addEventListener('dropdown:open', function(e) {
        if (!e || !e.detail || e.detail.source === 'file-context') return;
        closeMenu();
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && container.classList.contains('open')) {
            closeMenu();
        }
    });

    window.closeFileContextMenu = closeMenu;
}

// Контекстное меню строки настроек (ПКМ / long-press) — не используется на вкладке Search
function setupSettingsContextMenu() {
    const container = document.getElementById('settingsContextDropdown');
    const trigger = document.getElementById('settingsContextTrigger');
    const menu = document.getElementById('settingsContextMenu');
    const copyItem = document.getElementById('settingsContextCopy');
    const editItem = document.getElementById('settingsContextEdit');
    const deleteItem = document.getElementById('settingsContextDelete');
    const settingsInner = document.getElementById('settingsContentInner');
    if (!container || !trigger || !menu || !settingsInner) return;

    let contextRow = null;
    let ignoreOutsideClickUntil = 0;

    function closeMenu() {
        container.classList.remove('open');
        contextRow = null;
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(container);
        } else {
            menu.classList.add('hidden');
            trigger.setAttribute('aria-expanded', 'false');
        }
    }

    function setItemLabel(item, text) {
        if (!item) return;
        const span = item.querySelector('span');
        if (span) span.textContent = text;
        item.title = text || '';
    }

    function currentSettingsTab() {
        return (window.settingsPanelState && window.settingsPanelState.currentTab) || '';
    }

    function updateMenuForRow(row) {
        setItemLabel(copyItem, I18N['menu.copy'] || 'Copy');
        setItemLabel(editItem, I18N['menu.edit'] || 'Edit');
        setItemLabel(deleteItem, I18N['menu.delete'] || 'Delete');

        const canEdit = row.getAttribute('data-can-edit') !== '0';
        const canDelete = row.getAttribute('data-can-delete') !== '0';
        if (editItem) {
            editItem.disabled = !canEdit;
            editItem.title = canEdit
                ? (I18N['menu.edit'] || '')
                : (row.getAttribute('data-edit-denied-title') || I18N['files.admin_only'] || '');
        }
        if (deleteItem) {
            deleteItem.disabled = !canDelete;
            deleteItem.title = canDelete
                ? (I18N['menu.delete'] || '')
                : (row.getAttribute('data-delete-denied-title') || I18N['files.admin_only'] || '');
        }
        if (copyItem) copyItem.disabled = false;
    }

    function openMenu(e, row) {
        contextRow = row;
        updateMenuForRow(row);
        trigger.style.left = e.clientX + 'px';
        trigger.style.top = e.clientY + 'px';
        ignoreOutsideClickUntil = Date.now() + OUTSIDE_CLICK_IGNORE_MS;
        document.dispatchEvent(new CustomEvent('dropdown:open', { detail: { source: 'settings-context' } }));
        container.classList.add('open');
        menu.classList.remove('hidden');
        trigger.setAttribute('aria-expanded', 'true');
        if (typeof window.fitDropdownMenuOverlay === 'function') {
            window.fitDropdownMenuOverlay(container);
        }
    }

    function runAction(action) {
        const row = contextRow;
        if (!row) return;
        const tab = currentSettingsTab();
        closeMenu();

        if (tab === 'users') {
            const username = row.getAttribute('data-username');
            if (!username) return;
            if (action === 'edit' && typeof window.openEditUserModal === 'function') window.openEditUserModal(username);
            else if (action === 'copy' && typeof window.openEditUserModal === 'function') window.openEditUserModal(username, 'copy');
            else if (action === 'delete' && typeof window.confirmDeleteUser === 'function') window.confirmDeleteUser(username);
            return;
        }

        if (tab === 'roles') {
            const roleName = row.getAttribute('data-role-name');
            if (!roleName) return;
            if (action === 'edit' && typeof window.openEditRoleModal === 'function') window.openEditRoleModal(roleName);
            else if (action === 'copy' && typeof window.openCopyRoleModal === 'function') window.openCopyRoleModal(roleName);
            else if (action === 'delete' && typeof window.confirmDeleteRole === 'function') window.confirmDeleteRole(roleName);
            return;
        }

        if (tab === 'clouds') {
            const cloudId = row.getAttribute('data-cloud-id');
            if (!cloudId) return;
            if (action === 'edit' && typeof window.openEditCloudModal === 'function') window.openEditCloudModal(cloudId);
            else if (action === 'copy' && typeof window.openCopyCloudModal === 'function') window.openCopyCloudModal(cloudId);
            else if (action === 'delete' && typeof window.confirmDeleteCloud === 'function') window.confirmDeleteCloud(cloudId);
            return;
        }

        if (tab === 'buckets') {
            const cloudId = row.getAttribute('data-cloud-id');
            const displayName = row.getAttribute('data-display-name');
            if (!cloudId || displayName === null) return;
            if (action === 'edit' && typeof window.openEditBucketModal === 'function') window.openEditBucketModal(cloudId, displayName);
            else if (action === 'copy' && typeof window.openCopyBucketModal === 'function') window.openCopyBucketModal(cloudId, displayName);
            else if (action === 'delete' && typeof window.confirmDeleteBucket === 'function') window.confirmDeleteBucket(cloudId, displayName);
        }
    }

    bindContextMenuOpen(
        settingsInner,
        function (el) {
            if (currentSettingsTab() === 'search') return null;
            if (el.closest('input, button, a, select, textarea')) return null;
            return el.closest('#settingsTableBody tr');
        },
        function (point, row) { openMenu(point, row); },
        function (until) { ignoreOutsideClickUntil = until; }
    );

    [copyItem, editItem, deleteItem].forEach(function(item) {
        if (!item) return;
        item.addEventListener('click', function() {
            if (item.disabled || item.classList.contains('hidden')) return;
            runAction(item.getAttribute('data-action'));
        });
    });

    document.addEventListener('click', function(e) {
        if (Date.now() < ignoreOutsideClickUntil) return;
        if (container.classList.contains('open') && !container.contains(e.target)) closeMenu();
    });

    document.addEventListener('dropdown:open', function(e) {
        if (!e || !e.detail || e.detail.source === 'settings-context') return;
        closeMenu();
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && container.classList.contains('open')) closeMenu();
    });

    window.closeSettingsContextMenu = closeMenu;
}


    global.setupFileContextMenu = setupFileContextMenu;
    global.setupSettingsContextMenu = setupSettingsContextMenu;
})(window);
