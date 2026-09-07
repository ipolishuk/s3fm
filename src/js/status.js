/**
 * Settings → Status: Database / S3 / LDAP / SSO / Meilisearch.
 */
(function () {
    'use strict';

    var _lastStatus = null;
    var _refreshBound = false;
    var _abortCtrl = null;
    var STATUS_FETCH_TIMEOUT_MS = 35000;

    function t(key, fallback) {
        var v = (window.I18N || {})[key];
        return (v != null && v !== '') ? v : (fallback || key);
    }

    function escapeHtml(s) {
        if (window.S3FM && typeof window.S3FM.escapeHtml === 'function') {
            return window.S3FM.escapeHtml(s);
        }
        if (s == null) return '';
        var div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    function statusLabel(status) {
        if (status === 'ok') return t('settings.status.state_ok', 'Connected');
        if (status === 'disabled') return t('settings.status.state_disabled', 'Disabled');
        if (status === 'not_configured') return t('settings.status.state_not_configured', 'Not configured');
        if (status === 'error') return t('settings.status.state_error', 'Error');
        if (status === 'degraded') return t('settings.status.state_degraded', 'Degraded');
        return status || '—';
    }

    function serviceTitle(id) {
        if (id === 'database') return t('settings.status.database', 'Database');
        if (id === 'ldap') return t('settings.status.ldap', 'LDAP');
        if (id === 'meilisearch') return t('settings.status.meilisearch', 'Meilisearch');
        if (id === 'sso') return t('settings.status.sso', 'SSO / OIDC');
        if (id === 's3') return t('settings.status.s3', 'S3');
        return id;
    }

    function boolIcon(ok) {
        if (ok) {
            return '<span class="settings-status-var-ok" title="' +
                escapeHtml(t('settings.status.yes', 'Yes')) +
                '"><i class="fa-solid fa-check" aria-hidden="true"></i></span>';
        }
        return '<span class="settings-status-var-bad" title="' +
            escapeHtml(t('settings.status.no', 'No')) +
            '"><i class="fa-solid fa-xmark" aria-hidden="true"></i></span>';
    }

    function renderVarRows(svc) {
        var varsList = Array.isArray(svc && svc.vars) ? svc.vars : [];
        if (!varsList.length) {
            return '<p class="form-hint">' + escapeHtml(t('settings.status.unavailable', 'Status unavailable')) + '</p>';
        }
        return (
            '<ul class="settings-status-vars">' +
            varsList.map(function (item) {
                var name = (item && item.name) || '';
                var ok = !!(item && item.ok);
                return (
                    '<li class="settings-status-var-row" data-var="' + escapeHtml(name) + '">' +
                    '<span class="settings-status-var-name">' + escapeHtml(name) + '</span>' +
                    boolIcon(ok) +
                    '</li>'
                );
            }).join('') +
            '</ul>'
        );
    }

    function renderServiceSection(svc) {
        var status = (svc && svc.status) || 'error';
        var title = serviceTitle(svc.id);
        var detail = (svc && svc.detail) || '';
        return (
            '<section class="help-section settings-status-section" data-settings-status-section="1" data-service="' +
            escapeHtml(svc.id) + '">' +
            '<div class="help-section-card settings-status-' + escapeHtml(status) + '">' +
            '<div class="help-section-head settings-status-head">' +
            '<span class="lables">' + escapeHtml(title) + '</span>' +
            '<span class="settings-status-badge">' + escapeHtml(statusLabel(status)) + '</span>' +
            '</div>' +
            '<div class="help-section-body">' +
            (detail
                ? '<p class="form-hint settings-status-detail">' + escapeHtml(detail) + '</p>'
                : '') +
            renderVarRows(svc) +
            '</div>' +
            '</div>' +
            '</section>'
        );
    }

    function statusServicesOrder() {
        return ['database', 's3', 'ldap', 'sso', 'meilisearch'];
    }

    function getStatusServicesCount() {
        var cache = window._servicesStatusCache || _lastStatus;
        if (cache && cache.services) {
            return Object.keys(cache.services).length;
        }
        return statusServicesOrder().length;
    }

    function updateStatusMenuCount(payload) {
        var n = 0;
        if (payload && payload.services) {
            n = Object.keys(payload.services).length;
        } else {
            n = getStatusServicesCount();
        }
        if (typeof window.setSettingsMenuCountById === 'function') {
            window.setSettingsMenuCountById('settingsCountStatus', n);
        }
        if (window._settingsMenuCounts) {
            window._settingsMenuCounts.status = n;
        }
    }

    function renderStatusPanel(payload) {
        var services = (payload && payload.services) || {};
        var order = statusServicesOrder();
        updateStatusMenuCount(payload);
        return (
            '<div class="settings-status-panel">' +
            order.map(function (id) {
                var svc = services[id] || {
                    id: id,
                    status: 'error',
                    detail: t('settings.status.unavailable', 'Status unavailable'),
                    vars: []
                };
                return renderServiceSection(svc);
            }).join('') +
            '</div>'
        );
    }

    function filterStatusSections() {
        var input = document.getElementById('settingsSearchInput');
        var q = ((input && input.value) || '').trim().toLowerCase();
        var container = document.getElementById('settingsContentInner');
        if (!container) return;
        var sections = container.querySelectorAll('[data-settings-status-section]');
        sections.forEach(function (section) {
            if (!q) {
                section.classList.remove('hidden');
                return;
            }
            var text = (section.textContent || '').toLowerCase();
            section.classList.toggle('hidden', text.indexOf(q) === -1);
        });
    }

    function setToolbarForStatus() {
        if (typeof window.setSettingsToolbarState === 'function') {
            window.setSettingsToolbarState(true, { searchLocked: false });
        }
        var addBtn = document.getElementById('settingsAddBtn');
        if (addBtn) addBtn.classList.add('hidden');
        var meiliActions = document.getElementById('settingsSearchToolbarActions');
        if (meiliActions) meiliActions.classList.add('hidden');
        var refreshBtn = document.getElementById('settingsStatusRefreshBtn');
        if (refreshBtn) refreshBtn.classList.remove('hidden');
        var secondaryToolbar = document.getElementById('secondaryToolbar');
        if (secondaryToolbar) {
            secondaryToolbar.classList.remove('settings-toolbar-search');
            secondaryToolbar.classList.add('settings-toolbar-status');
        }
        if (typeof window.onSettingsTableCleared === 'function') {
            window.onSettingsTableCleared();
        }
        var footer = document.getElementById('settingsFooter');
        if (footer) footer.classList.add('hidden');
        ensureRefreshBound();
    }

    function hideStatusToolbarExtras() {
        var refreshBtn = document.getElementById('settingsStatusRefreshBtn');
        if (refreshBtn) refreshBtn.classList.add('hidden');
        var secondaryToolbar = document.getElementById('secondaryToolbar');
        if (secondaryToolbar) secondaryToolbar.classList.remove('settings-toolbar-status');
        var addBtn = document.getElementById('settingsAddBtn');
        if (addBtn) addBtn.classList.remove('hidden');
    }

    function ensureRefreshBound() {
        if (_refreshBound) return;
        var btn = document.getElementById('settingsStatusRefreshBtn');
        if (!btn) return;
        _refreshBound = true;
        btn.addEventListener('click', function () {
            loadSettingsStatus({ soft: true });
        });
        var searchInput = document.getElementById('settingsSearchInput');
        if (searchInput && !searchInput._statusFilterBound) {
            searchInput._statusFilterBound = true;
            searchInput.addEventListener('input', function () {
                if (window.settingsPanelState && window.settingsPanelState.currentTab === 'status') {
                    filterStatusSections();
                }
            });
        }
    }

    function fetchServicesStatus(signal) {
        var opts = { credentials: 'include', cache: 'no-store' };
        if (signal) opts.signal = signal;
        return fetch('/api/settings/status', opts)
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            });
    }

    function setRefreshBusy(busy) {
        var btn = document.getElementById('settingsStatusRefreshBtn');
        if (btn) btn.disabled = !!busy;
    }

    function loadSettingsStatus(options) {
        options = options || {};
        window.settingsPanelState = window.settingsPanelState || {};
        window.settingsPanelState.currentTab = 'status';
        setToolbarForStatus();

        var container = document.getElementById('settingsContentInner');
        if (!container) return;

        if (_abortCtrl) {
            try { _abortCtrl.abort(); } catch (e) { /* ignore */ }
        }
        _abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = null;
        if (_abortCtrl) {
            timer = setTimeout(function () {
                try { _abortCtrl.abort(); } catch (e) { /* ignore */ }
            }, STATUS_FETCH_TIMEOUT_MS);
        }

        setRefreshBusy(true);

        if (!options.soft) {
            container.innerHTML =
                '<div class="settings-status-panel">' +
                '<div class="empty-state">' +
                '<i class="fa-solid fa-spinner fa-spin empty-state-icon" aria-hidden="true"></i>' +
                '<div>' + escapeHtml(t('settings.loading', 'Loading...')) + '</div>' +
                '</div>' +
                '</div>';
        }

        fetchServicesStatus(_abortCtrl ? _abortCtrl.signal : null)
            .then(function (res) {
                if (!res.ok) {
                    var err = (res.data && res.data.error) || t('error.unexpected', 'Unexpected error');
                    container.innerHTML =
                        '<div class="settings-status-panel">' +
                        '<p class="error-message">' + escapeHtml(err) + '</p>' +
                        '</div>';
                    _lastStatus = null;
                    if (typeof window.setSettingsMenuCountById === 'function') {
                        window.setSettingsMenuCountById('settingsCountStatus', 0);
                    }
                    return;
                }
                _lastStatus = res.data || null;
                window._servicesStatusCache = _lastStatus;
                container.innerHTML = renderStatusPanel(_lastStatus);
                filterStatusSections();
            })
            .catch(function (err) {
                var aborted = err && (err.name === 'AbortError' || err.code === 20);
                var msg = aborted
                    ? (t('settings.status.timeout', 'Status check timed out'))
                    : (t('msg.network_error', 'Network error'));
                if (options.soft && _lastStatus) {
                    container.innerHTML = renderStatusPanel(_lastStatus);
                    filterStatusSections();
                    if (typeof showError === 'function') showError(msg);
                } else {
                    container.innerHTML =
                        '<div class="settings-status-panel">' +
                        '<p class="error-message">' + escapeHtml(msg) + '</p>' +
                        '</div>';
                    if (typeof window.setSettingsMenuCountById === 'function') {
                        window.setSettingsMenuCountById('settingsCountStatus', 0);
                    }
                }
            })
            .finally(function () {
                if (timer) clearTimeout(timer);
                setRefreshBusy(false);
            });
    }

    function getCachedLdapStatus() {
        var cache = window._servicesStatusCache || _lastStatus;
        return cache && cache.services ? cache.services.ldap : null;
    }

    function prefetchServicesStatus() {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = null;
        if (ctrl) {
            timer = setTimeout(function () {
                try { ctrl.abort(); } catch (e) { /* ignore */ }
            }, STATUS_FETCH_TIMEOUT_MS);
        }
        return fetchServicesStatus(ctrl ? ctrl.signal : null)
            .then(function (res) {
                if (res.ok) {
                    _lastStatus = res.data || null;
                    window._servicesStatusCache = _lastStatus;
                    updateStatusMenuCount(_lastStatus);
                }
                return _lastStatus;
            })
            .catch(function () {
                return null;
            })
            .finally(function () {
                if (timer) clearTimeout(timer);
            });
    }

    window.loadSettingsStatus = loadSettingsStatus;
    window.prefetchServicesStatus = prefetchServicesStatus;
    window.getCachedLdapStatus = getCachedLdapStatus;
    window.getStatusServicesCount = getStatusServicesCount;
    window.hideSettingsStatusToolbarExtras = hideStatusToolbarExtras;
})();
