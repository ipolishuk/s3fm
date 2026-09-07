/**
 * Selection mode UI: enter/exit select mode, checkboxes, clear selection.
 * Syncs with page via window.selectionMode / window.selectedItems / bridges.
 */
(function (global) {
    'use strict';

    if (typeof global.prefixWideSelection === 'undefined') global.prefixWideSelection = false;
    if (typeof global.selectAllScopeLoading === 'undefined') global.selectAllScopeLoading = false;
    if (typeof global.lastClickedSelectionElementId === 'undefined') global.lastClickedSelectionElementId = null;
    if (typeof global.pendingShiftRangeClickTarget === 'undefined') global.pendingShiftRangeClickTarget = null;
    if (typeof global.shiftRangeApplying === 'undefined') global.shiftRangeApplying = false;

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

    function replaceSelectedSet(newSet) {
        var set = newSet instanceof Set ? newSet : new Set(newSet || []);
        if (typeof global.__setSelectedItems === 'function') {
            global.__setSelectedItems(set);
        } else {
            global.selectedItems = set;
        }
        return set;
    }

    function getSelectionMode() {
        return !!global.selectionMode;
    }

    function setSelectionMode(value) {
        var on = !!value;
        global.selectionMode = on;
        if (typeof global.__setSelectionMode === 'function') global.__setSelectionMode(on);
    }

// Включение/выключение режима выбора
async function toggleSelectionMode() {
    if (!getSelectionMode() && !global.canUseSelectionMode()) return;
    setSelectionMode(!getSelectionMode());
    /* synced by setSelectionMode */
    document.body.classList.toggle('selection-mode', getSelectionMode());

    if (getSelectionMode()) {
        const uploadDropdown = document.getElementById('uploadDropdown');
        const uploadDropdownMenu = document.getElementById('uploadDropdownMenu');
        const uploadBtnEl = document.getElementById('uploadBtn');
        if (uploadDropdown) uploadDropdown.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function' && uploadDropdown) {
            window.resetDropdownMenuOverlay(uploadDropdown);
        } else {
            if (uploadDropdownMenu) uploadDropdownMenu.classList.add('hidden');
            if (uploadBtnEl) uploadBtnEl.setAttribute('aria-expanded', 'false');
        }
        // Режим выбора активен
        const headerTitle = document.getElementById('headerTitle');
        const selectionHeader = document.getElementById('selectionHeader');
        const selectModeBtn = document.getElementById('selectModeBtn');
        const selectModeIcon = document.getElementById('selectModeIcon');
        const selectModeText = document.getElementById('selectModeText');

        // Переключаем заголовки
        headerTitle.style.display = 'none';
        selectionHeader.style.display = 'flex';

        selectModeIcon.className = 'fa-solid fa-xmark';
        selectModeText.textContent = (global.I18N || {})['toolbar.cancel_select'];
        selectModeBtn.title = (global.I18N || {})['toolbar.cancel_select'] || 'Cancel selection';
        selectModeBtn.setAttribute('aria-label', selectModeBtn.title);
        selectModeBtn.classList.add('select-mode-active');

        if (typeof window.updateBulkAclToolbarButton === 'function') {
            window.updateBulkAclToolbarButton(0, 0);
        }
        if (typeof window.updateCopyToolbarButton === 'function') {
            window.updateCopyToolbarButton(0, 0);
        }
        if (typeof window.updateMoveToolbarButton === 'function') {
            window.updateMoveToolbarButton(0, 0);
        }

        // БЛОКИРУЕМ кнопки скачивания и удаления
        blockActionButtons(true);

        // Обновляем отображение элементов для режима выбора
        updateItemsForSelectionMode();

    } else {
        // Режим выбора неактивен
        const headerTitle = document.getElementById('headerTitle');
        const selectionHeader = document.getElementById('selectionHeader');
        const selectModeBtn = document.getElementById('selectModeBtn');
        const selectModeIcon = document.getElementById('selectModeIcon');
        const selectModeText = document.getElementById('selectModeText');
        
        // Переключаем заголовки обратно
        headerTitle.style.display = 'block';
        selectionHeader.style.display = 'none';
        
        selectModeIcon.className = 'fa-solid fa-square-check';
        selectModeText.textContent = (global.I18N || {})['toolbar.select'];
        selectModeBtn.classList.remove('select-mode-active');
        
        // Скрываем кнопки выбора
        document.getElementById('selectionButtons').style.display = 'none';
        if (typeof window.updateBulkAclToolbarButton === 'function') {
            window.updateBulkAclToolbarButton(0, 0);
        }
        if (typeof window.updateCopyToolbarButton === 'function') {
            window.updateCopyToolbarButton(0, 0);
        }
        if (typeof window.updateMoveToolbarButton === 'function') {
            window.updateMoveToolbarButton(0, 0);
        }

        typeof global.setupUserPermissions === 'function' && global.setupUserPermissions();

        // Сначала очищаем выделение
        clearSelectionWithoutBlocking();

        // Затем РАЗБЛОКИРУЕМ кнопки скачивания и удаления
        blockActionButtons(false);

        // Восстанавливаем обычное отображение элементов
        updateItemsForNormalMode();
    }
    typeof global.setupUserPermissions === 'function' && global.setupUserPermissions();
}

// Очистка выделения без блокировки кнопок
function clearSelectionWithoutBlocking() {
    const pathsToClear = new Set();
    Array.from(getSelectedSet()).forEach(itemKey => {
        try {
            const item = JSON.parse(itemKey);
            if (item.path) pathsToClear.add(item.path);
            if (item.elementId) {
                const cb = document.getElementById(item.elementId);
                if (cb) {
                    cb.checked = false;
                    updateItemSelectionStyle(item.elementId, false);
                }
            }
        } catch (e) { /* ignore */ }
    });

    getSelectedSet().clear();
        global.prefixWideSelection = false;
    global.selectAllScopeLoading = false;
    global.lastClickedSelectionElementId = null;

    document.querySelectorAll('.list-checkbox').forEach(checkbox => {
        const path = (checkbox.dataset && checkbox.dataset.path) || '';
        if (!checkbox.checked && !pathsToClear.has(path)) return;
        checkbox.checked = false;
        updateItemSelectionStyle(checkbox.id, false);
    });
    document.querySelectorAll('.file-item.selected, .folder-item.selected').forEach(item => {
        item.classList.remove('selected');
    });
    updateSelectionInfo();

    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    }
    hideSelectAllScopeInline();
}
// Блокировка/разблокировка кнопок действий
function blockActionButtons(block) {
    const allActionButtons = document.querySelectorAll('#fileList .icon-btn');

    if (block) {
        allActionButtons.forEach(btn => {
            if (!btn.hasAttribute('data-was-enabled')) {
                btn.setAttribute('data-was-enabled', !btn.disabled);
            }
            btn.disabled = true;
        });
    } else {
        allActionButtons.forEach(btn => {
            const wasEnabled = btn.getAttribute('data-was-enabled') === 'true';
            btn.disabled = !wasEnabled;
            btn.removeAttribute('data-was-enabled');
        });
    }
}

