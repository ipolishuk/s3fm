/**
 * Meilisearch: вкладка «Поиск» — таблица бакетов, переиндексация, статус и инфо в toolbar.
 */
(function () {
    'use strict';

    var _meiliStatusCache = null;
    var _meiliToolbarBound = false;
    var _reindexAllInProgress = false;
    var _reindexJobState = null;
    var _reindexEventSource = null;
    /** 'all' | 'one' — кто запустил текущую задачу (для корректного завершения UI). */
    var _reindexScope = null;
    var _reindexScopeBucketId = null;
    /** Был ли progress/snapshot(active) для текущего scope — отсекает чужой done. */
    var _reindexSeenProgressForScope = false;

    var ENV_LABEL_KEYS = {
        MEILI_ENABLED: 'settings.search.env.meili_enabled',
        MEILI_HOST: 'settings.search.env.meili_host',
        MEILI_API_KEY: 'settings.search.env.meili_api_key',
        MEILI_REINDEX_ON_STARTUP: 'settings.search.env.meili_reindex_on_startup',
        MEILI_PERIODIC_SYNC: 'settings.search.env.meili_periodic_sync',
        MEILI_SYNC_AT: 'settings.search.env.meili_sync_at',
        MEILI_SYNC_TIMEZONE: 'settings.search.env.meili_sync_timezone',
        MEILI_SYNC_NEXT: 'settings.search.env.meili_sync_next',
        MEILI_REINDEX_WORKERS: 'settings.search.env.meili_reindex_workers',
        MEILI_HTTP_TIMEOUT: 'settings.search.env.meili_http_timeout',
        MEILI_REINDEX_HTTP_TIMEOUT: 'settings.search.env.meili_reindex_http_timeout',
        MEILI_REINDEX_S3_READ_TIMEOUT: 'settings.search.env.meili_reindex_s3_read_timeout',
        MEILI_LARGE_BUCKET_THRESHOLD: 'settings.search.env.meili_large_bucket_threshold',
        MEILI_INDEX_PART_SIZE: 'settings.search.env.meili_index_part_size',
        MEILI_INDEX_EXCLUDE_PREFIXES: 'settings.search.env.meili_index_exclude_prefixes',
    };

    var ENV_HINT_KEYS = {
        MEILI_ENABLED: 'settings.search.env.hint.meili_enabled',
        MEILI_HOST: 'settings.search.env.hint.meili_host',
        MEILI_API_KEY: 'settings.search.env.hint.meili_api_key',
        MEILI_REINDEX_ON_STARTUP: 'settings.search.env.hint.meili_reindex_on_startup',
        MEILI_PERIODIC_SYNC: 'settings.search.env.hint.meili_periodic_sync',
        MEILI_SYNC_AT: 'settings.search.env.hint.meili_sync_at',
        MEILI_SYNC_TIMEZONE: 'settings.search.env.hint.meili_sync_timezone',
        MEILI_REINDEX_WORKERS: 'settings.search.env.hint.meili_reindex_workers',
        MEILI_HTTP_TIMEOUT: 'settings.search.env.hint.meili_http_timeout',
        MEILI_REINDEX_HTTP_TIMEOUT: 'settings.search.env.hint.meili_reindex_http_timeout',
        MEILI_REINDEX_S3_READ_TIMEOUT: 'settings.search.env.hint.meili_reindex_s3_read_timeout',
        MEILI_LARGE_BUCKET_THRESHOLD: 'settings.search.env.hint.meili_large_bucket_threshold',
        MEILI_INDEX_PART_SIZE: 'settings.search.env.hint.meili_index_part_size',
        MEILI_INDEX_EXCLUDE_PREFIXES: 'settings.search.env.hint.meili_index_exclude_prefixes',
    };

    function t(key) {
        return (window.I18N || {})[key] || '';
    }

    function capitalizeLabel(text) {
        text = String(text || '').trim();
        if (!text) return text;
        return text.charAt(0).toLocaleUpperCase() + text.slice(1);
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

    function getMeiliSyncTimezone() {
        var env = (_meiliStatusCache && _meiliStatusCache.env) || {};
        var tz = String(env.MEILI_SYNC_TIMEZONE || '').trim();
        return tz || 'UTC';
    }

    function formatReindexTime(iso) {
        if (!iso) return t('settings.search.reindex_never') || '—';
        try {
            var date = new Date(iso);
            if (isNaN(date.getTime())) return '—';
            // Same clock as MEILI_SYNC_AT / MEILI_SYNC_TIMEZONE (not browser local)
            var parts = new Intl.DateTimeFormat('en-GB', {
                timeZone: getMeiliSyncTimezone(),
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).formatToParts(date);
            var map = {};
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
            }
            if (!map.day || !map.month || !map.year || !map.hour || !map.minute) {
                throw new Error('incomplete date parts');
            }
            // en-GB may yield "24" for midnight in some engines
            var hour = map.hour === '24' ? '00' : map.hour;
            return map.day + '.' + map.month + '.' + map.year + ' ' + hour + ':' + map.minute;
        } catch (e) {
            if (typeof formatDate === 'function') return formatDate(iso);
            try {
                return new Date(iso).toLocaleString();
            } catch (e2) {
                return '—';
            }
        }
    }

    function isMeiliRunnable(status) {
        return !!(status && status.configured);
    }

    function fetchMeilisearchStatus() {
        return fetch('/api/search/status?_=' + Date.now(), {
            credentials: 'include',
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
        })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            })
            .then(function (res) {
                if (res.ok) _meiliStatusCache = res.data || {};
                return res;
            });
    }

    function runMeilisearchReindex(body, signal) {
        var opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body || {}),
        };
        if (signal) opts.signal = signal;
        return fetch('/api/search/reindex', opts).then(function (r) {
            return r.json().then(function (data) {
                return { ok: r.ok, status: r.status, data: data };
            });
        });
    }

    function confirmAction(message, onConfirm, modalType) {
        modalType = modalType || 'reindex';
        if (typeof showConfirmModal === 'function') {
            showConfirmModal(message, onConfirm, modalType);
        } else if (window.confirm(message)) {
            onConfirm();
        }
    }

    function formatReindexResult(data) {
        if (data.indexed_by_bucket) {
            var lines = [];
            Object.keys(data.indexed_by_bucket).forEach(function (bid) {
                lines.push(bid + ': ' + String(data.indexed_by_bucket[bid]));
            });
            return t('settings.search.reindex_all_done') + '\n' + lines.join('\n');
        }
        if (data.bucket_id != null && data.indexed != null) {
            return t('settings.search.reindex_one_done')
                .replace('{bucket}', data.bucket_id)
                .replace('{count}', String(data.indexed));
        }
        return t('notification.operation_ok');
    }

    var MEILI_BOOL_KEYS = {
        MEILI_ENABLED: true,
        MEILI_REINDEX_ON_STARTUP: true,
        MEILI_PERIODIC_SYNC: true
    };

    var MEILI_BOOL_OPTIONS = [
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' }
    ];

    /** IANA timezones for MEILI_SYNC_TIMEZONE select. */
    var MEILI_TIMEZONE_OPTIONS = [
        { value: 'UTC', label: 'UTC' },
        { value: 'Europe/Kaliningrad', label: 'Europe/Kaliningrad (UTC+2)' },
        { value: 'Europe/Moscow', label: 'Europe/Moscow (MSK)' },
        { value: 'Europe/Samara', label: 'Europe/Samara (UTC+4)' },
        { value: 'Asia/Yekaterinburg', label: 'Asia/Yekaterinburg (UTC+5)' },
        { value: 'Asia/Omsk', label: 'Asia/Omsk (UTC+6)' },
        { value: 'Asia/Novosibirsk', label: 'Asia/Novosibirsk (UTC+7)' },
        { value: 'Asia/Krasnoyarsk', label: 'Asia/Krasnoyarsk (UTC+7)' },
        { value: 'Asia/Irkutsk', label: 'Asia/Irkutsk (UTC+8)' },
        { value: 'Asia/Yakutsk', label: 'Asia/Yakutsk (UTC+9)' },
        { value: 'Asia/Vladivostok', label: 'Asia/Vladivostok (UTC+10)' },
        { value: 'Asia/Magadan', label: 'Asia/Magadan (UTC+11)' },
        { value: 'Asia/Kamchatka', label: 'Asia/Kamchatka (UTC+12)' },
        { value: 'Europe/Minsk', label: 'Europe/Minsk' },
        { value: 'Europe/Kyiv', label: 'Europe/Kyiv' },
        { value: 'Europe/Berlin', label: 'Europe/Berlin' },
        { value: 'Europe/London', label: 'Europe/London' },
        { value: 'Asia/Almaty', label: 'Asia/Almaty' },
        { value: 'Asia/Tashkent', label: 'Asia/Tashkent' },
        { value: 'America/New_York', label: 'America/New_York' },
        { value: 'America/Los_Angeles', label: 'America/Los_Angeles' }
    ];

    var MEILI_SETTINGS_ORDER = [
        'MEILI_ENABLED',
        'MEILI_HOST',
        'MEILI_API_KEY',
        'MEILI_PERIODIC_SYNC',
        'MEILI_SYNC_AT',
        'MEILI_REINDEX_WORKERS',
        'MEILI_REINDEX_ON_STARTUP',
        'MEILI_SYNC_TIMEZONE',
        'MEILI_HTTP_TIMEOUT',
        'MEILI_REINDEX_HTTP_TIMEOUT',
        'MEILI_REINDEX_S3_READ_TIMEOUT',
        'MEILI_LARGE_BUCKET_THRESHOLD',
        'MEILI_INDEX_PART_SIZE',
        'MEILI_INDEX_EXCLUDE_PREFIXES'
    ];

    function fetchMeiliSettings() {
        return fetch('/api/search/settings', { credentials: 'include' })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            });
    }

    function saveMeiliSettings(settings) {
        return fetch('/api/search/settings', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: settings })
        }).then(function (r) {
            return r.json().then(function (data) {
                return { ok: r.ok, data: data };
            });
        });
    }

    function isTruthySetting(value) {
        var s = String(value == null ? '' : value).trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    }

    function buildMeiliDropdownHtml(id, key, options, selectedValue, fromEnvAttr, disabledAttr, titleAttr, valueWrapClass) {
        var selected = String(selectedValue || '').trim();
        var opts = options.slice();
        if (selected && !opts.some(function (opt) { return opt.value === selected; })) {
            opts.unshift({ value: selected, label: selected });
        }
        if (!selected && opts.length) selected = opts[0].value;
        var selectedLabel = selected;
        for (var i = 0; i < opts.length; i++) {
            if (opts[i].value === selected) {
                selectedLabel = opts[i].label;
                break;
            }
        }
        var itemsHtml = opts.map(function (opt) {
            var sel = opt.value === selected ? ' selected' : '';
            return (
                '<button type="button" class="dropdown-item' + sel + '" data-value="' +
                escapeHtml(opt.value) + '" role="option">' + escapeHtml(opt.label) + '</button>'
            );
        }).join('');
        return (
            '<span class="' + valueWrapClass + '">' +
            '<div class="dropdown" id="' + id + 'Wrap">' +
            '<button type="button" class="dropdown-trigger" id="' + id + '"' +
            ' aria-expanded="false" aria-haspopup="listbox"' + disabledAttr + titleAttr + '>' +
            '<span class="has-selection" id="' + id + 'Label">' + escapeHtml(selectedLabel) + '</span>' +
            '<i class="fa-solid fa-chevron-down dropdown-icon"></i>' +
            '</button>' +
            '<div class="dropdown-menu hidden" id="' + id + 'Panel" role="listbox">' + itemsHtml + '</div>' +
            '<input type="hidden" class="dropdown-value" data-meili-key="' + escapeHtml(key) + '"' +
            fromEnvAttr + ' value="' + escapeHtml(selected) + '">' +
            '</div>' +
            '</span>'
        );
    }

    function renderMeiliSettingsForm(payload, container) {
        if (!container) return;
        payload = payload || {};
        var settings = payload.settings || {};
        var envPlaceholders = payload.env_placeholders || {};
        var configError = payload.config_error || '';
        var errorHtml =
            '<p class="form-hint meili-settings-config-error' + (configError ? '' : ' hidden') +
            '" id="meiliSettingsConfigError">' +
            (configError ? escapeHtml(configError) : '') +
            '</p>';

        container.innerHTML = errorHtml + MEILI_SETTINGS_ORDER.map(function (key) {
            var label = escapeHtml(t(ENV_LABEL_KEYS[key]) || key);
            var hint = ENV_HINT_KEYS[key] ? String(t(ENV_HINT_KEYS[key]) || '').trim() : '';
            var hintHtml = hint
                ? '<span class="form-hint meili-settings-desc">' + escapeHtml(hint) + '</span>'
                : '';
            var value = settings[key] != null ? String(settings[key]) : '';
            var envPh = envPlaceholders[key] != null ? String(envPlaceholders[key]) : '';
            var fromEnv = envPh !== '';
            // Env/Vault: show value and lock the control (cannot edit).
            var displayValue = fromEnv ? envPh : value;
            var fromEnvAttr = fromEnv ? ' data-meili-from-env="1"' : '';
            var disabledAttr = fromEnv ? ' disabled' : '';
            var titleAttr = fromEnv
                ? ' title="' + escapeHtml(t('settings.search.status_env_locked') || 'Controlled by environment variable') + '"'
                : '';
            var id = 'meiliSetting_' + key;
            var valueWrapClass = 'user-info-value meili-settings-value' + (fromEnv ? ' search-container-disabled' : '');
            var inputDisabledClass = fromEnv ? ' search-input-disabled' : '';
            var controlHtml;
            if (MEILI_BOOL_KEYS[key]) {
                var boolSource = fromEnv ? envPh : value;
                var boolValue = isTruthySetting(boolSource) ? 'true' : 'false';
                controlHtml = buildMeiliDropdownHtml(
                    id, key, MEILI_BOOL_OPTIONS, boolValue,
                    fromEnvAttr, disabledAttr, titleAttr, valueWrapClass
                );
            } else if (key === 'MEILI_SYNC_TIMEZONE') {
                controlHtml = buildMeiliDropdownHtml(
                    id, key, MEILI_TIMEZONE_OPTIONS, displayValue.trim() || 'UTC',
                    fromEnvAttr, disabledAttr, titleAttr, valueWrapClass
                );
            } else if (key === 'MEILI_API_KEY') {
                controlHtml =
                    '<span class="' + valueWrapClass + '">' +
                    '<input type="password" class="form-control' + inputDisabledClass + '" id="' + id + '" data-meili-key="' + escapeHtml(key) + '"' +
                    fromEnvAttr + disabledAttr + titleAttr +
                    ' value="' + escapeHtml(displayValue) + '" autocomplete="new-password" spellcheck="false">' +
                    '</span>';
            } else {
                controlHtml =
                    '<span class="' + valueWrapClass + '">' +
                    '<input type="text" class="form-control' + inputDisabledClass + '" id="' + id + '" data-meili-key="' + escapeHtml(key) + '"' +
                    fromEnvAttr + disabledAttr + titleAttr +
                    ' value="' + escapeHtml(displayValue) + '" autocomplete="off" spellcheck="false">' +
                    '</span>';
            }
            return (
                '<div class="modal-field meili-settings-field">' +
                '<div class="meili-settings-label-wrap">' +
                '<label class="lables" for="' + id + '">' + label + '</label>' +
                hintHtml +
                '</div>' +
                '<div class="meili-settings-value-col">' +
                controlHtml +
                '</div>' +
                '</div>'
            );
        }).join('');

        bindMeiliSettingsDropdowns(container);
    }

    function closeMeiliSettingsDropdown(wrap) {
        if (!wrap) return;
        wrap.classList.remove('open');
        var trigger = wrap.querySelector('.dropdown-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(wrap);
        }
    }

    function bindMeiliSettingsDropdowns(container) {
        if (!container) return;
        container.querySelectorAll('.dropdown').forEach(function (wrap) {
            if (wrap._meiliDdBound) return;
            wrap._meiliDdBound = true;

            var trigger = wrap.querySelector('.dropdown-trigger');
            var menu = wrap.querySelector('.dropdown-menu');
            var hidden = wrap.querySelector('.dropdown-value');
            var labelEl = wrap.querySelector('.dropdown-trigger > span');
            if (!trigger || !menu || !hidden) return;

            trigger.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (trigger.disabled) return;
                var willOpen = !wrap.classList.contains('open');
                container.querySelectorAll('.dropdown.open').forEach(function (other) {
                    if (other !== wrap) closeMeiliSettingsDropdown(other);
                });
                if (willOpen) {
                    wrap.classList.add('open');
                    trigger.setAttribute('aria-expanded', 'true');
                    menu.classList.remove('hidden');
                    if (typeof window.fitDropdownMenuOverlay === 'function') {
                        window.fitDropdownMenuOverlay(wrap);
                    }
                } else {
                    closeMeiliSettingsDropdown(wrap);
                }
            });

            menu.querySelectorAll('.dropdown-item').forEach(function (item) {
                item.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    if (trigger.disabled) return;
                    var nextValue = item.getAttribute('data-value') || '';
                    var nextLabel = (item.textContent || '').trim();
                    hidden.value = nextValue;
                    if (labelEl) {
                        labelEl.textContent = nextLabel;
                        labelEl.classList.add('has-selection');
                    }
                    menu.querySelectorAll('.dropdown-item').forEach(function (opt) {
                        opt.classList.toggle('selected', opt === item);
                    });
                    closeMeiliSettingsDropdown(wrap);
                });
            });
        });

        if (!container._meiliDdOutsideBound) {
            container._meiliDdOutsideBound = true;
            document.addEventListener('click', function (ev) {
                var openWrap = container.querySelector('.dropdown.open');
                if (!openWrap) return;
                if (ev.target.closest && ev.target.closest('.dropdown') === openWrap) return;
                closeMeiliSettingsDropdown(openWrap);
            });
        }
    }

    function collectMeiliSettingsFromForm(container) {
        var out = {};
        if (!container) return out;
        container.querySelectorAll('[data-meili-key]').forEach(function (el) {
            var key = el.getAttribute('data-meili-key');
            if (!key) return;
            // Env/Vault wins — never persist these fields from the form into DB.
            if (el.getAttribute('data-meili-from-env') === '1') return;
            if (el.disabled) return;
            out[key] = el.value;
        });
        return out;
    }

    function showMeiliSettingsModal() {
        var modal = document.getElementById('meiliSettingsModal');
        var form = document.getElementById('meiliSettingsForm');
        var saveBtn = document.getElementById('meiliSettingsSaveBtn');
        if (!modal || !form) return;

        function render(payload) {
            renderMeiliSettingsForm(payload, form);
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
        }

        if (saveBtn) saveBtn.disabled = true;
        render({ settings: {}, config_error: '' });

        fetchMeiliSettings()
            .then(function (res) {
                if (saveBtn) saveBtn.disabled = false;
                if (res.ok) {
                    render(res.data || {});
                } else if (typeof showError === 'function') {
                    showError((res.data && res.data.error) || t('notification.error') || 'Error');
                }
            })
            .catch(function () {
                if (saveBtn) saveBtn.disabled = false;
                if (typeof showError === 'function') {
                    showError(t('notification.error') || 'Error');
                }
            });
    }

    function hideMeiliSettingsModal() {
        var modal = document.getElementById('meiliSettingsModal');
        if (!modal) return;
        modal.querySelectorAll('.dropdown.open').forEach(closeMeiliSettingsDropdown);
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }

    function submitMeiliSettings() {
        var form = document.getElementById('meiliSettingsForm');
        var saveBtn = document.getElementById('meiliSettingsSaveBtn');
        var settings = collectMeiliSettingsFromForm(form);
        if (saveBtn) saveBtn.disabled = true;
        saveMeiliSettings(settings)
            .then(function (res) {
                if (saveBtn) saveBtn.disabled = false;
                if (!res.ok) {
                    if (typeof showError === 'function') {
                        showError((res.data && res.data.error) || t('notification.error') || 'Error');
                    }
                    return;
                }
                renderMeiliSettingsForm(res.data || {}, form);
                if (res.data && res.data.env) {
                    _meiliStatusCache = Object.assign({}, _meiliStatusCache || {}, { env: res.data.env });
                }
                if (typeof refreshMeiliStatus === 'function') {
                    refreshMeiliStatus();
                } else {
                    fetchMeilisearchStatus().then(function (st) {
                        if (st.ok) updateMeiliStatusButton(st.data || {});
                    });
                }
                if (typeof showSuccess === 'function') {
                    showSuccess(t('settings.search.settings_saved') || 'Saved');
                }
                hideMeiliSettingsModal();
            })
            .catch(function () {
                if (saveBtn) saveBtn.disabled = false;
                if (typeof showError === 'function') {
                    showError(t('notification.error') || 'Error');
                }
            });
    }

    function updateMeiliStatusButton(status) {
        var icon = document.getElementById('settingsMeiliStatusIcon');
        var btn = document.getElementById('settingsMeiliStatusBtn');
        if (!icon || !btn) return;
        status = status || {};
        var enabled = !!status.enabled;
        var connected = !!status.available;
        var label;
        if (!enabled) {
            label = capitalizeLabel(t('settings.search.status_disabled') || 'Disabled');
        } else if (connected) {
            label = capitalizeLabel(t('settings.search.status_connected') || 'Connected');
        } else {
            label = capitalizeLabel(t('settings.search.status_disconnected') || 'Disconnected');
        }
        btn.classList.remove('status-connected', 'status-disconnected', 'status-enabled');
        if (enabled && connected) {
            btn.classList.add('status-connected');
        } else {
            btn.classList.add('status-disconnected');
        }
        if (enabled) {
            btn.classList.add('status-enabled');
        }
        btn.disabled = false;
        var titleBase = t('settings.search.status_toggle_title') || 'Enable / disable Meilisearch';
        btn.title = titleBase + ': ' + label;
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        updateMeiliIndexSize(status);
    }

    function applyMeiliEnabledLocally(enabled) {
        var prev = _meiliStatusCache || {};
        var next = Object.assign({}, prev, {
            enabled: !!enabled,
            available: enabled ? !!prev.available : false,
            configured: enabled ? !!prev.configured : false
        });
        _meiliStatusCache = next;
        updateMeiliStatusButton(next);
        updateSearchToolbar(next);
    }

    function toggleMeiliEnabled() {
        var btn = document.getElementById('settingsMeiliStatusBtn');
        var status = _meiliStatusCache || {};
        if (status.enabled_from_env) {
            if (typeof showInfo === 'function') {
                showInfo(t('settings.search.status_env_locked') || 'Controlled by MEILI_ENABLED environment variable');
            }
            return;
        }
        var nextEnabled = !status.enabled;
        var message = nextEnabled
            ? (t('settings.search.confirm_enable') || 'Enable Meilisearch?')
            : (t('settings.search.confirm_disable') || 'Disable Meilisearch?');
        confirmAction(message, function () {
            if (btn) btn.disabled = true;
            saveMeiliSettings({ MEILI_ENABLED: nextEnabled ? 'true' : 'false' })
                .then(function (res) {
                    if (btn) btn.disabled = false;
                    if (!res.ok) {
                        if (typeof showError === 'function') {
                            showError((res.data && res.data.error) || t('notification.error') || 'Error');
                        }
                        return;
                    }
                    var settings = (res.data && res.data.settings) || {};
                    var enabled = Object.prototype.hasOwnProperty.call(settings, 'MEILI_ENABLED')
                        ? isTruthySetting(settings.MEILI_ENABLED)
                        : nextEnabled;
                    applyMeiliEnabledLocally(enabled);
                    if (typeof showSuccess === 'function') {
                        showSuccess(
                            enabled
                                ? (t('settings.search.enabled_on') || 'Meilisearch enabled')
                                : (t('settings.search.enabled_off') || 'Meilisearch disabled')
                        );
                    }
                    return refreshMeiliStatus();
                })
                .catch(function () {
                    if (btn) btn.disabled = false;
                    if (typeof showError === 'function') {
                        showError(t('msg.network_error') || 'Network error');
                    }
                });
        }, 'yes');
    }

    function formatMeiliIndexSize(bytes) {
        var n = Number(bytes);
        if (!isFinite(n) || n < 0) return '—';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function updateMeiliIndexSize(status) {
        var sizeText = document.getElementById('settingsMeiliIndexSizeText');
        var sizeBox = document.getElementById('settingsMeiliIndexSize');
        if (!sizeText) return;
        status = status || {};
        var title = t('settings.search.index_size') || 'Index size';
        if (sizeBox) sizeBox.title = title;
        if (!status.available) {
            sizeText.textContent = '—';
            return;
        }
        if (status.database_size == null) {
            sizeText.textContent = t('bucket.size_no_data') || '—';
            return;
        }
        sizeText.textContent = formatMeiliIndexSize(status.database_size);
    }

    function closeMeiliStatusMenu() {
        // Status button is an enable/disable toggle; dropdown removed.
    }

    function refreshMeiliStatus() {
        return fetchMeilisearchStatus().then(function (res) {
            var status = res.ok ? res.data : {};
            updateMeiliStatusButton(status);
            updateSearchToolbar(status);
            return status;
        });
    }

    function updateSearchToolbar(status) {
        var toolbar = document.getElementById('secondaryToolbar');
        var reindexBtn = document.getElementById('settingsReindexAllBtn');
        var searchActions = document.getElementById('settingsSearchToolbarActions');
        var onSearch = window.settingsPanelState && window.settingsPanelState.currentTab === 'search';

        if (toolbar) toolbar.classList.toggle('settings-toolbar-search', onSearch);
        if (searchActions) searchActions.classList.toggle('hidden', !onSearch);
        if (!onSearch) {
            closeMeiliStatusMenu();
        }

        if (onSearch) {
            updateMeiliStatusButton(status);
        }

        if (reindexBtn) {
            if (isReindexJobStoppable()) {
                updateReindexAllButtonState(true);
                reindexBtn.disabled = false;
            } else {
                updateReindexAllButtonState(false);
                reindexBtn.disabled = !onSearch || !isMeiliRunnable(status);
                var reindexLabel = isMeiliRunnable(status)
                    ? t('settings.search.reindex_all')
                    : t('settings.search.status_off');
                reindexBtn.title = reindexLabel;
                reindexBtn.setAttribute('aria-label', reindexLabel);
            }
        }
    }

    function bindSearchToolbarControls() {
        if (_meiliToolbarBound) return;
        _meiliToolbarBound = true;

        var statusBtn = document.getElementById('settingsMeiliStatusBtn');
        if (statusBtn) {
            statusBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleMeiliEnabled();
            });
        }

        var infoBtn = document.getElementById('settingsMeiliInfoBtn');
        if (infoBtn) {
            infoBtn.addEventListener('click', showMeiliSettingsModal);
        }

        var closeBtn = document.getElementById('meiliSettingsCloseBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', hideMeiliSettingsModal);
        }

        var saveBtn = document.getElementById('meiliSettingsSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', submitMeiliSettings);
        }

        var meiliForm = document.getElementById('meiliSettingsForm');
        if (meiliForm) {
            meiliForm.addEventListener('submit', function (e) {
                e.preventDefault();
                submitMeiliSettings();
            });
        }

        var settingsModal = document.getElementById('meiliSettingsModal');
        if (settingsModal) {
            settingsModal.addEventListener('click', function (e) {
                if (e.target === settingsModal) hideMeiliSettingsModal();
            });
        }

        var settingsInner = document.getElementById('settingsContentInner');
        if (settingsInner && !settingsInner._searchIndexChangeBound) {
            settingsInner._searchIndexChangeBound = true;
            settingsInner.addEventListener('change', function (e) {
                var allCb = e.target && e.target.id === 'settingsSearchIndexEnabledAll'
                    ? e.target
                    : null;
                if (allCb) {
                    if (allCb.disabled || _searchIndexToggleAllInProgress) return;
                    var enabled = !!allCb.checked;
                    // Вернуть чекбокс к состоянию из snapshot до подтверждения
                    updateSearchIndexAllHeaderState();
                    confirmAndToggleSearchIndexAll(enabled);
                    return;
                }
                var cb = e.target && e.target.closest && e.target.closest('.settings-search-index-enabled');
                if (!cb || cb.disabled || _searchIndexToggleAllInProgress) return;
                var bucketId = (cb.getAttribute('data-bucket-id') || '').trim();
                if (!bucketId) return;
                var enabled = !!cb.checked;
                var prevEnabled = isBucketSearchIndexEnabled(bucketId);
                cb.disabled = true;
                setBucketSearchIndexEnabled(bucketId, enabled)
                    .then(function (res) {
                        if (!res.ok) {
                            cb.checked = prevEnabled;
                            if (typeof showError === 'function') {
                                showError((res.data && res.data.error) || t('error.unexpected'));
                            }
                            return;
                        }
                        updateSearchIndexEnabledInSnapshot(bucketId, enabled);
                        applySearchIndexEnabledRowState();
                    })
                    .catch(function () {
                        cb.checked = prevEnabled;
                        if (typeof showError === 'function') showError(t('msg.network_error'));
                    })
                    .finally(function () {
                        cb.disabled = false;
                    });
            });
            settingsInner.addEventListener('click', function (e) {
                var allBtn = e.target && e.target.closest && e.target.closest('#settingsReindexAllBtn');
                if (allBtn) {
                    e.preventDefault();
                    handleReindexAllBtnClick();
                    return;
                }
                var btn = e.target && e.target.closest && e.target.closest('button.settings-search-bucket-reindex');
                if (!btn || btn.disabled) return;
                var tr = btn.closest('tr[data-bucket-id]');
                var bucketId = tr ? (tr.getAttribute('data-bucket-id') || '').trim() : '';
                if (!bucketId) return;
                e.preventDefault();
                confirmAndReindexBucket(bucketId);
            });
        }
    }

    function isRowSearchIndexEnabled(row) {
        return row && row.search_index_enabled !== false;
    }

    function isBucketSearchIndexEnabled(bucketId) {
        var snap = window._settingsSearchBucketsSnapshot;
        if (!snap || !bucketId) return true;
        for (var i = 0; i < snap.length; i++) {
            if (snap[i].bucket_id === bucketId) {
                return isRowSearchIndexEnabled(snap[i]);
            }
        }
        return true;
    }

    function setBucketSearchIndexEnabled(bucketId, enabled) {
        return fetch('/api/settings/buckets/search-index-enabled', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bucket_id: bucketId, enabled: !!enabled }),
        }).then(function (r) {
            return r.json().then(function (data) {
                return { ok: r.ok, data: data };
            });
        });
    }

    function updateSearchIndexEnabledInSnapshot(bucketId, enabled) {
        var snap = window._settingsSearchBucketsSnapshot;
        if (!snap) return;
        snap.forEach(function (row) {
            if (row.bucket_id === bucketId) {
                row.search_index_enabled = !!enabled;
            }
        });
    }

    function getSearchIndexToggleableBucketIds() {
        var snap = window._settingsSearchBucketsSnapshot || [];
        var ids = [];
        var seen = {};
        snap.forEach(function (row) {
            var id = (row.bucket_id || '').trim();
            if (id && !seen[id]) {
                seen[id] = true;
                ids.push(id);
            }
        });
        return ids;
    }

    function updateSearchIndexAllHeaderState() {
        var allCb = document.getElementById('settingsSearchIndexEnabledAll');
        if (!allCb) return;
        var ids = getSearchIndexToggleableBucketIds();
        if (!ids.length) {
            allCb.checked = false;
            allCb.indeterminate = false;
            allCb.disabled = true;
            return;
        }
        allCb.disabled = false;
        var enabledCount = 0;
        ids.forEach(function (id) {
            if (isBucketSearchIndexEnabled(id)) enabledCount++;
        });
        if (enabledCount === 0) {
            allCb.checked = false;
            allCb.indeterminate = false;
        } else if (enabledCount === ids.length) {
            allCb.checked = true;
            allCb.indeterminate = false;
        } else {
            allCb.checked = false;
            allCb.indeterminate = true;
        }
    }

    var _searchIndexToggleAllInProgress = false;

    function confirmAndToggleSearchIndexAll(enabled) {
        var ids = getSearchIndexToggleableBucketIds();
        if (!ids.length || _searchIndexToggleAllInProgress) {
            updateSearchIndexAllHeaderState();
            return;
        }
        var msg = enabled
            ? t('settings.search.confirm_index_enable_all')
            : t('settings.search.confirm_index_disable_all');
        confirmAction(msg, function () {
            toggleSearchIndexAll(enabled);
        }, 'yes');
    }

    function toggleSearchIndexAll(enabled) {
        var ids = getSearchIndexToggleableBucketIds();
        if (!ids.length || _searchIndexToggleAllInProgress) return;

        var previous = {};
        ids.forEach(function (bucketId) {
            previous[bucketId] = isBucketSearchIndexEnabled(bucketId);
            updateSearchIndexEnabledInSnapshot(bucketId, enabled);
        });
        // Сразу обновляем UI (без disabled/opacity), запросы — в фоне.
        applySearchIndexEnabledRowState();

        _searchIndexToggleAllInProgress = true;

        var requests = ids.map(function (bucketId) {
            return setBucketSearchIndexEnabled(bucketId, enabled).then(function (res) {
                return { bucketId: bucketId, res: res };
            });
        });
        Promise.all(requests)
            .then(function (results) {
                var failed = results.filter(function (r) {
                    return !r.res.ok;
                });
                failed.forEach(function (r) {
                    updateSearchIndexEnabledInSnapshot(r.bucketId, previous[r.bucketId]);
                });
                applySearchIndexEnabledRowState();
                if (failed.length && typeof showError === 'function') {
                    showError((failed[0].res.data && failed[0].res.data.error) || t('error.unexpected'));
                }
            })
            .catch(function () {
                ids.forEach(function (bucketId) {
                    updateSearchIndexEnabledInSnapshot(bucketId, previous[bucketId]);
                });
                applySearchIndexEnabledRowState();
                if (typeof showError === 'function') showError(t('msg.network_error'));
            })
            .finally(function () {
                _searchIndexToggleAllInProgress = false;
                updateSearchIndexAllHeaderState();
            });
    }

    function applySearchIndexEnabledRowState() {
        document.querySelectorAll('#settingsTableBody tr[data-bucket-id]').forEach(function (tr) {
            var bid = tr.getAttribute('data-bucket-id') || '';
            var enabled = isBucketSearchIndexEnabled(bid);
            tr.setAttribute('data-search-index-enabled', enabled ? '1' : '0');
            var cb = tr.querySelector('.settings-search-index-enabled');
            if (cb) {
                cb.checked = enabled;
                cb.title = enabled
                    ? t('settings.search.index_enabled_on')
                    : t('settings.search.index_enabled_off');
            }
            var reindexBtn = tr.querySelector('.settings-search-bucket-reindex');
            if (reindexBtn && !isBucketReindexInProgress(bid)) {
                // Кнопка reindex зависит только от Meili, не от master «enable all».
                // Для выключенного бакета клик покажет error.search_index_disabled.
                reindexBtn.disabled = !isMeiliRunnable(_meiliStatusCache);
            }
        });
        updateSearchIndexAllHeaderState();
    }

    function renderSearchBucketsTable(items, status) {
        var i18n = window.I18N || {};
        var meiliRunnable = isMeiliRunnable(status);
        var reindexTh = i18n['settings.search.table_reindexed_at'] || 'Last reindexed';
        var reindexTitle = i18n['settings.search.reindex_one'] || 'Reindex';
        var indexAllTitle = i18n['settings.search.table_index_enabled'] || 'Enabled';
        var reindexAllTitle = i18n['settings.search.reindex_all'] || 'Reindex all';
        var reindexAllDisabled = !meiliRunnable ? ' disabled' : '';
        var html = '<table class="content-table settings-search-buckets-table"><thead><tr>' +
            '<th><div class="content-table-header">' + escapeHtml(i18n['settings.table_bucket_name'] || 'Bucket Name') + '</div></th>' +
            '<th class="settings-col-display"><div class="content-table-header">' + escapeHtml(i18n['settings.table_display_name'] || 'Display Name') + '</div></th>' +
            '<th class="settings-col-bucket-id"><div class="content-table-header">' + escapeHtml(i18n['settings.table_bucket_id'] || 'Bucket ID') + '</div></th>' +
            '<th class="settings-col-cloud"><div class="content-table-header">' + escapeHtml(i18n['settings.table_cloud'] || 'Cloud') + '</div></th>' +
            '<th class="settings-col-reindexed-at"><div class="content-table-header">' + escapeHtml(reindexTh) + '</div></th>' +
            '<th class="settings-col-search-index">' +
            '<div class="content-table-header settings-search-col-header">' +
            '<label class="settings-search-index-all-btn" id="settingsSearchIndexEnabledAllWrap" title="' +
            escapeHtml(indexAllTitle).replace(/"/g, '&quot;') + '" aria-label="' +
            escapeHtml(indexAllTitle).replace(/"/g, '&quot;') + '">' +
            '<input type="checkbox" id="settingsSearchIndexEnabledAll" class="checkbox" title="' +
            escapeHtml(indexAllTitle).replace(/"/g, '&quot;') + '" aria-label="' +
            escapeHtml(indexAllTitle).replace(/"/g, '&quot;') + '">' +
            '</label></div></th>' +
            '<th class="settings-col-search-reindex">' +
            '<div class="content-table-header settings-search-col-header">' +
            '<button type="button" class="btn icon-btn" id="settingsReindexAllBtn" title="' +
            escapeHtml(reindexAllTitle).replace(/"/g, '&quot;') + '" aria-label="' +
            escapeHtml(reindexAllTitle).replace(/"/g, '&quot;') + '"' + reindexAllDisabled + '>' +
            '<i class="fa-solid fa-rotate"></i></button></div></th>' +
            '</tr></thead><tbody id="settingsTableBody">';

        items.forEach(function (row) {
            var bucketIdAttr = (row.bucket_id || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            var reindexCell = formatReindexTime(row.search_reindexed_at);
            var indexEnabled = isRowSearchIndexEnabled(row);
            var indexEnabledAttr = indexEnabled ? '1' : '0';
            var cbTitle = indexEnabled
                ? (i18n['settings.search.index_enabled_on'] || '')
                : (i18n['settings.search.index_enabled_off'] || '');
            html += '<tr data-bucket-id="' + bucketIdAttr + '" data-search-index-enabled="' + indexEnabledAttr + '">' +
                '<td>' + escapeHtml(row.bucket_name) + '</td>' +
                '<td class="settings-col-display">' + escapeHtml(row.display_name) + '</td>' +
                '<td class="settings-col-bucket-id">' + escapeHtml(row.bucket_id || '—') + '</td>' +
                '<td class="settings-col-cloud">' + escapeHtml(row.cloud_id) + '</td>' +
                '<td class="settings-col-reindexed-at">' + escapeHtml(reindexCell) + '</td>' +
                '<td class="settings-col-search-index">';
            if (row.bucket_id) {
                html +=
                    '<input type="checkbox" class="checkbox settings-search-index-enabled" ' +
                    'data-bucket-id="' + bucketIdAttr + '" ' +
                    (indexEnabled ? 'checked ' : '') +
                    'title="' + escapeHtml(cbTitle).replace(/"/g, '&quot;') + '" ' +
                    'aria-label="' + escapeHtml(cbTitle).replace(/"/g, '&quot;') + '">';
            }
            html += '</td><td class="settings-col-search-reindex">';
            if (row.bucket_id) {
                var reindexDisabled = !meiliRunnable ? ' disabled' : '';
                html += '<button type="button" class="btn icon-btn settings-search-bucket-reindex" data-base-title="' +
                    reindexTitle.replace(/"/g, '&quot;') + '" title="' +
                    reindexTitle.replace(/"/g, '&quot;') + '" aria-label="' +
                    reindexTitle.replace(/"/g, '&quot;') + '"' + reindexDisabled +
                    '><i class="fa-solid fa-rotate"></i></button>';
            }
            html += '</td></tr>';
        });
        html += '</tbody></table>';
        return html;
    }

    function initSearchIndexAllHeaderState() {
        updateSearchIndexAllHeaderState();
    }

    function reloadSettingsSearchSoft() {
        loadSettingsSearch({ soft: true });
    }

    function collectSearchTabBucketIds() {
        var items = window._settingsSearchBucketsSnapshot || [];
        var ids = [];
        var seen = {};
        items.forEach(function (row) {
            var id = (row.bucket_id || '').trim();
            if (id && !seen[id] && isRowSearchIndexEnabled(row)) {
                seen[id] = true;
                ids.push(id);
            }
        });
        return ids;
    }

    function findBucketReindexButton(bucketId) {
        var rows = document.querySelectorAll('#settingsTableBody tr[data-bucket-id]');
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-bucket-id') === bucketId) {
                return rows[i].querySelector('.settings-search-bucket-reindex');
            }
        }
        return null;
    }

    function setReindexButtonLoading(btn, loading, keepEnabled) {
        if (!btn) return;
        var icon = btn.querySelector('.fa-rotate');
        if (icon) icon.classList.toggle('fa-spin', !!loading);
        if (loading && !keepEnabled) {
            btn.disabled = true;
        } else {
            btn.disabled = !isMeiliRunnable(_meiliStatusCache);
        }
    }

    function isReindexJobActive() {
        var job = _reindexJobState;
        return !!(job && job.active);
    }

    function isReindexJobStoppable() {
        var job = _reindexJobState;
        return !!(job && job.active && !job.cancel_requested);
    }

    function isBucketReindexInProgress(bucketId) {
        if (!isReindexJobStoppable()) return false;
        var job = _reindexJobState;
        var bid = (bucketId || '').trim();
        if (!bid) return false;
        var batchIds = job.bucket_ids;
        if (batchIds && batchIds.length && batchIds.indexOf(bid) < 0) return false;
        return !(job.stats && Object.prototype.hasOwnProperty.call(job.stats, bid));
    }

    function updateReindexAllButtonState(active) {
        var allBtn = document.getElementById('settingsReindexAllBtn');
        if (!allBtn) return;
        var icon = allBtn.querySelector('.fa-rotate');
        if (icon) icon.classList.toggle('fa-spin', !!active);
        if (active) {
            allBtn.disabled = false;
            var stopLabel = t('settings.search.reindex_all_stop');
            if (!allBtn.getAttribute('data-base-title')) {
                allBtn.setAttribute('data-base-title', allBtn.title || t('settings.search.reindex_all'));
            }
            allBtn.setAttribute('aria-label', stopLabel);
        }
    }

    function applyReindexRowButtons(job) {
        job = job || {};
        var batchActive = !!job.active && !job.cancel_requested;
        var batchIds = job.bucket_ids && job.bucket_ids.length ? job.bucket_ids : null;
        var completedIds = {};
        if (job.stats) {
            Object.keys(job.stats).forEach(function (id) {
                completedIds[id] = true;
            });
        }
        var stopLabel = t('settings.search.reindex_all_stop');
        document.querySelectorAll('.settings-search-bucket-reindex').forEach(function (btn) {
            var tr = btn.closest('tr[data-bucket-id]');
            var bid = tr ? tr.getAttribute('data-bucket-id') : '';
            var inJob = !batchIds || (bid && batchIds.indexOf(bid) >= 0);
            var done = !!(bid && completedIds[bid]);
            var spin = batchActive && bid && inJob && !done;
            setReindexButtonLoading(btn, spin, true);
            if (spin) {
                btn.setAttribute('aria-label', stopLabel);
                btn.title = stopLabel;
            } else {
                var baseTitle = btn.getAttribute('data-base-title') || t('settings.search.reindex_one');
                btn.setAttribute('aria-label', baseTitle);
                btn.title = baseTitle;
            }
            if (!spin && isMeiliRunnable(_meiliStatusCache)) {
                btn.disabled = false;
            } else if (!spin) {
                btn.disabled = true;
            }
        });
    }

    function setReindexAllInProgress(active, job) {
        if (job) {
            applyReindexJobStatus(Object.assign({ active: !!active, cancel_requested: false }, job));
        } else {
            applyReindexJobStatus({ active: !!active });
        }
        updateSearchToolbar(_meiliStatusCache);
    }

    function fetchReindexJobStatus() {
        return fetch('/api/search/reindex/status', { credentials: 'include' })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, status: r.status, data: data };
                });
            });
    }

    function stopReindexJobStream() {
        if (_reindexEventSource) {
            _reindexEventSource.close();
            _reindexEventSource = null;
        }
    }

    function reindexEventAppliesToCurrentScope(job) {
        job = job || {};
        if (!_reindexScope) return true;
        var ids = job.bucket_ids || [];
        if (_reindexScope === 'one') {
            var bid = (_reindexScopeBucketId || '').trim();
            return ids.length === 1 && ids[0] === bid;
        }
        if (_reindexScope === 'all') {
            return ids.length !== 1;
        }
        return true;
    }

    function clearReindexScope() {
        _reindexScope = null;
        _reindexScopeBucketId = null;
        _reindexSeenProgressForScope = false;
    }

    function inferReindexScopeFromJob(job) {
        job = job || {};
        var ids = job.bucket_ids || [];
        if (ids.length === 1) {
            _reindexScope = 'one';
            _reindexScopeBucketId = ids[0];
        } else if (ids.length > 1) {
            _reindexScope = 'all';
            _reindexScopeBucketId = null;
        }
        if (job.active) {
            _reindexSeenProgressForScope = true;
        }
    }

    function handleReindexStreamEvent(event) {
        if (!event || !event.job) return;
        if (!reindexEventAppliesToCurrentScope(event.job)) {
            return;
        }
        if (event.type === 'snapshot' && event.job.active) {
            _reindexSeenProgressForScope = true;
        }
        if (event.type === 'progress') {
            _reindexSeenProgressForScope = true;
        }
        applyReindexJobStatus(event.job);
        if (event.type === 'progress' && event.bucket_id && _reindexScope === 'one') {
            var n = event.job.stats && event.job.stats[event.bucket_id];
            if (n != null && n >= 0) {
                updateBucketReindexTimeInTable(event.bucket_id, new Date().toISOString());
            }
        }
        if (event.type === 'done') {
            if (_reindexScope && !_reindexSeenProgressForScope && !event.job.error) {
                return;
            }
            if (event.job.active) {
                return;
            }
            stopReindexJobStream();
            onBatchReindexFinished(event.job);
        }
    }

    function startReindexJobStream() {
        stopReindexJobStream();
        if (typeof EventSource === 'undefined') return;
        _reindexEventSource = new EventSource('/api/search/reindex/events');
        _reindexEventSource.onmessage = function (msg) {
            try {
                var event = JSON.parse(msg.data);
                handleReindexStreamEvent(event);
            } catch (e) { /* ignore malformed */ }
        };
        _reindexEventSource.onerror = function () {
            stopReindexJobStream();
            syncReindexJobFromServer();
        };
    }

    function applyReindexJobStatus(job) {
        job = job || {};
        _reindexJobState = job;
        var spinning = !!(job.active && !job.cancel_requested);
        _reindexAllInProgress = spinning;
        updateReindexAllButtonState(spinning);
        applyReindexRowButtons(job);
        var allBtn = document.getElementById('settingsReindexAllBtn');
        if (!allBtn) return;
        var baseTitle = allBtn.getAttribute('data-base-title') || t('settings.search.reindex_all');
        if (!allBtn.getAttribute('data-base-title')) {
            allBtn.setAttribute('data-base-title', baseTitle);
        }
        if (spinning && job.total) {
            allBtn.title = baseTitle + ' (' + (job.completed || 0) + '/' + job.total + ')';
        } else if (spinning) {
            allBtn.title = t('settings.search.reindex_all_stop');
            allBtn.setAttribute('aria-label', t('settings.search.reindex_all_stop'));
        } else {
            allBtn.title = baseTitle;
            allBtn.setAttribute('aria-label', baseTitle);
        }
    }

    function onBatchReindexFinished(job) {
        job = job || {};
        var scope = _reindexScope;
        var scopeBucketId = _reindexScopeBucketId;
        clearReindexScope();
        applyReindexJobStatus({ active: false, stats: job.stats || {}, bucket_ids: job.bucket_ids || [] });
        refreshMeiliStatus().catch(function () { /* ignore */ });

        if (scope === 'one' && scopeBucketId) {
            var displayName = scopeBucketId;
            var snapDone = window._settingsSearchBucketsSnapshot;
            if (snapDone) {
                snapDone.forEach(function (row) {
                    if (row.bucket_id === scopeBucketId && row.bucket_name) {
                        displayName = row.bucket_name;
                    }
                });
            }
            if (job.cancel_requested) {
                if (typeof showInfo === 'function') {
                    showInfo(t('settings.search.reindex_all_stopped_short'));
                }
            } else {
                var count = job.stats && job.stats[scopeBucketId];
                if (count != null && count >= 0 && typeof showInfo === 'function') {
                    showInfo(
                        t('settings.search.reindex_one_done')
                            .replace('{bucket}', displayName)
                            .replace('{count}', String(count))
                    );
                }
                if (count != null && count >= 0) {
                    updateBucketReindexTimeInTable(scopeBucketId, new Date().toISOString());
                }
            }
            if (job.error && typeof showError === 'function') {
                showError(job.error);
            }
            return;
        }

        if (job.cancel_requested) {
            if (typeof showInfo === 'function') {
                showInfo(t('settings.search.reindex_all_stopped_short'));
            }
        } else if (job.stats && Object.keys(job.stats).length) {
            if (typeof showInfo === 'function') {
                showInfo(formatReindexResult({ indexed_by_bucket: job.stats }));
            }
        }
        if (job.error && typeof showError === 'function') {
            showError(job.error);
        }
        reloadSettingsSearchSoft();
    }

    function syncReindexJobFromServer() {
        return fetchReindexJobStatus().then(function (res) {
            if (!res.ok || !res.data) return res;
            applyReindexJobStatus(res.data);
            if (res.data.active) startReindexJobStream();
            else stopReindexJobStream();
            return res;
        });
    }

    function requestStopReindexJob() {
        if (!isReindexJobStoppable()) return;
        var allBtn = document.getElementById('settingsReindexAllBtn');
        if (allBtn) allBtn.disabled = true;
        fetch('/api/search/reindex/cancel', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
        })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            })
            .then(function (res) {
                if (!res.ok && typeof showError === 'function') {
                    showError((res.data && res.data.error) || t('error.unexpected'));
                } else if (res.ok && res.data) {
                    applyReindexJobStatus(res.data);
                    if (!res.data.active) {
                        stopReindexJobStream();
                        onBatchReindexFinished(res.data);
                    } else if (res.data.cancel_requested && !_reindexEventSource) {
                        startReindexJobStream();
                    }
                }
                if (allBtn) allBtn.disabled = false;
            })
            .catch(function () {
                if (typeof showError === 'function') showError(t('msg.network_error'));
                if (allBtn) allBtn.disabled = false;
            });
    }

    function requestStopReindexAll() {
        requestStopReindexJob();
    }

    function updateBucketReindexTimeInTable(bucketId, iso) {
        if (!bucketId) return;
        var rows = document.querySelectorAll('#settingsTableBody tr[data-bucket-id]');
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-bucket-id') === bucketId) {
                var cell = rows[i].querySelector('.settings-col-reindexed-at');
                if (cell) cell.textContent = formatReindexTime(iso);
                break;
            }
        }
        var snap = window._settingsSearchBucketsSnapshot;
        if (snap) {
            snap.forEach(function (row) {
                if (row.bucket_id === bucketId) row.search_reindexed_at = iso;
            });
        }
    }

    function startReindexAllBatch(bucketIds) {
        _reindexScope = 'all';
        _reindexScopeBucketId = null;
        _reindexSeenProgressForScope = false;
        stopReindexJobStream();
        applyReindexJobStatus({
            active: true,
            cancel_requested: false,
            stats: {},
            bucket_ids: bucketIds,
            total: bucketIds.length,
            completed: 0,
        });
        return runMeilisearchReindex({ buckets: bucketIds, background: true })
            .then(function (res) {
                if (res.status === 409) {
                    if (res.data && res.data.status) {
                        applyReindexJobStatus(res.data.status);
                        if (res.data.status.active) startReindexJobStream();
                    } else {
                        syncReindexJobFromServer();
                    }
                    if (typeof showInfo === 'function') {
                        showInfo((res.data && res.data.error) || t('error.reindex_already_running'));
                    }
                    return;
                }
                if (!res.ok) {
                    applyReindexJobStatus({ active: false });
                    if (typeof showError === 'function') {
                        showError((res.data && res.data.error) || t('error.unexpected'));
                    }
                    return;
                }
                if (res.data) {
                    applyReindexJobStatus({
                        active: true,
                        cancel_requested: false,
                        stats: {},
                        bucket_ids: bucketIds,
                        total: res.data.total != null ? res.data.total : bucketIds.length,
                        completed: 0,
                        workers: res.data.workers,
                    });
                }
                startReindexJobStream();
            })
            .catch(function () {
                applyReindexJobStatus({ active: false });
                if (typeof showError === 'function') showError(t('msg.network_error'));
            });
    }

    function handleReindexAllBtnClick() {
        syncReindexJobFromServer().then(function () {
            if (isReindexJobStoppable()) {
                confirmAction(t('settings.search.confirm_reindex_all_stop'), requestStopReindexJob, 'yes');
                return;
            }
            if (isReindexJobActive()) {
                if (typeof showInfo === 'function') {
                    showInfo(t('settings.search.reindex_all_finishing'));
                }
                startReindexJobStream();
                return;
            }
            confirmAndReindexAll();
        });
    }

    function confirmAndReindexAll() {
        if (!isMeiliRunnable(_meiliStatusCache)) {
            if (typeof showError === 'function') showError(t('settings.search.status_off'));
            return;
        }
        var bucketIds = collectSearchTabBucketIds();
        if (!bucketIds.length) {
            var snap = window._settingsSearchBucketsSnapshot || [];
            var hasAny = snap.some(function (row) {
                return (row.bucket_id || '').trim();
            });
            if (typeof showError === 'function') {
                showError(
                    hasAny
                        ? t('error.search_index_all_disabled')
                        : t('error.reindex_buckets_empty') || t('settings.no_buckets')
                );
            }
            return;
        }
        confirmAction(t('settings.search.confirm_reindex_all'), function () {
            startReindexAllBatch(bucketIds);
        });
    }

    function startReindexOneBucket(bucketId) {
        bucketId = (bucketId || '').trim();
        _reindexScope = 'one';
        _reindexScopeBucketId = bucketId;
        _reindexSeenProgressForScope = false;
        stopReindexJobStream();
        applyReindexJobStatus({
            active: true,
            cancel_requested: false,
            total: 1,
            completed: 0,
            stats: {},
            bucket_ids: [bucketId],
        });
        return runMeilisearchReindex({ buckets: [bucketId], background: true })
            .then(function (res) {
                if (res.status === 409) {
                    var st409 = res.data && res.data.status;
                    if (st409) {
                        var ids409 = st409.bucket_ids || [];
                        if (ids409.length !== 1 || ids409[0] !== bucketId) {
                            clearReindexScope();
                        } else {
                            inferReindexScopeFromJob(st409);
                        }
                        applyReindexJobStatus(st409);
                        if (st409.active) startReindexJobStream();
                    } else {
                        clearReindexScope();
                        syncReindexJobFromServer();
                    }
                    if (typeof showInfo === 'function') {
                        showInfo((res.data && res.data.error) || t('error.reindex_already_running'));
                    }
                    return;
                }
                if (!res.ok) {
                    clearReindexScope();
                    applyReindexJobStatus({ active: false });
                    if (typeof showError === 'function') {
                        showError((res.data && res.data.error) || t('error.unexpected'));
                    }
                    return;
                }
                if (res.data) {
                    applyReindexJobStatus({
                        active: true,
                        cancel_requested: false,
                        total: res.data.total != null ? res.data.total : 1,
                        completed: 0,
                        stats: {},
                        bucket_ids: [bucketId],
                    });
                }
                startReindexJobStream();
            })
            .catch(function () {
                clearReindexScope();
                applyReindexJobStatus({ active: false });
                if (typeof showError === 'function') showError(t('msg.network_error'));
            });
    }

    function confirmAndReindexBucket(bucketId) {
        if (!bucketId) return;
        if (!isBucketSearchIndexEnabled(bucketId)) {
            if (typeof showInfo === 'function') {
                showInfo(t('error.search_index_disabled'));
            }
            return;
        }
        if (isBucketReindexInProgress(bucketId)) {
            requestStopReindexJob();
            return;
        }
        if (isReindexJobActive() && !isBucketReindexInProgress(bucketId)) {
            if (typeof showInfo === 'function') {
                showInfo(t('error.reindex_already_running'));
            }
            if (_reindexJobState) {
                inferReindexScopeFromJob(_reindexJobState);
            }
            startReindexJobStream();
            return;
        }
        if (!isMeiliRunnable(_meiliStatusCache)) {
            if (typeof showError === 'function') showError(t('settings.search.status_off'));
            return;
        }
        var displayName = bucketId;
        var snap = window._settingsSearchBucketsSnapshot;
        if (snap) {
            snap.forEach(function (row) {
                if (row.bucket_id === bucketId && row.bucket_name) {
                    displayName = row.bucket_name;
                }
            });
        }
        var msg = t('settings.search.confirm_reindex_one').replace('{bucket}', displayName);
        confirmAction(msg, function () {
            startReindexOneBucket(bucketId);
        });
    }

    function loadSettingsSearch(options) {
        options = options || {};
        var soft = !!options.soft;

        if (window.settingsPanelState) window.settingsPanelState.currentTab = 'search';
        var inner = document.getElementById('settingsContentInner');
        var settingsSearchInput = document.getElementById('settingsSearchInput');
        var settingsSearchClear = document.getElementById('settingsSearchClear');
        if (!inner) return;

        var viewState = soft && typeof window.captureSettingsTableViewState === 'function'
            ? window.captureSettingsTableViewState()
            : null;

        if (typeof window.setSettingsToolbarState === 'function') {
            window.setSettingsToolbarState(true, { searchLocked: false });
        }
        updateSearchToolbar(_meiliStatusCache);

        if (!soft && typeof window.onSettingsTableCleared === 'function') {
            window.onSettingsTableCleared();
        }

        if (soft) {
            inner.classList.add('content-body-soft-refresh');
        } else {
            inner.classList.remove('content-body-soft-refresh');
            inner.innerHTML =
                '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin empty-state-icon"></i><div>' +
                escapeHtml(t('settings.loading')) + '</div></div>';
        }

        var bucketsReq = fetch('/api/settings/buckets', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.statusText)); });
        var statusReq = fetchMeilisearchStatus();
        var reindexJobReq = fetchReindexJobStatus();

        Promise.all([bucketsReq, statusReq, reindexJobReq])
            .then(function (results) {
                var bucketsData = results[0];
                var statusRes = results[1];
                var reindexJobRes = results[2];
                var status = statusRes.ok ? statusRes.data : {};
                updateSearchToolbar(status);
                if (reindexJobRes.ok && reindexJobRes.data) {
                    applyReindexJobStatus(reindexJobRes.data);
                    if (reindexJobRes.data.active) {
                        inferReindexScopeFromJob(reindexJobRes.data);
                        startReindexJobStream();
                    }
                }

                var items = bucketsData.items || [];
                window._settingsSearchBucketsSnapshot = items;
                if (typeof window.setSettingsMenuCountById === 'function') {
                    window.setSettingsMenuCountById('settingsCountSearch', items.length);
                }

                inner.classList.remove('content-body-soft-refresh');

                if (items.length === 0) {
                    inner.innerHTML =
                        '<div class="empty-state">' +
                        '<i class="fa-solid fa-database empty-state-icon"></i>' +
                        '</div>';
                    if (typeof window.setSettingsToolbarState === 'function') {
                        window.setSettingsToolbarState(true, { searchLocked: true });
                    }
                    if (!soft && typeof window.onSettingsTableCleared === 'function') {
                        window.onSettingsTableCleared();
                    }
                    return;
                }

                if (!soft) {
                    if (settingsSearchInput) settingsSearchInput.value = '';
                    if (settingsSearchClear) settingsSearchClear.classList.add('hidden');
                }

                inner.innerHTML = renderSearchBucketsTable(items, status);
                applySearchIndexEnabledRowState();
                initSearchIndexAllHeaderState();
                updateSearchToolbar(status);
                if (reindexJobRes.ok && reindexJobRes.data) {
                    applyReindexJobStatus(reindexJobRes.data);
                }

                if (typeof window.onSettingsTableRendered === 'function') {
                    window.onSettingsTableRendered({ preservePage: soft });
                }

                if (soft && viewState && typeof window.restoreSettingsTableViewState === 'function') {
                    window.restoreSettingsTableViewState(viewState);
                }
            })
            .catch(function () {
                inner.classList.remove('content-body-soft-refresh');
                if (typeof window.setSettingsMenuCountById === 'function') {
                    window.setSettingsMenuCountById('settingsCountSearch', 0);
                }
                inner.innerHTML =
                    '<div class="content-empty">' + escapeHtml(t('settings.error_load')) + '</div>';
                if (!soft && typeof window.onSettingsTableCleared === 'function') {
                    window.onSettingsTableCleared();
                }
            });
    }

    function resetSettingsSearchLayout() {
        updateSearchToolbar(_meiliStatusCache);
        syncReindexJobFromServer();
    }

    bindSearchToolbarControls();

    window.fetchMeilisearchStatus = fetchMeilisearchStatus;
    window.syncReindexJobFromServer = syncReindexJobFromServer;
    window.confirmAndReindexAll = confirmAndReindexAll;
    window.handleReindexAllBtnClick = handleReindexAllBtnClick;
    window.confirmAndReindexBucket = confirmAndReindexBucket;
    window.resetSettingsSearchLayout = resetSettingsSearchLayout;
    window.loadSettingsSearch = loadSettingsSearch;
    window.isMeiliSearchRunnable = function () {
        return isMeiliRunnable(_meiliStatusCache);
    };
    window.isBucketSearchReindexInProgress = isBucketReindexInProgress;
    window.toggleBucketSearchIndexEnabled = function (bucketId, enabled) {
        var prevEnabled = isBucketSearchIndexEnabled(bucketId);
        updateSearchIndexEnabledInSnapshot(bucketId, enabled);
        applySearchIndexEnabledRowState();
        return setBucketSearchIndexEnabled(bucketId, enabled)
            .then(function (res) {
                if (!res.ok) {
                    updateSearchIndexEnabledInSnapshot(bucketId, prevEnabled);
                    applySearchIndexEnabledRowState();
                    if (typeof showError === 'function') {
                        showError((res.data && res.data.error) || t('error.unexpected'));
                    }
                    return;
                }
                updateSearchIndexEnabledInSnapshot(bucketId, enabled);
                applySearchIndexEnabledRowState();
            })
            .catch(function () {
                updateSearchIndexEnabledInSnapshot(bucketId, prevEnabled);
                applySearchIndexEnabledRowState();
                if (typeof showError === 'function') showError(t('msg.network_error'));
            });
    };
})();
