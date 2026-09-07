/**
 * Create-folder modal submit + client-side name validation.
 * Depends on: I18N, showSuccess, showError, hideCreateFolderModal, loadFiles,
 * window.fileManagerCurrentBucketId / bridges for current path & bucket.
 */
(function (global) {
    'use strict';

    function getCurrentBucket() {
        if (typeof global.__getCurrentBucket === 'function') {
            return global.__getCurrentBucket() || '';
        }
        return global.fileManagerCurrentBucketId || '';
    }

    function getCurrentPath() {
        if (typeof global.__getCurrentPath === 'function') {
            return global.__getCurrentPath() || '';
        }
        return '';
    }

    function toastFolderError(message) {
        if (!message) return;
        if (typeof global.showError === 'function') {
            global.showError(message);
        }
    }

    async function createFolderSubmit() {
        var I18N = global.I18N || {};
        var folderNameInput = document.getElementById('folderNameInput');
        var errorDiv = document.getElementById('folderNameError');
        if (!folderNameInput) return;

        var folderName = folderNameInput.value.trim();

        folderNameInput.classList.remove('error');
        if (errorDiv) {
            errorDiv.style.display = 'none';
            errorDiv.textContent = '';
        }

        if (!folderName) {
            folderNameInput.classList.add('error');
            toastFolderError(I18N['modal.folder_empty'] || '');
            folderNameInput.focus();
            return;
        }

        var forbiddenChars = /[\\/:*?"<>|]/;
        if (forbiddenChars.test(folderName)) {
            folderNameInput.classList.add('error');
            toastFolderError(I18N['msg.forbidden_chars'] || '');
            folderNameInput.focus();
            return;
        }

        if (folderName.length > 255) {
            folderNameInput.classList.add('error');
            toastFolderError(I18N['msg.folder_too_long'] || '');
            folderNameInput.focus();
            return;
        }

        var fullPath = getCurrentPath() + folderName + '/';

        try {
            var response = await fetch('/files/create-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    bucket: getCurrentBucket(),
                    path: fullPath,
                }),
            });

            if (response.status === 401) {
                global.location.href = '/login';
                return;
            }

            var data = await response.json();

            if (response.ok) {
                if (typeof global.showSuccess === 'function') {
                    global.showSuccess(I18N['msg.folder_created'] || '');
                }
                if (typeof global.hideCreateFolderModal === 'function') {
                    global.hideCreateFolderModal();
                }
                if (global.fileSearch && global.fileSearch.mode && typeof global.performSearch === 'function') {
                    await global.performSearch(global.fileSearch.query);
                } else if (typeof global.loadFiles === 'function') {
                    global.loadFiles(getCurrentPath());
                }
            } else {
                folderNameInput.classList.add('error');
                toastFolderError((data && data.error) || I18N['msg.unknown_error'] || '');
                folderNameInput.focus();
            }
        } catch (error) {
            folderNameInput.classList.add('error');
            toastFolderError(
                (I18N['msg.create_folder_failed'] || '') + ': ' + (error && error.message ? error.message : error)
            );
            folderNameInput.focus();
        }
    }

    global.createFolderSubmit = createFolderSubmit;
    global.S3FM = global.S3FM || {};
    global.S3FM.createFolderSubmit = createFolderSubmit;
})(window);
