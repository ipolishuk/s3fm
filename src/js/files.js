/**
 * File manager UI: utils, actions, list, info modal, preview.
 * Merged from file-utils / file-actions / file-list / file-info / file-preview.
 */

/* ===== file-utils.js ===== */
/**
 * Shared formatting helpers for the file manager UI.
 */
(function (global) {
    'use strict';

// Форматирование размера файла
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    if (bytes < 1024) return bytes + ' Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    // Для больших размеров показываем 2 знака после запятой, для маленьких - целые числа
    const precision = bytes >= Math.pow(k, 3) ? 2 : 0; // GB и больше - 2 знака, меньше - целые
    const value = parseFloat((bytes / Math.pow(k, i)).toFixed(precision));

    return value + ' ' + sizes[i];
}





    global.formatFileSize = formatFileSize;
    global.S3FM = global.S3FM || {};
    global.S3FM.formatFileSize = formatFileSize;
})(window);

/* ===== file-actions.js ===== */
/**
 * Single-object delete / download / folder archive helpers.
 * Depends on: I18N, showError, showInfo, hideNotification, showConfirmModal,
 * window.OperationJobs, window.userHasPermission, __getCurrentBucket/Path bridges.
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

    function hasPerm(perm) {
        return typeof global.userHasPermission === 'function' && global.userHasPermission(perm);
    }

// Удаление объекта через icon-btn delete с прогресс-баром
async function deleteObject(path) {
    const isFolder = path.endsWith('/');
    if (isFolder && !hasPerm('delete_folder')) {
        showError(I18N['msg.admin_only_folder']);
        return;
    }
    if (!isFolder && !hasPerm('delete_file')) {
        showError(I18N['msg.admin_only_delete']);
        return;
    }

    const objectName = path.split('/').filter(p => p).pop() || path;

    showConfirmModal(
        I18N['delete.confirm_one'].replace('{name}', objectName),
        async () => {
            try {
                await window.OperationJobs.startDelete({
                    bucket: getBucket(),
                    items: [{ path: path, type: isFolder ? 'folder' : 'file' }],
                    display_names: [objectName],
                });
            } catch (error) {
                showError(I18N['msg.delete_failed'] + ': ' + error.message);
            }
        }
    );
}

// Скачивание одной папки архивом
async function downloadFolderAsArchive(folderPath) {
    if (!getBucket() || !folderPath) return;
    if (!hasPerm('download_folder')) {
        showError(I18N['files.download_folder_denied']);
        return;
    }
    showInfo(I18N['download.archive_creating'], 300000);
    const basePath = (getPath() || '').replace(/\/$/, '');
    const pathSegments = basePath.split('/').filter(Boolean);
    const parentFolder = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : 'archive';
    try {
        const res = await fetch('/files/download-archive', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bucket: getBucket(),
                paths: [],
                folders: [folderPath],
                parent_folder: parentFolder,
                base_path: basePath
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showError(err.error || I18N['download.error']);
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'archive.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        hideNotification();
    } catch (e) {
        showError(I18N['msg.download_failed'] + ': ' + (e.message || ''));
    }
}

// Кодирует S3-ключ для URL: слэши остаются разделителями (совместимо с nginx и Flask path).
function encodeS3KeyForDownloadUrl(bucketId, s3Key) {
    const key = (s3Key || '').replace(/^\/+/, '');
    const encodedKey = key.split('/').map(function (seg) {
        return encodeURIComponent(seg);
    }).join('/');
    return '/files/download/' + encodeURIComponent(bucketId) + '/' + encodedKey;
}

let _downloadPreparingDismiss = null;

function clearDownloadPreparingDismiss() {
    if (typeof _downloadPreparingDismiss === 'function') {
        _downloadPreparingDismiss();
        _downloadPreparingDismiss = null;
    }
}

// Нативное скачивание: браузер стримит ответ сервера (без fetch+blob в памяти).
function downloadFile(path) {
    if (!getBucket() || !path) return;

    clearDownloadPreparingDismiss();
    hideNotification();

    const fileName = path.split('/').pop() || 'download';
    const url = encodeS3KeyForDownloadUrl(getBucket(), path);
    showInfo(I18N['download.preparing'] || I18N['download.started_count'] || '');

    let dismissed = false;
    const dismissPreparing = function () {
        if (dismissed) return;
        dismissed = true;
        clearDownloadPreparingDismiss();
        hideNotification();
    };

    const fallbackTimer = setTimeout(dismissPreparing, 6000);

    const onWindowFocus = function () {
        setTimeout(dismissPreparing, 150);
    };
    const onWindowBlur = function () {
        window.removeEventListener('blur', onWindowBlur);
        window.addEventListener('focus', onWindowFocus, { once: true });
    };
    window.addEventListener('blur', onWindowBlur);

    const onVisibilityChange = function () {
        if (document.visibilityState === 'visible') {
            setTimeout(dismissPreparing, 150);
        }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    _downloadPreparingDismiss = function () {
        clearTimeout(fallbackTimer);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('focus', onWindowFocus);
        document.removeEventListener('visibilitychange', onVisibilityChange);
    };

    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', fileName);
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}


    global.deleteObject = deleteObject;
    global.downloadFolderAsArchive = downloadFolderAsArchive;
    global.downloadFile = downloadFile;
    global.encodeS3KeyForDownloadUrl = encodeS3KeyForDownloadUrl;
})(window);

/* ===== file-list.js ===== */
/**
 * File list: loadFiles, display/append rows, reveal helpers.
 * Depends on pagination.js, selection-mode.js, file-utils, breadcrumb, notifications,
 * and index.html bridges (__getCurrentBucket/Path, __paginationBridge, escape helpers).
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

    function setPath(value) {
        if (typeof global.__setCurrentPath === 'function') global.__setCurrentPath(value || '');
    }

    function getSelectionMode() {
        if (typeof global.__getSelectionMode === 'function') return !!global.__getSelectionMode();
        return !!global.selectionMode;
    }

    function pageState() {
        var b = global.__paginationBridge;
        if (b && typeof b.getState === 'function') return b.getState() || {};
        return {};
    }

    function getFilesLimit() {
        var n = pageState().filesLimit;
        return n != null ? n : 50;
    }

    function getPageTokens() {
        var t = pageState().filesPageStartTokens;
        return Array.isArray(t) ? t : [''];
    }

    function getIsLoading() {
        return !!pageState().isFilesPageLoading;
    }

    function setLoadedItemsCount(n) {
        var b = global.__paginationBridge;
        if (b && typeof b.setState === 'function') {
            b.setState({ loadedItemsCount: n });
        }
        global.loadedItemsCount = n;
    }

var isRevealingPendingItem = false;
var loadFilesRequestId = 0;
async function loadFiles(path = '', loadOptions = {}) {
    if (!loadOptions || typeof loadOptions !== 'object') {
        loadOptions = {};
    }
    const requestId = ++loadFilesRequestId;
    const targetBucket = getBucket();
    const requestedPage = Math.max(1, loadOptions.page || 1);
    const revealKey = window.pendingFileListReveal;

    if (!targetBucket) {
        global.showError((global.I18N || {})['msg.select_bucket_first'], 10000);
        return Promise.resolve();
    }

    const fileList = document.getElementById('fileList');
    try {
        // Декодируем путь, если он закодирован
        let decodedPath = path;
        try {
            decodedPath = decodeURIComponent(path);
        } catch (e) {
            // Если декодирование не удалось, используем исходный путь
            console.log('Path is not encoded or could not decode:', e.message);
        }

        // Скрываем прогресс загрузки при обновлении списка файлов
        if (!window.OperationJobs || !window.OperationJobs.hasActive('upload')) {
            if (window.ProgressBars) window.ProgressBars.hide('upload');
        }

        // Формируем URL с параметрами пагинации
        const pathChanged = decodedPath !== getPath() && loadOptions.page === undefined && !revealKey;
        if (pathChanged || (loadOptions.resetPagination !== false && requestedPage === 1 && !revealKey)) {
            global.resetFilesPagination();
        }

        const isPaginate = !!loadOptions.paginate;
        if (isPaginate) {
            fileList.classList.add('content-body-loading');
        } else {
            fileList.classList.remove('content-body-loading');
            fileList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-spinner fa-spin empty-state-icon"></i>
                <div>${(global.I18N || {})['files.loading_list']}</div>
            </div>
        `;
        }
        document.getElementById('filesHeader').style.display = 'grid';
        global.setFilesPaginationLoading(true);
        global.updateFilesPaginationUI();

        let url = `/files?bucket=${encodeURIComponent(targetBucket)}&prefix=${encodeURIComponent(decodedPath)}&limit=${getFilesLimit()}&page=${requestedPage}`;
        if (revealKey) {
            url += `&reveal_key=${encodeURIComponent(revealKey)}`;
        } else if (requestedPage > 1) {
            const pageToken = getPageTokens()[requestedPage - 1];
            if (!pageToken) {
                global.showError((global.I18N || {})['msg.load_files_failed']);
                fileList.classList.remove('content-body-loading');
                global.setFilesPaginationLoading(false);
                global.updateFilesPaginationUI();
                return Promise.resolve();
            }
            url += `&continuation_token=${encodeURIComponent(pageToken)}`;
        }

        console.log('loadFiles - запрос к серверу:', {
            url,
            bucketId: targetBucket,
            path: decodedPath,
            page: requestedPage,
            revealKey: revealKey || null
        });

        const response = await fetch(url, {
            credentials: 'include',
            headers: {
                'Accept': 'application/json'
            }
        });

        // Устаревший ответ (новый loadFiles уже запущен) — не трогаем UI
        if (requestId !== loadFilesRequestId) {
            return Promise.resolve();
        }

        // Проверяем, не изменился ли бакет во время запроса
        if (getBucket() !== targetBucket) {
            console.log('Bucket changed during request, ignoring response');
            fileList.classList.remove('content-body-loading');
            global.setFilesPaginationLoading(false);
            global.updateFilesPaginationUI();
            return Promise.resolve();
        }

        if (response.status === 401) {
            window.location.href = '/login';
            return Promise.resolve();
        }

        if (response.status === 403) {
            fileList.classList.remove('content-body-loading');
            global.showError((global.I18N || {})['error.access_denied'], 10000);
            // Показываем пустое состояние
            fileList.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-ban empty-state-icon empty-state-icon-error"></i>
                    <div>${(global.I18N || {})['error.access_denied']}</div>
                </div>
            `;
            document.getElementById('filesHeader').style.display = 'none';
            global.setFilesPaginationLoading(false);
            global.updateFilesPaginationUI();
            return Promise.resolve();
        }

        const data = await response.json();

        if (requestId !== loadFilesRequestId) {
            return Promise.resolve();
        }

        console.log('loadFiles - ответ от сервера:', {
            data: data,
            bucketInData: data.bucket_id,
            currentBucket: getBucket(),
            targetBucket: targetBucket,
            foldersCount: data.folders?.length || 0,
            filesCount: data.files?.length || 0,
            page: data.page
        });

        if (response.ok) {
            global.applyFilesPageTokensFromResponse(data, requestedPage);
            displayFiles(data);
            setLoadedItemsCount((data.folders?.length || 0) + (data.files?.length || 0));
            setPath(decodedPath);
            if (!loadOptions.paginate) {
                global.updateURL(getBucket(), decodedPath, false);
                global.updateBreadcrumb(decodedPath);
            }
            global.setFilesPaginationLoading(false);
            global.updateFilesPaginationUI();

            if (window.pendingFileListReveal) {
                await revealPendingFileListItem();
            }

            return Promise.resolve();
        } else {
            // Проверяем, не изменился ли бакет
            if (getBucket() !== targetBucket || requestId !== loadFilesRequestId) {
                console.log('Bucket changed during error handling, ignoring');
                return Promise.resolve();
            }

            // Для ошибок credentials показываем пустое состояние
            const errorText = data.error || (global.I18N || {})['msg.unknown_error'] || 'Unknown error';
            const isCredentialError = errorText.includes('credentials') || errorText.includes('Access Key') || errorText.includes('Отсутствуют');
            const duration = isCredentialError ? 10000 : 10000;

            fileList.classList.remove('content-body-loading');
            // ОЧИЩАЕМ СПИСОК ФАЙЛОВ ПРИ ОШИБКЕ
            fileList.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-triangle-exclamation empty-state-icon empty-state-icon-warning"></i>
                    <div>${(global.I18N || {})['msg.load_files_admin']}</div>
                </div>
            `;
            document.getElementById('filesHeader').style.display = 'none';
            global.setFilesPaginationLoading(false);
            global.updateFilesPaginationUI();

            global.showError((global.I18N || {})['msg.load_files_failed'] + ': ' + errorText, duration);
            return Promise.resolve();
        }
    } catch (error) {
        // Проверяем, не изменился ли бакет / не устарел ли запрос
        if (getBucket() !== targetBucket || requestId !== loadFilesRequestId) {
            console.log('Bucket changed during network error, ignoring');
            return Promise.resolve();
        }

        if (fileList) fileList.classList.remove('content-body-loading');
        console.error('Load files error:', error);
        const errorText = error.message;
        const isNetworkError = errorText.includes('network') || errorText.includes('Network') || errorText.includes('Failed to fetch');
        const duration = isNetworkError ? 10000 : 10000;

        // ОЧИЩАЕМ СПИСОК ФАЙЛОВ ПРИ ОШИБКЕ СЕТИ
        if (fileList) {
            fileList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-triangle-exclamation empty-state-icon empty-state-icon-warning"></i>
                    <div>${(global.I18N || {})['msg.connection_error_prefix']} ${errorText}</div>
            </div>
        `;
        }
        document.getElementById('filesHeader').style.display = 'none';
        global.setFilesPaginationLoading(false);
        global.updateFilesPaginationUI();

        global.showError((global.I18N || {})['msg.load_files_failed'] + ': ' + errorText, duration);
        return Promise.resolve();
    } finally {
        if (requestId === loadFilesRequestId && getIsLoading()) {
            global.setFilesPaginationLoading(false);
            global.updateFilesPaginationUI();
        }
    }
}
// Добавьте эту функцию после функции appendFiles
function appendMoreFiles(files) {
    const fileList = document.getElementById('fileList');

    // Если нет элементов, выходим
    if (!files || files.length === 0) return;

    // Используем DocumentFragment для пакетной вставки
    const fragment = document.createDocumentFragment();

    // Добавляем только файлы
    files.forEach(file => {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'file-item';
        fileDiv.dataset.path = file.path || '';
        fileDiv.dataset.size = file.size != null ? String(file.size) : '';
        fileDiv.dataset.lastModified = file.last_modified || '';
        const attrPath = global.escapePathForHtmlAttr(file.path);
        const safeName = global.escapeHtmlText(file.name);
        const modifiedDate = file.last_modified ? formatDate(file.last_modified) : '—';

        // Уникальный идентификатор для файла
        const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        fileDiv.innerHTML = `
            <div class="file-info">
                ${getSelectionMode() ? `
                    <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${fileId}"
                            data-path="${attrPath}" data-type="file"
                            ${global.fileCheckboxSelectDisabledAttr()}>
                        <i class="fa-solid fa-file file-icon"></i>
                        <span>${safeName}</span>
                    </label>
                ` : `
                    <i class="fa-solid fa-file file-icon"></i>
                    <span>${safeName}</span>
                `}
            </div>
            <div class="file-size">${global.formatFileSize(file.size)}</div>
            <div class="file-modified">${modifiedDate}</div>
        `;
        fragment.appendChild(fileDiv);
    });

    // Вставляем все элементы в конец списка
    if (fragment.children.length > 0) {
        fileList.appendChild(fragment);

        // Показываем заголовки окон если их еще нет
        if (document.getElementById('filesHeader').style.display === 'none') {
            document.getElementById('filesHeader').style.display = 'grid';
        }

        global.updateSelectAllContainer();
    }
}

function appendFiles(data) {
    const fileList = document.getElementById('fileList');

    // Проверяем, что это данные для текущего бакета
    if (!data) {
        console.log('displayFiles - data undefined, игнорируем');
        return;
    }

    console.log('appendFiles - начинаем добавление:', {
        totalFolders: data.folders?.length || 0,
        totalFiles: data.files?.length || 0,
        currentItems: fileList.children.length
    });

    // Удаляем сообщение о пустом состоянии если оно есть
    const emptyState = fileList.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }

    // Используем DocumentFragment для пакетной вставки
    const fragment = document.createDocumentFragment();

    // Папки - проверяем дубликаты
    if (data.folders && data.folders.length > 0) {
        data.folders.forEach(folder => {
            const attrPath = global.escapePathForHtmlAttr(folder.path);
            const safeName = global.escapeHtmlText(folder.name);

            const existingFolder = Array.from(document.querySelectorAll('.folder-item')).find(
                (el) => el.dataset.path === folder.path || el.dataset.path === folder.path + '/'
            );

            if (existingFolder) {
                console.log('appendFiles - папка уже существует, пропускаем:', folder.path);
                return;
            }

            const folderId = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            const folderDiv = document.createElement('div');
            folderDiv.className = 'folder-item';
            folderDiv.dataset.path = folder.path || '';

            global.bindFolderRowNavigation(folderDiv, folder.path);

            folderDiv.innerHTML = `
                <div class="folder-info">
                    ${getSelectionMode() ? `
                        <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${folderId}"
                            data-path="${attrPath}" data-type="folder"
                            ${global.folderCheckboxSelectDisabledAttr()}>
                            <i class="fa-solid fa-folder folder-icon"></i>
                            <span>${safeName}</span>
                        </label>
                    ` : `
                        <i class="fa-solid fa-folder folder-icon"></i>
                        <span>${safeName}</span>
                    `}
                </div>
                <div class="file-size">—</div>
                <div class="folder-modified">—</div>
            `;
            fragment.appendChild(folderDiv);
        });
    }

    // Файлы - проверяем дубликаты
    if (data.files && data.files.length > 0) {
        data.files.forEach(file => {
            const attrPath = global.escapePathForHtmlAttr(file.path);
            const safeName = global.escapeHtmlText(file.name);
            const modifiedDate = file.last_modified ? formatDate(file.last_modified) : '—';

            const existingFile = Array.from(document.querySelectorAll('.file-item')).find(
                (el) => el.dataset.path === file.path
            );

            if (existingFile) {
                console.log('appendFiles - файл уже существует, пропускаем:', file.path);
                return;
            }

            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            const fileDiv = document.createElement('div');
            fileDiv.className = 'file-item';
            fileDiv.dataset.path = file.path || '';
            fileDiv.dataset.size = file.size != null ? String(file.size) : '';
            fileDiv.dataset.lastModified = file.last_modified || '';

            fileDiv.innerHTML = `
                <div class="file-info">
                    ${getSelectionMode() ? `
                        <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${fileId}"
                            data-path="${attrPath}" data-type="file"
                            ${global.fileCheckboxSelectDisabledAttr()}>
                            <i class="fa-solid fa-file file-icon"></i>
                            <span>${safeName}</span>
                        </label>
                    ` : `
                        <i class="fa-solid fa-file file-icon"></i>
                        <span>${safeName}</span>
                    `}
                </div>
                <div class="file-size">${global.formatFileSize(file.size)}</div>
                <div class="file-modified">${modifiedDate}</div>
            `;
            fragment.appendChild(fileDiv);
        });
    }

    // Вставляем все элементы в конец списка
    if (fragment.children.length > 0) {
        fileList.appendChild(fragment);

        // Показываем заголовки окон если их еще нет
        if (document.getElementById('filesHeader').style.display === 'none') {
            document.getElementById('filesHeader').style.display = 'grid';
        }

        global.updateSelectAllContainer();
        if (getSelectionMode()) {
            global.updateItemsForSelectionMode();
            global.reconcileSelectionWithDom();
        }
    } else {
        console.log('appendFiles - не добавлено ни одного элемента');
    }
}

// Отображение файлов и папок
function displayFiles(data) {
    const fileList = document.getElementById('fileList');
    fileList.classList.remove('content-body-loading');

    // ВСЕГДА показываем заголовки колонок, даже для пустой папки
    document.getElementById('filesHeader').style.display = 'grid';

    if ((!data.folders || data.folders.length === 0) && (!data.files || data.files.length === 0)) {
        fileList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-folder-open empty-state-icon"></i>
                <div>${(global.I18N || {})['files.folder_empty']}</div>
            </div>
        `;
        return;
    }

    fileList.innerHTML = '';

    // Используем DocumentFragment для пакетной вставки
    const fragment = document.createDocumentFragment();

    // Папки
    if (data.folders && data.folders.length > 0) {
        data.folders.forEach(folder => {
            const folderDiv = document.createElement('div');
            folderDiv.className = 'folder-item';
            folderDiv.dataset.path = folder.path || '';
            const attrPath = global.escapePathForHtmlAttr(folder.path);
            const safeName = global.escapeHtmlText(folder.name);

            const folderId = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            global.bindFolderRowNavigation(folderDiv, folder.path);

            folderDiv.innerHTML = `
                <div class="folder-info">
                    ${getSelectionMode() ? `
                        <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${folderId}"
                            data-path="${attrPath}" data-type="folder"
                            ${global.folderCheckboxSelectDisabledAttr()}>
                            <i class="fa-solid fa-folder folder-icon"></i>
                            <span>${safeName}</span>
                        </label>
                    ` : `
                        <i class="fa-solid fa-folder folder-icon"></i>
                        <span>${safeName}</span>
                    `}
                </div>
                <div class="file-size">—</div>
                <div class="folder-modified">—</div>
            `;
            fragment.appendChild(folderDiv);
        });
    }

    // Файлы
    if (data.files && data.files.length > 0) {
        data.files.forEach(file => {
            const fileDiv = document.createElement('div');
            fileDiv.className = 'file-item';
            fileDiv.dataset.path = file.path || '';
            fileDiv.dataset.size = file.size != null ? String(file.size) : '';
            fileDiv.dataset.lastModified = file.last_modified || '';
            const attrPath = global.escapePathForHtmlAttr(file.path);
            const safeName = global.escapeHtmlText(file.name);
            const modifiedDate = file.last_modified ? formatDate(file.last_modified) : '—';

            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            fileDiv.innerHTML = `
                <div class="file-info">
                    ${getSelectionMode() ? `
                        <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${fileId}"
                            data-path="${attrPath}" data-type="file"
                            ${global.fileCheckboxSelectDisabledAttr()}>
                            <i class="fa-solid fa-file file-icon"></i>
                            <span>${safeName}</span>
                        </label>
                    ` : `
                        <i class="fa-solid fa-file file-icon"></i>
                        <span>${safeName}</span>
                    `}
                </div>
                <div class="file-size">${global.formatFileSize(file.size)}</div>
                <div class="file-modified">${modifiedDate}</div>
            `;
            fragment.appendChild(fileDiv);
        });
    }

    // Вставляем все элементы разом
    if (fragment.children.length > 0) {
        fileList.appendChild(fragment);
    }

    global.updateSelectAllContainer();
    if (getSelectionMode()) {
        global.updateItemsForSelectionMode();
        global.reconcileSelectionWithDom();
    }
}

// Форматирование даты
function formatDate(dateString) {
    try {
        const date = new Date(dateString);

        // Проверяем, что дата валидна
        if (isNaN(date.getTime())) {
            return '—';
        }

        // Форматируем дату в формате "DD.MM.YYYY HH:MM"
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');

        return `${day}.${month}.${year} ${hours}:${minutes}`;
    } catch (error) {
        console.error('Error formatting date:', error);
        return '—';
    }
}

function scrollProgressbarListItemIntoView(listEl, itemEl) {
    if (!listEl || !itemEl) return;
    const pad = 4;
    const listRect = listEl.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const itemTop = listEl.scrollTop + (itemRect.top - listRect.top);
    const itemBottom = itemTop + itemRect.height;
    const viewTop = listEl.scrollTop;
    const viewBottom = viewTop + listEl.clientHeight;
    if (itemBottom > viewBottom - pad) {
        const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
        listEl.scrollTop = Math.min(maxScroll, itemBottom - listEl.clientHeight + pad);
    } else if (itemTop < viewTop + pad) {
        listEl.scrollTop = Math.max(0, itemTop - pad);
    }
}

function normalizePathForListMatch(path) {
    if (!path) return '';
    let p = String(path).trim();
    if (p.endsWith('/') && p.length > 1) {
        p = p.slice(0, -1);
    }
    return p;
}

function pathsMatchForFileList(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return normalizePathForListMatch(a) === normalizePathForListMatch(b);
}

function getListItemPath(el) {
    if (!el) return '';
    return el.getAttribute('data-path') || el.dataset.path || '';
}

function parentPrefixOfItemPath(itemPath) {
    const raw = String(itemPath || '');
    if (!raw) return '';
    const withoutTrailing = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const slashIdx = withoutTrailing.lastIndexOf('/');
    if (slashIdx < 0) return '';
    return withoutTrailing.substring(0, slashIdx + 1);
}

function findFileListItemByPath(itemPath) {
    if (!itemPath) return null;

    const rows = document.querySelectorAll('#fileList .folder-item[data-path], #fileList .file-item[data-path]');
    for (const el of rows) {
        if (pathsMatchForFileList(getListItemPath(el), itemPath)) {
            return el;
        }
    }

    const targetNorm = normalizePathForListMatch(itemPath);
    const targetName = targetNorm.split('/').pop();
    if (!targetName) return null;

    const parentPrefix = parentPrefixOfItemPath(itemPath);
    const currentPrefix = typeof getPath() === 'string' ? getPath() : '';

    if (parentPrefix !== currentPrefix) {
        return null;
    }

    for (const el of rows) {
        const rowPath = getListItemPath(el);
        const rowName = normalizePathForListMatch(rowPath).split('/').pop();
        if (rowName === targetName) {
            return el;
        }
    }

    return null;
}

function highlightFileListItem(itemEl) {
    if (!itemEl) return;
    itemEl.classList.add('file-list-item-revealed');
    const fileList = document.getElementById('fileList');
    itemEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    if (fileList) {
        scrollProgressbarListItemIntoView(fileList, itemEl);
    }
    window.setTimeout(() => itemEl.classList.remove('file-list-item-revealed'), 4000);
}

async function revealPendingFileListItem() {
    const targetPath = window.pendingFileListReveal;
    if (!targetPath || isRevealingPendingItem) return;

    isRevealingPendingItem = true;
    try {
        const itemEl = findFileListItemByPath(targetPath);
        if (itemEl) {
            requestAnimationFrame(() => highlightFileListItem(itemEl));
        }
        window.pendingFileListReveal = null;
    } finally {
        isRevealingPendingItem = false;
    }
}



    global.loadFiles = loadFiles;
    global.appendMoreFiles = appendMoreFiles;
    global.appendFiles = appendFiles;
    global.displayFiles = displayFiles;
    global.formatDate = formatDate;
    global.scrollProgressbarListItemIntoView = scrollProgressbarListItemIntoView;
    global.normalizePathForListMatch = normalizePathForListMatch;
    global.pathsMatchForFileList = pathsMatchForFileList;
    global.getListItemPath = getListItemPath;
    global.parentPrefixOfItemPath = parentPrefixOfItemPath;
    global.findFileListItemByPath = findFileListItemByPath;
    global.highlightFileListItem = highlightFileListItem;
    global.revealPendingFileListItem = revealPendingFileListItem;
})(window);

/* ===== file-info.js ===== */
/**
 * Свойства файла S3: модальное окно (размер, дата, ACL) и редактирование ACL.
 */
