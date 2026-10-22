/**
 * Bulk download / delete for multi-select mode.
 * Depends on: I18N, showError, showInfo, hideNotification, showConfirmModal,
 * OperationJobs, downloadFile, clearSelection, toggleSelectionMode,
 * userHasPermission, selectedItems / selectionMode on window.
 */
(function (global) {
    'use strict';

    function getBucket() {
        if (typeof global.__getCurrentBucket === 'function') return global.__getCurrentBucket() || '';
        return global.fileManagerCurrentBucketId || '';
    }

    function getPath() {
        if (typeof global.__getCurrentPath === 'function') return global.__getCurrentPath() || '';
        return '';
    }

    function getSelectedSet() {
        if (!global.selectedItems) global.selectedItems = new Set();
        return global.selectedItems;
    }

    function hasPerm(perm) {
        return typeof global.userHasPermission === 'function' && global.userHasPermission(perm);
    }

    function getPluralForm(number, one, two, five) {
        var n = Math.abs(number);
        n %= 100;
        if (n >= 5 && n <= 20) return five;
        n %= 10;
        if (n === 1) return one;
        if (n >= 2 && n <= 4) return two;
        return five;
    }

    async function downloadSelected() {
        var I18N = global.I18N || {};
        if (getSelectedSet().size === 0) return;

        var items = Array.from(getSelectedSet()).map(function (item) {
            return JSON.parse(item);
        });
        var files = items.filter(function (item) { return item.type === 'file'; });
        var folders = items.filter(function (item) { return item.type === 'folder'; });

        if (files.length === 0) {
            if (typeof global.showError === 'function') {
                global.showError(I18N['download.no_files'] || I18N['msg.download_select_files'] || '');
            }
            return;
        }

        var canDownloadFile = hasPerm('download_file') || hasPerm('download_files_multi');
        var canDownloadMultiFiles = hasPerm('download_files_multi');
        var canDownload = files.length === 1 ? canDownloadFile : canDownloadMultiFiles;
        if (!canDownload) {
            if (typeof global.showError === 'function') {
                global.showError(
                    (files.length > 1 && !canDownloadMultiFiles)
                        ? (I18N['files.select_files_requires_permissions'] || I18N['files.select_requires_permissions'] || '')
                        : (I18N['files.admin_only'] || '')
                );
            }
            return;
        }

        if (folders.length > 0) {
            var confirmMsg = (I18N['download.confirm_mixed'] || '').replace('{count}', String(files.length));
            if (confirmMsg && !global.confirm(confirmMsg)) return;
        }

        var useArchive = files.length > 1;

        try {
            if (useArchive) {
                var filePaths = files.map(function (f) { return f.path; }).filter(Boolean);
                var basePath = (getPath() || '').replace(/\/$/, '');
                var pathSegments = basePath.split('/').filter(Boolean);
                var parentFolder = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : 'archive';
                var labels = files.slice(0, 5).map(function (f) {
                    return (f.path || '').split('/').pop() || f.path;
                });
                if (files.length > 5) labels.push('+' + (files.length - 5));
                if (!global.OperationJobs || typeof global.OperationJobs.startDownloadArchive !== 'function') {
                    if (typeof global.showError === 'function') {
                        global.showError(I18N['download.error'] || '');
                    }
                    return;
                }
                await global.OperationJobs.startDownloadArchive({
                    bucket: getBucket(),
                    paths: filePaths,
                    folders: [],
                    parent_folder: parentFolder,
                    base_path: basePath,
                }, labels);
            } else if (typeof global.downloadFile === 'function') {
                await global.downloadFile(files[0].path);
            }

            if (typeof global.clearSelection === 'function') global.clearSelection();
            if (global.selectionMode && typeof global.toggleSelectionMode === 'function') {
                global.selectionMode = true;
                global.toggleSelectionMode();
            }
        } catch (error) {
            if (typeof global.showError === 'function') {
                global.showError((I18N['msg.download_failed'] || '') + ': ' + (error && error.message ? error.message : error));
            }
        }
    }

    async function deleteSelected() {
        var I18N = global.I18N || {};
        var canDeleteFiles = hasPerm('delete_file');
        var canDeleteFolders = hasPerm('delete_folder');
        var canDeleteMultiFiles = hasPerm('delete_files_multi');
        var canDeleteMultiFolders = hasPerm('delete_folder_multi');
        var selectedFilesCount = 0;
        var selectedFoldersCount = 0;
        getSelectedSet().forEach(function (itemKey) {
            var item = JSON.parse(itemKey);
            if (item.type === 'folder') selectedFoldersCount++;
            else if (item.type === 'file') selectedFilesCount++;
        });
        if (getSelectedSet().size === 0) return;
        if (selectedFilesCount >= 1 && (selectedFilesCount === 1 ? !canDeleteFiles : !canDeleteMultiFiles)) return;
        if (selectedFoldersCount >= 1 && (selectedFoldersCount === 1 ? !canDeleteFolders : !canDeleteMultiFolders)) return;

        var items = Array.from(getSelectedSet()).map(function (item) {
            return JSON.parse(item);
        });
        var validItems = items.filter(function (item) {
            return item.path && item.path.trim() !== '';
        });

        if (validItems.length === 0) {
            if (typeof global.showError === 'function') global.showError(I18N['delete.no_valid'] || '');
            return;
        }

        var itemNames = validItems.map(function (item) {
            var parts = item.path.split('/').filter(function (p) { return p; });
            return parts.length > 0 ? parts[parts.length - 1] : item.path;
        });

        if (typeof global.showConfirmModal !== 'function') return;
        global.showConfirmModal(
            (I18N['delete.confirm_prefix'] || '') + ' ' + validItems.length + ' ' +
            getPluralForm(
                validItems.length,
                I18N['plural.element_one'],
                I18N['plural.element_two'],
                I18N['plural.element_five']
            ) + '?\n\n' + itemNames.join('\n'),
            async function () {
                try {
                    var normalizedItems = validItems.map(function (item) {
                        var path = item.path;
                        try {
                            var decoded = decodeURIComponent(path);
                            if (decoded !== path) path = decoded;
                        } catch (e) { /* ignore */ }
                        return { path: path.trim(), type: item.type };
                    });

                    await global.OperationJobs.startDelete({
                        bucket: getBucket(),
                        items: normalizedItems,
                        display_names: itemNames,
                    });
                } catch (error) {
                    console.error('Delete error details:', error);
                    if (typeof global.showError === 'function') {
                        global.showError((I18N['delete.error'] || '') + ': ' + (error && error.message ? error.message : error));
                    }
                }
            }
        );
    }

    global.getPluralForm = getPluralForm;
    global.downloadSelected = downloadSelected;
    global.deleteSelected = deleteSelected;
})(window);
