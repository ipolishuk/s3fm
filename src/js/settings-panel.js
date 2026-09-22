function settingsSortLabel(key, fallback) {
    var value = (window.I18N || {})[key];
    return (value != null && value !== '') ? value : fallback;
}

function settingsEscapeHtml(value) {
    if (window.S3FM && typeof window.S3FM.escapeHtml === 'function') {
        return window.S3FM.escapeHtml(value);
    }
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function settingsSortableHeader(label, sortKey) {
    var title = settingsSortLabel('settings.sort', 'Sort');
    return '<div class="content-table-header settings-col-sort-header">' +
        '<span class="settings-col-sort-label">' + settingsEscapeHtml(label) + '</span>' +
        '<button type="button" class="btn icon-btn settings-col-sort-btn" data-sort-key="' + sortKey + '" ' +
        'title="' + settingsEscapeHtml(title) + '" aria-label="' + settingsEscapeHtml(title) + '" aria-pressed="false">' +
        '<i class="fa-solid fa-arrow-down-a-z" aria-hidden="true"></i></button></div>';
}

function settingsSortState(scope) {
    window._settingsColumnSort = window._settingsColumnSort || {};
    if (!window._settingsColumnSort[scope]) {
        window._settingsColumnSort[scope] = { key: 'bucket_name', dir: 'asc' };
    }
    return window._settingsColumnSort[scope];
}

function setSettingsSortState(scope, state) {
    window._settingsColumnSort = window._settingsColumnSort || {};
    window._settingsColumnSort[scope] = state;
}

function updateSettingsSortButtons(table, state) {
    if (!table) return;
    var activeKey = state && state.key;
    var desc = !!(state && state.dir === 'desc');
    table.querySelectorAll('.settings-col-sort-btn').forEach(function (btn) {
        var key = btn.getAttribute('data-sort-key');
        var active = !!activeKey && key === activeKey;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        var title = !active
            ? settingsSortLabel('settings.sort', 'Sort')
            : (desc
                ? settingsSortLabel('settings.sort_desc', 'Sorted descending')
                : settingsSortLabel('settings.sort_asc', 'Sorted ascending'));
        btn.title = title;
        btn.setAttribute('aria-label', title);
        var icon = btn.querySelector('i');
        if (icon) {
            icon.classList.remove('fa-arrow-down-a-z', 'fa-arrow-up-z-a');
            icon.classList.add(active && desc ? 'fa-arrow-up-z-a' : 'fa-arrow-down-a-z');
        }
    });
}

function reorderSettingsTableRows(table, state) {
    var tbody = table && table.querySelector('tbody');
    if (!tbody) return;
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var col = -1;
    if (state && state.key) {
        var btn = table.querySelector('.settings-col-sort-btn[data-sort-key="' + state.key + '"]');
        var th = btn && btn.closest('th');
        col = th ? th.cellIndex : -1;
    }
    var locale = document.documentElement.lang || 'en';
    rows.sort(function (a, b) {
        if (!state || !state.key || col < 0) {
            return (parseInt(a.getAttribute('data-sort-index'), 10) || 0) -
                (parseInt(b.getAttribute('data-sort-index'), 10) || 0);
        }
        var av = ((a.cells[col] && a.cells[col].textContent) || '').trim();
        var bv = ((b.cells[col] && b.cells[col].textContent) || '').trim();
        var cmp = av.localeCompare(bv, locale, { sensitivity: 'base', numeric: true });
        return state.dir === 'desc' ? -cmp : cmp;
    });
    rows.forEach(function (tr) { tbody.appendChild(tr); });
}

function bindSettingsColumnSort(scope) {
    var table = document.querySelector('#settingsContentInner > table.content-table');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    if (!tbody) return;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr, index) {
        tr.setAttribute('data-sort-index', String(index));
    });
    var state = settingsSortState(scope);
    if (state.key) reorderSettingsTableRows(table, state);
    updateSettingsSortButtons(table, state);
    if (table._settingsSortBound) return;
    table._settingsSortBound = true;
    table.addEventListener('click', function (e) {
        var btn = e.target.closest('.settings-col-sort-btn');
        if (!btn || !table.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        var key = btn.getAttribute('data-sort-key');
        var prev = settingsSortState(scope);
        var next = (prev.key === key && prev.dir === 'asc')
            ? { key: key, dir: 'desc' }
            : { key: key, dir: 'asc' };
        setSettingsSortState(scope, next);
        reorderSettingsTableRows(table, next);
        updateSettingsSortButtons(table, next);
        if (typeof window.onSettingsTableRendered === 'function') {
            window.onSettingsTableRendered();
        }
    });
}

window.settingsSortableHeader = settingsSortableHeader;
window.bindSettingsColumnSort = bindSettingsColumnSort;