function updateItemsForSelectionMode() {
    const fileItems = document.querySelectorAll('.file-item');
    const folderItems = document.querySelectorAll('.folder-item');

    // Обновляем файлы
    fileItems.forEach(item => {
        const fileInfo = item.querySelector('.file-info');
        const path = global.getListRowPath(item);

        if (fileInfo && !fileInfo.querySelector('.list-checkbox')) {
            const fileName =
                fileInfo.querySelector('.search-result-name')?.textContent?.trim() ||
                fileInfo.querySelector('span')?.textContent?.trim() ||
                '';

            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const attrPath = global.escapePathForHtmlAttr(path);

            fileInfo.innerHTML = `
                <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${fileId}"
                    data-path="${attrPath}" data-type="file"
                    ${global.fileCheckboxSelectDisabledAttr()}>
                    <i class="fa-solid fa-file file-icon"></i>
                    <span>${global.escapeHtmlText(fileName)}</span>
                </label>
            `;
        }
    });

    // Обновляем папки (чекбокс активен только при праве delete_folder_multi)
    folderItems.forEach(item => {
        global.clearFolderRowNavigation(item);
        const folderInfo = item.querySelector('.folder-info');
        const path = global.getListRowPath(item);

        if (folderInfo && !folderInfo.querySelector('.list-checkbox')) {
            const folderName =
                folderInfo.querySelector('.search-result-name')?.textContent?.trim() ||
                folderInfo.querySelector('label span')?.textContent?.trim() ||
                folderInfo.querySelector('span')?.textContent?.trim() ||
                '';
            const folderId = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const attrPath = global.escapePathForHtmlAttr(path);

            folderInfo.innerHTML = `
                <label class="lables">
<input type="checkbox" class="checkbox list-checkbox" id="${folderId}"
                    data-path="${attrPath}" data-type="folder"
                    ${global.folderCheckboxSelectDisabledAttr()}>
                    <i class="fa-solid fa-folder folder-icon"></i>
                    <span>${global.escapeHtmlText(folderName)}</span>
                </label>
            `;
        }
    });

    // Обновляем информацию о выборе
    updateSelectionInfo();
    reconcileSelectionWithDom();
}

