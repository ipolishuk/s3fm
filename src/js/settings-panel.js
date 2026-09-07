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
