// Home screen navigation
function renderHomeBreadcrumb() {
    const breadcrumb = document.getElementById('breadcrumb');
    if (!breadcrumb) return;
    breadcrumb.classList.remove('hidden');
    var homeLabel = I18N['nav.home'] || 'Home';
    breadcrumb.innerHTML = '<a title="' + homeLabel + '"><span class="breadcrumb-link"><i class="fa-solid fa-house"></i><span class="breadcrumb-text">' + homeLabel + '</span></span></a>';
    breadcrumb.style.display = 'flex';
}
window.renderHomeBreadcrumb = renderHomeBreadcrumb;

// Функция для перехода на главную
function goToHome() {
    // Если активен режим выбора, корректно выходим из него
    if (selectionMode) {
        selectionMode = true;
        window.selectionMode = true;
        if (typeof window.toggleSelectionMode === "function") window.toggleSelectionMode();
    }

    // Сбрасываем состояние
    if (typeof window.__setCurrentBucket === 'function') window.__setCurrentBucket('');
    else currentBucket = '';
    window.fileManagerCurrentBucketName = '';
    if (typeof window.__setCurrentPath === 'function') window.__setCurrentPath('');
    else currentPath = '';
    selectedItems.clear();
    window.lastClickedSelectionElementId = null;
    window.prefixWideSelection = false;
    window.fileSearch.mode = false;
    window.fileSearch.query = '';
    if (window.fileSearch.timeout) {
        clearTimeout(window.fileSearch.timeout);
        window.fileSearch.timeout = null;
    }

    // Сбрасываем поле поиска
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';

    // Скрываем элементы интерфейса
    window.ensureUnifiedSearchInputs();
    window.setMainToolbarLocked(true);
    const bucketInfoEl = document.getElementById('bucketInfo');
    if (bucketInfoEl) {
        bucketInfoEl.style.display = 'none';
        bucketInfoEl.classList.add('hidden');
    }
    window.renderHomeBreadcrumb();
    if (typeof window.hideSelectAllScopeInline === "function") window.hideSelectAllScopeInline();
    document.getElementById('selectionButtons').style.display = 'none';
    document.getElementById('userPermissionHint').style.display = 'none';
    if (typeof window.updateFilesPaginationUI === "function") window.updateFilesPaginationUI();
    document.getElementById('filesHeader').style.display = 'none';

    // Скрываем прогресс-бары
    if (window.ProgressBars) window.ProgressBars.hideLocal();

    // Сбрасываем активный бакет в списке
    document.querySelectorAll('.bucket-list-item').forEach(item => {
        item.classList.remove('active');
    });

    document.getElementById('fileList').innerHTML = `
        <div class="empty-state">
            <i class="fa-solid fa-database empty-state-icon"></i>
            <div class="empty-state-title">${I18N['files.empty_select_bucket']}</div>
        </div>
    `;

    const selectModeBtn = document.getElementById('selectModeBtn');
    const selectModeIcon = document.getElementById('selectModeIcon');
    const selectModeText = document.getElementById('selectModeText');

    selectModeIcon.className = 'fa-solid fa-square-check';
    selectModeText.textContent = I18N['toolbar.select'];
    if (selectModeBtn) selectModeBtn.classList.remove('select-mode-active');

    if (typeof window.showInfo === "function") window.showInfo((window.I18N || {})['notification.home']);

    window.updateURL('', '', false);
}


window.goToHome = goToHome;