// Восстановить обычное отображение элементов (убрать чекбоксы)
function updateItemsForNormalMode() {
    const fileItems = document.querySelectorAll('.file-item');
    const folderItems = document.querySelectorAll('.folder-item');

    // Восстанавливаем файлы
    fileItems.forEach(item => {
        const fileInfo = item.querySelector('.file-info');
        if (fileInfo) {
            // Сохраняем путь и имя из чекбокса если есть
            const checkbox = fileInfo.querySelector('.checkbox');
            const label = fileInfo.querySelector('label');
            const path = checkbox?.dataset.path || '';
            const fileName =
                fileInfo.querySelector('.search-result-name')?.textContent?.trim() ||
                label?.querySelector('span')?.textContent?.trim() ||
                '';
            
            if (checkbox) {
                checkbox.remove();
            }
            if (label) {
                label.remove();
            }
            
            // Восстанавливаем оригинальную структуру
            fileInfo.innerHTML = `
                <i class="fa-solid fa-file file-icon"></i>
                <span>${fileName}</span>
            `;
        }
    });

    // Восстанавливаем папки после режима выбора: убираем чекбокс, путь из data-path или из чекбокса
    folderItems.forEach(item => {
        const folderInfo = item.querySelector('.folder-info');
        if (folderInfo) {
            const path = item.dataset.path || folderInfo.querySelector('.checkbox')?.dataset.path || '';
            const folderName =
                folderInfo.querySelector('.search-result-name')?.textContent?.trim() ||
                folderInfo.querySelector('label span')?.textContent?.trim() ||
                folderInfo.querySelector('span')?.textContent?.trim() ||
                '';
            const checkbox = folderInfo.querySelector('.checkbox');
            const label = folderInfo.querySelector('label');
            if (checkbox) checkbox.remove();
            if (label) label.remove();
            folderInfo.innerHTML = `
                <i class="fa-solid fa-folder folder-icon"></i>
                <span>${folderName}</span>
            `;
            if (path) {
                global.bindFolderRowNavigation(item, path);
            }
        }
    });
}

// Переключение выбора элемента
function toggleItemSelection(path, type, isChecked, elementId) {
    if (global.shiftRangeApplying) return;
    // Проверяем что путь не пустой
    if (!path || path.trim() === '') {
        console.error('Empty path detected!');
        return;
    }

    const item = { path, type, elementId };
    const itemKey = JSON.stringify(item);

    if (isChecked) {
        getSelectedSet().add(itemKey);
    } else {
        getSelectedSet().delete(itemKey);
        if (global.prefixWideSelection) {
            global.prefixWideSelection = false;
        }
    }

    global.lastClickedSelectionElementId = elementId;

    updateSelectionInfo();
    updateItemSelectionStyle(elementId, isChecked);
}