// Settings shell panel
function setupSettingsPanel() {
    const settingsBtn = document.getElementById('settingsMenuItem');
    const settingsView = document.getElementById('settingsView');
    const containerContent = document.querySelector('.container-content');
    const appTitleLink = document.querySelector('.app-title a');
    const settingsItemBuckets = document.getElementById('settingsItemBuckets');
    const settingsItemClouds = document.getElementById('settingsItemClouds');
    const settingsItemUsers = document.getElementById('settingsItemUsers');
    const settingsItemRoles = document.getElementById('settingsItemRoles');
    const settingsItemSearch = document.getElementById('settingsItemSearch');
    const settingsItemStatus = document.getElementById('settingsItemStatus');
    const settingsList = document.getElementById('settingsList');
    const settingsToolbar = document.getElementById('secondaryToolbar');
    const settingsSearchInput = document.getElementById('settingsSearchInput');
    const settingsSearchClear = document.getElementById('settingsSearchClear');
    if (!settingsBtn || !settingsView || !containerContent) return;
    if (!canOpenSettings()) {
        settingsBtn.classList.add('hidden');
        return;
    }
    applySettingsNavBucketsOnly();

    function sortSettingsListMenu() {
        var settingsListEl = document.getElementById('settingsList');
        if (!settingsListEl) return;
        var locale = document.documentElement.lang || 'en';
        var menuItems = Array.from(settingsListEl.querySelectorAll('[data-settings]'));
        menuItems.sort(function (a, b) {
            var labelA = ((a.querySelector('span') && a.querySelector('span').textContent) || a.textContent || '').trim();
            var labelB = ((b.querySelector('span') && b.querySelector('span').textContent) || b.textContent || '').trim();
            return labelA.localeCompare(labelB, locale, { sensitivity: 'base', numeric: true });
        });
        menuItems.forEach(function (el) {
            settingsListEl.appendChild(el);
        });
    }
    sortSettingsListMenu();

    window.settingsPanelState = { currentTab: 'buckets' };
    if (typeof window.initBucketSettingsModal === 'function') {
        window.initBucketSettingsModal();
    }
    updateSettingsMenuItemVisibility();
    function openSettings(activeTab, options) {
        options = options || {};
        var urlMode = options.urlMode || 'replace'; // replace | push | none
        var helpViewEl = document.getElementById('helpView');
        if (helpViewEl) helpViewEl.classList.add('hidden');
        containerContent.classList.add('hidden');
        var appFooter = document.getElementById('appFooter');
        if (appFooter) appFooter.classList.add('hidden');
        settingsView.classList.remove('hidden');
        var tab = activeTab;
        if (!tab) {
            tab = getSettingsTabFromLocation() || 'buckets';
        }
        if (typeof isSettingsBucketsOnly === 'function' && isSettingsBucketsOnly() && tab !== 'buckets') {
            tab = 'buckets';
        }
        applySettingsNavBucketsOnly();
        if (settingsItemBuckets) settingsItemBuckets.classList.toggle('active', tab === 'buckets');
        if (settingsItemClouds) settingsItemClouds.classList.toggle('active', tab === 'clouds');
        if (settingsItemUsers) settingsItemUsers.classList.toggle('active', tab === 'users');
        if (settingsItemRoles) settingsItemRoles.classList.toggle('active', tab === 'roles');
        if (settingsItemSearch) settingsItemSearch.classList.toggle('active', tab === 'search');
        if (settingsItemStatus) settingsItemStatus.classList.toggle('active', tab === 'status');
        if (settingsList && !window._settingsMenuCounts) {
            settingsList.classList.add('hidden');
        }
        if (typeof window.refreshSettingsMenuCounts === 'function') {
            Promise.resolve(window.refreshSettingsMenuCounts()).finally(function() {
                if (settingsList) settingsList.classList.remove('hidden');
            });
        } else if (settingsList) {
            settingsList.classList.remove('hidden');
        }
        var secondaryToolbar = document.getElementById('secondaryToolbar');
        if (secondaryToolbar) {
            secondaryToolbar.classList.toggle('settings-toolbar-search', tab === 'search');
            secondaryToolbar.classList.toggle('settings-toolbar-status', tab === 'status');
        }
        var statusRefreshBtn = document.getElementById('settingsStatusRefreshBtn');
        if (statusRefreshBtn) statusRefreshBtn.classList.toggle('hidden', tab !== 'status');
        if (tab !== 'status' && typeof window.hideSettingsStatusToolbarExtras === 'function') {
            window.hideSettingsStatusToolbarExtras();
        }
        if (tab === 'search') {
            if (typeof window.loadSettingsSearch === 'function') window.loadSettingsSearch();
        } else if (tab === 'status') {
            if (typeof window.loadSettingsStatus === 'function') window.loadSettingsStatus();
        } else if (tab === 'clouds') {
            if (typeof window.loadSettingsClouds === 'function') window.loadSettingsClouds();
        } else if (tab === 'users') {
            if (typeof window.loadSettingsUsers === 'function') window.loadSettingsUsers();
        } else if (tab === 'roles') {
            if (typeof window.loadSettingsRoles === 'function') window.loadSettingsRoles();
        } else if (typeof window.loadSettingsBuckets === 'function') {
            window.loadSettingsBuckets();
        }
        if (urlMode === 'push') updateSettingsURL(tab, false);
        else if (urlMode === 'replace') updateSettingsURL(tab, true);
    }
    function closeSettings() {
        settingsView.classList.add('hidden');
        var secondaryToolbar = document.getElementById('secondaryToolbar');
        if (secondaryToolbar) secondaryToolbar.classList.remove('settings-toolbar-search');
        if (typeof window.hideSettingsStatusToolbarExtras === 'function') {
            window.hideSettingsStatusToolbarExtras();
        }
        containerContent.classList.remove('hidden');
        onSettingsTableCleared();
        if (typeof window.updateFilesPaginationUI === 'function') {
            window.updateFilesPaginationUI();
        }
        window.availableBuckets = [];
        window.bucketsSidebarLoaded = false;
        if (typeof window.loadBuckets === 'function') {
            window.loadBuckets();
        }
        updateURL(currentBucket || '', currentPath || '', true);
    }
    const SETTINGS_PAGE_SIZE = 50;
    let currentSettingsPage = 1;
    let settingsTotalPages = 1;
    let hasPrevSettingsPage = false;
    let hasNextSettingsPage = false;

    function updateSettingsPaginationUI() {
        const footer = document.getElementById('settingsFooter');
        const info = document.getElementById('settingsPageInfo');
        const prevBtn = document.getElementById('settingsPagePrev');
        const nextBtn = document.getElementById('settingsPageNext');
        if (!footer) return;
        const tab = (window.settingsPanelState && window.settingsPanelState.currentTab) || '';
        // Status / Search — не табличный список, пагинация не нужна.
        if (tab === 'status' || tab === 'search') {
            footer.classList.add('hidden');
            return;
        }
        const tbody = document.getElementById('settingsTableBody');
        const show = !!tbody && tbody.querySelectorAll('tr').length > 0;
        footer.classList.toggle('hidden', !show);
        if (!show) return;
        if (info) {
            const pageLabel = I18N['files.page'] || 'Page {page}';
            info.textContent = pageLabel.replace('{page}', String(currentSettingsPage));
        }
        if (prevBtn) prevBtn.disabled = !hasPrevSettingsPage;
        if (nextBtn) nextBtn.disabled = !hasNextSettingsPage;
    }

    function onSettingsTableCleared() {
        currentSettingsPage = 1;
        settingsTotalPages = 1;
        hasPrevSettingsPage = false;
        hasNextSettingsPage = false;
        updateSettingsPaginationUI();
    }

    function applySettingsPagination(options) {
        options = options || {};
        const tbody = document.getElementById('settingsTableBody');
        const scrollEl = typeof window.getSettingsScrollHost === 'function'
            ? window.getSettingsScrollHost()
            : document.getElementById('settingsContentInner');
        const savedInnerScroll = options.preserveInnerScroll && scrollEl ? scrollEl.scrollTop : 0;
        if (!tbody) {
            onSettingsTableCleared();
            return;
        }
        const q = (settingsSearchInput && settingsSearchInput.value || '').trim().toLowerCase();
        const allRows = Array.from(tbody.querySelectorAll('tr'));
        if (allRows.length === 0) {
            onSettingsTableCleared();
            return;
        }
        const matched = allRows.filter(function(tr) {
            return !q || (tr.textContent || '').toLowerCase().indexOf(q) !== -1;
        });
        settingsTotalPages = Math.max(1, Math.ceil(matched.length / SETTINGS_PAGE_SIZE));
        if (currentSettingsPage > settingsTotalPages) currentSettingsPage = settingsTotalPages;
        if (currentSettingsPage < 1) currentSettingsPage = 1;
        const start = (currentSettingsPage - 1) * SETTINGS_PAGE_SIZE;
        const pageRows = new Set(matched.slice(start, start + SETTINGS_PAGE_SIZE));
        allRows.forEach(function(tr) {
            if (q && (tr.textContent || '').toLowerCase().indexOf(q) === -1) {
                tr.style.display = 'none';
            } else {
                tr.style.display = pageRows.has(tr) ? '' : 'none';
            }
        });
        if (options.preserveInnerScroll && scrollEl) {
            const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
            scrollEl.scrollTop = Math.min(savedInnerScroll, maxScroll);
        }
        hasPrevSettingsPage = currentSettingsPage > 1;
        hasNextSettingsPage = currentSettingsPage < settingsTotalPages;
        updateSettingsPaginationUI();
    }

    function captureSettingsTableViewState() {
        var scrollEl = typeof window.getSettingsScrollHost === 'function'
            ? window.getSettingsScrollHost()
            : document.getElementById('settingsContentInner');
        return {
            query: (settingsSearchInput && settingsSearchInput.value) || '',
            page: currentSettingsPage,
            scrollTop: scrollEl ? scrollEl.scrollTop : 0,
        };
    }

    function restoreSettingsTableViewState(state) {
        if (!state) return;
        if (settingsSearchInput) settingsSearchInput.value = state.query || '';
        var q = (state.query || '').trim();
        if (settingsSearchClear) settingsSearchClear.classList.toggle('hidden', !q);
        currentSettingsPage = state.page > 0 ? state.page : 1;
        applySettingsPagination({ preserveInnerScroll: true });
        var scrollEl = typeof window.getSettingsScrollHost === 'function'
            ? window.getSettingsScrollHost()
            : document.getElementById('settingsContentInner');
        if (scrollEl) {
            var maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
            scrollEl.scrollTop = Math.min(state.scrollTop || 0, maxScroll);
        }
    }

    window.captureSettingsTableViewState = captureSettingsTableViewState;
    window.restoreSettingsTableViewState = restoreSettingsTableViewState;

    function onSettingsTableRendered(options) {
        options = options || {};
        if (!options.preservePage) {
            currentSettingsPage = 1;
        }
        applySettingsPagination();
    }

    function settingsPagePrev() {
        if (!hasPrevSettingsPage || currentSettingsPage <= 1) return;
        currentSettingsPage -= 1;
        applySettingsPagination({ preserveInnerScroll: true });
    }

    function settingsPageNext() {
        if (!hasNextSettingsPage) return;
        currentSettingsPage += 1;
        applySettingsPagination({ preserveInnerScroll: true });
    }

    window.onSettingsTableRendered = onSettingsTableRendered;
    window.onSettingsTableCleared = onSettingsTableCleared;
    window.settingsPagePrev = settingsPagePrev;
    window.settingsPageNext = settingsPageNext;
    if (typeof window.setupSettingsPaginationControls === "function") window.setupSettingsPaginationControls();

    function filterSettingsTable() {
        var q = (settingsSearchInput && settingsSearchInput.value || '').trim().toLowerCase();
        currentSettingsPage = 1;
        applySettingsPagination();
        if (settingsSearchClear) settingsSearchClear.classList.toggle('hidden', !q);
    }
    if (settingsSearchInput) {
        settingsSearchInput.addEventListener('input', filterSettingsTable);
        settingsSearchInput.addEventListener('keyup', filterSettingsTable);
    }
    if (settingsSearchClear) {
        settingsSearchClear.addEventListener('click', function() {
            if (settingsSearchInput) settingsSearchInput.value = '';
            filterSettingsTable();
            if (settingsSearchInput) settingsSearchInput.focus();
        });
    }
    if (typeof window.initSettingsUsersRoles === 'function') {
        window.initSettingsUsersRoles();
    }
    window.openSettingsByRoute = function(tab) {
        openSettings(tab, { urlMode: 'none' });
    };
    settingsBtn.addEventListener('click', function() { openSettings('buckets', { urlMode: 'push' }); });
    const settingsBackBtn = document.getElementById('settingsBackBtn');
    if (settingsBackBtn) settingsBackBtn.addEventListener('click', closeSettings);
    if (appTitleLink) {
        appTitleLink.addEventListener('click', function(e) {
            if (settingsView.classList.contains('hidden')) return;
            e.preventDefault();
            closeSettings();
        });
    }
    settingsItemBuckets.addEventListener('click', function() {
        openSettings('buckets', { urlMode: 'push' });
    });
    if (settingsItemClouds) {
        settingsItemClouds.addEventListener('click', function() {
            openSettings('clouds', { urlMode: 'push' });
        });
    }
    settingsItemUsers.addEventListener('click', function() {
        openSettings('users', { urlMode: 'push' });
    });
    if (settingsItemRoles) {
        settingsItemRoles.addEventListener('click', function() {
            openSettings('roles', { urlMode: 'push' });
        });
    }
    if (settingsItemSearch) {
        settingsItemSearch.addEventListener('click', function() {
            openSettings('search', { urlMode: 'push' });
        });
    }
    if (settingsItemStatus) {
        settingsItemStatus.addEventListener('click', function() {
            openSettings('status', { urlMode: 'push' });
        });
    }
    if (getSettingsTabFromLocation()) {
        openSettings(null, { urlMode: 'replace' });
    }
}

// И обновим загрузку при старте

window.setupSettingsPanel = setupSettingsPanel;