(function () {
    'use strict';

    var S3_PERMISSIONS = ['READ', 'WRITE', 'READ_ACP', 'WRITE_ACP', 'FULL_CONTROL'];

    var _metadataRequestId = 0;
    var ACL_CACHE_TTL_MS = 120000;
    var META_CACHE_TTL_MS = 120000;
    var _aclCache = Object.create(null);
    var _aclInflight = Object.create(null);
    var _aclPreloadHoverTimer = null;
    var _metaCache = Object.create(null);
    var _metaInflight = Object.create(null);

    var _state = {
        bucketId: '',
        path: '',
        contentType: '',
        canEditAcl: false,
        serverAllowsAclEdit: false,
        aclReadable: false,
        aclGrantsPending: false,
        aclCapabilityPending: false,
        owner: null,
        grants: [],
        aclError: null,
        editingAcl: false,
        aclEditShowRows: false,
    };

    function normalizeRoleKey(role) {
        return String(role || '')
            .trim()
            .toLowerCase()
            .replace(/_/g, '.');
    }

    function getAppUser() {
        return window.fileManagerCurrentUser || window.currentUser || null;
    }

    function roleImpliesAclEdit(role) {
        var r = normalizeRoleKey(role);
        if (r === 'admin' || r === 'storage.admin' || r === 'storage.editor' || r === 'editor') return true;
        return r.indexOf('storage') >= 0 && r.indexOf('admin') >= 0;
    }

    function clientHasEditFileAclPerm() {
        if (typeof window.userHasPermission === 'function') {
            return window.userHasPermission('edit_file_acl');
        }
        var user = getAppUser();
        if (!user) return false;
        if (Array.isArray(user.permissions) && user.permissions.indexOf('edit_file_acl') >= 0) {
            return true;
        }
        return roleImpliesAclEdit(user.role);
    }

    function t(key) {
        return (window.I18N && window.I18N[key]) || key;
    }

    function escapeHtml(s) {
        if (window.S3FM && typeof window.S3FM.escapeHtml === 'function') {
            return window.S3FM.escapeHtml(s);
        }
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatFileSizeLocal(bytes) {
        if (typeof window.formatFileSize === 'function') {
            return window.formatFileSize(bytes);
        }
        var n = Number(bytes) || 0;
        if (n === 0) return '0 Bytes';
        var k = 1024;
        var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(n) / Math.log(k));
        return parseFloat((n / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatDateLocal(iso) {
        if (!iso) return '—';
        if (typeof window.formatDate === 'function') {
            return window.formatDate(iso);
        }
        try {
            return new Date(iso).toLocaleString();
        } catch (e) {
            return iso;
        }
    }

    function setField(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value != null && value !== '' ? value : '—';
    }

    function decodeUrlForDisplay(url) {
        try {
            var parsed = new URL(url);
            var decodedPath = parsed.pathname
                .split('/')
                .map(function (segment) {
                    if (!segment) return segment;
                    try {
                        return decodeURIComponent(segment);
                    } catch (e) {
                        return segment;
                    }
                })
                .join('/');
            return parsed.origin + decodedPath + parsed.search + parsed.hash;
        } catch (e) {
            return url;
        }
    }

    function setLinkField(id, url) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = '';
        if (!url) {
            el.textContent = '—';
            return;
        }
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = url;
        a.textContent = decodeUrlForDisplay(url);
        a.addEventListener('click', function (e) {
            e.preventDefault();
            window.open(url, '_blank', 'noopener,noreferrer');
        });
        el.appendChild(a);
    }

    /** Same as security.build_object_url: {endpoint}/{bucket}/{key} */
    function buildObjectUrl(bucketName, endpointUrl, objectKey) {
        var bn = String(bucketName || '').trim();
        var ep = String(endpointUrl || '').trim();
        var key = String(objectKey || '').trim().replace(/^\/+/, '');
        if (!bn || !ep || !key) return '';
        if (ep.indexOf('://') === -1) ep = 'https://' + ep;
        try {
            var parsed = new URL(ep);
            if (!parsed.protocol || !parsed.host) return '';
            var encodedBucket = encodeURIComponent(bn);
            var encodedKey = key
                .split('/')
                .map(function (part) {
                    return encodeURIComponent(part);
                })
                .join('/');
            return parsed.origin + '/' + encodedBucket + '/' + encodedKey;
        } catch (e) {
            return '';
        }
    }

    /**
     * Instant public URL from availableBuckets (no S3 round-trip).
     * null = unknown yet (keep loading); '' = disabled / unavailable (show —).
     */
    function resolveClientObjectUrl(bucketId, filePath) {
        var list = window.availableBuckets || [];
        var bucket = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].bucket_id === bucketId) {
                bucket = list[i];
                break;
            }
        }
        if (!bucket) return null;
        if (bucket.public_url_enabled !== true) {
            return bucket.public_url_enabled === false ? '' : null;
        }
        return buildObjectUrl(
            bucket.bucket_name || bucket.name,
            bucket.endpoint_url,
            filePath
        );
    }

    function normalizeOwner(acl) {
        if (!acl || !acl.owner) return null;
        var o = acl.owner;
        if (typeof o === 'string') {
            return { id: '', display_name: o };
        }
        return {
            id: (o.id || '').trim(),
            display_name: (o.display_name || o.id || '—').trim(),
        };
    }

    function cloneGrants(grants) {
        return (grants || []).map(function (g) {
            return {
                permission: g.permission || '',
                grantee_type: g.grantee_type || 'CanonicalUser',
                grantee_preset: g.grantee_preset || 'canonical_user',
                grantee_uri: g.grantee_uri || '',
                grantee_id: g.grantee_id || '',
                grantee_label: g.grantee_label || '',
            };
        });
    }

    function setAclFooterMode(editing) {
        var editBtn = document.getElementById('fileInfoEditAclBtn');
        var applyBtn = document.getElementById('fileInfoApplyAclBtn');
        var cancelBtn = document.getElementById('fileInfoCancelAclBtn');
        var addBtn = document.getElementById('fileInfoAclAddRow');
        var closeBtn = document.getElementById('fileInfoCloseBtn');
        var previewBtn = document.getElementById('fileInfoPreviewBtn');
        var mayEditAtAppLevel = clientHasEditFileAclPerm() || _state.serverAllowsAclEdit;
        var aclActionsDisabled = _state.aclCapabilityPending || !_state.canEditAcl;

        if (editBtn) {
            editBtn.classList.toggle('hidden', editing || !mayEditAtAppLevel);
            editBtn.disabled = aclActionsDisabled;
        }
        if (applyBtn) {
            applyBtn.classList.toggle('hidden', !editing || !mayEditAtAppLevel);
            applyBtn.disabled = aclActionsDisabled;
        }
        if (cancelBtn) cancelBtn.classList.toggle('hidden', !editing);
        if (addBtn) addBtn.classList.toggle('hidden', !editing);
        if (closeBtn) closeBtn.classList.toggle('hidden', editing);
        if (previewBtn && editing) {
            previewBtn.classList.add('hidden');
        } else if (previewBtn && !editing && typeof window.updateFileInfoPreviewButton === 'function') {
            window.updateFileInfoPreviewButton(_state.path, _state.contentType);
        }
    }

    function handleFileInfoEditAclClick() {
        enterAclEditMode();
    }

    function handleFileInfoApplyAclClick() {
        saveAcl();
    }

    function sortDropdownOptionsByLabel(options) {
        return options.slice().sort(function (a, b) {
            return String(a.label || '').localeCompare(String(b.label || ''), undefined, {
                sensitivity: 'base',
            });
        });
    }

    function getGranteeDropdownOptions() {
        return sortDropdownOptionsByLabel([
            { value: 'canonical_user', label: t('files.info_acl_grantee_canonical') },
            { value: 'all_users', label: t('files.info_acl_grantee_all_users') },
            { value: 'authenticated_users', label: t('files.info_acl_grantee_auth_users') },
        ]);
    }

    function getPermDropdownOptions() {
        return sortDropdownOptionsByLabel(
            S3_PERMISSIONS.map(function (p) {
                return { value: p, label: p };
            }),
        );
    }

    function defaultAclEditRowGrant() {
        return {
            permission: 'READ',
            grantee_preset: 'all_users',
            grantee_id: '',
        };
    }

    function aclDropdownLabel(options, value) {
        var found = options.filter(function (o) {
            return o.value === value;
        })[0];
        return (found && found.label) || value || '—';
    }

    function buildAclDropdownHtml(id, role, options, value) {
        var label = aclDropdownLabel(options, value);
        var items = options
            .map(function (opt) {
                var sel = opt.value === value ? ' selected' : '';
                return (
                    '<button type="button" class="dropdown-item' +
                    sel +
                    '" data-value="' +
                    escapeHtml(opt.value) +
                    '" role="option">' +
                    escapeHtml(opt.label) +
                    '</button>'
                );
            })
            .join('');
        return (
            '<div class="dropdown dropdown-acl" id="' +
            escapeHtml(id) +
            '" data-acl-role="' +
            escapeHtml(role) +
            '">' +
            '<button type="button" class="dropdown-trigger" aria-expanded="false" aria-haspopup="listbox">' +
            '<span class="has-selection">' +
            escapeHtml(label) +
            '</span>' +
            '<i class="fa-solid fa-chevron-down dropdown-icon"></i></button>' +
            '<div class="dropdown-menu hidden" role="listbox">' +
            items +
            '</div>' +
            '<input type="hidden" class="dropdown-value" value="' +
            escapeHtml(value) +
            '">' +
            '</div>'
        );
    }

    function closeAllFileInfoAclDropdowns() {
        var modal = document.getElementById('fileInfoModal');
        if (!modal) return;
        modal.querySelectorAll('.dropdown-acl.open').forEach(function (wrap) {
            wrap.classList.remove('open');
            if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
        });
    }

    function setAclDropdownValue(wrap, value, label) {
        var hidden = wrap.querySelector('.dropdown-value');
        var labelEl = wrap.querySelector('.dropdown-trigger span');
        if (hidden) hidden.value = value;
        if (labelEl) {
            labelEl.textContent = label;
            labelEl.classList.add('has-selection');
        }
        wrap.querySelectorAll('.dropdown-item').forEach(function (item) {
            item.classList.toggle('selected', item.getAttribute('data-value') === value);
        });
    }

    function setupFileInfoAclDropdown(wrap, onChange) {
        var trigger = wrap.querySelector('.dropdown-trigger');
        var menu = wrap.querySelector('.dropdown-menu');
        if (!trigger || !menu) return;

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = !wrap.classList.contains('open');
            closeAllFileInfoAclDropdowns();
            if (willOpen) {
                wrap.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
                menu.classList.remove('hidden');
                if (typeof window.fitDropdownMenuOverlay === 'function') window.fitDropdownMenuOverlay(wrap);
            }
        });

        menu.querySelectorAll('.dropdown-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                var value = item.getAttribute('data-value') || '';
                var label = (item.textContent || '').trim();
                setAclDropdownValue(wrap, value, label);
                wrap.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
                if (typeof onChange === 'function') onChange(value, wrap);
            });
        });
    }

    function initFileInfoAclDropdowns(root) {
        if (!root) return;
        root.querySelectorAll('.dropdown-acl').forEach(function (wrap) {
            if (wrap._aclDdBound) return;
            wrap._aclDdBound = true;
            setupFileInfoAclDropdown(wrap, function (value) {
                if (wrap.getAttribute('data-acl-role') !== 'grantee') return;
                var row = wrap.closest('.file-info-acl-edit-row');
                var idInput = row && row.querySelector('.file-info-acl-grantee-id');
                if (!idInput) return;
                if (value === 'canonical_user') {
                    idInput.classList.remove('hidden');
                } else {
                    idInput.classList.add('hidden');
                    idInput.value = '';
                }
            });
        });
    }

    function getAclDropdownValue(wrap) {
        if (!wrap) return '';
        var hidden = wrap.querySelector('.dropdown-value');
        return hidden ? hidden.value : '';
    }

    function applyAclCapabilityFlags(data) {
        data = data || {};
        _state.serverAllowsAclEdit = !!data.can_edit_acl;
        _state.canEditAcl = !!(data.can_edit_acl && data.can_put_object_acl);
        _state.aclCapabilityPending = false;
    }

    function aclCacheKey(bucketId, path) {
        return String(bucketId) + '\x00' + String(path);
    }

    function getAclCacheEntry(bucketId, path) {
        var entry = _aclCache[aclCacheKey(bucketId, path)];
        if (!entry) return null;
        if (Date.now() - entry.at > ACL_CACHE_TTL_MS) {
            delete _aclCache[aclCacheKey(bucketId, path)];
            return null;
        }
        return entry;
    }

    function putAclCacheEntry(bucketId, path, update) {
        var key = aclCacheKey(bucketId, path);
        var entry = _aclCache[key] || { at: 0, acl: null, capability: null };
        if (update.acl !== undefined) entry.acl = update.acl;
        if (update.capability !== undefined) entry.capability = update.capability;
        entry.at = Date.now();
        _aclCache[key] = entry;
        return entry;
    }

    function invalidateAclCache(bucketId, path) {
        var key = aclCacheKey(bucketId, path);
        delete _aclCache[key];
        delete _aclInflight[key];
    }

    function aclCacheReady(entry) {
        if (!entry || !entry.acl) return false;
        if (clientHasEditFileAclPerm() && !entry.capability) return false;
        return true;
    }

    function fetchJson(url) {
        return fetch(url, { credentials: 'include' }).then(function (r) {
            return r.json().then(function (data) {
                return { ok: r.ok, data: data };
            });
        });
    }

    function applyAclBundle(entry) {
        if (!entry) return;
        if (entry.acl) {
            if (entry.acl.ok) {
                applyAclGrantsPayload(entry.acl.data || {});
            } else {
                _state.aclGrantsPending = false;
                _state.aclReadable = false;
                _state.aclError =
                    (entry.acl.data && entry.acl.data.error) || t('error.unexpected');
            }
        }
        if (entry.capability) {
            if (entry.capability.ok) {
                applyAclCapabilityFlags(entry.capability.data || {});
            } else {
                _state.canEditAcl = false;
                _state.aclCapabilityPending = false;
            }
        }
        renderAclView();
        setAclFooterMode(_state.editingAcl);
    }

    function fetchAclBundle(bucketId, path) {
        var key = aclCacheKey(bucketId, path);
        if (_aclInflight[key]) return _aclInflight[key];

        var cached = getAclCacheEntry(bucketId, path);
        if (aclCacheReady(cached)) {
            return Promise.resolve(cached);
        }

        var q =
            '?bucket=' + encodeURIComponent(bucketId) + '&path=' + encodeURIComponent(path);
        var fetches = [fetchJson('/api/files/metadata/acl' + q)];
        if (clientHasEditFileAclPerm()) {
            fetches.push(fetchJson('/api/files/metadata/acl-capability' + q));
        }

        _aclInflight[key] = Promise.all(fetches)
            .then(function (results) {
                var entry = {
                    acl: results[0],
                    capability: clientHasEditFileAclPerm() ? results[1] : null,
                };
                putAclCacheEntry(bucketId, path, entry);
                delete _aclInflight[key];
                return entry;
            })
            .catch(function (err) {
                delete _aclInflight[key];
                throw err;
            });
        return _aclInflight[key];
    }

    function renderAclGrantsSkeleton() {
        var container = document.getElementById('fileInfoAclGrants');
        if (!container) return;
        var row =
            '<div class="modal-field file-info-acl-row file-info-acl-row-skeleton">' +
            '<span class="user-info-value file-info-acl-col-user">&nbsp;</span>' +
            '<span class="user-info-value file-info-acl-col-perm">&nbsp;</span></div>';
        container.innerHTML = row + row + row;
    }

    function applyAclGrantsPayload(data) {
        data = data || {};
        applyAclFromResponse(data);
        _state.aclReadable = !!(data.acl_readable || (data.acl && !data.acl_error));
        _state.aclGrantsPending = false;
    }

    function renderAclView() {
        var container = document.getElementById('fileInfoAclGrants');
        if (!container) return;
        if (_state.aclError) {
            container.innerHTML =
                '<div class="file-info-acl-message">' + escapeHtml(_state.aclError) + '</div>';
            return;
        }
        if (!_state.grants.length) {
            container.innerHTML =
                '<div class="file-info-acl-message">' + escapeHtml(t('files.info_acl_empty')) + '</div>';
            return;
        }
        var html = '';
        _state.grants.forEach(function (g) {
            html +=
                '<div class="modal-field file-info-acl-row">' +
                '<span class="user-info-value file-info-acl-col-user">' +
                escapeHtml(g.grantee_label || g.grantee || '—') +
                '</span>' +
                '<span class="user-info-value file-info-acl-col-perm">' +
                escapeHtml(g.permission || '—') +
                '</span></div>';
        });
        container.innerHTML = html;
    }

    function removeAclEditRow(row) {
        var rows = document.getElementById('fileInfoAclEditRows');
        if (!row || !rows) return;
        row.remove();
        if (!rows.querySelectorAll('.file-info-acl-edit-row').length) {
            _state.grants = [];
            _state.aclEditShowRows = false;
            renderAclEdit();
        }
    }

    function ensureAclEditRemoveDelegation() {
        var container = document.getElementById('fileInfoAclGrants');
        if (!container || container._aclRemoveDelegated) return;
        container._aclRemoveDelegated = true;
        container.addEventListener('click', function (e) {
            var btn = e.target.closest('.file-info-acl-remove');
            if (!btn || !_state.editingAcl) return;
            e.preventDefault();
            e.stopPropagation();
            var row = btn.closest('.file-info-acl-edit-row');
            if (row) removeAclEditRow(row);
        });
    }

    function addAclEditRow() {
        var container = document.getElementById('fileInfoAclGrants');
        if (!_state.aclEditShowRows) {
            _state.aclEditShowRows = true;
            if (container && !_state.grants.length) {
                container.innerHTML = '<div id="fileInfoAclEditRows"></div>';
            } else {
                renderAclEdit();
            }
        }
        var rows = document.getElementById('fileInfoAclEditRows');
        if (!rows) return;
        var idx = rows.querySelectorAll('.file-info-acl-edit-row').length;
        var div = document.createElement('div');
        div.innerHTML = aclEditRowHtml(defaultAclEditRowGrant(), idx);
        var row = div.firstElementChild;
        rows.appendChild(row);
        initFileInfoAclDropdowns(row);
    }

    function renderAclEdit() {
        var container = document.getElementById('fileInfoAclGrants');
        if (!container) return;
        if (!_state.grants.length && !_state.aclEditShowRows) {
            container.innerHTML =
                '<div class="file-info-acl-message">' + escapeHtml(t('files.info_acl_empty')) + '</div>';
            return;
        }
        var html = '<div id="fileInfoAclEditRows">';
        (_state.grants || []).forEach(function (g, idx) {
            html += aclEditRowHtml(g, idx);
        });
        html += '</div>';
        container.innerHTML = html;
        initFileInfoAclDropdowns(container);
    }

    function aclEditRowHtml(g, idx) {
        g = g || defaultAclEditRowGrant();
        var granteeOpts = getGranteeDropdownOptions();
        var permOpts = getPermDropdownOptions();
        var defaults = defaultAclEditRowGrant();
        var preset =
            g.grantee_preset && granteeOpts.some(function (o) {
                return o.value === g.grantee_preset;
            })
                ? g.grantee_preset
                : defaults.grantee_preset;
        var perm =
            g.permission && permOpts.some(function (o) {
                return o.value === g.permission;
            })
                ? g.permission
                : defaults.permission;
        return (
            '<div class="modal-field file-info-acl-edit-row" data-row="' +
            idx +
            '">' +
            '<div class="file-info-acl-grantee-cell">' +
            buildAclDropdownHtml('fileInfoAclGranteeDd_' + idx, 'grantee', granteeOpts, preset) +
            '<input type="text" class="search-input file-info-acl-grantee-id' +
            (preset === 'canonical_user' ? '' : ' hidden') +
            '" placeholder="' +
            escapeHtml(t('files.info_acl_grantee_id_placeholder')) +
            '" value="' +
            escapeHtml(g.grantee_id || '') +
            '">' +
            '</div>' +
            buildAclDropdownHtml('fileInfoAclPermDd_' + idx, 'permission', permOpts, perm) +
            '<button type="button" class="btn icon-btn delete file-info-acl-remove" title="' +
            escapeHtml(t('files.info_acl_remove_grant')) +
            '" aria-label="' +
            escapeHtml(t('files.info_acl_remove_grant')) +
            '"><i class="fa-solid fa-trash-can"></i></button></div>'
        );
    }

    function collectGrantsFromForm() {
        var rows = document.querySelectorAll('#fileInfoAclEditRows .file-info-acl-edit-row');
        var grants = [];
        rows.forEach(function (row) {
            var granteeDd = row.querySelector('[data-acl-role="grantee"]');
            var permDd = row.querySelector('[data-acl-role="permission"]');
            var perm = getAclDropdownValue(permDd);
            var preset = getAclDropdownValue(granteeDd) || 'canonical_user';
            var gid = (row.querySelector('.file-info-acl-grantee-id') || {}).value || '';
            grants.push({
                permission: perm,
                grantee_preset: preset,
                grantee_id: preset === 'canonical_user' ? gid.trim() : '',
                grantee_uri: '',
            });
        });
        return grants;
    }

    function applyAclFromResponse(data) {
        if (data.acl) {
            _state.owner = normalizeOwner(data.acl);
            _state.grants = cloneGrants(data.acl.grants);
            _state.aclError = null;
        } else if (data.acl_error) {
            _state.aclError = data.acl_error;
            _state.grants = [];
        }
    }

    function enterAclEditMode() {
        if (_state.aclGrantsPending || !_state.canEditAcl || _state.aclError) return;
        _state.editingAcl = true;
        _state.aclEditShowRows = _state.grants.length > 0;
        setAclFooterMode(true);
        renderAclEdit();
    }

    function exitAclEditMode() {
        _state.editingAcl = false;
        _state.aclEditShowRows = false;
        closeAllFileInfoAclDropdowns();
        setAclFooterMode(false);
        renderAclView();
    }

    function validateGrantsBeforeSave(grants) {
        for (var i = 0; i < grants.length; i++) {
            var g = grants[i];
            if (g.grantee_preset === 'canonical_user' && !g.grantee_id) {
                return t('files.info_acl_grantee_id_required');
            }
        }
        return '';
    }

    function saveAcl() {
        if (!_state.bucketId || !_state.path) {
            if (typeof window.showError === 'function') {
                window.showError(t('files.info_acl_context_missing'));
            }
            return;
        }
        var grants = collectGrantsFromForm();
        var validationError = validateGrantsBeforeSave(grants);
        if (validationError) {
            if (typeof window.showError === 'function') {
                window.showError(validationError);
            }
            return;
        }
        var applyBtn = document.getElementById('fileInfoApplyAclBtn');
        if (applyBtn) applyBtn.disabled = true;

        fetch('/api/files/metadata/acl', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bucket: _state.bucketId,
                path: _state.path,
                owner: _state.owner
                    ? {
                          id: _state.owner.id || '',
                          display_name: _state.owner.display_name || '',
                      }
                    : {},
                grants: grants,
            }),
        })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            })
            .then(function (res) {
                if (!res.ok) {
                    if (typeof window.showError === 'function') {
                        window.showError((res.data && res.data.error) || t('error.unexpected'));
                    }
                    return;
                }
                var saved = res.data || {};
                applyAclFromResponse(saved);
                _state.editingAcl = false;
                _state.aclEditShowRows = false;
                setAclFooterMode(false);
                renderAclView();
                invalidateAclCache(_state.bucketId, _state.path);
                putAclCacheEntry(_state.bucketId, _state.path, {
                    acl: {
                        ok: true,
                        data: {
                            acl: saved.acl,
                            acl_error: saved.acl_error,
                            acl_readable: !!(saved.acl && !saved.acl_error),
                        },
                    },
                });
                if (typeof window.showSuccess === 'function') {
                    window.showSuccess((saved && saved.message) || t('files.info_acl_saved'));
                }
            })
            .catch(function () {
                if (typeof window.showError === 'function') {
                    window.showError(t('msg.network_error'));
                }
            })
            .finally(function () {
                if (applyBtn) applyBtn.disabled = false;
            });
    }

    function resetAclUiState() {
        closeAllFileInfoAclDropdowns();
        _state.canEditAcl = false;
        _state.serverAllowsAclEdit = false;
        _state.aclReadable = false;
        _state.aclGrantsPending = false;
        _state.aclCapabilityPending = false;
        _state.owner = null;
        _state.grants = [];
        _state.aclError = null;
        _state.editingAcl = false;
        _state.aclEditShowRows = false;
        setAclFooterMode(false);
    }

    function resetFileInfoState() {
        _state.bucketId = '';
        _state.path = '';
        _state.contentType = '';
        resetAclUiState();
        if (typeof window.updateFileInfoPreviewButton === 'function') {
            window.updateFileInfoPreviewButton('', '');
        }
    }

    function applyFileInfoMainFields(data, filePath, fileName) {
        document.getElementById('fileInfoModalTitle').textContent = t('files.info_title');
        setField('fileInfoName', (data && data.name) || fileName || '—');
        if (data && data.size != null) {
            setField('fileInfoSize', formatFileSizeLocal(data.size));
        }
        var contentType =
            (data && data.content_type && String(data.content_type).trim()) || '';
        _state.contentType = contentType;
        setField('fileInfoContentType', contentType || '—');
        if (data && data.last_modified) {
            setField('fileInfoModified', formatDateLocal(data.last_modified));
        }
        if (data && data.created_at) {
            setField('fileInfoCreated', formatDateLocal(data.created_at));
        } else {
            setField('fileInfoCreated', '—');
        }
        setField('fileInfoModifiedBy', (data && data.modified_by) || '—');
        setLinkField('fileInfoUrl', (data && data.object_url) || '');
        if (typeof window.updateFileInfoPreviewButton === 'function') {
            window.updateFileInfoPreviewButton(filePath || _state.path, contentType);
        }
    }

    function metaCacheKey(bucketId, path) {
        return String(bucketId || '') + '\0' + String(path || '');
    }

    function getMetaCacheEntry(bucketId, path) {
        var key = metaCacheKey(bucketId, path);
        var entry = _metaCache[key];
        if (!entry) return null;
        if (Date.now() - entry.at > META_CACHE_TTL_MS) {
            delete _metaCache[key];
            return null;
        }
        return entry.data || null;
    }

    function setMetaCacheEntry(bucketId, path, data) {
        _metaCache[metaCacheKey(bucketId, path)] = {
            at: Date.now(),
            data: data || null,
        };
    }

    function guessContentTypeFromPath(filePath) {
        var name = String(filePath || '').split('/').pop() || '';
        var dot = name.lastIndexOf('.');
        if (dot < 0) return '';
        var ext = name.slice(dot + 1).toLowerCase();
        var map = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
            bmp: 'image/bmp',
            ico: 'image/x-icon',
            pdf: 'application/pdf',
            txt: 'text/plain',
            md: 'text/markdown',
            csv: 'text/csv',
            json: 'application/json',
            xml: 'application/xml',
            html: 'text/html',
            htm: 'text/html',
            css: 'text/css',
            js: 'text/javascript',
            mjs: 'text/javascript',
            ts: 'text/typescript',
            zip: 'application/zip',
            gz: 'application/gzip',
            tar: 'application/x-tar',
            mp4: 'video/mp4',
            webm: 'video/webm',
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        };
        return map[ext] || '';
    }

    function fetchFileMetadata(bucketId, path) {
        var key = metaCacheKey(bucketId, path);
        var cached = getMetaCacheEntry(bucketId, path);
        if (cached) return Promise.resolve(cached);
        if (_metaInflight[key]) return _metaInflight[key];

        var url =
            '/api/files/metadata?bucket=' +
            encodeURIComponent(bucketId) +
            '&path=' +
            encodeURIComponent(path);

        _metaInflight[key] = fetch(url, { credentials: 'include' })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            })
            .then(function (res) {
                delete _metaInflight[key];
                if (!res.ok) {
                    var err = new Error((res.data && res.data.error) || t('error.unexpected'));
                    err.payload = res.data;
                    throw err;
                }
                var data = res.data || {};
                setMetaCacheEntry(bucketId, path, data);
                return data;
            })
            .catch(function (err) {
                delete _metaInflight[key];
                throw err;
            });

        return _metaInflight[key];
    }

    function applyFileInfoFromHints(fileName, filePath, hints, bucketId) {
        setField('fileInfoName', fileName || '—');
        if (hints && hints.sizeLabel) {
            setField('fileInfoSize', hints.sizeLabel);
        } else if (hints && hints.size != null && !isNaN(Number(hints.size))) {
            setField('fileInfoSize', formatFileSizeLocal(hints.size));
        } else {
            setField('fileInfoSize', '—');
        }
        var guessed = guessContentTypeFromPath(filePath);
        _state.contentType = guessed;
        setField('fileInfoContentType', guessed || '—');
        if (hints && hints.modifiedLabel) {
            setField('fileInfoModified', hints.modifiedLabel);
        } else if (hints && hints.lastModified) {
            setField('fileInfoModified', formatDateLocal(hints.lastModified));
        } else {
            setField('fileInfoModified', '—');
        }
        setField('fileInfoCreated', '—');
        setField('fileInfoModifiedBy', '—');
        var clientUrl = resolveClientObjectUrl(bucketId, filePath);
        if (clientUrl === null) {
            setField('fileInfoUrl', '—');
        } else {
            setLinkField('fileInfoUrl', clientUrl);
        }
        if (typeof window.updateFileInfoPreviewButton === 'function') {
            window.updateFileInfoPreviewButton(filePath || '', guessed);
        }
    }

    window.fileInfoCurrentPath = function () {
        return _state.path || '';
    };
    window.fileInfoCurrentBucketId = function () {
        return _state.bucketId || '';
    };
    window.fileInfoCurrentContentType = function () {
        return _state.contentType || '';
    };

    function fileInfoHintsFromItem(fileItem) {
        if (!fileItem) return null;
        var sizeEl = fileItem.querySelector('.file-size');
        var modEl = fileItem.querySelector('.file-modified');
        var sizeLabel = sizeEl ? (sizeEl.textContent || '').trim() : '';
        var modifiedLabel = modEl ? (modEl.textContent || '').trim() : '';
        if (!sizeLabel && !modifiedLabel && !fileItem.dataset.size && !fileItem.dataset.lastModified) {
            return null;
        }
        return {
            size: fileItem.dataset.size ? Number(fileItem.dataset.size) : null,
            sizeLabel: sizeLabel || null,
            lastModified: fileItem.dataset.lastModified || null,
            modifiedLabel: modifiedLabel || null,
        };
    }

    function showFileInfoLoading(fileName, filePath, hints, bucketId, cachedData) {
        var modal = document.getElementById('fileInfoModal');
        if (!modal) return;
        resetAclUiState();
        _state.aclGrantsPending = true;
        _state.aclCapabilityPending = clientHasEditFileAclPerm();
        if (clientHasEditFileAclPerm()) {
            _state.serverAllowsAclEdit = true;
        }
        setAclFooterMode(false);
        document.getElementById('fileInfoModalTitle').textContent = t('files.info_title');
        if (cachedData) {
            applyFileInfoMainFields(cachedData, filePath, fileName);
            // Public URL from client if server returned empty (flag off or missing)
            if (!(cachedData.object_url || '').trim()) {
                var clientUrl = resolveClientObjectUrl(bucketId, filePath);
                if (clientUrl !== null) setLinkField('fileInfoUrl', clientUrl);
            }
        } else {
            applyFileInfoFromHints(fileName, filePath, hints, bucketId);
        }
        renderAclGrantsSkeleton();
        modal.style.display = 'flex';
    }

    function applyCachedAclIfReady(bucketId, path) {
        var entry = getAclCacheEntry(bucketId, path);
        if (!aclCacheReady(entry)) return false;
        applyAclBundle(entry);
        return true;
    }

    function renderAclGrants(acl, aclError) {
        _state.aclError = aclError || null;
        if (acl) {
            _state.owner = normalizeOwner(acl);
            _state.grants = cloneGrants(acl.grants);
        }
        if (_state.editingAcl) {
            renderAclEdit();
        } else {
            renderAclView();
        }
    }

    window.hideFileInfoModal = function () {
        var modal = document.getElementById('fileInfoModal');
        if (modal) modal.style.display = 'none';
        resetFileInfoState();
    };

    window.showFileInfoModal = function (filePath, hints) {
        filePath = (filePath || '').trim();
        var bucketId = window.fileManagerCurrentBucketId || window.currentBucket || '';
        if (!bucketId || !filePath) return;

        _state.bucketId = bucketId;
        _state.path = filePath;

        var fileName = filePath.split('/').pop() || filePath;
        var requestId = ++_metadataRequestId;
        var cachedMeta = getMetaCacheEntry(bucketId, filePath);
        showFileInfoLoading(fileName, filePath, hints, bucketId, cachedMeta);
        applyCachedAclIfReady(bucketId, filePath);

        fetchFileMetadata(bucketId, filePath)
            .then(function (data) {
                if (requestId !== _metadataRequestId) return;
                applyFileInfoMainFields(data || {}, filePath, fileName);
                if (!(data && data.object_url)) {
                    var clientUrl = resolveClientObjectUrl(bucketId, filePath);
                    if (clientUrl !== null) setLinkField('fileInfoUrl', clientUrl);
                }
            })
            .catch(function (err) {
                if (requestId !== _metadataRequestId) return;
                // Keep hint/client fields if request failed after open; only hard-fail when nothing useful shown
                if (!cachedMeta && !(hints && (hints.sizeLabel || hints.modifiedLabel))) {
                    window.hideFileInfoModal();
                    if (typeof window.showError === 'function') {
                        window.showError((err && err.message) || t('msg.network_error'));
                    }
                }
            });

        fetchAclBundle(bucketId, filePath)
            .then(function (entry) {
                if (requestId !== _metadataRequestId) return;
                applyAclBundle(entry);
            })
            .catch(function () {
                if (requestId !== _metadataRequestId) return;
                _state.aclGrantsPending = false;
                _state.aclReadable = false;
                _state.aclError = t('msg.network_error');
                renderAclView();
                setAclFooterMode(false);
            });
    };

    function preloadFileInfoMetadata(fileItemOrPath) {
        var path =
            typeof fileItemOrPath === 'string'
                ? String(fileItemOrPath || '').trim()
                : ((fileItemOrPath && fileItemOrPath.dataset && fileItemOrPath.dataset.path) || '').trim();
        var bucketId = window.fileManagerCurrentBucketId || window.currentBucket || '';
        if (!bucketId || !path || path.endsWith('/')) return;
        if (getMetaCacheEntry(bucketId, path)) return;
        fetchFileMetadata(bucketId, path).catch(function () {});
    }

    function preloadFileInfoAcl(fileItem) {
        if (!fileItem) return;
        var path = (fileItem.dataset.path || '').trim();
        var bucketId = window.fileManagerCurrentBucketId || window.currentBucket || '';
        if (!bucketId || !path) return;
        var cached = getAclCacheEntry(bucketId, path);
        if (aclCacheReady(cached)) return;
        fetchAclBundle(bucketId, path).catch(function () {});
    }

    function preloadFileInfo(fileItem) {
        if (!fileItem) return;
        preloadFileInfoAcl(fileItem);
        preloadFileInfoMetadata(fileItem);
    }

    function scheduleAclPreloadOnHover(fileItem) {
        if (!fileItem) return;
        clearTimeout(_aclPreloadHoverTimer);
        _aclPreloadHoverTimer = setTimeout(function () {
            preloadFileInfo(fileItem);
        }, 150);
    }

    window.preloadFileInfoForPath = function (filePath) {
        preloadFileInfoMetadata(filePath);
        var bucketId = window.fileManagerCurrentBucketId || window.currentBucket || '';
        var path = String(filePath || '').trim();
        if (!bucketId || !path) return;
        var cached = getAclCacheEntry(bucketId, path);
        if (!aclCacheReady(cached)) {
            fetchAclBundle(bucketId, path).catch(function () {});
        }
    };

    /* --- Bulk ACL for multi-select --- */
    var _bulkState = {
        paths: [],
        bucketId: '',
        canPut: false,
        capabilityPending: false,
        grants: [],
        aclEditShowRows: false,
    };

    function closeAllBulkAclDropdowns() {
        var modal = document.getElementById('bulkAclModal');
        if (!modal) return;
        modal.querySelectorAll('.dropdown-acl.open').forEach(function (wrap) {
            wrap.classList.remove('open');
            if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
        });
    }

    function bulkAclEditRowHtml(g, idx) {
        g = g || defaultAclEditRowGrant();
        var granteeOpts = getGranteeDropdownOptions();
        var permOpts = getPermDropdownOptions();
        var defaults = defaultAclEditRowGrant();
        var preset =
            g.grantee_preset && granteeOpts.some(function (o) {
                return o.value === g.grantee_preset;
            })
                ? g.grantee_preset
                : defaults.grantee_preset;
        var perm =
            g.permission && permOpts.some(function (o) {
                return o.value === g.permission;
            })
                ? g.permission
                : defaults.permission;
        return (
            '<div class="modal-field file-info-acl-edit-row" data-row="' +
            idx +
            '">' +
            '<div class="file-info-acl-grantee-cell">' +
            buildAclDropdownHtml('bulkAclGranteeDd_' + idx, 'grantee', granteeOpts, preset) +
            '<input type="text" class="search-input file-info-acl-grantee-id' +
            (preset === 'canonical_user' ? '' : ' hidden') +
            '" placeholder="' +
            escapeHtml(t('files.info_acl_grantee_id_placeholder')) +
            '" value="' +
            escapeHtml(g.grantee_id || '') +
            '">' +
            '</div>' +
            buildAclDropdownHtml('bulkAclPermDd_' + idx, 'permission', permOpts, perm) +
            '<button type="button" class="btn icon-btn delete file-info-acl-remove" title="' +
            escapeHtml(t('files.info_acl_remove_grant')) +
            '" aria-label="' +
            escapeHtml(t('files.info_acl_remove_grant')) +
            '"><i class="fa-solid fa-trash-can"></i></button></div>'
        );
    }

    function bulkRenderAclEdit() {
        var container = document.getElementById('bulkAclGrants');
        if (!container) return;
        if (!_bulkState.grants.length && !_bulkState.aclEditShowRows) {
            container.innerHTML =
                '<div class="file-info-acl-message">' + escapeHtml(t('files.info_acl_empty')) + '</div>';
            return;
        }
        var html = '<div id="bulkAclEditRows">';
        (_bulkState.grants || []).forEach(function (g, idx) {
            html += bulkAclEditRowHtml(g, idx);
        });
        html += '</div>';
        container.innerHTML = html;
        initFileInfoAclDropdowns(container);
    }

    function bulkRemoveAclEditRow(row) {
        var rows = document.getElementById('bulkAclEditRows');
        if (!row || !rows) return;
        row.remove();
        if (!rows.querySelectorAll('.file-info-acl-edit-row').length) {
            _bulkState.grants = [];
            _bulkState.aclEditShowRows = false;
            bulkRenderAclEdit();
        }
    }

    function bulkAddAclEditRow() {
        if (!_bulkState.aclEditShowRows) {
            _bulkState.aclEditShowRows = true;
            bulkRenderAclEdit();
        }
        var rows = document.getElementById('bulkAclEditRows');
        if (!rows) return;
        var idx = rows.querySelectorAll('.file-info-acl-edit-row').length;
        var div = document.createElement('div');
        div.innerHTML = bulkAclEditRowHtml(defaultAclEditRowGrant(), idx);
        var row = div.firstElementChild;
        rows.appendChild(row);
        initFileInfoAclDropdowns(row);
    }

    function bulkCollectGrantsFromForm() {
        var rows = document.querySelectorAll('#bulkAclEditRows .file-info-acl-edit-row');
        var grants = [];
        rows.forEach(function (row) {
            var granteeDd = row.querySelector('[data-acl-role="grantee"]');
            var permDd = row.querySelector('[data-acl-role="permission"]');
            var perm = getAclDropdownValue(permDd);
            var preset = getAclDropdownValue(granteeDd) || 'canonical_user';
            var gid = (row.querySelector('.file-info-acl-grantee-id') || {}).value || '';
            grants.push({
                permission: perm,
                grantee_preset: preset,
                grantee_id: preset === 'canonical_user' ? gid.trim() : '',
                grantee_uri: '',
            });
        });
        return grants;
    }

    function getSelectedFilePathsFromSelection() {
        return getSelectedItemsFromSelection().files;
    }

    function normalizeBulkAclSelection(overrideItems) {
        if (overrideItems == null) return null;
        if (typeof overrideItems === 'string') {
            var single = String(overrideItems).trim();
            return single ? { files: [single], folders: [] } : { files: [], folders: [] };
        }
        if (Array.isArray(overrideItems)) {
            var files = [];
            var folders = [];
            overrideItems.forEach(function (item) {
                if (!item) return;
                if (typeof item === 'string') {
                    if (item) files.push(item);
                    return;
                }
                var path = item.path || '';
                if (!path) return;
                if (item.type === 'folder') folders.push(path);
                else files.push(path);
            });
            return { files: files, folders: folders };
        }
        if (typeof overrideItems === 'object') {
            return {
                files: Array.isArray(overrideItems.files) ? overrideItems.files.slice() : [],
                folders: Array.isArray(overrideItems.folders) ? overrideItems.folders.slice() : [],
            };
        }
        return null;
    }

    function getSelectedItemsFromSelection() {
        var files = [];
        var folders = [];
        var items = window.selectedItems;
        if (items && typeof items.forEach === 'function') {
            items.forEach(function (itemKey) {
                try {
                    var item = JSON.parse(itemKey);
                    if (item.type === 'file' && item.path) files.push(item.path);
                    else if (item.type === 'folder' && item.path) folders.push(item.path);
                } catch (e) { /* ignore */ }
            });
        }
        if (files.length || folders.length) {
            return { files: files, folders: folders };
        }
        var fileList = document.getElementById('fileList');
        if (!fileList) return { files: files, folders: folders };
        fileList.querySelectorAll('.file-item .list-checkbox:checked').forEach(function (cb) {
            var p = (cb.dataset && cb.dataset.path) || '';
            if (p) files.push(p);
        });
        fileList.querySelectorAll('.folder-item .list-checkbox:checked').forEach(function (cb) {
            var p = (cb.dataset && cb.dataset.path) || '';
            if (p) folders.push(p);
        });
        return { files: files, folders: folders };
    }

    function fetchFolderFilesRecursive(bucketId, folderPrefixes) {
        return fetch('/api/folders/files', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bucket: bucketId,
                prefixes: folderPrefixes,
            }),
        }).then(function (r) {
            return r.json().then(function (data) {
                return { ok: r.ok, data: data };
            });
        });
    }

    function resolveBulkAclPaths(bucketId, selected) {
        selected = selected || getSelectedItemsFromSelection();
        var directFiles = selected.files.slice();
        var folders = selected.folders.slice();
        if (!folders.length) {
            return Promise.resolve(directFiles);
        }
        return fetchFolderFilesRecursive(bucketId, folders).then(function (res) {
            if (!res.ok) {
                var err = (res.data && res.data.error) || t('error.unexpected');
                throw new Error(err);
            }
            var folderFiles = (res.data && res.data.files) || [];
            var seen = Object.create(null);
            var all = [];
            directFiles.concat(folderFiles).forEach(function (path) {
                if (!path || seen[path]) return;
                seen[path] = true;
                all.push(path);
            });
            return all;
        });
    }

    function resetBulkAclState() {
        closeAllBulkAclDropdowns();
        _bulkState.paths = [];
        _bulkState.bucketId = '';
        _bulkState.canPut = false;
        _bulkState.capabilityPending = false;
        _bulkState.grants = [];
        _bulkState.aclEditShowRows = false;
    }

    function setBulkAclSummary(fileCount, folderCount) {
        var el = document.getElementById('bulkAclSummary');
        if (!el) return;
        var folders = folderCount || 0;
        if (folders > 0) {
            var mixedTpl = t('files.bulk_acl_summary_folders') || '{folders} folder(s), {files} file(s) total';
            el.textContent = mixedTpl
                .replace('{folders}', String(folders))
                .replace('{files}', String(fileCount || 0));
            return;
        }
        var tpl = t('files.bulk_acl_summary') || '{count} files';
        el.textContent = tpl.replace('{count}', String(fileCount || 0));
    }

    function setBulkAclFormEnabled(enabled) {
        var applyBtn = document.getElementById('bulkAclApplyBtn');
        var addBtn = document.getElementById('bulkAclAddRow');
        if (applyBtn) applyBtn.disabled = !enabled;
        if (addBtn) addBtn.disabled = !enabled;
    }

    window.hideBulkAclModal = function () {
        var modal = document.getElementById('bulkAclModal');
        if (modal) modal.style.display = 'none';
        resetBulkAclState();
    };

    window.showBulkAclModal = function (overrideItems) {
        if (!clientHasEditFileAclPerm()) {
            if (typeof window.showError === 'function') {
                window.showError(t('error.acl_access_denied'));
            }
            return;
        }
        var selected = normalizeBulkAclSelection(overrideItems) || getSelectedItemsFromSelection();
        if (selected.files.length < 1 && selected.folders.length < 1) {
            if (typeof window.showError === 'function') {
                window.showError(t('files.bulk_acl_select_min_files'));
            }
            return;
        }
        var bucketId = window.fileManagerCurrentBucketId || window.currentBucket || '';
        if (!bucketId) return;

        resetBulkAclState();
        _bulkState.bucketId = bucketId;
        _bulkState.grants = [];
        _bulkState.aclEditShowRows = false;

        var modal = document.getElementById('bulkAclModal');
        if (!modal) return;
        var folderCount = selected.folders.length;
        setBulkAclSummary(selected.files.length, folderCount);
        bulkRenderAclEdit();
        setBulkAclFormEnabled(false);
        modal.style.display = 'flex';

        var container = document.getElementById('bulkAclGrants');
        var loadingMessage =
            folderCount > 0
                ? t('files.bulk_acl_loading_files')
                : t('files.bulk_acl_loading_template');
        if (container) {
            container.innerHTML =
                '<div class="file-info-acl-message">' + escapeHtml(loadingMessage) + '</div>';
        }

        resolveBulkAclPaths(bucketId, selected)
            .then(function (paths) {
                if (paths.length < 1) {
                    window.hideBulkAclModal();
                    if (typeof window.showError === 'function') {
                        window.showError(t('files.bulk_acl_folder_empty'));
                    }
                    return null;
                }
                _bulkState.paths = paths.slice();
                setBulkAclSummary(paths.length, folderCount);

                var templatePath = paths[0];
                if (container) {
                    container.innerHTML =
                        '<div class="file-info-acl-message">' +
                        escapeHtml(t('files.bulk_acl_loading_template')) +
                        '</div>';
                }

                var capPromise = fetchJson(
                    '/api/files/metadata/acl-capability?bucket=' +
                        encodeURIComponent(bucketId) +
                        '&path=' +
                        encodeURIComponent(templatePath),
                );
                var aclPromise = fetchJson(
                    '/api/files/metadata/acl?bucket=' +
                        encodeURIComponent(bucketId) +
                        '&path=' +
                        encodeURIComponent(templatePath),
                );
                return Promise.all([capPromise, aclPromise]);
            })
            .then(function (results) {
                if (!results) return;
                var capRes = results[0];
                var aclRes = results[1];
                if (!capRes.ok || !(capRes.data && capRes.data.can_put_object_acl)) {
                    window.hideBulkAclModal();
                    var err =
                        (capRes.data && capRes.data.error) ||
                        t('files.info_acl_edit_no_put_permission');
                    if (typeof window.showError === 'function') window.showError(err);
                    return;
                }
                _bulkState.canPut = true;
                if (aclRes.ok && aclRes.data && aclRes.data.acl && aclRes.data.acl.grants) {
                    _bulkState.grants = cloneGrants(aclRes.data.acl.grants);
                } else {
                    _bulkState.grants = [];
                }
                _bulkState.aclEditShowRows = _bulkState.grants.length > 0;
                bulkRenderAclEdit();
                setBulkAclFormEnabled(true);
            })
            .catch(function (err) {
                window.hideBulkAclModal();
                if (typeof window.showError === 'function') {
                    window.showError((err && err.message) || t('msg.network_error'));
                }
            });
    };

    function pathDisplayName(path) {
        var parts = String(path || '')
            .split('/')
            .filter(function (p) {
                return p;
            });
        return parts.length ? parts[parts.length - 1] : path;
    }

    var BULK_ACL_PROGRESS_LIST_LIMIT = 100;

    function saveBulkAcl() {
        if (!_bulkState.bucketId || !_bulkState.paths.length) return;
        var grants = bulkCollectGrantsFromForm();
        var validationError = validateGrantsBeforeSave(grants);
        if (validationError) {
            if (typeof window.showError === 'function') window.showError(validationError);
            return;
        }
        if (!window.OperationJobs || typeof window.OperationJobs.startAcl !== 'function') {
            if (typeof window.showError === 'function') {
                window.showError(t('error.unexpected'));
            }
            return;
        }

        var applyBtn = document.getElementById('bulkAclApplyBtn');
        if (applyBtn) applyBtn.disabled = true;

        var paths = _bulkState.paths.slice();
        var bucketId = _bulkState.bucketId;
        var total = paths.length;
        var showItemList = total <= BULK_ACL_PROGRESS_LIST_LIMIT;
        var displayNames = showItemList ? paths.map(pathDisplayName) : [];

        window.hideBulkAclModal();

        window.OperationJobs.startAcl(
            {
                bucket: bucketId,
                paths: paths,
                grants: grants,
                display_names: displayNames,
            },
            displayNames,
        )
            .catch(function (err) {
                if (typeof window.showError === 'function') {
                    window.showError((err && err.message) || t('msg.network_error'));
                }
            })
            .finally(function () {
                if (applyBtn) applyBtn.disabled = false;
            });
    }

    function clientCanEditFileAcl() {
        return clientHasEditFileAclPerm();
    }

    function isSelectionModeActive() {
        return document.body.classList.contains('selection-mode');
    }

    window.updateBulkAclToolbarButton = function (selectedFiles, selectedFolders) {
        var btn = document.getElementById('aclSelectedBtn');
        if (!btn) return;
        if (!clientCanEditFileAcl()) {
            btn.classList.add('hidden');
            return;
        }
        if (!isSelectionModeActive()) {
            btn.classList.add('hidden');
            btn.disabled = true;
            return;
        }
        btn.classList.remove('hidden');
        var files = selectedFiles || 0;
        var folders = selectedFolders || 0;
        if (files >= 1 || folders >= 1) {
            btn.disabled = false;
            if (folders >= 1 && files === 0) {
                btn.title = t('toolbar.acl_selected_folders') || t('toolbar.acl_selected');
            } else {
                btn.title = t('toolbar.acl_selected') || t('files.info_acl');
            }
        } else {
            btn.disabled = true;
            btn.title = t('files.bulk_acl_select_min_files');
        }
    };

    function bindBulkAclUi() {
        var aclBtn = document.getElementById('aclSelectedBtn');
        if (aclBtn) {
            aclBtn.addEventListener('click', function () {
                if (!aclBtn.disabled) window.showBulkAclModal();
            });
        }
        if (typeof window.bindModalScrollChaining === 'function') {
            window.bindModalScrollChaining({
                modalId: 'bulkAclModal',
                scrollHostId: 'BulkAclModal',
                targetSelector: '#bulkAclGrants, #bulkAclEditRows'
            });
        }
        var modal = document.getElementById('bulkAclModal');
        if (modal) {
            modal.addEventListener('click', function (e) {
                if (e.target === modal) window.hideBulkAclModal();
                if (!e.target.closest('.dropdown-acl')) {
                    closeAllBulkAclDropdowns();
                }
            });
        }
        var bulkApplyBtn = document.getElementById('bulkAclApplyBtn');
        if (bulkApplyBtn) bulkApplyBtn.addEventListener('click', saveBulkAcl);
        var closeBtn = document.getElementById('bulkAclCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', window.hideBulkAclModal);
        var addBtn = document.getElementById('bulkAclAddRow');
        if (addBtn) addBtn.addEventListener('click', bulkAddAclEditRow);

        var grants = document.getElementById('bulkAclGrants');
        if (grants && !grants._bulkAclRemoveDelegated) {
            grants._bulkAclRemoveDelegated = true;
            grants.addEventListener('click', function (e) {
                var btn = e.target.closest('.file-info-acl-remove');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                var row = btn.closest('.file-info-acl-edit-row');
                if (row) bulkRemoveAclEditRow(row);
            });
        }

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var m = document.getElementById('bulkAclModal');
            if (!m || m.style.display !== 'flex') return;
            window.hideBulkAclModal();
        });
    }

    function bindFileInfoUi() {
        bindBulkAclUi();
        if (typeof window.bindModalScrollChaining === 'function') {
            window.bindModalScrollChaining({
                modalId: 'fileInfoModal',
                scrollHostId: 'FileInfoModal',
                targetSelector: '#fileInfoAclGrants, #fileInfoAclEditRows'
            });
        }
        var fileList = document.getElementById('fileList');
        if (fileList) {
            fileList.addEventListener('mousedown', function (e) {
                if (e.target.closest('.list-checkbox, label')) return;
                var fileItem = e.target.closest('.file-item');
                if (fileItem) preloadFileInfo(fileItem);
            });
            fileList.addEventListener('mouseover', function (e) {
                if (e.target.closest('.list-checkbox, label')) return;
                var fileItem = e.target.closest('.file-item');
                if (fileItem) scheduleAclPreloadOnHover(fileItem);
            });
        }

        var modal = document.getElementById('fileInfoModal');
        if (modal) {
            modal.addEventListener('click', function (e) {
                if (e.target === modal) window.hideFileInfoModal();
                if (!e.target.closest('.dropdown-acl')) {
                    closeAllFileInfoAclDropdowns();
                }
            });
        }

        var editBtn = document.getElementById('fileInfoEditAclBtn');
        if (editBtn) editBtn.addEventListener('click', handleFileInfoEditAclClick);

        var applyBtn = document.getElementById('fileInfoApplyAclBtn');
        if (applyBtn) applyBtn.addEventListener('click', handleFileInfoApplyAclClick);

        var cancelBtn = document.getElementById('fileInfoCancelAclBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', exitAclEditMode);

        var addRowBtn = document.getElementById('fileInfoAclAddRow');
        if (addRowBtn) addRowBtn.addEventListener('click', addAclEditRow);

        ensureAclEditRemoveDelegation();

        setAclFooterMode(false);

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var m = document.getElementById('fileInfoModal');
            if (!m || m.style.display !== 'flex') return;
            if (_state.editingAcl) {
                exitAclEditMode();
                return;
            }
            window.hideFileInfoModal();
        });
    }

    window.clientHasEditFileAclPerm = clientHasEditFileAclPerm;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFileInfoUi);
    } else {
        bindFileInfoUi();
    }
})();

