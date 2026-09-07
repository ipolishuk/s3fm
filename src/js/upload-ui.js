/**
 * File/folder upload + drag-and-drop onto the files panel.
 * Depends on: I18N, showError, OperationJobs, userHasPermission, getActivePermissions,
 * window.selectionMode, __getCurrentBucket.
 */
(function (global) {
    'use strict';

    function getBucket() {
        if (typeof global.__getCurrentBucket === 'function') return global.__getCurrentBucket() || '';
        return global.fileManagerCurrentBucketId || '';
    }

    function hasPerm(perm) {
        return typeof global.userHasPermission === 'function' && global.userHasPermission(perm);
    }

    function activePerms() {
        return (typeof global.getActivePermissions === 'function') ? (global.getActivePermissions() || []) : [];
    }

async function processFileUploads(fileDescriptors, options) {
    try {
        await window.OperationJobs.startUpload(fileDescriptors, options || {});
    } catch (error) {
        showError(I18N['msg.load_files_failed'] + ': ' + (error.message || ''));
    }
}

// Загрузка файла
async function uploadFile() {
    if (!hasPerm('upload_files')) {
        showError(I18N['msg.admin_only_upload']);
        document.getElementById('fileInput').value = '';
        return;
    }

    const fileInput = document.getElementById('fileInput');
    const files = fileInput.files;
    if (files.length === 0) {
        return;
    }

    const descriptors = Array.from(files).map((file) => ({
        file: file,
        label: file.name
    }));
    await processFileUploads(descriptors, { folderMode: false });
    fileInput.value = '';
}

// Загрузка папки
async function uploadFolder() {
    if (!hasPerm('upload_folder')) {
        showError(I18N['msg.admin_only_folder']);
        document.getElementById('folderInput').value = '';
        return;
    }
    const folderInput = document.getElementById('folderInput');
    const files = folderInput.files;
    if (!files.length) return;
    const hasRelativePath = files[0].webkitRelativePath !== undefined && files[0].webkitRelativePath !== '';
    if (!hasRelativePath) {
        showError(I18N['upload.folder_not_supported']);
        folderInput.value = '';
        return;
    }

    const descriptors = Array.from(files).map((file) => {
        const relPath = file.webkitRelativePath || file.name;
        return { file: file, label: relPath, formFilename: relPath };
    });
    await processFileUploads(descriptors, { folderMode: true });
    folderInput.value = '';
}

function dataTransferHasFiles(dataTransfer) {
    if (!dataTransfer) return false;
    if (dataTransfer.types && Array.from(dataTransfer.types).includes('Files')) return true;
    if (dataTransfer.items) {
        return Array.from(dataTransfer.items).some((item) => item.kind === 'file');
    }
    return !!(dataTransfer.files && dataTransfer.files.length);
}

function canAcceptFileDrop() {
    if (!getBucket()) return false;
    if (global.selectionMode) return false;
    const containerContent = document.querySelector('.container-content');
    if (!containerContent || containerContent.classList.contains('hidden')) return false;
    const perms = activePerms();
    return perms.includes('upload_files') || perms.includes('upload_folder');
}

function collectEntriesFromDataTransfer(dataTransfer) {
    const entries = [];
    if (dataTransfer.items && dataTransfer.items.length) {
        for (const item of Array.from(dataTransfer.items)) {
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : (item.getAsEntry ? item.getAsEntry() : null);
            if (entry) entries.push(entry);
        }
    }
    if (!entries.length && dataTransfer.files && dataTransfer.files.length) {
        return Array.from(dataTransfer.files);
    }
    return entries;
}

async function readDroppedEntry(entry, pathPrefix) {
    const results = [];
    if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        const relativePath = pathPrefix + entry.name;
        results.push({ file: file, label: relativePath, formFilename: relativePath });
    } else if (entry.isDirectory) {
        const dirPath = pathPrefix + entry.name + '/';
        const reader = entry.createReader();
        let batch;
        do {
            batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            for (const child of batch) {
                const childResults = await readDroppedEntry(child, dirPath);
                results.push(...childResults);
            }
        } while (batch.length > 0);
    }
    return results;
}

async function collectFilesFromDropEntries(entries) {
    const descriptors = [];
    let hasDirectory = false;
    for (const entry of entries) {
        if (entry instanceof File) {
            descriptors.push({ file: entry, label: entry.name });
            continue;
        }
        if (entry.isDirectory) hasDirectory = true;
        const files = await readDroppedEntry(entry, '');
        descriptors.push(...files);
    }
    return { descriptors: descriptors, hasDirectory: hasDirectory };
}

function setupFileDropZone() {
    const dropZone = document.getElementById('filesPanel');
    const overlay = document.getElementById('dropOverlay');
    const overlayText = document.getElementById('dropOverlayText');
    if (!dropZone || !overlay) return;

    let dragDepth = 0;

    function hideDropOverlay() {
        dragDepth = 0;
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
        dropZone.classList.remove('drop-active');
    }

    function showDropOverlay() {
        if (overlayText) {
            const perms = activePerms();
            overlayText.textContent = perms.includes('upload_folder')
                ? I18N['drop.hint_folder']
                : I18N['drop.hint'];
        }
        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
        dropZone.classList.add('drop-active');
    }

    dropZone.addEventListener('dragenter', function(e) {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        if (!canAcceptFileDrop()) return;
        dragDepth++;
        if (dragDepth === 1) showDropOverlay();
    });

    dropZone.addEventListener('dragover', function(e) {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canAcceptFileDrop() ? 'copy' : 'none';
    });

    dropZone.addEventListener('dragleave', function(e) {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hideDropOverlay();
    });

    dropZone.addEventListener('drop', async function(e) {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        hideDropOverlay();

        if (!canAcceptFileDrop()) {
            if (global.selectionMode) {
                showError(I18N['msg.upload_disabled_in_select_mode']);
            } else if (!getBucket()) {
                showError(I18N['msg.select_bucket_first']);
            }
            return;
        }

        const entries = collectEntriesFromDataTransfer(e.dataTransfer);
        if (!entries.length) return;

        const perms = activePerms();
        const hasDirectoryEntry = entries.some((entry) => !(entry instanceof File) && entry.isDirectory);
        if (hasDirectoryEntry && !perms.includes('upload_folder')) {
            showError(I18N['msg.admin_only_folder']);
            return;
        }
        if (!hasDirectoryEntry && !perms.includes('upload_files')) {
            showError(I18N['msg.admin_only_upload']);
            return;
        }

        try {
            const collected = await collectFilesFromDropEntries(entries);
            if (!collected.descriptors.length) return;
            const folderMode = collected.hasDirectory || hasDirectoryEntry;
            if (folderMode && !perms.includes('upload_folder')) {
                showError(I18N['msg.admin_only_folder']);
                return;
            }
            if (!folderMode && !perms.includes('upload_files')) {
                showError(I18N['msg.admin_only_upload']);
                return;
            }
            await processFileUploads(collected.descriptors, { folderMode: folderMode });
        } catch (err) {
            showError(I18N['msg.upload_failed'] + ': ' + (err.message || err));
        }
    });

    document.addEventListener('dragend', hideDropOverlay);
    window.addEventListener('blur', hideDropOverlay);

    document.addEventListener('dragover', function(e) {
        if (dataTransferHasFiles(e.dataTransfer)) {
            e.preventDefault();
        }
    });
    document.addEventListener('drop', function(e) {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        if (!dropZone.contains(e.target)) {
            e.preventDefault();
        }
    });
}



    global.processFileUploads = processFileUploads;
    global.uploadFile = uploadFile;
    global.uploadFolder = uploadFolder;
    global.setupFileDropZone = setupFileDropZone;
    global.dataTransferHasFiles = dataTransferHasFiles;
    global.canAcceptFileDrop = canAcceptFileDrop;
})(window);
