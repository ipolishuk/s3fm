(function () {
    'use strict';

    function bridge() {
        return window.__paginationBridge || {};
    }

    function getState() {
        var b = bridge();
        return typeof b.getState === 'function' ? (b.getState() || {}) : {};
    }

    function setState(patch) {
        var b = bridge();
        if (typeof b.setState === 'function') b.setState(patch || {});
    }

    function resetFilesPagination() {
        setState({
            currentFilesPage: 1,
            filesPageStartTokens: [''],
            nextContinuationToken: '',
            isTruncated: false,
            hasPrevFilesPage: false,
            hasNextFilesPage: false
        });
    }

    function applyFilesPageTokensFromResponse(data, requestedPage) {
        data = data || {};
        var currentFilesPage = data.page || requestedPage || 1;
        var filesPageStartTokens = null;
        if (Array.isArray(data.page_start_tokens) && data.page_start_tokens.length > 0) {
            filesPageStartTokens = data.page_start_tokens.slice();
        } else {
            var st = getState();
            filesPageStartTokens = Array.isArray(st.filesPageStartTokens) ? st.filesPageStartTokens.slice() : [''];
        }

        var nextContinuationToken = data.next_continuation_token || '';
        var isTruncated = !!data.is_truncated;
        if (isTruncated && nextContinuationToken && filesPageStartTokens.length === currentFilesPage) {
            filesPageStartTokens.push(nextContinuationToken);
        }

        setState({
            currentFilesPage: currentFilesPage,
            filesPageStartTokens: filesPageStartTokens,
            nextContinuationToken: nextContinuationToken,
            isTruncated: isTruncated,
            hasPrevFilesPage: !!data.has_prev_page,
            hasNextFilesPage: !!data.has_next_page
        });
    }

    function setFilesPaginationLoading(loading) {
        setState({ isFilesPageLoading: !!loading });
        var state = getState();
        var prevBtn = document.getElementById('filesPagePrev');
        var nextBtn = document.getElementById('filesPageNext');
        if (prevBtn) prevBtn.disabled = !!loading || !state.hasPrevFilesPage;
        if (nextBtn) nextBtn.disabled = !!loading || !state.hasNextFilesPage;
    }

    function updateFilesPaginationUI() {
        var state = getState();
        var footer = document.getElementById('appFooter');
        var info = document.getElementById('filesPageInfo');
        var prevBtn = document.getElementById('filesPagePrev');
        var nextBtn = document.getElementById('filesPageNext');
        if (!footer) return;

        var show = !!state.currentBucket && !(window.fileSearch && window.fileSearch.mode);
        footer.classList.toggle('hidden', !show);
        if (!show) return;

        if (info) {
            var tr = typeof bridge().i18n === 'function' ? (bridge().i18n() || {}) : (window.I18N || {});
            var pageLabel = tr['files.page'] || 'Page {page}';
            info.textContent = pageLabel.replace('{page}', String(state.currentFilesPage || 1));
        }
        if (prevBtn) prevBtn.disabled = !!state.isFilesPageLoading || !state.hasPrevFilesPage;
        if (nextBtn) nextBtn.disabled = !!state.isFilesPageLoading || !state.hasNextFilesPage;
    }

    function filesPagePrev() {
        var b = bridge();
        var state = getState();
        if (state.isFilesPageLoading || !state.hasPrevFilesPage || (state.currentFilesPage || 1) <= 1) return;
        if (typeof b.loadFiles !== 'function') return;
        return b.loadFiles(state.currentPath || '', { page: (state.currentFilesPage || 1) - 1, resetPagination: false, paginate: true });
    }

    function filesPageNext() {
        var b = bridge();
        var state = getState();
        if (state.isFilesPageLoading || !state.hasNextFilesPage) return;
        if (typeof b.loadFiles !== 'function') return;
        return b.loadFiles(state.currentPath || '', { page: (state.currentFilesPage || 1) + 1, resetPagination: false, paginate: true });
    }

    function getWindowScrollY() {
        return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    function setWindowScroll(x, y) {
        window.scrollTo(x, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
    }

    function getActivePaginationMenu() {
        var settingsView = document.getElementById('settingsView');
        if (settingsView && !settingsView.classList.contains('hidden')) {
            return settingsView.querySelector('.menu');
        }
        return document.querySelector('.container-content .menu');
    }

    function getFilesScrollHost() {
        return document.getElementById('fileList');
    }

    function getSettingsScrollHost() {
        return document.getElementById('settingsContentInner');
    }

    function capturePaginationScrollState() {
        var bucketsList = document.getElementById('bucketsList');
        var settingsList = document.getElementById('settingsList');
        var fileList = getFilesScrollHost();
        var settingsInner = getSettingsScrollHost();
        var menu = getActivePaginationMenu();
        return {
            windowX: window.scrollX || document.documentElement.scrollLeft || 0,
            windowY: getWindowScrollY(),
            bucketsList: bucketsList ? bucketsList.scrollTop : 0,
            settingsList: settingsList ? settingsList.scrollTop : 0,
            menu: menu ? menu.scrollTop : 0,
            fileList: fileList ? fileList.scrollTop : 0,
            settingsInner: settingsInner ? settingsInner.scrollTop : 0
        };
    }

    function restorePaginationScrollState(state) {
        if (!state) return;
        var apply = function () {
            setWindowScroll(state.windowX, state.windowY);
            var bucketsList = document.getElementById('bucketsList');
            var settingsList = document.getElementById('settingsList');
            var fileList = getFilesScrollHost();
            var settingsInner = getSettingsScrollHost();
            var menu = getActivePaginationMenu();
            if (bucketsList) bucketsList.scrollTop = state.bucketsList;
            if (settingsList) settingsList.scrollTop = state.settingsList;
            if (menu) menu.scrollTop = state.menu;
            if (fileList) fileList.scrollTop = state.fileList != null ? state.fileList : 0;
            if (settingsInner) settingsInner.scrollTop = state.settingsInner != null ? state.settingsInner : 0;
        };
        apply();
        requestAnimationFrame(function () {
            apply();
            requestAnimationFrame(function () {
                apply();
                setTimeout(apply, 0);
            });
        });
    }

    function releasePaginationButtonFocus(btn) {
        if (btn && document.activeElement === btn) btn.blur();
        var focusTarget = getSettingsScrollHost() || getFilesScrollHost();
        if (focusTarget && typeof focusTarget.focus === 'function') {
            try {
                focusTarget.focus({ preventScroll: true });
            } catch (e) {
                focusTarget.focus();
            }
        }
    }

    function runPaginationAction(handler) {
        var saved = capturePaginationScrollState();
        var result;
        try {
            result = handler();
        } catch (err) {
            restorePaginationScrollState(saved);
            throw err;
        }
        if (result && typeof result.then === 'function') {
            return result.then(function (value) {
                restorePaginationScrollState(saved);
                return value;
            }, function (err) {
                restorePaginationScrollState(saved);
                throw err;
            });
        }
        restorePaginationScrollState(saved);
        return result;
    }

    function bindPaginationButton(btn, handler) {
        if (!btn || btn.dataset.paginationBound === '1') return;
        btn.dataset.paginationBound = '1';
        btn.setAttribute('tabindex', '-1');
        ['pointerdown', 'mousedown'].forEach(function (eventName) {
            btn.addEventListener(eventName, function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
            }, true);
        });
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var run = runPaginationAction(handler);
            var finishFocus = function () {
                releasePaginationButtonFocus(btn);
            };
            if (run && typeof run.then === 'function') run.then(finishFocus, finishFocus);
            else finishFocus();
        });
    }

    function setupFilesPaginationControls() {
        var prevBtn = document.getElementById('filesPagePrev');
        var nextBtn = document.getElementById('filesPageNext');
        bindPaginationButton(prevBtn, filesPagePrev);
        bindPaginationButton(nextBtn, filesPageNext);
    }

    function setupSettingsPaginationControls() {
        var prevBtn = document.getElementById('settingsPagePrev');
        var nextBtn = document.getElementById('settingsPageNext');
        bindPaginationButton(prevBtn, function () {
            if (typeof window.settingsPagePrev === 'function') window.settingsPagePrev();
        });
        bindPaginationButton(nextBtn, function () {
            if (typeof window.settingsPageNext === 'function') window.settingsPageNext();
        });
    }

    window.resetFilesPagination = resetFilesPagination;
    window.applyFilesPageTokensFromResponse = applyFilesPageTokensFromResponse;
    window.setFilesPaginationLoading = setFilesPaginationLoading;
    window.updateFilesPaginationUI = updateFilesPaginationUI;
    window.filesPagePrev = filesPagePrev;
    window.filesPageNext = filesPageNext;
    window.getActivePaginationMenu = getActivePaginationMenu;
    window.getFilesScrollHost = getFilesScrollHost;
    window.getSettingsScrollHost = getSettingsScrollHost;
    window.setupFilesPaginationControls = setupFilesPaginationControls;
    window.setupSettingsPaginationControls = setupSettingsPaginationControls;
})();