/* ===== file-preview.js ===== */
/**
 * Предпросмотр изображений, PDF, JSON, TXT, MD, HTML и CSS в новой вкладке браузера.
 */
(function () {
    'use strict';

    var IMAGE_EXTENSIONS = {
        jpg: true,
        jpeg: true,
        png: true,
        gif: true,
        webp: true,
        bmp: true,
    };
    var PDF_EXTENSIONS = { pdf: true };
    var TEXT_EXTENSIONS = {
        json: true,
        txt: true,
        md: true,
        markdown: true,
        css: true,
        html: true,
        htm: true,
    };
    var IMAGE_CONTENT_TYPES = {
        'image/jpeg': true,
        'image/png': true,
        'image/gif': true,
        'image/webp': true,
        'image/bmp': true,
    };
    var PDF_CONTENT_TYPES = {
        'application/pdf': true,
    };
    var TEXT_CONTENT_TYPES = {
        'application/json': true,
        'text/plain': true,
        'text/json': true,
        'text/markdown': true,
        'text/x-markdown': true,
        'text/css': true,
        'text/html': true,
        'application/xhtml+xml': true,
    };

    function t(key, fallback) {
        return (window.I18N && window.I18N[key]) || fallback || key;
    }

    function fileExtension(path) {
        var name = String(path || '').split('/').pop() || '';
        var dot = name.lastIndexOf('.');
        if (dot < 0 || dot === name.length - 1) return '';
        return name.slice(dot + 1).toLowerCase();
    }

    function normalizeContentType(contentType) {
        return String(contentType || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
    }

    function isImageContentType(contentType) {
        return !!IMAGE_CONTENT_TYPES[normalizeContentType(contentType)];
    }

    function isPdfContentType(contentType) {
        return !!PDF_CONTENT_TYPES[normalizeContentType(contentType)];
    }

    function isTextContentType(contentType) {
        return !!TEXT_CONTENT_TYPES[normalizeContentType(contentType)];
    }

    function isPreviewableByExtension(path) {
        var ext = fileExtension(path);
        return !!(IMAGE_EXTENSIONS[ext] || PDF_EXTENSIONS[ext] || TEXT_EXTENSIONS[ext]);
    }

    function isPreviewableContentType(contentType) {
        return (
            isImageContentType(contentType) ||
            isPdfContentType(contentType) ||
            isTextContentType(contentType)
        );
    }

    function isPreviewable(path, contentType) {
        if (isPreviewableContentType(contentType)) return true;
        return isPreviewableByExtension(path);
    }

    function encodeS3ObjectUrl(prefix, bucketId, s3Key) {
        var key = String(s3Key || '').replace(/^\/+/, '');
        var encodedKey = key
            .split('/')
            .map(function (seg) {
                return encodeURIComponent(seg);
            })
            .join('/');
        return prefix + encodeURIComponent(bucketId) + '/' + encodedKey;
    }

    function buildViewUrl(bucketId, path) {
        return encodeS3ObjectUrl('/files/view/', bucketId, path);
    }

    function canPreviewWithPermission(bucketId) {
        if (typeof window.userHasPermission === 'function') {
            return window.userHasPermission('preview', bucketId);
        }
        return true;
    }

    function updateFileInfoPreviewButton(path, contentType) {
        var btn = document.getElementById('fileInfoPreviewBtn');
        if (!btn) return;
        var show = canPreviewWithPermission() && isPreviewable(path, contentType);
        btn.classList.toggle('hidden', !show);
        btn.disabled = !show;
    }

    function openFilePreview(filePath, options) {
        options = options || {};
        filePath = String(filePath || '').trim();
        var bucketId =
            options.bucketId ||
            window.fileManagerCurrentBucketId ||
            window.currentBucket ||
            '';
        if (!bucketId || !filePath) return;

        if (!canPreviewWithPermission(bucketId)) {
            if (typeof window.showError === 'function') {
                window.showError(t('error.access_denied', 'Access denied'));
            }
            return;
        }

        var contentType = options.contentType || '';
        if (!isPreviewable(filePath, contentType)) {
            if (typeof window.showError === 'function') {
                window.showError(
                    t('files.preview_unsupported', 'Preview is not available for this file type')
                );
            }
            return;
        }

        var url = buildViewUrl(bucketId, filePath);
        // Не передаём noopener в 3-й аргумент: тогда open() всегда возвращает null
        // (даже при успехе), и UI ошибочно показывает «Failed to load preview».
        var opened = window.open(url, '_blank');
        if (opened) {
            try {
                opened.opener = null;
            } catch (_) {
                /* ignore */
            }
        } else if (typeof window.showError === 'function') {
            window.showError(t('files.preview_failed', 'Failed to open preview'));
        }
    }

    window.isFilePreviewable = isPreviewable;
    window.isFilePreviewableByExtension = isPreviewableByExtension;
    window.updateFileInfoPreviewButton = updateFileInfoPreviewButton;
    window.buildFileViewUrl = buildViewUrl;
    window.encodeS3ObjectUrl = encodeS3ObjectUrl;
    window.openFilePreview = openFilePreview;
    // Совместимость со старым именем
    window.showFilePreviewModal = openFilePreview;
    window.hideFilePreviewModal = function () {};

    function bindFilePreviewUi() {
        var infoPreviewBtn = document.getElementById('fileInfoPreviewBtn');
        if (infoPreviewBtn) {
            infoPreviewBtn.addEventListener('click', function () {
                var path =
                    typeof window.fileInfoCurrentPath === 'function'
                        ? window.fileInfoCurrentPath()
                        : '';
                var bucketId =
                    typeof window.fileInfoCurrentBucketId === 'function'
                        ? window.fileInfoCurrentBucketId()
                        : window.fileManagerCurrentBucketId || window.currentBucket || '';
                var contentType =
                    typeof window.fileInfoCurrentContentType === 'function'
                        ? window.fileInfoCurrentContentType()
                        : '';
                if (!path) return;
                openFilePreview(path, {
                    bucketId: bucketId,
                    contentType: contentType,
                });
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFilePreviewUi);
    } else {
        bindFilePreviewUi();
    }
})();
