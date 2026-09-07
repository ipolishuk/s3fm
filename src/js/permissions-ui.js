// Permissions toolbar wiring
function canSelectFilesInList(bucketId) {
    return typeof window.canSelectFilesInSelectionMode === 'function'
        && window.canSelectFilesInSelectionMode(bucketId || currentBucket);
}

function canSelectFoldersInList(bucketId) {
    return typeof window.canSelectFoldersInSelectionMode === 'function'
        && window.canSelectFoldersInSelectionMode(bucketId || currentBucket);
}

function canUseSelectionMode(bucketId) {
    return typeof window.canEnterSelectionMode === 'function'
        && window.canEnterSelectionMode(bucketId || currentBucket);
}
window.canUseSelectionMode = canUseSelectionMode;
window.canSelectFilesInList = canSelectFilesInList;
window.canSelectFoldersInList = canSelectFoldersInList;

function fileCheckboxSelectDisabledAttr() {
    if (canSelectFilesInList()) return '';
    return 'disabled title="' + (I18N['files.select_files_copy_requires_permissions'] || I18N['files.select_files_requires_permissions'] || 'Selection requires permissions').replace(/"/g, '&quot;') + '"';
}

function folderCheckboxSelectDisabledAttr() {
    if (canSelectFoldersInList()) return '';
    return 'disabled title="' + (I18N['files.select_folders_copy_requires_permissions'] || I18N['files.select_folders_requires_permissions'] || '').replace(/"/g, '&quot;') + '"';
}

function setupUserPermissions() {
    const uploadBtn = document.getElementById('uploadBtn');
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    const selectModeBtn = document.getElementById('selectModeBtn');
    const aclSelectedBtn = document.getElementById('aclSelectedBtn');
    const uploadFilesOption = document.getElementById('uploadFilesOption');
    const uploadFolderOption = document.getElementById('uploadFolderOption');
    const createFolderOption = document.getElementById('createFolderOption');
    const addBucketOption = document.getElementById('addBucketOption');
    const perms = getActivePermissions();
    const canUploadFiles = perms.includes('upload_files');
    const canUploadFolder = perms.includes('upload_folder');
    const canCreateFolder = perms.includes('create_folder');
    const canAddBucket = typeof window.userHasPermission === 'function'
        && window.userHasPermission('add_bucket');
    const canEdit = canUploadFiles || canUploadFolder || canCreateFolder;
    const canUseUploadMenu = canEdit || canAddBucket;
    const canSelect = canUseSelectionMode();
    if (selectModeBtn && !selectionMode) {
        selectModeBtn.disabled = !canSelect;
        var selectTitle = canSelect
            ? (I18N['toolbar.select'] || 'Select')
            : (I18N['files.select_requires_permissions'] || 'Selection requires permissions');
        selectModeBtn.title = selectTitle;
        selectModeBtn.setAttribute('aria-label', selectTitle);
    }
    if (aclSelectedBtn && typeof window.updateBulkAclToolbarButton === 'function') {
        let aclFiles = 0;
        let aclFolders = 0;
        if (selectionMode) {
            selectedItems.forEach(itemKey => {
                try {
                    const item = JSON.parse(itemKey);
                    if (item.type === 'file') aclFiles++;
                    else if (item.type === 'folder') aclFolders++;
                } catch (e) { /* ignore */ }
            });
        }
        window.updateBulkAclToolbarButton(aclFiles, aclFolders);
    }
    if (addBucketOption) {
        if (canAddBucket) {
            addBucketOption.classList.remove('hidden');
            addBucketOption.disabled = false;
            addBucketOption.title = I18N['buckets.add'] || 'Add bucket';
        } else {
            addBucketOption.classList.add('hidden');
            addBucketOption.disabled = true;
        }
    }
    const hasBucket = !!currentBucket;
    const toolbarLocked = !!(document.getElementById('primaryToolbar')
        && document.getElementById('primaryToolbar').classList.contains('toolbar-locked'));
    if (!canUseUploadMenu) {
        if (uploadBtn) uploadBtn.disabled = true;
        if (uploadFilesOption) uploadFilesOption.disabled = true;
        if (uploadFolderOption) uploadFolderOption.disabled = true;
        if (createFolderOption) createFolderOption.disabled = true;
        if (uploadBtn) uploadBtn.title = I18N['msg.admin_only_upload'];
    } else {
        if (uploadBtn) {
            // Active with add_bucket even when no bucket is selected (toolbar locked)
            uploadBtn.disabled = !!selectionMode || (toolbarLocked && !canAddBucket);
            uploadBtn.title = selectionMode
                ? (I18N['msg.upload_disabled_in_select_mode'] || 'Exit selection mode to upload')
                : (canEdit && hasBucket
                    ? I18N['toolbar.upload']
                    : (I18N['buckets.add'] || 'Add bucket'));
        }
        // Bucket-scoped actions need a selected bucket
        if (uploadFilesOption) {
            uploadFilesOption.disabled = !canUploadFiles || !hasBucket;
            uploadFilesOption.title = !hasBucket
                ? (I18N['msg.select_bucket_first'] || I18N['buckets.title'] || 'Select a bucket')
                : (canUploadFiles ? I18N['toolbar.upload'] : I18N['msg.admin_only_upload']);
        }
        if (uploadFolderOption) {
            uploadFolderOption.disabled = !canUploadFolder || !hasBucket;
            uploadFolderOption.title = !hasBucket
                ? (I18N['msg.select_bucket_first'] || I18N['buckets.title'] || 'Select a bucket')
                : (canUploadFolder ? I18N['toolbar.upload_folder'] : I18N['msg.admin_only_upload']);
        }
        if (createFolderOption) {
            createFolderOption.disabled = !canCreateFolder || !hasBucket;
            createFolderOption.title = !hasBucket
                ? (I18N['msg.select_bucket_first'] || I18N['buckets.title'] || 'Select a bucket')
                : (canCreateFolder ? I18N['toolbar.create_folder'] : I18N['msg.admin_only_upload']);
        }
    }
}
window.setupUserPermissions = setupUserPermissions;

// Отображение информации о пользователе

window.fileCheckboxSelectDisabledAttr = fileCheckboxSelectDisabledAttr;
window.folderCheckboxSelectDisabledAttr = folderCheckboxSelectDisabledAttr;