// Возвращает массив элементов для выбора в порядке отображения в списке
function getOrderedSelectionItems() {
    const fileList = document.getElementById('fileList');
    if (!fileList) return [];
    const rows = fileList.querySelectorAll('.file-item, .folder-item');
    const result = [];
    rows.forEach(row => {
        const cb = row.querySelector('.list-checkbox');
        if (cb && cb.id && cb.dataset.path !== undefined) {
            result.push({
                elementId: cb.id,
                path: cb.dataset.path,
                type: cb.dataset.type || 'file'
            });
        }
    });
    return result;
}

// Блокирует следующий нативный click по чекбоксу (иначе после mousedown+preventDefault браузер всё равно переключает чекбокс и ломает диапазон).
// Таймаут снимает слушатель, если click не пришёл (иначе чекбокс перестаёт реагировать на следующие нажатия).
function swallowNextNativeCheckboxClick(checkboxEl) {
    if (!checkboxEl) return;
    let handler = null;
    const cleanup = () => {
        clearTimeout(timeoutId);
        if (handler) {
            checkboxEl.removeEventListener('click', handler, true);
            handler = null;
        }
    };
    handler = function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        cleanup();
    };
    const timeoutId = setTimeout(cleanup, 500);
    checkboxEl.addEventListener('click', handler, true);
}

// Shift+клик по диапазону: если конечный чекбокс был выключен — включаем диапазон (от якоря до строки); если был включён — выключаем.
// Якорь — global.lastClickedSelectionElementId (обычный клик или предыдущий Shift); без якоря обрабатываем только одну строку.
// Возвращает true, если обработали сами (вызывающий код должен сделать preventDefault на mousedown).
function handleShiftRangeSelection(clickedCheckbox) {
    if (clickedCheckbox.disabled) return false;
    const ordered = getOrderedSelectionItems();
    const toIdx = ordered.findIndex(item => item.elementId === clickedCheckbox.id);
    if (toIdx === -1) return false;

    const turnOn = !clickedCheckbox.checked;

    const applyRange = (start, end, on) => {
        global.prefixWideSelection = false;
        global.shiftRangeApplying = true;
        try {
            for (let i = start; i <= end; i++) {
                const item = ordered[i];
                const cb = document.getElementById(item.elementId);
                if (!cb || cb.disabled) continue;
                const itemKey = JSON.stringify({ path: item.path, type: item.type, elementId: item.elementId });
                if (on) {
                    getSelectedSet().add(itemKey);
                    cb.checked = true;
                    updateItemSelectionStyle(item.elementId, true);
                } else {
                    getSelectedSet().delete(itemKey);
                    cb.checked = false;
                    updateItemSelectionStyle(item.elementId, false);
                }
            }
        } finally {
            global.shiftRangeApplying = false;
        }
    };

    const finishShiftGesture = () => {
        global.lastClickedSelectionElementId = clickedCheckbox.id;
        global.pendingShiftRangeClickTarget = clickedCheckbox;
        updateSelectionInfo();
        swallowNextNativeCheckboxClick(clickedCheckbox);
    };

    if (!global.lastClickedSelectionElementId) {
        applyRange(toIdx, toIdx, turnOn);
        finishShiftGesture();
        return true;
    }

    const fromIdx = ordered.findIndex(item => item.elementId === global.lastClickedSelectionElementId);
    if (fromIdx === -1) {
        // Якорь устарел (список перерисован и т.п.) — только текущая строка, не блокируем UI из‑за «тихого» сбоя
        applyRange(toIdx, toIdx, turnOn);
        finishShiftGesture();
        return true;
    }
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    applyRange(start, end, turnOn);

    finishShiftGesture();
    return true;
}

// Обновление стиля выбранного элемента
function updateItemSelectionStyle(elementId, isSelected) {
    const checkbox = document.getElementById(elementId);
    if (checkbox) {
        const item = checkbox.closest('.file-item, .folder-item');
        if (item) {
            if (isSelected) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        }
    }
}

// Синхронизировать состояние выбранных элементов с UI
function syncSelectionWithUI() {
    getSelectedSet().forEach(itemKey => {
        const item = JSON.parse(itemKey);
        const checkbox = document.getElementById(item.elementId);
        if (checkbox) {
            checkbox.checked = true;
            updateItemSelectionStyle(item.elementId, true);
        }
    });
    updateSelectionInfo();
}

