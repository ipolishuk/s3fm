/**
 * 1) Сайдбар на главном экране: loadBuckets, displayBuckets, поиск по списку.
 * 2) Настройки бакетов в админ-панели: таблица, модалка добавления/редактирования, удаление.
 * Зависит от window.I18N, window.showError/showInfo (modal.js), window.settingsPanelState, window.fileManagerCurrentUser (index).
 */
(function () {
    'use strict';

    var addBucketEditCloseDropdowns = null;
    var bucketModalListenersBound = false;
    var bucketIdValidateTimer = null;

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

    function noAccessFooterHtml(I18N) {
        var linkText = (I18N && I18N['buckets.no_access_help']) || 'Support';
        return '<div class="no-buckets-message-support">' +
            '<a href="/help/support">' + escapeHtml(linkText) + '</a></div>';
    }

    function setSearchFieldLocked(input, locked) {
        if (!input) return;
        if (!input.classList.contains('search-input')) {
            input.classList.add('search-input');
        }
        var container = input.closest('.search-container');
        if (locked) {
            if (!Object.prototype.hasOwnProperty.call(input.dataset, 'preLockDisabled')) {
                input.dataset.preLockDisabled = input.disabled ? '1' : '0';
            }
            input.disabled = true;
            input.classList.add('search-input-disabled');
            input.setAttribute('aria-disabled', 'true');
            if (container) container.classList.add('search-container-disabled');
        } else {
            if (Object.prototype.hasOwnProperty.call(input.dataset, 'preLockDisabled')) {
                input.disabled = input.dataset.preLockDisabled === '1';
                delete input.dataset.preLockDisabled;
            } else {
                input.disabled = false;
            }
            input.classList.remove('search-input-disabled');
            input.removeAttribute('aria-disabled');
            if (container) container.classList.remove('search-container-disabled');
        }
    }

    function setSettingsToolbarState(visible, options) {
        options = options || {};
        var toolbar = document.getElementById('secondaryToolbar');
        if (!toolbar) return;
        if (visible === false) {
            toolbar.classList.add('hidden');
            return;
        }
        toolbar.classList.remove('hidden');
        toolbar.style.display = 'flex';

        var searchLocked = !!(options.searchLocked || options.hideSearch);
        var searchContainer = toolbar.querySelector('.search-container');
        var searchInput = document.getElementById('settingsSearchInput');
        var searchClear = document.getElementById('settingsSearchClear');
        if (searchContainer) searchContainer.classList.remove('hidden');
        if (searchInput) {
            if (searchLocked) searchInput.value = '';
            setSearchFieldLocked(searchInput, searchLocked);
        }
        if (searchClear) {
            if (searchLocked) searchClear.classList.add('hidden');
        }
    }

    function setSettingsToolbarVisible(visible, options) {
        setSettingsToolbarState(visible, options);
    }

    /** cloud_id / endpoint из текстовых полей, если справочники облаков пусты. */
    function getBucketFormCloudId(isEdit) {
        if (!isEdit) {
            var manualCloud = document.getElementById('addBucketCloudAddGroup');
            if (manualCloud && !manualCloud.classList.contains('hidden')) {
                return (document.getElementById('addBucketCloudId').value || '').trim();
            }
        }
        var el = document.getElementById('addBucketEditCloudValue');
        return ((el && el.value) || '').trim();
    }

    function getBucketFormEndpointUrl(isEdit) {
        if (!isEdit) {
            var manualEp = document.getElementById('addBucketEndpointUrlAddGroup');
            if (manualEp && !manualEp.classList.contains('hidden')) {
                return (document.getElementById('addBucketEndpointUrl').value || '').trim();
            }
        }
        var el = document.getElementById('addBucketEndpointUrlHidden');
        return ((el && el.value) || '').trim();
    }

    function applyBucketFormManualCatalogMode(noClouds) {
        if (noClouds) {
            var ga = document.getElementById('addBucketCloudAddGroup');
            var ge = document.getElementById('addBucketCloudEditGroup');
            var geuAdd = document.getElementById('addBucketEndpointUrlAddGroup');
            var geuEdit = document.getElementById('addBucketEndpointUrlEditGroup');
            if (ga) ga.classList.remove('hidden');
            if (ge) ge.classList.add('hidden');
            if (geuAdd) geuAdd.classList.remove('hidden');
            if (geuEdit) geuEdit.classList.add('hidden');
        }
    }

    /** 12 hex-символов (6 байт), как allocate_bucket_id на сервере */
    function generateNewBucketId12() {
        var arr = new Uint8Array(6);
        var c = window.crypto;
        if (c && typeof c.getRandomValues === 'function') {
            c.getRandomValues(arr);
        } else {
            for (var i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
        }
        var hex = '';
        for (var j = 0; j < 6; j++) {
            var h = arr[j].toString(16);
            hex += h.length < 2 ? '0' + h : h;
        }
        return hex;
    }

    function getSettingsBucketsSnapshot() {
        return window._settingsBucketsSnapshot || [];
    }

    /** true, если пара (cloud_id, display_name) уже у другой строки */
    function isBucketKeyTakenByOther(cloudId, displayName, excludeCloudId, excludeDisplayName) {
        var cid = (cloudId || '').trim();
        var dn = (displayName || '').trim();
        if (!cid || !dn) return false;
        var rows = getSettingsBucketsSnapshot();
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r) continue;
            if (String(r.cloud_id) !== cid || String(r.display_name) !== dn) continue;
            if (excludeCloudId != null && excludeDisplayName != null &&
                String(r.cloud_id) === String(excludeCloudId) &&
                String(r.display_name) === String(excludeDisplayName)) {
                continue;
            }
            return true;
        }
        return false;
    }

    /** true, если bucket_id уже у другой строки (не exclude cloud/display) */
    function isBucketIdTakenByOther(bucketId, excludeCloudId, excludeDisplayName) {
        var v = (bucketId || '').trim();
        if (!v) return false;
        var rows = getSettingsBucketsSnapshot();
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r) continue;
            var rid = String(r.bucket_id != null ? r.bucket_id : '').trim();
            if (rid !== v) continue;
            if (excludeCloudId != null && excludeDisplayName != null &&
                String(r.cloud_id) === String(excludeCloudId) &&
                String(r.display_name) === String(excludeDisplayName)) {
                continue;
            }
            return true;
        }
        return false;
    }

    /** true, если та же пара (bucket_name + endpoint_url) уже у другой строки */
    function isBucketS3TargetTakenByOther(bucketName, endpointUrl, excludeCloudId, excludeDisplayName) {
        var bn = (bucketName || '').trim().toLowerCase();
        var ep = (endpointUrl || '').trim().replace(/\/+$/, '').toLowerCase();
        if (!bn || !ep) return false;
        var rows = getSettingsBucketsSnapshot();
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r) continue;
            if (excludeCloudId != null && excludeDisplayName != null &&
                String(r.cloud_id) === String(excludeCloudId) &&
                String(r.display_name) === String(excludeDisplayName)) {
                continue;
            }
            var rbn = String(r.bucket_name != null ? r.bucket_name : '').trim().toLowerCase();
            var rep = String(r.endpoint_url != null ? r.endpoint_url : '').trim().replace(/\/+$/, '').toLowerCase();
            if (rbn && rep && rbn === bn && rep === ep) return true;
        }
        return false;
    }

    function clearBucketIdDuplicateError(errEl) {
        if (!errEl || errEl.getAttribute('data-error-kind') !== 'bucket_id_dup') return;
        errEl.textContent = '';
        errEl.removeAttribute('data-error-kind');
    }

    function toastBucketFormError(message) {
        if (!message) return;
        if (typeof showError === 'function') {
            showError(message);
        }
    }

    function showBucketIdDuplicateError(errEl, message) {
        if (errEl) {
            errEl.setAttribute('data-error-kind', 'bucket_id_dup');
            errEl.textContent = '';
        }
        toastBucketFormError(message);
    }

    function validateBucketIdOnInput() {
        var bidEl = document.getElementById('addBucketBucketId');
        var errEl = document.getElementById('addBucketError');
        if (!bidEl || !errEl) return;
        if (bidEl.readOnly) return;
        var modal = document.getElementById('addBucketModal');
        var ec = modal && modal.dataset.editCloudId;
        var ed = modal && modal.dataset.editDisplayName;
        var t = window.I18N || {};
        var dupMsg = t['settings.error_bucket_id_duplicate'] || 'This Bucket ID is already in use';
        var v = (bidEl.value || '').trim();
        if (!v) {
            clearBucketIdDuplicateError(errEl);
            return;
        }
        if (isBucketIdTakenByOther(v, ec, ed)) {
            showBucketIdDuplicateError(errEl, dupMsg);
        } else {
            clearBucketIdDuplicateError(errEl);
        }
    }

    function scheduleValidateBucketId() {
        if (bucketIdValidateTimer) clearTimeout(bucketIdValidateTimer);
        bucketIdValidateTimer = setTimeout(function () {
            bucketIdValidateTimer = null;
            validateBucketIdOnInput();
        }, 200);
    }

    function setAddBucketIdFieldForMode(isEdit, bucketIdValue) {
        var bidEl = document.getElementById('addBucketBucketId');
        if (!bidEl) return;
        var t = window.I18N || {};
        if (isEdit) {
            bidEl.value = bucketIdValue != null ? String(bucketIdValue) : '';
        } else {
            var chosen = '';
            var genT = window.I18N || {};
            for (var attempt = 0; attempt < 64; attempt++) {
                var cand = generateNewBucketId12();
                if (!isBucketIdTakenByOther(cand, null, null)) {
                    chosen = cand;
                    break;
                }
            }
            bidEl.value = chosen;
            var errGen = document.getElementById('addBucketError');
            if (!chosen && errGen) {
                showBucketIdDuplicateError(errGen, genT['settings.error_bucket_id_unique_gen'] || '');
            } else if (chosen && errGen && errGen.getAttribute('data-error-kind') === 'bucket_id_dup') {
                clearBucketIdDuplicateError(errGen);
            }
        }
        // Bucket ID неизменяем: автогенерация при создании, только просмотр при редактировании
        bidEl.readOnly = true;
        bidEl.setAttribute('readonly', 'readonly');
        bidEl.setAttribute('aria-readonly', 'true');
        bidEl.title = isEdit
            ? (t['modal.bucket_id_locked_hint'] || t['modal.bucket_id_readonly_hint'] || '')
            : (t['modal.bucket_id_readonly_hint'] || '');
    }

    function isCurrentUserAdmin() {
        var user = window.fileManagerCurrentUser;
        return !!(user && String(user.role || '').toLowerCase() === 'admin');
    }

    function canManageBucketAccessUi() {
        if (typeof window.isCurrentUserAdmin === 'function' && window.isCurrentUserAdmin()) return true;
        if (typeof window.isCurrentUserStorageAdmin === 'function' && window.isCurrentUserStorageAdmin()) return true;
        if (typeof window.canOpenSettings === 'function' && window.canOpenSettings()) return true;
        var user = window.fileManagerCurrentUser;
        if (!user) return false;
        var role = String(user.role || '').toLowerCase();
        return role === 'admin' || role === 'storage_admin';
    }

    function skipTlsValueFromRaw(raw) {
        return raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 't';
    }

    function setAddBucketSkipTls(value) {
        var on = !!value;
        var hidden = document.getElementById('addBucketSkipTlsVerify');
        var label = document.getElementById('addBucketSkipTlsLabel');
        var panel = document.getElementById('addBucketSkipTlsPanel');
        if (hidden) hidden.value = on ? 'true' : 'false';
        if (label) {
            label.textContent = on ? 'true' : 'false';
            label.classList.add('has-selection');
        }
        if (panel) {
            panel.querySelectorAll('.dropdown-item').forEach(function (item) {
                item.classList.toggle('selected', item.getAttribute('data-value') === (on ? 'true' : 'false'));
            });
        }
    }

    function getAddBucketSkipTls() {
        var hidden = document.getElementById('addBucketSkipTlsVerify');
        return skipTlsValueFromRaw(hidden ? hidden.value : 'false');
    }

    function initAddBucketSkipTlsDropdown() {
        var wrap = document.getElementById('addBucketSkipTlsWrap');
        var trigger = document.getElementById('addBucketSkipTlsTrigger');
        var panel = document.getElementById('addBucketSkipTlsPanel');
        if (!wrap || !trigger || !panel || wrap._skipTlsDdBound) return;
        wrap._skipTlsDdBound = true;
        trigger.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var willOpen = !wrap.classList.contains('open');
            wrap.classList.remove('open');
            if (typeof window.resetDropdownMenuOverlay === 'function') {
                window.resetDropdownMenuOverlay(wrap);
            }
            // close other bucket form dropdowns
            ['addBucketEditCloudWrap', 'addBucketEditEndpointWrap'].forEach(function (id) {
                var w = document.getElementById(id);
                if (!w) return;
                w.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(w);
            });
            if (willOpen) {
                wrap.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
                panel.classList.remove('hidden');
                if (typeof window.fitDropdownMenuOverlay === 'function') {
                    window.fitDropdownMenuOverlay(wrap);
                }
            } else {
                trigger.setAttribute('aria-expanded', 'false');
                panel.classList.add('hidden');
            }
        });
        panel.querySelectorAll('.dropdown-item').forEach(function (item) {
            item.addEventListener('click', function (ev) {
                ev.stopPropagation();
                setAddBucketSkipTls(item.getAttribute('data-value') === 'true');
                wrap.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
                panel.classList.add('hidden');
                if (typeof window.resetDropdownMenuOverlay === 'function') {
                    window.resetDropdownMenuOverlay(wrap);
                }
            });
        });
    }

    function setAddBucketNameFieldForMode(isEdit, bucketNameValue) {
        var bnEl = document.getElementById('addBucketBucketName');
        var bnHidden = document.getElementById('addBucketBucketNameHidden');
        if (!bnEl) return;
        var t = window.I18N || {};
        var value = bucketNameValue != null ? String(bucketNameValue) : '';
        bnEl.value = value;
        if (bnHidden) bnHidden.value = value;
        // При редактировании Bucket name может менять только admin
        var lockName = isEdit && !isCurrentUserAdmin();
        if (lockName) {
            bnEl.readOnly = true;
            bnEl.setAttribute('readonly', 'readonly');
            bnEl.setAttribute('aria-readonly', 'true');
            bnEl.title = t['modal.bucket_name_locked_hint'] || '';
        } else {
            bnEl.readOnly = false;
            bnEl.removeAttribute('readonly');
            bnEl.removeAttribute('aria-readonly');
            bnEl.removeAttribute('title');
        }
    }

    function teardownAddBucketEditDropdowns() {
        var bm = document.getElementById('addBucketModal');
        if (bm && bm._bucketFocusClose) {
            bm.removeEventListener('focusin', bm._bucketFocusClose, true);
            delete bm._bucketFocusClose;
        }
        if (addBucketEditCloseDropdowns) {
            document.removeEventListener('click', addBucketEditCloseDropdowns);
            addBucketEditCloseDropdowns = null;
        }
    }

    function setFormControlRevealLabel(btn, label) {
        if (!btn) return;
        var span = btn.querySelector('.form-control-reveal-label');
        if (span) span.textContent = label;
        else if (!btn.querySelector('.fa-eye, .fa-eye-slash')) btn.textContent = label;
    }

    function setFormControlRevealIcon(btn, revealed) {
        if (!btn) return;
        var icon = btn.querySelector('.fa-eye, .fa-eye-slash');
        if (!icon) return;
        icon.classList.remove('fa-eye', 'fa-eye-slash');
        icon.classList.add(revealed ? 'fa-eye-slash' : 'fa-eye');
    }

    function resetAddBucketSecretKeyVisibility() {
        var input = document.getElementById('addBucketSecretKey');
        var btn = document.getElementById('addBucketSecretKeyToggle');
        if (!input || !btn) return;
        input.type = 'password';
        btn.setAttribute('aria-pressed', 'false');
        var t = window.I18N || {};
        var showLabel = t['modal.secret_key_show'] || 'Show secret key';
        btn.setAttribute('aria-label', showLabel);
        btn.title = showLabel;
        setFormControlRevealLabel(btn, showLabel);
        setFormControlRevealIcon(btn, false);
    }

    function copyTextToClipboard(text, onSuccess, onFail) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onSuccess).catch(onFail);
            return;
        }
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) onSuccess();
            else onFail();
        } catch (e) {
            onFail();
        }
    }

    function copyAddBucketField(inputId, emptyKey, copiedKey, failedKey, emptyFallback, copiedFallback, failedFallback) {
        var input = document.getElementById(inputId);
        if (!input) return;
        var t = window.I18N || {};
        var value = (input.value || '').trim();
        if (!value) {
            if (typeof showInfo === 'function') {
                showInfo(t[emptyKey] || emptyFallback);
            }
            return;
        }
        copyTextToClipboard(
            input.value,
            function () {
                if (typeof showInfo === 'function') {
                    showInfo(t[copiedKey] || copiedFallback);
                }
            },
            function () {
                if (typeof showError === 'function') {
                    showError(t[failedKey] || failedFallback);
                }
            }
        );
    }

    function copyAddBucketAccessKey() {
        copyAddBucketField(
            'addBucketAccessKey',
            'modal.access_key_copy_empty',
            'modal.access_key_copied',
            'modal.access_key_copy_failed',
            'Access key is empty',
            'Access key copied',
            'Could not copy access key'
        );
    }

    function copyAddBucketSecretKey() {
        copyAddBucketField(
            'addBucketSecretKey',
            'modal.secret_key_copy_empty',
            'modal.secret_key_copied',
            'modal.secret_key_copy_failed',
            'Secret key is empty',
            'Secret key copied',
            'Could not copy secret key'
        );
    }

    function toggleAddBucketSecretKeyVisibility() {
        var input = document.getElementById('addBucketSecretKey');
        var btn = document.getElementById('addBucketSecretKeyToggle');
        if (!input || !btn) return;
        var t = window.I18N || {};
        var showLabel = t['modal.secret_key_show'] || 'Show secret key';
        var hideLabel = t['modal.secret_key_hide'] || 'Hide secret key';
        if (input.type === 'password') {
            input.type = 'text';
            btn.setAttribute('aria-pressed', 'true');
            btn.setAttribute('aria-label', hideLabel);
            btn.title = hideLabel;
            setFormControlRevealLabel(btn, hideLabel);
            setFormControlRevealIcon(btn, true);
        } else {
            input.type = 'password';
            btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('aria-label', showLabel);
            btn.title = showLabel;
            setFormControlRevealLabel(btn, showLabel);
            setFormControlRevealIcon(btn, false);
        }
    }

    function applyBucketModalLayout() {
        teardownAddBucketEditDropdowns();
        var ga = document.getElementById('addBucketCloudAddGroup');
        var gd = document.getElementById('addBucketDisplayAddGroup');
        var ge = document.getElementById('addBucketCloudEditGroup');
        var gbnAdd = document.getElementById('addBucketBucketNameAddGroup');
        var geuAdd = document.getElementById('addBucketEndpointUrlAddGroup');
        var geuEdit = document.getElementById('addBucketEndpointUrlEditGroup');
        if (ga) ga.classList.add('hidden');
        if (gd) gd.classList.remove('hidden');
        if (ge) ge.classList.remove('hidden');
        if (gbnAdd) gbnAdd.classList.remove('hidden');
        /* URL облака: всегда выпадающий список (и при создании, и при редактировании) */
        if (geuAdd) geuAdd.classList.add('hidden');
        if (geuEdit) geuEdit.classList.remove('hidden');
        updateAddBucketTestBtnVisibility();
    }

    function canShowBucketTestBtn() {
        var user = window.fileManagerCurrentUser;
        if (user && String(user.role || '').toLowerCase() === 'admin') return true;
        return typeof window.userHasPermission === 'function' && window.userHasPermission('add_bucket');
    }

    function updateAddBucketTestBtnVisibility() {
        var btn = document.getElementById('addBucketTestBtn');
        if (!btn) return;
        if (canShowBucketTestBtn()) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
        }
    }

    function prepareBucketModalAddMode() {
        applyBucketModalLayout();
    }

    function prepareBucketModalEditMode() {
        applyBucketModalLayout();
    }

    function reloadSettingsBucketsSoft() {
        loadSettingsBuckets({ soft: true });
    }

    function reloadSettingsAfterBucketMutation() {
        var tab = window.settingsPanelState && window.settingsPanelState.currentTab;
        if (tab === 'search' && typeof window.loadSettingsSearch === 'function') {
            window.loadSettingsSearch({ soft: true });
        } else if (tab === 'status' && typeof window.loadSettingsStatus === 'function') {
            window.loadSettingsStatus({ soft: true });
        } else {
            loadSettingsBuckets({ soft: true });
        }
    }

    function loadSettingsBuckets(options) {
        options = options || {};
        var soft = !!options.soft;
        if (window.settingsPanelState) {
            if (!soft || window.settingsPanelState.currentTab !== 'search') {
                window.settingsPanelState.currentTab = 'buckets';
            }
        }
        var settingsContentInner = document.getElementById('settingsContentInner');
        var settingsSearchInput = document.getElementById('settingsSearchInput');
        var settingsSearchClear = document.getElementById('settingsSearchClear');
        if (!settingsContentInner) return;

        var viewState = soft && typeof window.captureSettingsTableViewState === 'function'
            ? window.captureSettingsTableViewState()
            : null;

        var t = window.I18N || {};
        if (!soft) {
            setSettingsToolbarVisible(false);
            if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
            if (typeof window.resetSettingsSearchLayout === 'function') {
                window.resetSettingsSearchLayout();
            }
            settingsContentInner.classList.remove('content-body-soft-refresh');
            settingsContentInner.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin empty-state-icon"></i><div>' + (t['settings.loading'] || 'Loading...') + '</div></div>';
        } else {
            settingsContentInner.classList.add('content-body-soft-refresh');
            setSettingsToolbarState(true, { searchLocked: false });
        }

        fetch('/api/settings/buckets', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.statusText)); })
            .then(function (data) {
                settingsContentInner.classList.remove('content-body-soft-refresh');
                var items = data.items || [];
                window._settingsBucketsSnapshot = items;
                if (typeof window.setSettingsMenuCountById === 'function') {
                    window.setSettingsMenuCountById('settingsCountBuckets', items.length);
                }
                if (items.length === 0) {
                    var emptyHint = t['settings.no_buckets_hint'] || '';
                    settingsContentInner.innerHTML =
                        '<div class="empty-state">' +
                        '<i class="fa-solid fa-database empty-state-icon"></i>' +
                        (emptyHint ? '<div class="empty-state-title">' + escapeHtml(emptyHint) + '</div>' : '') +
                        '</div>';
                    setSettingsToolbarState(true, { searchLocked: true });
                    if (!soft && typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
                    return;
                }
                setSettingsToolbarState(true, { searchLocked: false });
                if (!soft) {
                    if (settingsSearchInput) settingsSearchInput.value = '';
                    if (settingsSearchClear) settingsSearchClear.classList.add('hidden');
                }
                var credTh = (t['settings.table_credentials'] || 'Credentials').replace(/"/g, '&quot;');
                var credThTitle = (t['settings.table_credentials_th_title'] || '').replace(/"/g, '&quot;');
                var tlsTh = (t['settings.table_tls'] || 'TLS').replace(/"/g, '&quot;');
                var tlsThTitle = (t['settings.table_tls_th_title'] || '').replace(/"/g, '&quot;');
                var caTh = (t['settings.table_ca_path'] || 'CA path').replace(/"/g, '&quot;');
                var caThTitle = (t['settings.table_ca_path_th_title'] || '').replace(/"/g, '&quot;');
                var html = '<table class="content-table"><thead><tr>'
                    + '<th><div class="content-table-header">' + (t['settings.table_bucket_name'] || 'Bucket Name') + '</div></th>'
                    + '<th class="settings-col-display"><div class="content-table-header">' + (t['settings.table_display_name'] || 'Display Name') + '</div></th>'
                    + '<th class="settings-col-bucket-id"><div class="content-table-header">' + (t['settings.table_bucket_id'] || 'Bucket ID') + '</div></th>'
                    + '<th><div class="content-table-header">' + (t['settings.table_cloud'] || 'Cloud') + '</div></th>'
                    + '<th class="content-table-col-compact settings-col-credentials" title="' + credThTitle + '"><div class="content-table-header">' + credTh + '</div></th>'
                    + '<th class="content-table-col-compact settings-col-tls" title="' + tlsThTitle + '"><div class="content-table-header">' + tlsTh + '</div></th>'
                    + '<th class="content-table-col-compact settings-col-ca" title="' + caThTitle + '"><div class="content-table-header">' + caTh + '</div></th>'
                    + '</tr></thead><tbody id="settingsTableBody">';
                items.forEach(function (row) {
                    var credHas = !!(row.has_access_key && row.has_secret_key);
                    var stv = row.skip_tls_verify === true || row.skip_tls_verify === 'true' || row.skip_tls_verify === 1 || row.skip_tls_verify === 't';
                    var caSet = row.ca_bundle_path != null && String(row.ca_bundle_path).trim() !== '';
                    var credCellTitle = (credHas ? (t['settings.table_credentials_on_title'] || '') : (t['settings.table_credentials_off_title'] || '')).replace(/"/g, '&quot;');
                    var tlsCellTitle = (stv ? (t['settings.table_tls_on_title'] || '') : (t['settings.table_tls_off_title'] || '')).replace(/"/g, '&quot;');
                    var caCellTitle = (caSet ? (t['settings.table_ca_on_title'] || '') : (t['settings.table_ca_off_title'] || '')).replace(/"/g, '&quot;');
                    var cloudIdAttr = (row.cloud_id || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    var displayNameAttr = (row.display_name || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    var bucketIdAttr = (row.bucket_id || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    var bucketNameAttr = (row.bucket_name || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    var canDelete = (typeof window.isCurrentUserAdmin === 'function')
                        ? window.isCurrentUserAdmin()
                        : false;
                    html += '<tr data-cloud-id="' + cloudIdAttr + '" data-display-name="' + displayNameAttr +
                        '" data-bucket-id="' + bucketIdAttr + '" data-bucket-name="' + bucketNameAttr + '"'
                        + ' data-can-edit="1" data-can-delete="' + (canDelete ? '1' : '0') + '">'
                        + '<td>' + escapeHtml(row.bucket_name) + '</td>'
                        + '<td class="settings-col-display">' + escapeHtml(row.display_name) + '</td>'
                        + '<td class="settings-col-bucket-id">' + escapeHtml(row.bucket_id || '—') + '</td>'
                        + '<td>' + escapeHtml(row.cloud_id) + '</td>'
                        + '<td class="content-table-col-compact settings-col-credentials" title="' + credCellTitle + '">' + (credHas ? '<span class="content-table-bool-yes"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : '<span class="content-table-bool-no">—</span>') + '</td>'
                        + '<td class="content-table-col-compact settings-col-tls" title="' + tlsCellTitle + '">' + (stv ? '<span class="content-table-bool-yes"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : '<span class="content-table-bool-no">—</span>') + '</td>'
                        + '<td class="content-table-col-compact settings-col-ca" title="' + caCellTitle + '">' + (caSet ? '<span class="content-table-bool-yes"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : '<span class="content-table-bool-no">—</span>') + '</td>'
                        + '</tr>';
                });
                html += '</tbody></table>';
                settingsContentInner.innerHTML = html;
                if (typeof window.onSettingsTableRendered === 'function') {
                    window.onSettingsTableRendered({ preservePage: soft });
                }
                if (soft && viewState && typeof window.restoreSettingsTableViewState === 'function') {
                    window.restoreSettingsTableViewState(viewState);
                }
            })
            .catch(function () {
                settingsContentInner.classList.remove('content-body-soft-refresh');
                if (typeof window.setSettingsMenuCountById === 'function') {
                    window.setSettingsMenuCountById('settingsCountBuckets', 0);
                }
                settingsContentInner.innerHTML = '<div class="content-empty">' + (t['settings.error_load'] || 'Error loading or access denied') + '</div>';
                if (!soft && typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
            });
    }

    function setupBucketFormDropdowns(_modal, cloudItems, _bucketItems, endpointItems, cfg) {
        cfg = cfg || {};
        var cloudIdArg = cfg.cloudId;
        var displayName = cfg.displayName || '';
        var initialBucketName = (cfg.bucketName == null || cfg.bucketName === undefined) ? '' : ('' + cfg.bucketName).trim();
        var initialEndpointUrl = (cfg.endpointUrl == null || cfg.endpointUrl === undefined) ? '' : ('' + cfg.endpointUrl).trim();
        var row = cfg.row || null;
        var prefillFromRow = cfg.prefillFromRow || null;
        var isEditForm = !!row;

        var cloudPanel = document.getElementById('addBucketEditCloudPanel');
        var cloudLabel = document.getElementById('addBucketEditCloudLabel');
        var cloudWrap = document.getElementById('addBucketEditCloudWrap');
        var cloudTrigger = document.getElementById('addBucketEditCloudTrigger');
        var cloudValue = document.getElementById('addBucketEditCloudValue');
        var cloudNameH = document.getElementById('addBucketEditCloudName');
        var epPanel = document.getElementById('addBucketEditEndpointPanel');
        var epLabel = document.getElementById('addBucketEditEndpointLabel');
        var epWrap = document.getElementById('addBucketEditEndpointWrap');
        var epTrigger = document.getElementById('addBucketEditEndpointTrigger');
        var epHidden = document.getElementById('addBucketEndpointUrlHidden');
        var dispEl = document.getElementById('addBucketDisplayName');
        var endpointItemsRef = endpointItems || [];

        var effectiveCloudId = (cloudIdArg || '').trim();
        if (!effectiveCloudId && cloudItems && cloudItems.length) {
            effectiveCloudId = cloudItems[0].id;
        }

        function closeAllBE() {
            [cloudWrap, epWrap].forEach(function(w) {
                if (!w) return;
                w.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(w);
            });
            var skipWrap = document.getElementById('addBucketSkipTlsWrap');
            if (skipWrap) {
                skipWrap.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(skipWrap);
                var skipPanel = document.getElementById('addBucketSkipTlsPanel');
                var skipTrig = document.getElementById('addBucketSkipTlsTrigger');
                if (skipPanel) skipPanel.classList.add('hidden');
                if (skipTrig) skipTrig.setAttribute('aria-expanded', 'false');
            }
            if (cloudPanel._dropdownSearchSetMode) cloudPanel._dropdownSearchSetMode(false);
            if (epPanel._dropdownSearchSetMode) epPanel._dropdownSearchSetMode(false);
        }
        function toggleBE(w, p) {
            var willOpen = !w.classList.contains('open');
            closeAllBE();
            if (willOpen) {
                w.classList.add('open');
                if (p._dropdownSearchSetMode) p._dropdownSearchSetMode(true);
                p.classList.remove('hidden');
                if (typeof window.fitDropdownMenuOverlay === 'function') window.fitDropdownMenuOverlay(w);
            }
        }

        function rebuildEndpointPanel(selectedCloudId, selectEndpointUrl) {
            var filtered = endpointItemsRef.filter(function (it) { return (it.cloud_id + '') === (selectedCloudId + ''); });
            var want = (selectEndpointUrl || '').trim();
            var urls = [];
            var seenU = {};
            function pushEndpointUrl(u) {
                u = (u || '').trim();
                if (!u || seenU[u]) return;
                seenU[u] = true;
                urls.push(u);
            }
            for (var ui = 0; ui < filtered.length; ui++) {
                if ((filtered[ui].bucket_display_name || '') === '') {
                    pushEndpointUrl(filtered[ui].endpoint_url);
                }
            }
            for (var uj = 0; uj < filtered.length; uj++) {
                pushEndpointUrl(filtered[uj].endpoint_url);
            }
            var nameToSelect = want;
            var hasMatch = false;
            for (var hi = 0; hi < urls.length; hi++) {
                if (urls[hi] === want) { hasMatch = true; break; }
            }
            if (want && !hasMatch && urls.length > 0) {
                nameToSelect = urls[0];
                hasMatch = true;
            }
            if (!want && urls.length > 0) {
                nameToSelect = urls[0];
                hasMatch = true;
            }
            epPanel.innerHTML = '';
            if (urls.length === 0 && want) {
                var epOrphan = document.createElement('div');
                epOrphan.className = 'dropdown-item selected';
                epOrphan.setAttribute('role', 'option');
                epOrphan.textContent = want;
                epOrphan.addEventListener('click', function () {
                    epHidden.value = want;
                    epLabel.textContent = want;
                    epLabel.classList.add('has-selection');
                    epWrap.classList.remove('open');
                    if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(epWrap);
                });
                epPanel.appendChild(epOrphan);
                epHidden.value = want;
                epLabel.textContent = want;
                epLabel.classList.add('has-selection');
                return;
            }
            for (var ei = 0; ei < urls.length; ei++) {
                (function (url) {
                    var lab = document.createElement('div');
                    lab.className = 'dropdown-item';
                    lab.setAttribute('role', 'option');
                    lab.textContent = url;
                    if (url === nameToSelect) lab.classList.add('selected');
                    lab.addEventListener('click', function () {
                        epHidden.value = url;
                        epLabel.textContent = url;
                        epLabel.classList.add('has-selection');
                        var opts = epPanel.querySelectorAll('.dropdown-item');
                        for (var oi = 0; oi < opts.length; oi++) opts[oi].classList.remove('selected');
                        lab.classList.add('selected');
                        epWrap.classList.remove('open');
                        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(epWrap);
                    });
                    epPanel.appendChild(lab);
                })(urls[ei]);
            }
            epHidden.value = nameToSelect;
            epLabel.textContent = nameToSelect || '—';
            epLabel.classList.toggle('has-selection', !!nameToSelect);
        }

        if (dispEl) dispEl.value = displayName;
        cloudPanel.innerHTML = '';
        for (var ci = 0; ci < cloudItems.length; ci++) {
            (function (item) {
                var lab = document.createElement('div');
                lab.className = 'dropdown-item';
                lab.setAttribute('role', 'option');
                lab.textContent = item.label || item.id;
                lab.dataset.cloudId = item.id;
                lab.dataset.cloudName = item.label || item.id;
                if (item.id === effectiveCloudId) lab.classList.add('selected');
                lab.addEventListener('click', function () {
                    closeAllBE();
                    var newCloudId = (item.id != null ? String(item.id) : '').trim();
                    cloudValue.value = newCloudId;
                    cloudNameH.value = item.label || item.id;
                    cloudLabel.textContent = lab.dataset.cloudName;
                    cloudLabel.classList.add('has-selection');
                    var cpts = cloudPanel.querySelectorAll('.dropdown-item');
                    for (var cpi = 0; cpi < cpts.length; cpi++) cpts[cpi].classList.remove('selected');
                    lab.classList.add('selected');
                    cloudWrap.classList.remove('open');
                    if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(cloudWrap);
                    /* Не сохраняем URL от предыдущего облака: подставляем дефолт для выбранного облака */
                    rebuildEndpointPanel(newCloudId, '');
                });
                cloudPanel.appendChild(lab);
            })(cloudItems[ci]);
        }
        var curCloud = null;
        for (var cci = 0; cci < cloudItems.length; cci++) {
            if (cloudItems[cci].id === effectiveCloudId) { curCloud = cloudItems[cci]; break; }
        }
        cloudValue.value = effectiveCloudId;
        cloudNameH.value = curCloud ? (curCloud.label || effectiveCloudId) : (effectiveCloudId || '');
        cloudLabel.textContent = curCloud ? (curCloud.label || effectiveCloudId) : (effectiveCloudId ? effectiveCloudId : '—');
        cloudLabel.classList.toggle('has-selection', !!effectiveCloudId);
        if (isEditForm) {
            setAddBucketNameFieldForMode(true, initialBucketName);
        } else {
            setAddBucketNameFieldForMode(false, initialBucketName || '');
        }
        if (row && row.endpoint_url != null && String(row.endpoint_url).trim() !== '') {
            initialEndpointUrl = ('' + row.endpoint_url).trim();
        }
        epHidden.value = initialEndpointUrl;
        rebuildEndpointPanel(effectiveCloudId, initialEndpointUrl);
        if (!isEditForm && (!cloudItems || cloudItems.length === 0)) {
            applyBucketFormManualCatalogMode(true);
        }

        if (row) {
            setAddBucketIdFieldForMode(true, row.bucket_id || '');
            document.getElementById('addBucketAccessKey').value = row.aws_access_key_id || '';
            document.getElementById('addBucketSecretKey').value = row.aws_secret_access_key || '';
            document.getElementById('addBucketCaBundlePath').value = (row.ca_bundle_path != null && row.ca_bundle_path !== undefined) ? String(row.ca_bundle_path) : '';
            document.getElementById('addBucketRegionName').value = (row.region_name != null && row.region_name !== undefined) ? String(row.region_name) : '';
            var st = row.skip_tls_verify;
            setAddBucketSkipTls(skipTlsValueFromRaw(st));
        } else {
            // Создание и копирование: новый Bucket ID, поле locked
            setAddBucketIdFieldForMode(false);
            if (prefillFromRow) {
                document.getElementById('addBucketAccessKey').value = prefillFromRow.aws_access_key_id || '';
                document.getElementById('addBucketSecretKey').value = prefillFromRow.aws_secret_access_key || '';
                document.getElementById('addBucketCaBundlePath').value = (prefillFromRow.ca_bundle_path != null && prefillFromRow.ca_bundle_path !== undefined) ? String(prefillFromRow.ca_bundle_path) : '';
                document.getElementById('addBucketRegionName').value = (prefillFromRow.region_name != null && prefillFromRow.region_name !== undefined) ? String(prefillFromRow.region_name) : '';
                var stPf = prefillFromRow.skip_tls_verify;
                setAddBucketSkipTls(skipTlsValueFromRaw(stPf));
                // Не переносим bucket_id источника — ещё раз сгенерировать после prefill
                setAddBucketIdFieldForMode(false);
            } else {
                document.getElementById('addBucketAccessKey').value = '';
                document.getElementById('addBucketSecretKey').value = '';
                document.getElementById('addBucketCaBundlePath').value = '';
                document.getElementById('addBucketRegionName').value = '';
                setAddBucketSkipTls(false);
            }
        }

        cloudTrigger.onclick = function (e) {
            e.stopPropagation();
            toggleBE(cloudWrap, cloudPanel);
        };
        epTrigger.onclick = function (e) {
            e.stopPropagation();
            toggleBE(epWrap, epPanel);
        };
        teardownAddBucketEditDropdowns();
        addBucketEditCloseDropdowns = function beClose(e) {
            if (e && e.target && e.target.closest('.dropdown') !== null) return;
            closeAllBE();
            document.removeEventListener('click', beClose);
            addBucketEditCloseDropdowns = null;
        };
        setTimeout(function () {
            document.addEventListener('click', addBucketEditCloseDropdowns);
        }, 0);
        var bucketModalEl = document.getElementById('addBucketModal');
        if (bucketModalEl._bucketFocusClose) {
            bucketModalEl.removeEventListener('focusin', bucketModalEl._bucketFocusClose, true);
            delete bucketModalEl._bucketFocusClose;
        }
        if (bucketModalEl._bucketClickClose) {
            bucketModalEl.removeEventListener('click', bucketModalEl._bucketClickClose, true);
            delete bucketModalEl._bucketClickClose;
        }
        bucketModalEl._bucketFocusClose = function (ev) {
            if (bucketModalEl.style.display === 'none') return;
            if (!bucketModalEl.contains(ev.target)) return;
            if (ev.target.closest && ev.target.closest('.dropdown')) return;
            closeAllBE();
        };
        bucketModalEl.addEventListener('focusin', bucketModalEl._bucketFocusClose, true);
        bucketModalEl._bucketClickClose = function (ev) {
            if (bucketModalEl.style.display === 'none') return;
            if (!bucketModalEl.contains(ev.target)) return;
            if (ev.target.closest && ev.target.closest('.dropdown')) return;
            closeAllBE();
        };
        bucketModalEl.addEventListener('click', bucketModalEl._bucketClickClose, true);
        if (isEditForm) scheduleValidateBucketId();
        resetAddBucketSecretKeyVisibility();
    }

    function openAddBucketModal() {
        var modal = document.getElementById('addBucketModal');
        if (!modal) return;
        var t = window.I18N || {};
        delete modal.dataset.editCloudId;
        delete modal.dataset.editDisplayName;
        var errOpen = document.getElementById('addBucketError');
        if (errOpen) {
            errOpen.textContent = '';
            errOpen.removeAttribute('data-error-kind');
        }
        prepareBucketModalAddMode();
        setAddBucketIdFieldForMode(false);
        var titleEl = modal.querySelector('.modal-title') || document.querySelector('#addBucketModal .modal-title');
        if (titleEl) titleEl.textContent = t['modal.add_bucket'] || 'Add bucket';
        if (typeof window.setModalSubmitBtn === 'function') {
            window.setModalSubmitBtn(document.getElementById('addBucketSubmitBtn'), t['settings.add'] || 'Add', 'add');
        }
        document.getElementById('addBucketDisplayName').value = '';
        document.getElementById('addBucketBucketNameHidden').value = '';
        setAddBucketNameFieldForMode(false, '');
        var ephPre = document.getElementById('addBucketEndpointUrlHidden');
        if (ephPre) ephPre.value = '';
        var epUrlPre = document.getElementById('addBucketEndpointUrl');
        if (epUrlPre) epUrlPre.value = '';
        var eplPre = document.getElementById('addBucketEditEndpointLabel');
        if (eplPre) { eplPre.textContent = '—'; eplPre.classList.remove('has-selection'); }
        document.getElementById('addBucketCaBundlePath').value = '';
        document.getElementById('addBucketRegionName').value = '';
        setAddBucketSkipTls(false);
        var cloudIdManual = document.getElementById('addBucketCloudId');
        if (cloudIdManual) cloudIdManual.value = '';

        modal.style.display = 'flex';
        updateAddBucketTestBtnVisibility();

        Promise.all([
            fetch('/api/settings/options/clouds', { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : r.json().then(function (d) { return Object.assign({ items: [] }, d); });
            }),
            fetch('/api/settings/options/buckets', { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : r.json().then(function (d) { return Object.assign({ items: [] }, d); });
            }),
            fetch('/api/settings/options/endpoints', { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : r.json().then(function (d) { return Object.assign({ items: [] }, d); });
            }),
            fetch('/api/settings/buckets', { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : { items: [] };
            })
        ]).then(function (results) {
            var listRows = (results[3] && results[3].items) ? results[3].items : [];
            window._settingsBucketsSnapshot = listRows;
            var cloudItems = (results[0] && results[0].items) ? results[0].items : [];
            var bucketItems = (results[1] && results[1].items) ? results[1].items : [];
            var endpointItems = (results[2] && results[2].items) ? results[2].items : [];
            setupBucketFormDropdowns(modal, cloudItems, bucketItems, endpointItems, {
                cloudId: '',
                displayName: '',
                bucketName: '',
                endpointUrl: '',
                row: null
            });
            modal.style.display = 'flex';
        }).catch(function () {
            toastBucketFormError(t['settings.error_load'] || 'Error loading');
            modal.style.display = 'flex';
        });
    }

    function openCopyBucketModal(cloudId, displayName) {
        var modal = document.getElementById('addBucketModal');
        var t = window.I18N || {};
        delete modal.dataset.editCloudId;
        delete modal.dataset.editDisplayName;
        var errOpen = document.getElementById('addBucketError');
        if (errOpen) {
            errOpen.textContent = '';
            errOpen.removeAttribute('data-error-kind');
        }
        prepareBucketModalAddMode();
        // Сразу новый ID и lock — не ждать fetch (и не оставлять id/режим от Edit)
        setAddBucketIdFieldForMode(false);
        setAddBucketNameFieldForMode(false, '');
        var titleEl = modal.querySelector('.modal-title') || document.querySelector('#addBucketModal .modal-title');
        if (titleEl) titleEl.textContent = t['modal.copy_bucket'] || 'Copy bucket';
        if (typeof window.setModalSubmitBtn === 'function') {
            window.setModalSubmitBtn(document.getElementById('addBucketSubmitBtn'), t['settings.add'] || 'Add', 'add');
        }
        updateAddBucketTestBtnVisibility();

        Promise.all([
            fetch('/api/settings/options/clouds', { credentials: 'include' }).then(function (r) { return r.json(); }),
            fetch('/api/settings/options/buckets', { credentials: 'include' }).then(function (r) { return r.json(); }),
            fetch('/api/settings/options/endpoints', { credentials: 'include' }).then(function (r) { return r.json(); }),
            fetch('/api/settings/buckets/' + encodeURIComponent(cloudId) + '/' + encodeURIComponent(displayName), { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); });
            }),
            fetch('/api/settings/buckets', { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : { items: [] };
            })
        ]).then(function (results) {
            var snap = (results[4] && results[4].items) ? results[4].items : [];
            window._settingsBucketsSnapshot = snap;
            var cloudItems = (results[0] && results[0].items) ? results[0].items : [];
            var bucketItems = (results[1] && results[1].items) ? results[1].items : [];
            var endpointItems = (results[2] && results[2].items) ? results[2].items : [];
            var row = results[3];
            setupBucketFormDropdowns(modal, cloudItems, bucketItems, endpointItems, {
                cloudId: cloudId,
                displayName: (row.display_name || displayName || '').trim(),
                bucketName: (row.bucket_name || '').trim(),
                endpointUrl: (row.endpoint_url || '').trim(),
                row: null,
                prefillFromRow: row
            });
            // Гарантированно новый ID (не id исходного бакета) и readonly
            setAddBucketIdFieldForMode(false);
            resetAddBucketSecretKeyVisibility();
            updateAddBucketTestBtnVisibility();
            modal.style.display = 'flex';
        }).catch(function () {
            setAddBucketIdFieldForMode(false);
            toastBucketFormError(t['settings.error_load'] || 'Error loading');
            modal.style.display = 'flex';
        });
    }

    function openEditBucketModal(cloudId, displayName) {
        var modal = document.getElementById('addBucketModal');
        var t = window.I18N || {};
        modal.dataset.editCloudId = cloudId;
        modal.dataset.editDisplayName = displayName;
        var errEditOpen = document.getElementById('addBucketError');
        if (errEditOpen) {
            errEditOpen.textContent = '';
            errEditOpen.removeAttribute('data-error-kind');
        }
        prepareBucketModalEditMode();
        var titleEl = modal.querySelector('.modal-title') || document.querySelector('#addBucketModal .modal-title');
        if (titleEl) titleEl.textContent = t['modal.edit_bucket'] || 'Edit bucket';
        if (typeof window.setModalSubmitBtn === 'function') {
            window.setModalSubmitBtn(document.getElementById('addBucketSubmitBtn'), t['modal.update'] || 'Update', 'update');
        }
        updateAddBucketTestBtnVisibility();

        Promise.all([
            fetch('/api/settings/options/clouds', { credentials: 'include' }).then(function (r) { return r.json(); }),
            fetch('/api/settings/options/buckets', { credentials: 'include' }).then(function (r) { return r.json(); }),
            fetch('/api/settings/options/endpoints', { credentials: 'include' }).then(function (r) { return r.json(); }),
            fetch('/api/settings/buckets/' + encodeURIComponent(cloudId) + '/' + encodeURIComponent(displayName), { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); });
            }),
            fetch('/api/settings/buckets', { credentials: 'include' }).then(function (r) {
                return r.ok ? r.json() : { items: [] };
            })
        ]).then(function (results) {
            var snap = (results[4] && results[4].items) ? results[4].items : [];
            window._settingsBucketsSnapshot = snap;
            var cloudItems = (results[0] && results[0].items) ? results[0].items : [];
            var bucketItems = (results[1] && results[1].items) ? results[1].items : [];
            var endpointItems = (results[2] && results[2].items) ? results[2].items : [];
            var row = results[3];
            setupBucketFormDropdowns(modal, cloudItems, bucketItems, endpointItems, {
                cloudId: cloudId,
                displayName: displayName,
                bucketName: (row.bucket_name || '').trim(),
                endpointUrl: (row.endpoint_url || '').trim(),
                row: row
            });
            updateAddBucketTestBtnVisibility();
            modal.style.display = 'flex';
        }).catch(function () {
            setAddBucketIdFieldForMode(true, '');
            toastBucketFormError(t['settings.error_load'] || 'Error loading');
            modal.style.display = 'flex';
        });
    }

    function confirmDeleteBucket(cloudId, displayName) {
        var t = window.I18N || {};
        var name = displayName || cloudId || '';
        var msg = (t['delete.confirm_bucket'] || 'Are you sure you want to delete bucket "{name}"?').replace('{name}', name);
        if (typeof showConfirmModal === 'function') {
            showConfirmModal(msg, function () {
                fetch('/api/settings/buckets/' + encodeURIComponent(cloudId) + '/' + encodeURIComponent(displayName), { method: 'DELETE', credentials: 'include' })
                    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
                    .then(function (res) {
                        if (res.ok) {
                            reloadSettingsAfterBucketMutation();
                            window.bucketsSidebarLoaded = false;
                            if (typeof window.loadBuckets === 'function') {
                                window.loadBuckets();
                            }
                            if (typeof showInfo === 'function') showInfo(t['notification.operation_ok'] || 'Success');
                        } else {
                            if (typeof showError === 'function') showError((res.data && res.data.error) || 'Error');
                        }
                    });
            }, 'delete');
        }
    }

    function hideAddBucketModal() {
        var modal = document.getElementById('addBucketModal');
        modal.style.display = 'none';
        delete modal.dataset.editCloudId;
        delete modal.dataset.editDisplayName;
        var dn = document.getElementById('addBucketDisplayName');
        if (dn) dn.value = '';
        var cvl = document.getElementById('addBucketEditCloudLabel');
        if (cvl) { cvl.textContent = '—'; cvl.classList.remove('has-selection'); }
        var cv = document.getElementById('addBucketEditCloudValue');
        if (cv) cv.value = '';
        var cnh = document.getElementById('addBucketEditCloudName');
        if (cnh) cnh.value = '';
        var bnh = document.getElementById('addBucketBucketNameHidden');
        if (bnh) bnh.value = '';
        var bnt = document.getElementById('addBucketBucketName');
        if (bnt) {
            bnt.value = '';
            bnt.readOnly = false;
            bnt.removeAttribute('readonly');
            bnt.removeAttribute('aria-readonly');
            bnt.removeAttribute('title');
        }
        var eph = document.getElementById('addBucketEndpointUrlHidden');
        if (eph) eph.value = '';
        var epu = document.getElementById('addBucketEndpointUrl');
        if (epu) epu.value = '';
        var epl = document.getElementById('addBucketEditEndpointLabel');
        if (epl) { epl.textContent = '—'; epl.classList.remove('has-selection'); }
        var cab = document.getElementById('addBucketCaBundlePath');
        if (cab) cab.value = '';
        var reg = document.getElementById('addBucketRegionName');
        if (reg) reg.value = '';
        setAddBucketSkipTls(false);
        var bidClose = document.getElementById('addBucketBucketId');
        if (bidClose) {
            bidClose.value = '';
            // Поле всегда только для чтения — не разблокируем при закрытии
            bidClose.readOnly = true;
            bidClose.setAttribute('readonly', 'readonly');
            bidClose.setAttribute('aria-readonly', 'true');
            bidClose.removeAttribute('title');
        }
        var errHide = document.getElementById('addBucketError');
        if (errHide) errHide.removeAttribute('data-error-kind');
        resetAddBucketSecretKeyVisibility();
        prepareBucketModalAddMode();
        var t = window.I18N || {};
        var titleEl = modal.querySelector('.modal-title') || document.querySelector('#addBucketModal .modal-title');
        if (titleEl) titleEl.textContent = t['modal.add_bucket'] || 'Add bucket';
        if (typeof window.setModalSubmitBtn === 'function') {
            window.setModalSubmitBtn(document.getElementById('addBucketSubmitBtn'), t['settings.add'] || 'Add', 'add');
        }
    }

    function finishBucketSaveSuccess() {
        hideAddBucketModal();
        var settingsView = document.getElementById('settingsView');
        if (settingsView && !settingsView.classList.contains('hidden') && typeof loadSettingsBuckets === 'function') {
            loadSettingsBuckets();
        }
        window.bucketsSidebarLoaded = false;
        window.availableBuckets = [];
        var reloadSidebar = function () {
            if (typeof window.loadBuckets === 'function') {
                return window.loadBuckets();
            }
        };
        if (typeof window.checkAuthentication === 'function') {
            Promise.resolve(window.checkAuthentication()).then(reloadSidebar).catch(reloadSidebar);
        } else {
            reloadSidebar();
        }
        if (typeof showSuccess === 'function') {
            showSuccess(window.I18N && window.I18N['notification.operation_ok']
                ? window.I18N['notification.operation_ok']
                : 'Success');
        }
    }

    function onAddBucketSubmit() {
        var modal = document.getElementById('addBucketModal');
        var isEdit = !!(modal.dataset.editCloudId && modal.dataset.editDisplayName);
        var cloudId = getBucketFormCloudId(isEdit);
        var displayName = (document.getElementById('addBucketDisplayName').value || '').trim();
        var bucketName = (document.getElementById('addBucketBucketName') && document.getElementById('addBucketBucketName').value || '').trim()
            || ((document.getElementById('addBucketBucketNameHidden') && document.getElementById('addBucketBucketNameHidden').value) || '').trim();
        var bucketId = (document.getElementById('addBucketBucketId').value || '').trim();
        var endpointUrl = getBucketFormEndpointUrl(isEdit);
        var accessKey = (document.getElementById('addBucketAccessKey').value || '').trim();
        var secretKey = (document.getElementById('addBucketSecretKey').value || '').trim();
        var errEl = document.getElementById('addBucketError');
        var t = window.I18N || {};
        if (errEl) {
            errEl.textContent = '';
            errEl.removeAttribute('data-error-kind');
        }
        if (!cloudId) { toastBucketFormError(t['error.cloud_id_invalid'] || 'Cloud ID is required'); return; }
        if (!displayName) { toastBucketFormError(t['error.display_name_required'] || 'Display name is required'); return; }
        if (!bucketName) { toastBucketFormError(t['error.bucket_name_required'] || 'Bucket name is required'); return; }
        var exCid = isEdit ? modal.dataset.editCloudId : null;
        var exDn = isEdit ? modal.dataset.editDisplayName : null;
        var dupKeyMsg = (window.I18N && window.I18N['error.bucket_exists']) || 'A bucket with this cloud and display name already exists';
        if (isBucketKeyTakenByOther(cloudId, displayName, exCid, exDn)) {
            toastBucketFormError(dupKeyMsg);
            return;
        }
        var dupS3Msg = (window.I18N && window.I18N['error.bucket_s3_target_exists']) ||
            'This S3 bucket is already registered in the file manager';
        if (isBucketS3TargetTakenByOther(bucketName, endpointUrl, exCid, exDn)) {
            toastBucketFormError(dupS3Msg);
            return;
        }
        var dupMsg = (window.I18N && window.I18N['settings.error_bucket_id_duplicate']) || 'This Bucket ID is already in use';
        if (isBucketIdTakenByOther(bucketId, exCid, exDn)) {
            showBucketIdDuplicateError(errEl, dupMsg);
            return;
        }
        var url = isEdit
            ? '/api/settings/buckets/' + encodeURIComponent(modal.dataset.editCloudId) + '/' + encodeURIComponent(modal.dataset.editDisplayName)
            : '/api/settings/buckets';
        var method = isEdit ? 'PUT' : 'POST';
        var caBundlePath = (document.getElementById('addBucketCaBundlePath').value || '').trim();
        var regionName = (document.getElementById('addBucketRegionName').value || '').trim();
        var skipTlsVerify = getAddBucketSkipTls();
        var payload = {
            cloud_id: cloudId, display_name: displayName, bucket_name: bucketName,
            bucket_id: bucketId || null, endpoint_url: endpointUrl || null,
            aws_access_key_id: accessKey || null, aws_secret_access_key: secretKey || null,
            ca_bundle_path: caBundlePath || null,
            region_name: regionName || null,
            skip_tls_verify: skipTlsVerify
        };
        var cn = (document.getElementById('addBucketEditCloudName') && document.getElementById('addBucketEditCloudName').value || '').trim();
        if (cn) {
            payload.cloud_name = cn;
        } else if (!isEdit) {
            var manualCloudInput = document.getElementById('addBucketCloudId');
            if (manualCloudInput && (manualCloudInput.value || '').trim()) {
                payload.cloud_name = (manualCloudInput.value || '').trim();
            }
        }
        fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
                if (!res.ok) {
                    toastBucketFormError((res.data && res.data.error) || (t['error.unexpected'] || 'Error'));
                    return null;
                }
                return true;
            })
            .then(function (ok) {
                if (ok) finishBucketSaveSuccess();
            })
            .catch(function () {
                toastBucketFormError(t['msg.network_error'] || 'Network error');
            });
    }

    function onAddBucketTest() {
        var modal = document.getElementById('addBucketModal');
        var isEdit = !!(modal.dataset.editCloudId && modal.dataset.editDisplayName);
        var cloudId = getBucketFormCloudId(isEdit);
        var displayName = (document.getElementById('addBucketDisplayName').value || '').trim();
        var bucketName = (document.getElementById('addBucketBucketName') && document.getElementById('addBucketBucketName').value || '').trim()
            || ((document.getElementById('addBucketBucketNameHidden') && document.getElementById('addBucketBucketNameHidden').value) || '').trim();
        var endpointUrl = getBucketFormEndpointUrl(isEdit);
        var accessKey = (document.getElementById('addBucketAccessKey').value || '').trim();
        var secretKey = (document.getElementById('addBucketSecretKey').value || '').trim();
        var caBundlePath = (document.getElementById('addBucketCaBundlePath').value || '').trim();
        var regionName = (document.getElementById('addBucketRegionName').value || '').trim();
        var skipTlsVerify = getAddBucketSkipTls();
        var errEl = document.getElementById('addBucketError');
        var t = window.I18N || {};
        function showTestError(message) {
            toastBucketFormError(message || t['error.unexpected'] || 'Error');
        }
        if (!cloudId) { showTestError(t['error.cloud_id_invalid'] || 'Cloud ID is required'); return; }
        if (!bucketName) { showTestError(t['error.bucket_name_required'] || 'Bucket name is required'); return; }
        if (errEl) {
            errEl.textContent = '';
            errEl.removeAttribute('data-error-kind');
        }
        var testBtn = document.getElementById('addBucketTestBtn');
        var baseBtnText = (t['modal.test_connection'] || 'Test');
        var waitBtnText = (t['modal.testing_connection'] || 'Testing...');
        if (testBtn) {
            testBtn.disabled = true;
            testBtn.textContent = waitBtnText;
        }
        var payload = {
            cloud_id: cloudId,
            display_name: displayName || bucketName,
            bucket_name: bucketName,
            endpoint_url: endpointUrl || null,
            aws_access_key_id: accessKey || null,
            aws_secret_access_key: secretKey || null,
            ca_bundle_path: caBundlePath || null,
            region_name: regionName || null,
            skip_tls_verify: skipTlsVerify
        };
        fetch('/api/settings/buckets/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
                if (res.ok) {
                    if (typeof showSuccess === 'function') showSuccess((res.data && res.data.message) || (t['modal.test_connection_success'] || 'Connection successful'));
                } else {
                    showTestError((res.data && res.data.error) || 'Error');
                }
            })
            .catch(function () {
                showTestError('Network error');
            })
            .finally(function () {
                if (testBtn) {
                    testBtn.disabled = false;
                    testBtn.textContent = baseBtnText;
                }
            });
    }

    // --- Сайдбар: список бакетов (главный экран) ---
    window.availableBuckets = window.availableBuckets || [];
    window.bucketsSidebarLoaded = window.bucketsSidebarLoaded || false;

    function updateBucketsAddBtnVisibility() {
        if (typeof window.setupUserPermissions === 'function') {
            window.setupUserPermissions();
            return;
        }
        var option = document.getElementById('addBucketOption');
        if (!option) return;
        var canAdd = typeof window.userHasPermission === 'function' && window.userHasPermission('add_bucket');
        if (canAdd) {
            option.classList.remove('hidden');
        } else {
            option.classList.add('hidden');
        }
    }

    function getDefaultGroupName(groupId) {
        var id = String(groupId || '');
        var tr = window.I18N || {};
        return tr['buckets.group.' + id] || id || '—';
    }
    function getDefaultGroupIcon() {
        return 'fa-cloud';
    }

    async function loadBuckets() {
        try {
            if (window.bucketsSidebarLoaded && window.availableBuckets.length > 0) {
                console.log('Buckets already loaded, skipping...');
                return;
            }
            var response = await fetch('/api/buckets', {
                credentials: 'include'
            });
            var I18N = window.I18N || {};
            if (response.ok) {
                var data = await response.json();
                window.availableBuckets = data.buckets || [];
                window.bucketsSidebarLoaded = true;
                displayBuckets();
            } else {
                var errorText = await response.text();
                console.error('Error loading buckets:', errorText);
                if (typeof window.showError === 'function') {
                    window.showError((I18N['msg.load_buckets_failed'] || 'Failed to load buckets') + ': ' + (response.statusText || 'Unknown error'));
                }
                var bucketsList = document.getElementById('bucketsList');
                if (bucketsList) {
                    bucketsList.innerHTML =
                        '<div class="no-buckets-message">' +
                        '<i class="fa-solid fa-triangle-exclamation empty-state-icon empty-state-icon-warning"></i>' +
                        '<div>' + (I18N['msg.load_buckets_failed'] || '') + '</div>' +
                        '<div style="font-size: 12px; margin-top: 5px;">' + response.status + ': ' + response.statusText + '</div>' +
                        '</div>';
                }
            }
        } catch (error) {
            console.error('Network error loading buckets:', error);
            var I18N2 = window.I18N || {};
            if (typeof window.showError === 'function') {
                window.showError((I18N2['msg.load_buckets_failed'] || 'Failed to load buckets') + ': ' + (error && error.message ? error.message : ''));
            }
            var bucketsList2 = document.getElementById('bucketsList');
            if (bucketsList2) {
                bucketsList2.innerHTML =
                    '<div class="no-buckets-message">' +
                    '<i class="fa-solid fa-triangle-exclamation empty-state-icon empty-state-icon-warning"></i>' +
                    '<div>' + (I18N2['login.error_network'] || I18N2['msg.network_error'] || '') + '</div>' +
                    '<div style="font-size: 12px; margin-top: 5px;">' + (error && error.message ? error.message : '') + '</div>' +
                    '</div>';
            }
        }
    }

    function displayBuckets() {
        var bucketsList = document.getElementById('bucketsList');
        if (!bucketsList) return;
        updateBucketsAddBtnVisibility();
        var searchInput = document.getElementById('bucketSearchInput');
        var searchQuery = (searchInput && searchInput.value || '').trim().toLowerCase();
        var list = window.availableBuckets || [];
        var bucketsToShow = list;
        if (searchQuery) {
            bucketsToShow = list.filter(function (b) {
                var name = (b.display_name || b.name || '').toLowerCase();
                var bucketId = (b.bucket_id || '').toLowerCase();
                var groupName = (b.group_name || b.group || '').toLowerCase();
                var cloudName = (b.cloud_name || '').toLowerCase();
                return name.indexOf(searchQuery) !== -1 || bucketId.indexOf(searchQuery) !== -1 ||
                    groupName.indexOf(searchQuery) !== -1 || cloudName.indexOf(searchQuery) !== -1;
            });
        }
        var cu = window.fileManagerCurrentUser;
        console.log('Displaying buckets:', list);
        console.log('User allowed clouds:', cu && cu.allowedClouds);
        var I18N = window.I18N || {};
        function userCanAccessCloud(cloudId) {
            if (!cu || !Array.isArray(cu.allowedClouds)) return true;
            if (cu.allowedClouds.length === 0) return true;
            return cu.allowedClouds.indexOf('*') !== -1 || cu.allowedClouds.indexOf(cloudId) !== -1;
        }
        if (!list || list.length === 0) {
            bucketsList.innerHTML =
                '<div class="no-buckets-message">' +
                '<i class="fa-solid fa-triangle-exclamation empty-state-icon empty-state-icon-warning"></i>' +
                '<div class="empty-state-title">' + (I18N['buckets.no_buckets'] || '') + '</div>' +
                noAccessFooterHtml(I18N) +
                '</div>';
            return;
        }
        var groups = {};
        bucketsToShow.forEach(function (bucket) {
            var bucketCloudId = bucket.cloud_id || bucket.group || 'other';
            if (!userCanAccessCloud(bucketCloudId)) return;
            var groupId = bucket.group || 'other';
            if (!groups[groupId]) {
                groups[groupId] = {
                    name: bucket.group_name || getDefaultGroupName(groupId),
                    icon: bucket.group_icon || getDefaultGroupIcon(),
                    cloud_id: bucketCloudId,
                    buckets: []
                };
            }
            groups[groupId].buckets.push(bucket);
        });
        console.log('Grouped buckets:', groups);
        bucketsList.innerHTML = '';
        function renderBucketGroup(groupId, groupData, expandedGroupId) {
            if (!groupData.buckets || groupData.buckets.length === 0) return '';
            var sortedBuckets = groupData.buckets.slice().sort(function (a, b) {
                var nameA = a.display_name || a.name;
                var nameB = b.display_name || b.name;
                return nameA.localeCompare(nameB, 'ru', { sensitivity: 'base' });
            });
            var isExpanded = searchQuery ? true : groupId === expandedGroupId;
            return (
                '<div class="bucket-group" id="bucketGroup_' + groupId + '">' +
                '<div class="btn menu-list-header ' + (isExpanded ? 'expanded' : 'collapsed') + '" ' +
                'onclick="window.toggleBucketGroup(\'' + String(groupId).replace(/'/g, '\\\'') + '\')">' +
                '<i class="fa-solid ' + groupData.icon + '"></i>' +
                '<span>' + groupData.name + '</span>' +
                '<span class="bucket-group-chevron-wrap">' +
                '<i class="fa-solid fa-chevron-down bucket-group-chevron"></i>' +
                '<span class="count">' + sortedBuckets.length + '</span>' +
                '</span></div>' +
                '<div class="bucket-group-items"' + (isExpanded ? '' : ' style="display: none"') + '>' +
                sortedBuckets.map(function (bucket) { return renderBucketItem(bucket); }).join('') +
                '</div></div>'
            );
        }
        function renderBucketItem(bucket) {
            if (!bucket || !bucket.bucket_id) {
                console.error('Invalid bucket item:', bucket);
                return '';
            }
            var dbIconClass = 'fa-solid fa-database';
            if (bucket.credentials_status === 'present') {
                dbIconClass += ' bucket-db-icon-ok';
            } else {
                dbIconClass += ' bucket-db-icon-error';
            }
            var safeBucketId = String(bucket.bucket_id).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            var safeDisplayName = bucket.display_name
                ? String(bucket.display_name).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
                : bucket.name;
            var bucketData = {
                name: bucket.name,
                display_name: bucket.display_name,
                bucket_id: bucket.bucket_id,
                aws_access_key_id: bucket.aws_access_key_id,
                aws_secret_access_key: bucket.aws_secret_access_key,
                endpoint_url: bucket.endpoint_url,
                region_name: bucket.region_name,
                ca_bundle_path: bucket.ca_bundle_path,
                skip_tls_verify: bucket.skip_tls_verify,
                has_custom_credentials: bucket.has_custom_credentials,
                credentials_status: bucket.credentials_status,
                group: bucket.group,
                group_name: bucket.group_name,
                group_icon: bucket.group_icon,
                cloud_id: bucket.cloud_id,
                cloud_name: bucket.cloud_name
            };
            var jsonAttr = JSON.stringify(bucketData).replace(/"/g, '&quot;');
            return (
                '<div class="bucket-list-item btn menu-list-header" data-bucket-id="' + safeBucketId + '" onclick="window.handleBucketClick(event, ' + jsonAttr + ')">' +
                '<div class="bucket-list-name">' +
                '<div class="bucket-list-name-content">' +
                '<i class="' + dbIconClass + '"></i>' +
                '<span>' + safeDisplayName + '</span></div>' +
                '</div></div>'
            );
        }
        var html = '';
        var sortedGroupIds = Object.keys(groups)
            .filter(function (groupId) { return groups[groupId] && groups[groupId].buckets.length > 0; })
            .sort(function (a, b) {
                var nameA = (groups[a].name || a).toLowerCase();
                var nameB = (groups[b].name || b).toLowerCase();
                return nameA.localeCompare(nameB, 'ru', { sensitivity: 'base' });
            });
        var expandedGroupId = null;
        if (!searchQuery) {
            sortedGroupIds.forEach(function (groupId) {
                if (localStorage.getItem('bucketGroup_' + groupId) === 'expanded') {
                    if (!expandedGroupId) {
                        expandedGroupId = groupId;
                    } else {
                        localStorage.setItem('bucketGroup_' + groupId, 'collapsed');
                    }
                }
            });
        }
        sortedGroupIds.forEach(function (groupId) {
            html += renderBucketGroup(groupId, groups[groupId], expandedGroupId);
        });
        if (html === '') {
            html = searchQuery
                ? '<div class="no-buckets-message"><i class="fa-solid fa-magnifying-glass empty-state-icon"></i><div>' + (I18N['search.nothing_found'] || '') + '</div>' +
                  '<div style="font-size: 12px; margin-top: 5px;">' + (I18N['search.try_different_query'] || '') + '</div></div>'
                : '<div class="no-buckets-message"><i class="fa-solid fa-info empty-state-icon"></i><div class="empty-state-title">' + (I18N['buckets.no_buckets'] || '') + '</div>' +
                  noAccessFooterHtml(I18N) + '</div>';
        }
        bucketsList.innerHTML = html;
        initBucketGroupItemsScrollChaining();
        var activeId = typeof window.fileManagerCurrentBucketId !== 'undefined' ? window.fileManagerCurrentBucketId : '';
        if (activeId) {
            var selectedItem = document.querySelector('.bucket-list-item[data-bucket-id="' + activeId.replace(/"/g, '\\"') + '"]');
            if (selectedItem) {
                selectedItem.classList.add('active');
            }
        }
    }

    function clearBucketSearch() {
        var bucketSearchInput = document.getElementById('bucketSearchInput');
        var clearBtn = document.getElementById('clearBucketSearchBtn');
        if (bucketSearchInput) {
            bucketSearchInput.value = '';
            bucketSearchInput.focus();
        }
        if (clearBtn) clearBtn.classList.add('hidden');
        displayBuckets();
    }

    function scrollScrollableAncestors(startEl, deltaY) {
        var parent = startEl.parentElement;
        while (parent) {
            var style = window.getComputedStyle(parent);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                parent.scrollHeight > parent.clientHeight) {
                var maxScroll = parent.scrollHeight - parent.clientHeight;
                var atParentTop = parent.scrollTop <= 0;
                var atParentBottom = parent.scrollTop >= maxScroll - 1;
                if ((deltaY < 0 && atParentTop) || (deltaY > 0 && atParentBottom)) {
                    parent = parent.parentElement;
                    continue;
                }
                parent.scrollTop += deltaY;
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    }

    function bindBucketGroupItemsScrollChaining(itemsEl) {
        if (!itemsEl || !itemsEl.classList.contains('bucket-group-items')) return;
        if (itemsEl.dataset.scrollChainingBound === '1') return;
        itemsEl.dataset.scrollChainingBound = '1';
        itemsEl.addEventListener('wheel', function (e) {
            if (itemsEl.scrollHeight <= itemsEl.clientHeight) return;
            var deltaY = e.deltaY;
            if (deltaY === 0) return;
            var atTop = itemsEl.scrollTop <= 0;
            var atBottom = itemsEl.scrollTop + itemsEl.clientHeight >= itemsEl.scrollHeight - 1;
            if (!((deltaY < 0 && atTop) || (deltaY > 0 && atBottom))) return;
            if (scrollScrollableAncestors(itemsEl, deltaY)) {
                e.preventDefault();
            }
        }, { passive: false });
    }

    function initBucketGroupItemsScrollChaining() {
        document.querySelectorAll('.bucket-group-items').forEach(bindBucketGroupItemsScrollChaining);
    }

    function getBucketGroupElements(groupId) {
        var groupEl = document.getElementById('bucketGroup_' + groupId);
        if (!groupEl) return null;
        return {
            groupEl: groupEl,
            groupHeader: groupEl.querySelector(':scope > .menu-list-header'),
            groupItems: groupEl.querySelector('.bucket-group-items')
        };
    }

    function setBucketGroupExpanded(groupId, expanded) {
        var parts = getBucketGroupElements(groupId);
        if (!parts || !parts.groupHeader || !parts.groupItems) return;
        var chevron = parts.groupHeader.querySelector('.bucket-group-chevron');
        if (expanded) {
            parts.groupHeader.classList.remove('collapsed');
            parts.groupHeader.classList.add('expanded');
            parts.groupItems.style.display = 'flex';
            if (chevron) chevron.style.transform = 'rotate(180deg)';
            localStorage.setItem('bucketGroup_' + groupId, 'expanded');
            bindBucketGroupItemsScrollChaining(parts.groupItems);
        } else {
            parts.groupHeader.classList.remove('expanded');
            parts.groupHeader.classList.add('collapsed');
            parts.groupItems.style.display = 'none';
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            localStorage.setItem('bucketGroup_' + groupId, 'collapsed');
        }
    }

    function collapseAllBucketGroups(exceptGroupId) {
        document.querySelectorAll('.bucket-group').forEach(function (groupEl) {
            var gid = groupEl.id.replace('bucketGroup_', '');
            if (exceptGroupId !== undefined && String(gid) === String(exceptGroupId)) {
                return;
            }
            setBucketGroupExpanded(gid, false);
        });
    }

    function toggleBucketGroup(groupId) {
        var parts = getBucketGroupElements(groupId);
        if (!parts || !parts.groupHeader) return;
        if (parts.groupHeader.classList.contains('expanded')) {
            setBucketGroupExpanded(groupId, false);
        } else {
            collapseAllBucketGroups();
            setBucketGroupExpanded(groupId, true);
        }
    }

    function handleBucketClick(event, bucket) {
        event.stopPropagation();
        var activeId = typeof window.fileManagerCurrentBucketId !== 'undefined' ? window.fileManagerCurrentBucketId : '';
        if (activeId === bucket.bucket_id) {
            console.log('Bucket already selected, skipping:', bucket.bucket_id);
            return;
        }
        if (typeof window.selectBucket === 'function') {
            window.selectBucket(bucket);
        }
    }

    function getCurrentBucket() {
        return typeof window.__getCurrentBucket === 'function' ? (window.__getCurrentBucket() || '') : '';
    }

    function setCurrentBucket(bucket) {
        if (typeof window.__setCurrentBucket === 'function') window.__setCurrentBucket(bucket);
    }

    function getCurrentPath() {
        return typeof window.__getCurrentPath === 'function' ? (window.__getCurrentPath() || '') : '';
    }

    function setCurrentPath(path) {
        if (typeof window.__setCurrentPath === 'function') window.__setCurrentPath(path);
    }

    function resetBucketPagingState() {
        if (typeof window.__resetBucketPagingState === 'function') {
            window.__resetBucketPagingState();
        }
    }

    function getSelectionMode() {
        return typeof window.__getSelectionMode === 'function' ? !!window.__getSelectionMode() : !!window.selectionMode;
    }

    function setSelectionMode(value) {
        if (typeof window.__setSelectionMode === 'function') window.__setSelectionMode(!!value);
        else window.selectionMode = !!value;
    }

    async function selectBucket(bucket, initialPath) {
        initialPath = typeof initialPath === 'string' ? initialPath : '';
        if (!bucket || !bucket.bucket_id) {
            console.error('Invalid bucket object:', bucket);
            return;
        }

        var currentBucket = getCurrentBucket();
        var isInitialFromUrl = initialPath.length > 0;
        if (!isInitialFromUrl && currentBucket === bucket.bucket_id) {
            console.log('Bucket already selected, skipping selectBucket for:', bucket.bucket_id);
            return;
        }

        console.log('Selecting bucket:', bucket.bucket_id, 'Current bucket:', currentBucket, 'Initial path:', initialPath || '(root)');

        if (typeof window.exitSearchMode === 'function') window.exitSearchMode();

        document.querySelectorAll('.bucket-list-item').forEach(function (item) {
            item.classList.remove('active');
        });

        var selectedItem = document.querySelector('.bucket-list-item[data-bucket-id="' + bucket.bucket_id + '"]');
        if (selectedItem) {
            selectedItem.classList.add('active');
            selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            var group = selectedItem.closest('.bucket-group');
            if (group) {
                var groupHeader = group.querySelector('.menu-list-header');
                if (groupHeader && groupHeader.classList.contains('collapsed')) {
                    var groupId = group.id.replace('bucketGroup_', '');
                    window.toggleBucketGroup(groupId);
                }
            }
        }

        if (typeof window.setMainToolbarLocked === 'function') window.setMainToolbarLocked(false);

        setCurrentBucket(bucket.bucket_id);
        window.fileManagerCurrentBucketName = (bucket.bucket_name || bucket.name || '').trim();
        if (typeof window.setupUserPermissions === 'function') window.setupUserPermissions();
        setCurrentPath('');
        resetBucketPagingState();

        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        if (searchInput) searchInput.value = '';
        if (clearSearchBtn) clearSearchBtn.style.display = 'none';

        if (window.ProgressBars) window.ProgressBars.hideLocal();

        var bucketInfo = document.getElementById('bucketInfo');
        var sizeText = document.getElementById('sizeText');
        var objectsText = document.getElementById('objectsText');
        if (bucketInfo) {
            bucketInfo.classList.remove('hidden');
            bucketInfo.style.display = 'flex';
        }
        if (sizeText) sizeText.textContent = (window.I18N && window.I18N['bucket.size_calculating']) || '';
        if (objectsText) objectsText.textContent = '...';

        var fileList = document.getElementById('fileList');
        if (fileList) {
            var tr = window.I18N || {};
            fileList.innerHTML =
                '<div class="empty-state">' +
                '<i class="fa-solid fa-spinner fa-spin empty-state-icon"></i>' +
                '<div>' + (tr['files.connecting_bucket'] || '').replace('{name}', bucket.display_name) + '</div>' +
                '</div>';
        }

        var filesHeader = document.getElementById('filesHeader');
        if (filesHeader) filesHeader.style.display = 'grid';
        if (typeof window.updateFilesPaginationUI === 'function') window.updateFilesPaginationUI();

        if (typeof window.clearSelection === 'function') window.clearSelection();
        if (getSelectionMode()) {
            setSelectionMode(true);
            if (typeof window.toggleSelectionMode === 'function') window.toggleSelectionMode();
        }

        var notification = document.getElementById('notification');
        if (notification) {
            if (notification.timeoutId) {
                clearTimeout(notification.timeoutId);
                notification.timeoutId = null;
            }
            notification.classList.remove('show');
        }

        try {
            var pathToLoad = initialPath.replace(/\/+$/, '') + (initialPath ? '/' : '');
            if (typeof window.updateBreadcrumb === 'function') window.updateBreadcrumb(pathToLoad);
            await Promise.all([
                loadBucketSize(),
                (typeof window.loadFiles === 'function' ? window.loadFiles(pathToLoad) : Promise.resolve())
            ]);
            if (typeof window.updateBreadcrumb === 'function') window.updateBreadcrumb(pathToLoad);
            setTimeout(function () {
                if (typeof window.updateURL === 'function') window.updateURL(bucket.bucket_id, pathToLoad, false);
            }, 100);
        } catch (error) {
            console.error('Error loading bucket data:', error);
            if (typeof window.showError === 'function') {
                var tr2 = window.I18N || {};
                window.showError((tr2['msg.load_bucket_data_failed'] || '') + ': ' + error.message);
            }
            var breadcrumb = document.getElementById('breadcrumb');
            if (breadcrumb) {
                breadcrumb.innerHTML = '';
                breadcrumb.style.display = 'none';
            }
            if (typeof window.goToHome === 'function') window.goToHome();
        }

        if (typeof window.setupUserPermissions === 'function') window.setupUserPermissions();
    }

    async function loadBucketSize() {
        var targetBucket = getCurrentBucket();
        if (!targetBucket) return;

        var sizeText = document.getElementById('sizeText');
        var objectsText = document.getElementById('objectsText');
        var tr = window.I18N || {};
        if (sizeText) sizeText.textContent = tr['bucket.size_calculating'] || '';
        if (objectsText) objectsText.textContent = '...';

        try {
            var response = await fetch('/api/bucket-size/' + encodeURIComponent(targetBucket), {
                credentials: 'include'
            });

            if (getCurrentBucket() !== targetBucket) return;

            var contentType = response.headers.get('Content-Type') || '';
            var isJson = contentType.includes('application/json');
            var data = null;
            if (isJson) data = await response.json();
            else {
                var text = await response.text();
                try { data = JSON.parse(text); } catch (_) { data = null; }
            }

            if (response.ok && data) {
                if (sizeText && typeof window.formatFileSize === 'function') {
                    sizeText.textContent = (data.truncated ? '> ' : '') + window.formatFileSize(data.size);
                }
                var objCount = data.objects_count;
                var numLocale = (tr['bucket.objects'] === 'objects') ? 'en-US' : 'ru-RU';
                var objWord = typeof window.getPluralForm === 'function'
                    ? window.getPluralForm(objCount, tr['plural.object_one'], tr['plural.object_two'], tr['plural.object_five'])
                    : '';
                if (objectsText) {
                    objectsText.textContent = data.truncated
                        ? '> ' + objCount.toLocaleString(numLocale) + ' ' + objWord
                        : objCount.toLocaleString(numLocale) + ' ' + objWord;
                }
            } else {
                if (sizeText) sizeText.textContent = tr['bucket.size_error'] || '';
                if (objectsText) objectsText.textContent = tr['bucket.size_no_data'] || '';
                if (getCurrentBucket() !== targetBucket) return;

                var errorText = tr['msg.unknown_error'] || '';
                if (response.status === 504) errorText = tr['msg.timeout_bucket'] || errorText;
                else if (data && data.error) errorText = data.error;
                else if (!isJson) errorText = response.status === 504 ? (tr['msg.timeout_server'] || errorText) : (tr['msg.invalid_response'] || errorText);

                var duration = (response.status === 504 || errorText.indexOf('Таймаут') !== -1 || errorText.indexOf('Timeout') !== -1) ? 8000 : 10000;
                if (typeof window.showError === 'function') {
                    window.showError((tr['msg.load_bucket_size_failed'] || '') + ': ' + errorText, duration);
                }
            }
        } catch (error) {
            if (getCurrentBucket() !== targetBucket) return;
            if (sizeText) sizeText.textContent = tr['bucket.size_error'] || '';
            if (objectsText) objectsText.textContent = tr['bucket.size_no_data'] || '';

            var errorMsg = error.message || '';
            var isTimeout = errorMsg.indexOf('504') !== -1 || errorMsg.indexOf('timeout') !== -1 || errorMsg.indexOf('Timeout') !== -1;
            var isNetwork = errorMsg.indexOf('network') !== -1 || errorMsg.indexOf('Network') !== -1 || errorMsg.indexOf('Failed to fetch') !== -1;
            var errorText2 = isTimeout ? (tr['msg.timeout_bucket'] || errorMsg) : (isNetwork ? (tr['msg.network_error'] || errorMsg) : errorMsg);
            if (errorMsg.indexOf("Unexpected token '<'") !== -1 || errorMsg.indexOf('is not valid JSON') !== -1) {
                errorText2 = tr['msg.timeout_or_server'] || errorText2;
            }
            if (typeof window.showError === 'function') {
                window.showError((tr['msg.load_bucket_size_failed'] || '') + ': ' + errorText2, 8000);
            }
        }
    }

    function getTabTitleBucketLabel(bucketId) {
        if (!bucketId || !String(bucketId).trim()) return '';
        var bid = String(bucketId).trim();
        var currentBucket = getCurrentBucket();
        if (bid === (currentBucket || '') || bid === (window.fileManagerCurrentBucketId || '')) {
            var fromState = (typeof window.fileManagerCurrentBucketName === 'string' && window.fileManagerCurrentBucketName.trim())
                ? window.fileManagerCurrentBucketName.trim()
                : '';
            if (fromState) return fromState;
        }
        var b = (window.availableBuckets || []).find(function (x) { return x && x.bucket_id === bid; });
        if (b) {
            var n = (b.bucket_name || b.name || '').trim();
            if (n) return n;
        }
        return bid;
    }

    window.loadBuckets = loadBuckets;
    window.displayBuckets = displayBuckets;
    window.updateBucketsAddBtnVisibility = updateBucketsAddBtnVisibility;
    window.clearBucketSearch = clearBucketSearch;
    window.toggleBucketGroup = toggleBucketGroup;
    window.handleBucketClick = handleBucketClick;
    window.selectBucket = selectBucket;
    window.loadBucketSize = loadBucketSize;
    window.getTabTitleBucketLabel = getTabTitleBucketLabel;

    window.setSearchFieldLocked = setSearchFieldLocked;
    window.setSettingsToolbarState = setSettingsToolbarState;
    window.setSettingsToolbarVisible = setSettingsToolbarVisible;
    window.loadSettingsBuckets = loadSettingsBuckets;
    window.reloadSettingsBucketsSoft = reloadSettingsBucketsSoft;
    window.reloadSettingsAfterBucketMutation = reloadSettingsAfterBucketMutation;
    window.openAddBucketModal = openAddBucketModal;
    window.openEditBucketModal = openEditBucketModal;
    window.openCopyBucketModal = openCopyBucketModal;
    window.confirmDeleteBucket = confirmDeleteBucket;
    window.hideAddBucketModal = hideAddBucketModal;
    window.canManageBucketAccessUi = canManageBucketAccessUi;

    // --- Bucket access modal (Settings → Buckets context menu) ---
    var bucketAccessState = {
        bucketId: '',
        displayName: '',
        bucketName: '',
        users: [],
        candidates: [],
        roles: [],
        editing: false,
        editShowRows: false,
        busy: false
    };
    var bucketAccessListenersBound = false;
    var BUCKET_ACCESS_USER_QUERY_MIN = 3;

    function bucketAccessT(key, fallback) {
        var t = window.I18N || {};
        return t[key] || fallback || key;
    }

    function closeBucketAccessDropdowns() {
        var modal = document.getElementById('bucketAccessModal');
        if (!modal) return;
        modal.querySelectorAll('.dropdown-acl.open').forEach(function (wrap) {
            if (wrap.classList.contains('bucket-access-user-search')) {
                closeBucketAccessUserMenu(wrap);
                return;
            }
            wrap.classList.remove('open');
            var trigger = wrap.querySelector('.dropdown-trigger');
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
            var menu = wrap.querySelector('.dropdown-menu');
            if (menu) menu.classList.add('hidden');
            if (typeof window.resetDropdownMenuOverlay === 'function') {
                window.resetDropdownMenuOverlay(wrap);
            }
        });
    }

    function setBucketAccessFooterMode(editing) {
        var addBtn = document.getElementById('bucketAccessAddUserBtn');
        var applyBtn = document.getElementById('bucketAccessApplyBtn');
        var cancelBtn = document.getElementById('bucketAccessCancelBtn');
        var closeBtn = document.getElementById('bucketAccessCloseBtn');
        if (addBtn) addBtn.classList.remove('hidden');
        if (applyBtn) applyBtn.classList.toggle('hidden', !editing);
        if (cancelBtn) cancelBtn.classList.toggle('hidden', !editing);
        if (closeBtn) closeBtn.classList.toggle('hidden', !!editing);
    }

    function hideBucketAccessModal() {
        var modal = document.getElementById('bucketAccessModal');
        if (!modal) return;
        closeBucketAccessDropdowns();
        bucketAccessState.editing = false;
        bucketAccessState.editShowRows = false;
        bucketAccessState.busy = false;
        setBucketAccessFooterMode(false);
        modal.classList.add('hidden');
        modal.style.display = 'none';
        bucketAccessState.bucketId = '';
        bucketAccessState.displayName = '';
        bucketAccessState.bucketName = '';
        bucketAccessState.users = [];
        bucketAccessState.candidates = [];
        bucketAccessState.roles = [];
        var grants = document.getElementById('bucketAccessGrants');
        if (grants) grants.innerHTML = '';
        var summary = document.getElementById('bucketAccessSummary');
        if (summary) summary.textContent = '';
    }

    function bucketAccessRoleOptions() {
        return (bucketAccessState.roles || []).map(function (r) {
            var id = (r && (r.id || r.name)) || '';
            return { value: id, label: id };
        }).filter(function (o) {
            return o.value && String(o.value).indexOf('storage_') === 0;
        });
    }

    /** Роль для назначения новым пользователям (не admin). */
    function normalizeAssignableBucketAccessRole(role) {
        var r = String(role || '').trim();
        if (r.indexOf('storage_') === 0) return r;
        if (r === 'admin') return 'storage_admin';
        return 'storage_viewer';
    }

    function bucketAccessRoleLabel(role) {
        var r = String(role || '').trim();
        var opts = bucketAccessRoleOptions();
        for (var i = 0; i < opts.length; i++) {
            if (opts[i].value === r) return opts[i].label;
        }
        return r || '—';
    }

    function bucketAccessUserLabel(user) {
        if (!user) return '—';
        var display = (user.display_name || '').trim();
        return display || user.username || '—';
    }

    function bucketAccessEditableUsers() {
        return (bucketAccessState.users || []).filter(function (u) { return !u.via_wildcard; });
    }

    function bucketAccessUserDropdownOptions(selectedUsername) {
        var used = {};
        if (bucketAccessState.editing) {
            document.querySelectorAll('#bucketAccessEditRows .file-info-acl-edit-row').forEach(function (row) {
                var dd = row.querySelector('[data-bucket-access="user"]');
                var val = getBucketAccessDropdownValue(dd);
                if (val) used[val] = true;
            });
        }
        var opts = [];
        var seen = {};
        function pushUser(u) {
            if (!u || !u.username || seen[u.username]) return;
            if (used[u.username] && u.username !== selectedUsername) return;
            seen[u.username] = true;
            opts.push({
                value: u.username,
                label: bucketAccessUserLabel(u),
                role: u.role || ''
            });
        }
        bucketAccessEditableUsers().forEach(pushUser);
        (bucketAccessState.candidates || []).forEach(pushUser);
        if (selectedUsername && !seen[selectedUsername]) {
            opts.unshift({ value: selectedUsername, label: selectedUsername, role: '' });
        }
        return opts;
    }

    function buildBucketAccessDropdownHtml(id, field, options, value, locked) {
        var label = '—';
        (options || []).forEach(function (opt) {
            if (opt.value === value) label = opt.label;
        });
        if (value && label === '—') label = value;
        var items = (options || []).map(function (opt) {
            var sel = opt.value === value ? ' selected' : '';
            return '<button type="button" class="dropdown-item' + sel + '" data-value="' +
                escapeHtml(opt.value) + '" data-role="' + escapeHtml(opt.role || '') +
                '" role="option"' + (locked ? ' disabled' : '') + '>' + escapeHtml(opt.label) + '</button>';
        }).join('');
        if (value && !(options || []).some(function (o) { return o.value === value; })) {
            items += '<button type="button" class="dropdown-item selected" data-value="' +
                escapeHtml(value) + '" role="option"' + (locked ? ' disabled' : '') + '>' +
                escapeHtml(value) + '</button>';
        }
        return '<div class="dropdown dropdown-acl' + (locked ? ' disabled' : '') + '" id="' + escapeHtml(id) +
            '" data-bucket-access="' + escapeHtml(field) + '">' +
            '<button type="button" class="dropdown-trigger" aria-expanded="false" aria-haspopup="listbox"' +
            (locked ? ' disabled' : '') + '>' +
            '<span class="has-selection">' + escapeHtml(label) + '</span>' +
            '<i class="fa-solid fa-chevron-down dropdown-icon"></i></button>' +
            '<div class="dropdown-menu hidden" role="listbox">' + items + '</div>' +
            '<input type="hidden" class="dropdown-value" value="' + escapeHtml(value || '') + '">' +
            '</div>';
    }

    function buildBucketAccessUserSearchHtml(id, options, value, locked) {
        var label = '';
        var role = '';
        (options || []).forEach(function (opt) {
            if (opt.value === value) {
                label = opt.label;
                role = opt.role || '';
            }
        });
        if (value && !label) label = value;
        var placeholder = bucketAccessT('modal.bucket_access_search_placeholder', 'Login');
        var items = (options || []).map(function (opt) {
            var sel = opt.value === value ? ' selected' : '';
            return '<button type="button" class="dropdown-item' + sel + '" data-value="' +
                escapeHtml(opt.value) + '" data-label="' + escapeHtml(opt.label) +
                '" data-role="' + escapeHtml(opt.role || '') +
                '" role="option"' + (locked ? ' disabled' : '') + '>' + escapeHtml(opt.label) + '</button>';
        }).join('');
        if (value && !(options || []).some(function (o) { return o.value === value; })) {
            items += '<button type="button" class="dropdown-item selected" data-value="' +
                escapeHtml(value) + '" data-label="' + escapeHtml(label) +
                '" role="option"' + (locked ? ' disabled' : '') + '>' +
                escapeHtml(label) + '</button>';
        }
        return '<div class="dropdown dropdown-acl bucket-access-user-search' + (locked ? ' disabled' : '') +
            '" id="' + escapeHtml(id) + '" data-bucket-access="user">' +
            '<input type="text" class="form-control search-input bucket-access-user-input" value="' +
            escapeHtml(label) + '" placeholder="' + escapeHtml(placeholder) + '" autocomplete="off"' +
            ' aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox"' +
            (locked ? ' readonly disabled' : '') + '>' +
            '<div class="dropdown-menu hidden" role="listbox">' +
            '<div class="dropdown-search-empty hidden">' +
            escapeHtml(bucketAccessT('modal.bucket_access_no_matches', 'User not found')) +
            '</div>' + items + '</div>' +
            '<input type="hidden" class="dropdown-value" value="' + escapeHtml(value || '') + '" data-role="' +
            escapeHtml(role) + '">' +
            '</div>';
    }

    function getBucketAccessDropdownValue(wrap) {
        if (!wrap) return '';
        var hidden = wrap.querySelector('.dropdown-value');
        return hidden ? hidden.value : '';
    }

    function setBucketAccessDropdownValue(wrap, value, label, role) {
        if (!wrap) return;
        var hidden = wrap.querySelector('.dropdown-value');
        var labelEl = wrap.querySelector('.dropdown-trigger span');
        var inputEl = wrap.querySelector('.bucket-access-user-input');
        if (hidden) {
            hidden.value = value || '';
            if (role != null) hidden.setAttribute('data-role', role || '');
        }
        if (labelEl) {
            labelEl.textContent = label || value || '—';
            labelEl.classList.add('has-selection');
        }
        if (inputEl) {
            inputEl.value = label || value || '';
        }
        wrap.querySelectorAll('.dropdown-item').forEach(function (item) {
            item.classList.toggle('selected', item.getAttribute('data-value') === value);
        });
    }

    function filterBucketAccessUserMenu(wrap, query) {
        var menu = wrap && wrap.querySelector('.dropdown-menu');
        if (!menu) return 0;
        var q = String(query || '').trim().toLowerCase();
        var visible = 0;
        menu.querySelectorAll('.dropdown-item').forEach(function (item) {
            var value = (item.getAttribute('data-value') || '').toLowerCase();
            var match = q.length >= BUCKET_ACCESS_USER_QUERY_MIN && value.indexOf(q) >= 0;
            item.classList.toggle('hidden', !match);
            if (match) visible += 1;
        });
        var empty = menu.querySelector('.dropdown-search-empty');
        if (empty) {
            empty.classList.toggle('hidden', q.length < BUCKET_ACCESS_USER_QUERY_MIN || visible > 0);
        }
        return visible;
    }

    function clearBucketAccessUserMenuInlineStyles(menu) {
        if (!menu) return;
        menu.style.position = '';
        menu.style.left = '';
        menu.style.width = '';
        menu.style.minWidth = '';
        menu.style.maxWidth = '';
        menu.style.right = '';
        menu.style.top = '';
        menu.style.bottom = '';
        menu.style.marginTop = '';
        menu.style.maxHeight = '';
        menu.style.overflowY = '';
        menu.style.zIndex = '';
    }

    function bucketAccessUserQueryReady(value) {
        return String(value || '').trim().length >= BUCKET_ACCESS_USER_QUERY_MIN;
    }

    function openBucketAccessUserMenu(wrap) {
        if (!wrap || wrap.classList.contains('disabled')) return;
        var input = wrap.querySelector('.bucket-access-user-input');
        var menu = wrap.querySelector('.dropdown-menu');
        if (!input || !menu) return;
        if (!bucketAccessUserQueryReady(input.value)) {
            closeBucketAccessUserMenu(wrap);
            return;
        }
        var modal = document.getElementById('bucketAccessModal');
        if (modal) {
            modal.querySelectorAll('.dropdown-acl.open').forEach(function (other) {
                if (other === wrap) return;
                if (other.classList.contains('bucket-access-user-search')) {
                    closeBucketAccessUserMenu(other);
                    return;
                }
                other.classList.remove('open');
                var otherTrigger = other.querySelector('.dropdown-trigger');
                if (otherTrigger) otherTrigger.setAttribute('aria-expanded', 'false');
                var otherMenu = other.querySelector('.dropdown-menu');
                if (otherMenu) otherMenu.classList.add('hidden');
                if (typeof window.resetDropdownMenuOverlay === 'function') {
                    window.resetDropdownMenuOverlay(other);
                }
            });
        }
        filterBucketAccessUserMenu(wrap, input.value);
        wrap.classList.add('open');
        input.setAttribute('aria-expanded', 'true');
        menu.classList.remove('hidden');
        // Fixed overlay escapes .file-info-acl-block overflow:hidden
        if (typeof window.fitDropdownMenuOverlay === 'function') {
            window.fitDropdownMenuOverlay(wrap);
        }
    }

    function closeBucketAccessUserMenu(wrap) {
        if (!wrap) return;
        var input = wrap.querySelector('.bucket-access-user-input');
        var menu = wrap.querySelector('.dropdown-menu');
        wrap.classList.remove('open');
        if (input) input.setAttribute('aria-expanded', 'false');
        if (menu) menu.classList.add('hidden');
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(wrap);
        } else if (menu) {
            clearBucketAccessUserMenuInlineStyles(menu);
        }
    }

    function setupBucketAccessUserSearch(wrap) {
        var input = wrap.querySelector('.bucket-access-user-input');
        var menu = wrap.querySelector('.dropdown-menu');
        if (!input || !menu || wrap._baUserSearchBound) return;
        wrap._baUserSearchBound = true;
        if (wrap.classList.contains('disabled') || input.disabled || input.readOnly) return;

        input.addEventListener('focus', function () {
            if (bucketAccessUserQueryReady(input.value)) openBucketAccessUserMenu(wrap);
        });
        input.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (bucketAccessUserQueryReady(input.value) && !wrap.classList.contains('open')) {
                openBucketAccessUserMenu(wrap);
            }
        });
        input.addEventListener('input', function () {
            var hidden = wrap.querySelector('.dropdown-value');
            if (hidden) {
                hidden.value = '';
                hidden.setAttribute('data-role', '');
            }
            menu.querySelectorAll('.dropdown-item.selected').forEach(function (item) {
                item.classList.remove('selected');
            });
            if (!bucketAccessUserQueryReady(input.value)) {
                closeBucketAccessUserMenu(wrap);
                return;
            }
            if (!wrap.classList.contains('open')) {
                openBucketAccessUserMenu(wrap);
            } else {
                filterBucketAccessUserMenu(wrap, input.value);
                if (typeof window.fitDropdownMenuOverlay === 'function') {
                    window.fitDropdownMenuOverlay(wrap);
                }
            }
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                closeBucketAccessUserMenu(wrap);
                input.blur();
            }
        });

        menu.querySelectorAll('.dropdown-item').forEach(function (item) {
            item.addEventListener('mousedown', function (ev) {
                // mousedown before blur so selection sticks
                ev.preventDefault();
                ev.stopPropagation();
                if (item.disabled || item.classList.contains('hidden')) return;
                var value = item.getAttribute('data-value') || '';
                var itemLabel = item.getAttribute('data-label') || (item.textContent || '').trim();
                var itemRole = item.getAttribute('data-role') || '';
                setBucketAccessDropdownValue(wrap, value, itemLabel, itemRole);
                closeBucketAccessUserMenu(wrap);
                var roleDd = wrap.closest('.file-info-acl-edit-row');
                roleDd = roleDd && roleDd.querySelector('[data-bucket-access="role"]');
                var defaultRole = normalizeAssignableBucketAccessRole(itemRole);
                if (roleDd && defaultRole && !getBucketAccessDropdownValue(roleDd)) {
                    setBucketAccessDropdownValue(roleDd, defaultRole, bucketAccessRoleLabel(defaultRole));
                }
            });
        });

        input.addEventListener('blur', function () {
            setTimeout(function () {
                if (wrap.contains(document.activeElement)) return;
                closeBucketAccessUserMenu(wrap);
                var hidden = wrap.querySelector('.dropdown-value');
                var selected = hidden ? hidden.value : '';
                if (!selected) {
                    // exact match by login only
                    var typed = String(input.value || '').trim().toLowerCase();
                    var matched = null;
                    menu.querySelectorAll('.dropdown-item').forEach(function (item) {
                        if (matched) return;
                        var value = (item.getAttribute('data-value') || '').toLowerCase();
                        if (typed && value === typed) matched = item;
                    });
                    if (matched) {
                        setBucketAccessDropdownValue(
                            wrap,
                            matched.getAttribute('data-value') || '',
                            matched.getAttribute('data-label') || (matched.textContent || '').trim(),
                            matched.getAttribute('data-role') || ''
                        );
                    } else {
                        input.value = '';
                    }
                } else {
                    var keepLabel = '';
                    menu.querySelectorAll('.dropdown-item').forEach(function (item) {
                        if (item.getAttribute('data-value') === selected) {
                            keepLabel = item.getAttribute('data-label') || (item.textContent || '').trim();
                        }
                    });
                    if (keepLabel) input.value = keepLabel;
                }
            }, 120);
        });
    }

    function setupBucketAccessDropdown(wrap) {
        var trigger = wrap.querySelector('.dropdown-trigger');
        var menu = wrap.querySelector('.dropdown-menu');
        if (!trigger || !menu || wrap._baDdBound) return;
        wrap._baDdBound = true;
        trigger.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (trigger.disabled || wrap.classList.contains('disabled')) return;
            var willOpen = !wrap.classList.contains('open');
            closeBucketAccessDropdowns();
            if (willOpen) {
                wrap.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
                menu.classList.remove('hidden');
                if (typeof window.fitDropdownMenuOverlay === 'function') {
                    window.fitDropdownMenuOverlay(wrap);
                }
            }
        });
        menu.querySelectorAll('.dropdown-item').forEach(function (item) {
            item.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (item.disabled) return;
                var value = item.getAttribute('data-value') || '';
                var itemLabel = (item.textContent || '').trim();
                setBucketAccessDropdownValue(wrap, value, itemLabel);
                wrap.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') {
                    window.resetDropdownMenuOverlay(wrap);
                }
            });
        });
    }

    function initBucketAccessDropdowns(root) {
        if (!root) return;
        root.querySelectorAll('.dropdown-acl[data-bucket-access="user"]').forEach(setupBucketAccessUserSearch);
        root.querySelectorAll('.dropdown-acl[data-bucket-access="role"]').forEach(setupBucketAccessDropdown);
    }

    function bucketAccessViewRowHtml(user) {
        return '<div class="modal-field file-info-acl-row">' +
            '<span class="user-info-value file-info-acl-col-user">' +
            escapeHtml(bucketAccessUserLabel(user)) +
            '</span>' +
            '<span class="user-info-value file-info-acl-col-perm">' +
            escapeHtml(bucketAccessRoleLabel(user.role)) +
            '</span></div>';
    }

    function defaultBucketAccessEditRow() {
        var roleOpts = bucketAccessRoleOptions();
        var role = 'storage_viewer';
        if (roleOpts.length && !roleOpts.some(function (o) { return o.value === role; })) {
            role = normalizeAssignableBucketAccessRole(roleOpts[0].value);
        }
        return { username: '', role: role };
    }

    function bucketAccessEditRowHtml(entry, idx, locked) {
        entry = entry || defaultBucketAccessEditRow();
        locked = !!locked || !!entry.via_wildcard;
        var userOpts = locked
            ? [{ value: entry.username, label: bucketAccessUserLabel(entry), role: entry.role || '' }]
            : bucketAccessUserDropdownOptions(entry.username || '');
        var roleOpts = locked
            ? [{ value: entry.role || '', label: entry.role || '—' }]
            : bucketAccessRoleOptions();
        // New rows stay empty — do not auto-pick the next candidate
        var username = entry.username || '';
        if (username && !locked && !userOpts.some(function (o) { return o.value === username; })) {
            username = '';
        }
        var entryRole = String(entry.role || '').trim();
        if (!locked) entryRole = normalizeAssignableBucketAccessRole(entryRole);
        var role = entryRole && roleOpts.some(function (o) { return o.value === entryRole; })
            ? entryRole
            : ((roleOpts[0] && roleOpts[0].value) || entryRole || '');
        var removeTitle = bucketAccessT('files.info_acl_remove_grant', 'Remove');
        return '<div class="modal-field file-info-acl-edit-row" data-row="' + idx + '"' +
            (locked ? ' data-locked="1"' : '') + '>' +
            buildBucketAccessUserSearchHtml('bucketAccessUser_' + idx, userOpts, username, locked) +
            buildBucketAccessDropdownHtml('bucketAccessRole_' + idx, 'role', roleOpts, role, locked) +
            '<button type="button" class="btn icon-btn delete file-info-acl-remove" title="' +
            escapeHtml(removeTitle) + '" aria-label="' + escapeHtml(removeTitle) + '"' +
            (locked ? ' disabled' : '') + '>' +
            '<i class="fa-solid fa-trash-can"></i></button></div>';
    }

    function renderBucketAccessView() {
        var container = document.getElementById('bucketAccessGrants');
        if (!container) return;
        var users = bucketAccessState.users || [];
        if (!users.length) {
            container.innerHTML = '<div class="file-info-acl-message">' +
                escapeHtml(bucketAccessT('modal.bucket_access_empty', 'No users have explicit access to this bucket.')) +
                '</div>';
            return;
        }
        var html = '';
        users.forEach(function (u) {
            html += bucketAccessViewRowHtml(u);
        });
        container.innerHTML = html;
    }

    function renderBucketAccessEdit() {
        var container = document.getElementById('bucketAccessGrants');
        if (!container) return;
        var users = bucketAccessState.users || [];
        if (!users.length && !bucketAccessState.editShowRows) {
            container.innerHTML = '<div class="file-info-acl-message">' +
                escapeHtml(bucketAccessT('modal.bucket_access_empty', 'No users have explicit access to this bucket.')) +
                '</div>';
            return;
        }
        var html = '<div id="bucketAccessEditRows">';
        users.forEach(function (u, idx) {
            html += bucketAccessEditRowHtml(u, idx, !!u.via_wildcard);
        });
        html += '</div>';
        container.innerHTML = html;
        initBucketAccessDropdowns(container);
    }

    function renderBucketAccessPanel() {
        if (bucketAccessState.editing) {
            renderBucketAccessEdit();
        } else {
            renderBucketAccessView();
        }
    }

    function enterBucketAccessEdit() {
        bucketAccessState.editing = true;
        bucketAccessState.editShowRows = (bucketAccessState.users || []).length > 0;
        setBucketAccessFooterMode(true);
        renderBucketAccessEdit();
    }

    function exitBucketAccessEdit() {
        bucketAccessState.editing = false;
        bucketAccessState.editShowRows = false;
        closeBucketAccessDropdowns();
        setBucketAccessFooterMode(false);
        renderBucketAccessView();
    }

    function removeBucketAccessEditRow(row) {
        var rows = document.getElementById('bucketAccessEditRows');
        if (!row || !rows || row.getAttribute('data-locked') === '1') return;
        row.remove();
        if (!rows.querySelectorAll('.file-info-acl-edit-row:not([data-locked="1"])').length &&
            !rows.querySelectorAll('.file-info-acl-edit-row[data-locked="1"]').length) {
            bucketAccessState.editShowRows = false;
            renderBucketAccessEdit();
        }
    }

    function bucketAccessAddRow() {
        if (!bucketAccessState.editing) enterBucketAccessEdit();
        var container = document.getElementById('bucketAccessGrants');
        if (!bucketAccessState.editShowRows) {
            bucketAccessState.editShowRows = true;
            renderBucketAccessEdit();
        }
        if (!document.getElementById('bucketAccessEditRows') && container) {
            var wrap = document.createElement('div');
            wrap.id = 'bucketAccessEditRows';
            container.appendChild(wrap);
        }
        var rows = document.getElementById('bucketAccessEditRows');
        if (!rows) return;
        var userOpts = bucketAccessUserDropdownOptions('');
        if (!userOpts.length) {
            if (typeof window.showInfo === 'function') {
                window.showInfo(bucketAccessT('modal.bucket_access_no_candidates', 'No users available to add'));
            }
            return;
        }
        var idx = rows.querySelectorAll('.file-info-acl-edit-row').length;
        var div = document.createElement('div');
        div.innerHTML = bucketAccessEditRowHtml(defaultBucketAccessEditRow(), idx, false);
        var row = div.firstElementChild;
        rows.appendChild(row);
        initBucketAccessDropdowns(row);
    }

    function collectBucketAccessEditRows() {
        var out = [];
        var seen = {};
        document.querySelectorAll('#bucketAccessEditRows .file-info-acl-edit-row').forEach(function (row) {
            if (row.getAttribute('data-locked') === '1') return;
            var userDd = row.querySelector('[data-bucket-access="user"]');
            var roleDd = row.querySelector('[data-bucket-access="role"]');
            var username = getBucketAccessDropdownValue(userDd);
            var role = getBucketAccessDropdownValue(roleDd);
            if (!username || seen[username]) return;
            seen[username] = true;
            out.push({ username: username, role: normalizeAssignableBucketAccessRole(role) });
        });
        return out;
    }

    function applyBucketAccessPayload(data) {
        if (!data) return;
        bucketAccessState.users = data.users || [];
        bucketAccessState.candidates = data.candidates || [];
        if (data.roles) bucketAccessState.roles = data.roles;
        renderBucketAccessPanel();
    }

    function applyBucketAccessChanges() {
        if (!bucketAccessState.bucketId || bucketAccessState.busy) return;
        var next = collectBucketAccessEditRows();
        var prev = bucketAccessEditableUsers();
        var prevMap = {};
        prev.forEach(function (u) { prevMap[u.username] = u.role || ''; });
        var nextMap = {};
        next.forEach(function (u) { nextMap[u.username] = u.role || ''; });

        var toGrant = next.filter(function (u) {
            return !Object.prototype.hasOwnProperty.call(prevMap, u.username) || prevMap[u.username] !== u.role;
        });
        var toRevoke = prev.filter(function (u) {
            return !Object.prototype.hasOwnProperty.call(nextMap, u.username);
        }).map(function (u) { return u.username; });

        if (!toGrant.length && !toRevoke.length) {
            exitBucketAccessEdit();
            return;
        }

        bucketAccessState.busy = true;
        var bid = bucketAccessState.bucketId;
        var chain = Promise.resolve();
        var applyBtn = document.getElementById('bucketAccessApplyBtn');
        if (applyBtn) applyBtn.disabled = true;

        toRevoke.forEach(function (username) {
            chain = chain.then(function () {
                return fetch('/api/settings/bucket-access/' + encodeURIComponent(bid) +
                    '?username=' + encodeURIComponent(username), {
                    method: 'DELETE',
                    credentials: 'include'
                }).then(function (r) {
                    return r.json().then(function (d) { return { ok: r.ok, data: d }; });
                }).then(function (res) {
                    if (!res.ok) throw new Error((res.data && res.data.error) || 'Error');
                    applyBucketAccessPayload(res.data);
                });
            });
        });

        toGrant.forEach(function (entry) {
            chain = chain.then(function () {
                return fetch('/api/settings/bucket-access/' + encodeURIComponent(bid), {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: entry.username, role: entry.role || undefined })
                }).then(function (r) {
                    return r.json().then(function (d) { return { ok: r.ok, data: d }; });
                }).then(function (res) {
                    if (!res.ok) throw new Error((res.data && res.data.error) || 'Error');
                    applyBucketAccessPayload(res.data);
                });
            });
        });

        chain.then(function () {
            bucketAccessState.busy = false;
            if (applyBtn) applyBtn.disabled = false;
            exitBucketAccessEdit();
            if (typeof window.showSuccess === 'function') {
                window.showSuccess(bucketAccessT('notification.operation_ok', 'Success'));
            }
        }).catch(function (err) {
            bucketAccessState.busy = false;
            if (applyBtn) applyBtn.disabled = false;
            if (typeof window.showError === 'function') {
                window.showError((err && err.message) || bucketAccessT('settings.error_load', 'Error'));
            }
        });
    }

    function bucketAccessAddUser() {
        if (!bucketAccessState.editing) enterBucketAccessEdit();
        bucketAccessAddRow();
    }

    function setBucketAccessSummary(bucketName) {
        var summary = document.getElementById('bucketAccessSummary');
        if (!summary) return;
        var label = bucketAccessT('modal.bucket_bucket_name', 'Bucket name');
        var name = String(bucketName || '').trim() || '—';
        summary.textContent = label + ': ' + name;
    }

    function openBucketAccessModal(bucketId, displayName, bucketName) {
        var bid = (bucketId || '').trim();
        if (!bid) {
            if (typeof window.showError === 'function') {
                window.showError(bucketAccessT('error.bucket_not_found', 'Bucket not found'));
            }
            return;
        }
        if (!canManageBucketAccessUi()) {
            if (typeof window.showError === 'function') {
                window.showError(bucketAccessT('files.admin_only', 'Access denied'));
            }
            return;
        }
        initBucketAccessModal();
        bucketAccessState.bucketId = bid;
        bucketAccessState.displayName = displayName || bid;
        bucketAccessState.bucketName = (bucketName || '').trim();
        bucketAccessState.editing = false;
        bucketAccessState.editShowRows = false;
        bucketAccessState.busy = false;
        setBucketAccessFooterMode(false);
        var title = document.getElementById('bucketAccessModalTitle');
        if (title) {
            title.textContent = bucketAccessT('modal.bucket_access_title', 'Access');
        }
        setBucketAccessSummary(bucketAccessState.bucketName || bucketAccessState.displayName);
        var grants = document.getElementById('bucketAccessGrants');
        if (grants) {
            grants.innerHTML = '<div class="file-info-acl-message">…</div>';
        }
        var modal = document.getElementById('bucketAccessModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
        }
        fetch('/api/settings/bucket-access/' + encodeURIComponent(bid), { credentials: 'include' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
                if (!res.ok) {
                    if (typeof window.showError === 'function') {
                        window.showError((res.data && res.data.error) || bucketAccessT('settings.error_load', 'Error'));
                    }
                    hideBucketAccessModal();
                    return;
                }
                if (res.data && res.data.bucket_name) {
                    bucketAccessState.bucketName = res.data.bucket_name;
                    setBucketAccessSummary(res.data.bucket_name);
                }
                applyBucketAccessPayload(res.data);
            })
            .catch(function () {
                if (typeof window.showError === 'function') {
                    window.showError(bucketAccessT('msg.network_error', 'Network error'));
                }
                hideBucketAccessModal();
            });
    }

    function initBucketAccessModal() {
        if (bucketAccessListenersBound) return;
        bucketAccessListenersBound = true;
        var closeBtn = document.getElementById('bucketAccessCloseBtn');
        var addBtn = document.getElementById('bucketAccessAddUserBtn');
        var applyBtn = document.getElementById('bucketAccessApplyBtn');
        var cancelBtn = document.getElementById('bucketAccessCancelBtn');
        var grants = document.getElementById('bucketAccessGrants');
        var modal = document.getElementById('bucketAccessModal');
        if (closeBtn) closeBtn.addEventListener('click', hideBucketAccessModal);
        if (addBtn) addBtn.addEventListener('click', bucketAccessAddUser);
        if (applyBtn) applyBtn.addEventListener('click', applyBucketAccessChanges);
        if (cancelBtn) cancelBtn.addEventListener('click', exitBucketAccessEdit);
        if (grants && !grants._baRemoveDelegated) {
            grants._baRemoveDelegated = true;
            grants.addEventListener('click', function (e) {
                var btn = e.target.closest('.file-info-acl-remove');
                if (!btn || btn.disabled || !bucketAccessState.editing) return;
                e.preventDefault();
                e.stopPropagation();
                var row = btn.closest('.file-info-acl-edit-row');
                if (row) removeBucketAccessEditRow(row);
            });
        }
        if (modal && !modal._baOverlayClose) {
            modal._baOverlayClose = true;
            modal.addEventListener('click', function (e) {
                if (e.target === modal) hideBucketAccessModal();
            });
        }
        document.addEventListener('click', function (e) {
            var accessModal = document.getElementById('bucketAccessModal');
            if (!accessModal || accessModal.style.display !== 'flex') return;
            if (!e.target.closest('.dropdown-acl')) {
                closeBucketAccessDropdowns();
            }
        });
    }

    window.openBucketAccessModal = openBucketAccessModal;
    window.hideBucketAccessModal = hideBucketAccessModal;

    window.initBucketSettingsModal = function () {
        if (bucketModalListenersBound) return;
        bucketModalListenersBound = true;
        updateBucketsAddBtnVisibility();
        updateAddBucketTestBtnVisibility();
        var cancelBtn = document.getElementById('addBucketCancelBtn');
        var submitBtn = document.getElementById('addBucketSubmitBtn');
        var testBtn = document.getElementById('addBucketTestBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', hideAddBucketModal);
        if (submitBtn) submitBtn.addEventListener('click', onAddBucketSubmit);
        if (testBtn) testBtn.addEventListener('click', onAddBucketTest);
        var bidInput = document.getElementById('addBucketBucketId');
        if (bidInput) {
            bidInput.addEventListener('input', scheduleValidateBucketId);
            bidInput.addEventListener('change', scheduleValidateBucketId);
        }
        var akCopy = document.getElementById('addBucketAccessKeyCopy');
        var skCopy = document.getElementById('addBucketSecretKeyCopy');
        var skToggle = document.getElementById('addBucketSecretKeyToggle');
        if (akCopy) akCopy.addEventListener('click', copyAddBucketAccessKey);
        if (skCopy) skCopy.addEventListener('click', copyAddBucketSecretKey);
        if (skToggle) skToggle.addEventListener('click', toggleAddBucketSecretKeyVisibility);
        var bucketForm = document.getElementById('addBucketForm');
        if (bucketForm) {
            bucketForm.addEventListener('submit', function (e) {
                e.preventDefault();
                if (typeof onAddBucketSubmit === 'function') onAddBucketSubmit();
            });
        }
        initAddBucketSkipTlsDropdown();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            window.initBucketSettingsModal();
        });
    } else {
        window.initBucketSettingsModal();
    }
})();