// Обновление информации о выборе
function updateSelectionInfo() {
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const selectedCountSpan = document.getElementById('selectedCount');

    // Подсчитываем выбранные файлы и папки
    let selectedFiles = 0;
    let selectedFolders = 0;

    getSelectedSet().forEach(itemKey => {
        const item = JSON.parse(itemKey);
        if (item.type === 'file') {
            selectedFiles++;
        } else if (item.type === 'folder') {
            selectedFolders++;
        }
    });

    // Обновляем счетчик в заголовке
    selectedCountSpan.textContent = getSelectedSet().size;

    // Блокировка кнопки удаления по правам из API (permissions)
    const canDeleteFiles = global.userHasPermission('delete_file');
    const canDeleteFolders = global.userHasPermission('delete_folder');
    const canDeleteMultiFiles = global.userHasPermission('delete_files_multi');
    const canDeleteMultiFolders = global.userHasPermission('delete_folder_multi');
    if (getSelectedSet().size === 0) {
        deleteSelectedBtn.disabled = true;
    } else if (selectedFiles >= 1 && (selectedFiles === 1 ? !canDeleteFiles : !canDeleteMultiFiles)) {
        deleteSelectedBtn.disabled = true;
    } else if (selectedFolders >= 1 && (selectedFolders === 1 ? !canDeleteFolders : !canDeleteMultiFolders)) {
        deleteSelectedBtn.disabled = true;
    } else {
        deleteSelectedBtn.disabled = false;
    }

    // 1 файл — download_file или multi; несколько — download_files_multi.
    const canDownloadFile = global.userHasPermission('download_file') || global.userHasPermission('download_files_multi');
    const canDownloadMultiFiles = global.userHasPermission('download_files_multi');
    const canDownloadSelected = selectedFiles > 0 && (
        selectedFiles === 1
            ? canDownloadFile
            : canDownloadMultiFiles
    );
    downloadSelectedBtn.disabled = !canDownloadSelected;

    if (selectedFiles === 0 && selectedFolders > 0) {
        downloadSelectedBtn.title = (global.I18N || {})['msg.download_select_files'] || (global.I18N || {})['download.folders_not_supported'];
    } else if (selectedFiles > 0 && !canDownloadSelected) {
        downloadSelectedBtn.title = (selectedFiles > 1 && !canDownloadMultiFiles)
            ? ((global.I18N || {})['files.select_files_requires_permissions'] || '')
            : ((global.I18N || {})['files.admin_only'] || '');
    } else if (selectedFiles > 0 && selectedFolders > 0) {
        downloadSelectedBtn.title =
            (global.I18N || {})['download.files_only_skip_folders_hint'] ||
            ((global.I18N || {})['download.confirm_mixed'] || '').replace('{count}', String(selectedFiles));
    } else if (selectedFiles > 0) {
        downloadSelectedBtn.title = (global.I18N || {})['toolbar.download'] + ' ' + selectedFiles + ' ' + global.getPluralForm(selectedFiles, (global.I18N || {})['plural.file_one'], (global.I18N || {})['plural.file_two'], (global.I18N || {})['plural.file_five']);
    } else {
        downloadSelectedBtn.title = (global.I18N || {})['msg.download_selected'];
    }

    // Обновляем состояние чекбокса «Выбрать все» по всем не disabled чекбоксам в списке
    const allCheckboxes = document.querySelectorAll('.list-checkbox:not([disabled])');
    const checkedCount = document.querySelectorAll('.list-checkbox:checked:not([disabled])').length;

    if (global.prefixWideSelection) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else if (allCheckboxes.length > 0) {
        selectAllCheckbox.checked = checkedCount === allCheckboxes.length;
        selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
    }

    updateSelectAllScopeInline();

    if (typeof window.updateBulkAclToolbarButton === 'function') {
        window.updateBulkAclToolbarButton(selectedFiles, selectedFolders);
    }
    if (typeof window.updateCopyToolbarButton === 'function') {
        window.updateCopyToolbarButton(selectedFiles, selectedFolders);
    }
    if (typeof window.updateMoveToolbarButton === 'function') {
        window.updateMoveToolbarButton(selectedFiles, selectedFolders);
    }
}

// Выделить все / снять выделение (в выбор попадают только строки с активным чекбоксом — см. права)
function toggleSelectAll() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const checkboxes = document.querySelectorAll('.list-checkbox:not([disabled])');

    if (!selectAllCheckbox.checked) {
        global.prefixWideSelection = false;
        hideSelectAllScopeInline();
    }

    checkboxes.forEach(checkbox => {
        const isChecked = selectAllCheckbox.checked;
        checkbox.checked = isChecked;

        const path = checkbox.dataset.path;
        const type = checkbox.dataset.type;
        const elementId = checkbox.id;

        const item = { path, type, elementId };
        const itemKey = JSON.stringify(item);

        if (isChecked) {
            getSelectedSet().add(itemKey);
        } else {
            getSelectedSet().delete(itemKey);
        }

        updateItemSelectionStyle(elementId, isChecked);
    });

    if (!selectAllCheckbox.checked) {
        getSelectedSet().clear();
            }

    updateSelectionInfo();
}

function hideSelectAllScopeInline() {
    const inline = document.getElementById('selectAllScopeInline');
    if (!inline) return;
    inline.classList.add('hidden');
    inline.innerHTML = '';
}

function getSelectedPathsMap() {
    const pathMap = new Map();
    getSelectedSet().forEach(itemKey => {
        try {
            const item = JSON.parse(itemKey);
            if (item.path) pathMap.set(item.path, item.type || 'file');
        } catch (e) { /* ignore */ }
    });
    return pathMap;
}

function reconcileSelectionWithDom() {
    if (!getSelectionMode() || getSelectedSet().size === 0) return;
    const pathMap = getSelectedPathsMap();
    const newSet = new Set();

    document.querySelectorAll('.list-checkbox:not([disabled])').forEach(checkbox => {
        const path = checkbox.dataset.path;
        if (!pathMap.has(path)) return;
        checkbox.checked = true;
        updateItemSelectionStyle(checkbox.id, true);
        newSet.add(JSON.stringify({
            path: path,
            type: pathMap.get(path),
            elementId: checkbox.id
        }));
        pathMap.delete(path);
    });

    pathMap.forEach((type, path) => {
        newSet.add(JSON.stringify({ path: path, type: type, elementId: '' }));
    });

    replaceSelectedSet(newSet);
}

function updateSelectAllScopeInline() {
    const inline = document.getElementById('selectAllScopeInline');
    if (!inline || !getSelectionMode()) {
        hideSelectAllScopeInline();
        return;
    }
    if (window.fileSearch && window.fileSearch.mode) {
        hideSelectAllScopeInline();
        return;
    }

    if (global.prefixWideSelection) {
        const scopeTpl = (global.I18N || {})['files.select_all_scope_bucket'] || 'All items are selected.';
        inline.innerHTML = '<span class="lables">' + scopeTpl + '</span>';
        inline.classList.remove('hidden');
        return;
    }

    const pageCheckboxes = document.querySelectorAll('.list-checkbox:not([disabled])');
    const checkedOnPage = document.querySelectorAll('.list-checkbox:checked:not([disabled])').length;
    const allOnPageSelected = pageCheckboxes.length > 0 && checkedOnPage === pageCheckboxes.length;

    if (!allOnPageSelected || !(global.__paginationBridge && global.__paginationBridge.getState().hasNextFilesPage) || global.selectAllScopeLoading) {
        if (!global.selectAllScopeLoading) hideSelectAllScopeInline();
        return;
    }

    const actionLabel = (getPath() || '')
        ? ((global.I18N || {})['files.select_all_in_folder'] || 'Select all items in folder')
        : ((global.I18N || {})['files.select_all_in_bucket'] || 'Select all items in bucket');
    inline.innerHTML =
        '<a href="#" class="lables" id="selectAllInScopeBtn" role="button">' + actionLabel + '</a>';
    inline.classList.remove('hidden');
    const btn = document.getElementById('selectAllInScopeBtn');
    if (btn) {
        btn.onclick = function(e) {
            e.preventDefault();
            selectAllInScope();
        };
    }
}

async function selectAllInScope() {
    if (!getBucket() || global.selectAllScopeLoading) return;
    const bucketAtStart = getBucket();
    const pathAtStart = getPath() || '';
    global.selectAllScopeLoading = true;
    updateSelectAllScopeInline();

    const inline = document.getElementById('selectAllScopeInline');
    if (inline) {
        inline.innerHTML = '<span class="lables">' + ((global.I18N || {})['files.select_all_loading'] || 'Loading items…') + '</span>';
    }

    try {
        const url = '/api/files/selection-items?bucket=' + encodeURIComponent(bucketAtStart)
            + '&prefix=' + encodeURIComponent(pathAtStart);
        const response = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        const data = await response.json();
        if (!response.ok) {
            global.showError(data.error || (global.I18N || {})['msg.load_files_failed']);
            return;
        }
        if (getBucket() !== bucketAtStart || (getPath() || '') !== pathAtStart) {
            return;
        }

        const items = []
            .concat(data.folders || [])
            .concat(data.files || [])
            .filter(item => item && item.path);

        const canFiles = global.canSelectFilesInList();
        const canFolders = global.canSelectFoldersInList();
        const newSet = new Set();
        items.forEach(item => {
            if (item.type === 'folder' && !canFolders) return;
            if (item.type === 'file' && !canFiles) return;
            newSet.add(JSON.stringify({ path: item.path, type: item.type, elementId: '' }));
        });

        replaceSelectedSet(newSet);
                global.prefixWideSelection = getSelectedSet().size > 0;
        reconcileSelectionWithDom();
        updateSelectionInfo();
    } catch (error) {
        global.showError(((global.I18N || {})['msg.load_files_failed'] || 'Failed to load files') + ': ' + error.message);
    } finally {
        global.selectAllScopeLoading = false;
        updateSelectAllScopeInline();
    }
}
// Обновление контейнера "Select All"
function updateSelectAllContainer() {
    const filesHeader = document.getElementById('filesHeader');
    const hasItems = document.querySelectorAll('.file-item, .folder-item').length > 0;

    // Показываем заголовки колонок, если есть элементы
    if (hasItems) {
        filesHeader.style.display = 'grid';
    } else {
        filesHeader.style.display = 'none';
        hideSelectAllScopeInline();
    }
}


// Очистка выбора
function clearSelection() {
    clearSelectionWithoutBlocking();

    // Если режим выбора активен, блокируем кнопки
    if (getSelectionMode()) {
        blockActionButtons(true);
    }
}
/** Сброс выделения и обновление списка после массовой операции. */
async function resetSelectionAfterMultiFileAction() {
    clearSelectionWithoutBlocking();

    // Сначала выходим из select, чтобы не гонять DOM параллельно с loadFiles
    if (getSelectionMode()) {
        await toggleSelectionMode();
    }

    if (window.fileSearch && window.fileSearch.mode && typeof window.performSearch === 'function') {
        await window.performSearch(window.fileSearch.query);
    } else if (typeof global.loadFiles === 'function') {
        await global.loadFiles(getPath() || '');
    }
}

    global.toggleSelectionMode = toggleSelectionMode;
    global.clearSelectionWithoutBlocking = clearSelectionWithoutBlocking;
    global.blockActionButtons = blockActionButtons;
    global.updateItemsForSelectionMode = updateItemsForSelectionMode;
    global.updateItemsForNormalMode = updateItemsForNormalMode;
    global.toggleItemSelection = toggleItemSelection;
    global.toggleSelectAll = toggleSelectAll;
    global.handleShiftRangeSelection = handleShiftRangeSelection;
    global.updateSelectionInfo = updateSelectionInfo;
    global.updateSelectAllContainer = updateSelectAllContainer;
    global.updateSelectAllScopeInline = updateSelectAllScopeInline;
    global.reconcileSelectionWithDom = reconcileSelectionWithDom;
    global.selectAllInScope = selectAllInScope;
    global.clearSelection = clearSelection;
    global.resetSelectionAfterMultiFileAction = resetSelectionAfterMultiFileAction;
    global.hideSelectAllScopeInline = hideSelectAllScopeInline;
})(window);
