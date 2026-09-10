/**
 * Настройки: пользователи и роли (таблицы, модалки add/edit user, role edit).
 * Зависит от window.I18N, window.settingsPanelState, showConfirmModal/showInfo (modal.js).
 * Инициализация: window.initSettingsUsersRoles() из setupSettingsPanel в index.html.
 */
(function () {
    'use strict';

function toastFormError(message) {
    if (!message) return;
    if (typeof window.showError === 'function') {
        window.showError(message);
    }
}

function isSelfAdminUser(username) {
    return String(username || '').trim().toLowerCase() === 'admin';
}

function setModalSubmitBtn(btn, label) {
    if (!btn) return;
    btn.textContent = label;
}
window.setModalSubmitBtn = setModalSubmitBtn;

function canEditTargetUser(username) {
    var targetIsAdmin = isSelfAdminUser(username);
    if (!targetIsAdmin) return true;
    var currentUsername = window.fileManagerCurrentUser && window.fileManagerCurrentUser.username;
    return isSelfAdminUser(currentUsername);
}

function getSettingsUsersSnapshot() {
    return window._settingsUsersSnapshot || [];
}

function setSettingsMenuCountById(elementId, value) {
    var el = document.getElementById(elementId);
    if (!el) return;
    var n = Number(value);
    el.textContent = Number.isFinite(n) && n >= 0 ? String(Math.floor(n)) : '0';
    el.classList.remove('hidden');
}
window.setSettingsMenuCountById = setSettingsMenuCountById;

function applySettingsMenuCounts(counts) {
    if (!counts) return;
    setSettingsMenuCountById('settingsCountBuckets', counts.buckets || 0);
    setSettingsMenuCountById('settingsCountSearch', counts.search || 0);
    setSettingsMenuCountById('settingsCountClouds', counts.clouds || 0);
    setSettingsMenuCountById('settingsCountUsers', counts.users || 0);
    setSettingsMenuCountById('settingsCountRoles', counts.roles || 0);
    var statusCount = counts.status;
    if (statusCount == null && typeof window.getStatusServicesCount === 'function') {
        statusCount = window.getStatusServicesCount();
    }
    if (statusCount == null) statusCount = 0;
    setSettingsMenuCountById('settingsCountStatus', statusCount);
}
window.applySettingsMenuCounts = applySettingsMenuCounts;

function refreshSettingsMenuCounts() {
    if (window._settingsMenuCounts) {
        applySettingsMenuCounts(window._settingsMenuCounts);
    }

    function fetchItemsCount(url) {
        return fetch(url, { credentials: 'include' })
            .then(function(r) {
                if (!r.ok) return { items: [] };
                return r.json();
            })
            .then(function(data) {
                return Array.isArray(data && data.items) ? data.items.length : 0;
            })
            .catch(function() { return 0; });
    }

    return Promise.all([
        fetchItemsCount('/api/settings/buckets'),
        fetchItemsCount('/api/settings/clouds'),
        fetchItemsCount('/api/settings/users'),
        fetchItemsCount('/api/settings/roles')
    ]).then(function(counts) {
        var statusCount = (typeof window.getStatusServicesCount === 'function')
            ? window.getStatusServicesCount()
            : 0;
        var resolved = {
            buckets: counts[0] || 0,
            search: counts[0] || 0,
            clouds: counts[1] || 0,
            users: counts[2] || 0,
            roles: counts[3] || 0,
            status: statusCount
        };
        window._settingsMenuCounts = resolved;
        applySettingsMenuCounts(resolved);
        return resolved;
    }).catch(function() {
        var fallback = window._settingsMenuCounts || { buckets: 0, search: 0, clouds: 0, users: 0, roles: 0, status: 0 };
        if (fallback.status == null && typeof window.getStatusServicesCount === 'function') {
            fallback.status = window.getStatusServicesCount();
        }
        applySettingsMenuCounts(fallback);
        return fallback;
    });
}
window.refreshSettingsMenuCounts = refreshSettingsMenuCounts;

function isUsernameTaken(username) {
    var v = (username || '').trim();
    if (!v) return false;
    var names = getSettingsUsersSnapshot();
    for (var i = 0; i < names.length; i++) {
        if (String(names[i]) === v) return true;
    }
    return false;
}

/** Роль admin может редактировать только пользователь с логином admin (как учётку admin). */
function canEditTargetRole(roleName) {
    if (String(roleName || '').trim().toLowerCase() !== 'admin') return true;
    var currentUsername = window.fileManagerCurrentUser && window.fileManagerCurrentUser.username;
    return isSelfAdminUser(currentUsername);
}

var addUserBucketRolesEditing = false;
var addUserBucketRolesEditShowRows = false;
var addUserBucketRolesOverrides = {};
var addUserBucketRolesRoleOptions = [];

function getAddUserDefaultRole() {
    return (document.getElementById('addUserRoleValue') && document.getElementById('addUserRoleValue').value) || 'storage_viewer';
}

function getAddUserSelectedBucketsList() {
    var bucketsPanel = document.getElementById('addUserBucketsPanel');
    if (!bucketsPanel) return [];
    return Array.from(bucketsPanel.querySelectorAll('input[type="checkbox"]:checked'))
        .filter(function(inp) { return inp.value && inp.value !== '*'; })
        .map(function(inp) {
            return {
                id: inp.value,
                label: inp.getAttribute('data-label') || inp.value
            };
        });
}

function getAddUserBucketDropdownOptions() {
    return getAddUserSelectedBucketsList().map(function(item) {
        return { value: item.id, label: item.label };
    });
}

function overridesFromGrantsMap(grantsMap, defaultRole) {
    var out = {};
    Object.keys(grantsMap || {}).forEach(function(bucketId) {
        var role = grantsMap[bucketId];
        if (role && role !== defaultRole) out[bucketId] = role;
    });
    return out;
}

function addUserBucketRolesEntriesFromOverrides() {
    var buckets = getAddUserSelectedBucketsList();
    var labels = {};
    buckets.forEach(function(b) { labels[b.id] = b.label; });
    return Object.keys(addUserBucketRolesOverrides)
        .filter(function(id) { return labels[id]; })
        .map(function(bucketId) {
            return { bucket_id: bucketId, role: addUserBucketRolesOverrides[bucketId] };
        })
        .sort(function(a, b) {
            return String(labels[a.bucket_id] || a.bucket_id).localeCompare(String(labels[b.bucket_id] || b.bucket_id), undefined, { sensitivity: 'base' });
        });
}

function showAddUserBucketRolesNoBucketsToast() {
    var message = (window.I18N && window.I18N['modal.user_bucket_roles_hint']) || 'Select buckets above first.';
    if (typeof showInfo === 'function') {
        showInfo(message);
    } else if (typeof showWarning === 'function') {
        showWarning(message);
    }
}

function escapeAddUserHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function userBucketRoleDropdownLabel(roleOptions, value) {
    var found = (roleOptions || []).filter(function(o) { return o.value === value; })[0];
    return (found && found.label) || value || '—';
}

function buildAddUserBucketRoleDropdownHtml(id, fieldRole, options, value) {
    var label = userBucketRoleDropdownLabel(options, value);
    var items = (options || []).map(function(opt) {
        var sel = opt.value === value ? ' selected' : '';
        return '<button type="button" class="dropdown-item' + sel + '" data-value="' + escapeAddUserHtml(opt.value) + '" role="option">' + escapeAddUserHtml(opt.label) + '</button>';
    }).join('');
    if (value && !(options || []).some(function(o) { return o.value === value; })) {
        items += '<button type="button" class="dropdown-item selected" data-value="' + escapeAddUserHtml(value) + '" role="option">' + escapeAddUserHtml(value) + '</button>';
    }
    return '<div class="dropdown dropdown-acl" id="' + escapeAddUserHtml(id) + '" data-bucket-role="' + escapeAddUserHtml(fieldRole) + '">' +
        '<button type="button" class="dropdown-trigger" aria-expanded="false" aria-haspopup="listbox">' +
        '<span class="has-selection">' + escapeAddUserHtml(label) + '</span>' +
        '<i class="fa-solid fa-chevron-down dropdown-icon"></i></button>' +
        '<div class="dropdown-menu hidden" role="listbox">' + items + '</div>' +
        '<input type="hidden" class="dropdown-value" value="' + escapeAddUserHtml(value) + '">' +
        '</div>';
}

function closeAllAddUserBucketRoleAclDropdowns() {
    var modal = document.getElementById('addUserModal');
    if (!modal) return;
    modal.querySelectorAll('.dropdown-acl.open').forEach(function(wrap) {
        wrap.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
    });
}

function bindAddUserBucketRolesScrollChaining() {
    if (typeof window.bindModalScrollChaining !== 'function') return;
    window.bindModalScrollChaining({
        modalId: 'addUserModal',
        scrollHostId: 'AddUserModal',
        targetSelector: '#addUserBucketRolesGrants, #addUserBucketRolesEditRows'
    });
}

function setAddUserBucketRoleDropdownValue(wrap, value, label) {
    var hidden = wrap.querySelector('.dropdown-value');
    var labelEl = wrap.querySelector('.dropdown-trigger span');
    if (hidden) hidden.value = value;
    if (labelEl) {
        labelEl.textContent = label;
        labelEl.classList.add('has-selection');
    }
    wrap.querySelectorAll('.dropdown-item').forEach(function(item) {
        item.classList.toggle('selected', item.getAttribute('data-value') === value);
    });
}

function getAddUserBucketRoleDropdownValue(wrap) {
    if (!wrap) return '';
    var hidden = wrap.querySelector('.dropdown-value');
    return hidden ? hidden.value : '';
}

function setupAddUserBucketRoleDropdown(wrap) {
    var trigger = wrap.querySelector('.dropdown-trigger');
    var menu = wrap.querySelector('.dropdown-menu');
    if (!trigger || !menu) return;
    trigger.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var willOpen = !wrap.classList.contains('open');
        closeAllAddUserDropdownPanels();
        closeAllAddUserBucketRoleAclDropdowns();
        if (willOpen) {
            wrap.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
            menu.classList.remove('hidden');
            if (typeof window.fitDropdownMenuOverlay === 'function') window.fitDropdownMenuOverlay(wrap);
        }
    });
    menu.querySelectorAll('.dropdown-item').forEach(function(item) {
        item.addEventListener('click', function(ev) {
            ev.stopPropagation();
            var value = item.getAttribute('data-value') || '';
            var itemLabel = (item.textContent || '').trim();
            setAddUserBucketRoleDropdownValue(wrap, value, itemLabel);
            wrap.classList.remove('open');
            if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
        });
    });
}

function initAddUserBucketRoleDropdowns(root) {
    if (!root) return;
    root.querySelectorAll('.dropdown-acl').forEach(function(wrap) {
        if (wrap._addUserBrDdBound) return;
        wrap._addUserBrDdBound = true;
        setupAddUserBucketRoleDropdown(wrap);
    });
}

function defaultAddUserBucketRoleEditRow() {
    var buckets = getAddUserBucketDropdownOptions();
    var defaultRole = getAddUserDefaultRole();
    var usedIds = {};
    if (addUserBucketRolesEditing) {
        document.querySelectorAll('#addUserBucketRolesEditRows .file-info-acl-edit-row').forEach(function(row) {
            var bucketDd = row.querySelector('[data-bucket-role="bucket"]');
            var bid = getAddUserBucketRoleDropdownValue(bucketDd);
            if (bid) usedIds[bid] = true;
        });
    }
    Object.keys(addUserBucketRolesOverrides).forEach(function(id) { usedIds[id] = true; });
    var bucketId = '';
    for (var i = 0; i < buckets.length; i++) {
        if (!usedIds[buckets[i].value]) {
            bucketId = buckets[i].value;
            break;
        }
    }
    if (!bucketId && buckets.length) bucketId = buckets[0].value;
    return { bucket_id: bucketId, role: defaultRole };
}

function addUserBucketRoleEditRowHtml(entry, idx) {
    var t = window.I18N || {};
    entry = entry || defaultAddUserBucketRoleEditRow();
    var bucketOpts = getAddUserBucketDropdownOptions();
    var roleOpts = addUserBucketRolesRoleOptions || [];
    var bucketId = entry.bucket_id && bucketOpts.some(function(o) { return o.value === entry.bucket_id; })
        ? entry.bucket_id
        : (bucketOpts[0] && bucketOpts[0].value) || '';
    var role = entry.role && roleOpts.some(function(o) { return o.value === entry.role; })
        ? entry.role
        : getAddUserDefaultRole();
    return '<div class="modal-field file-info-acl-edit-row" data-row="' + idx + '">' +
        buildAddUserBucketRoleDropdownHtml('addUserBrBucket_' + idx, 'bucket', bucketOpts, bucketId) +
        buildAddUserBucketRoleDropdownHtml('addUserBrRole_' + idx, 'role', roleOpts, role) +
        '<button type="button" class="btn icon-btn delete file-info-acl-remove" title="' + escapeAddUserHtml(t['files.info_acl_remove_grant'] || 'Remove') + '" aria-label="' + escapeAddUserHtml(t['files.info_acl_remove_grant'] || 'Remove') + '">' +
        '<i class="fa-solid fa-trash-can"></i></button></div>';
}

function addUserBucketRoleViewRowHtml(entry) {
    var buckets = getAddUserSelectedBucketsList();
    var label = entry.bucket_id;
    buckets.forEach(function(b) {
        if (b.id === entry.bucket_id) label = b.label;
    });
    var roleLabel = userBucketRoleDropdownLabel(addUserBucketRolesRoleOptions, entry.role);
    return '<div class="modal-field file-info-acl-row">' +
        '<span class="user-info-value file-info-acl-col-user">' + escapeAddUserHtml(label) + '</span>' +
        '<span class="user-info-value file-info-acl-col-perm">' + escapeAddUserHtml(roleLabel) + '</span></div>';
}

function renderAddUserBucketRolesView() {
    var container = document.getElementById('addUserBucketRolesGrants');
    if (!container) return;
    var entries = addUserBucketRolesEntriesFromOverrides();
    if (!entries.length) {
        container.innerHTML = '<div class="file-info-acl-message">' + escapeAddUserHtml((window.I18N && window.I18N['modal.user_bucket_roles_empty']) || 'All selected buckets use the default role.') + '</div>';
        return;
    }
    var html = '';
    entries.forEach(function(entry) {
        html += addUserBucketRoleViewRowHtml(entry);
    });
    container.innerHTML = html;
}

function renderAddUserBucketRolesEdit() {
    var container = document.getElementById('addUserBucketRolesGrants');
    if (!container) return;
    var entries = addUserBucketRolesEntriesFromOverrides();
    if (!entries.length && !addUserBucketRolesEditShowRows) {
        container.innerHTML = '<div class="file-info-acl-message">' + escapeAddUserHtml((window.I18N && window.I18N['modal.user_bucket_roles_empty']) || 'All selected buckets use the default role.') + '</div>';
        return;
    }
    var html = '<div id="addUserBucketRolesEditRows">';
    entries.forEach(function(entry, idx) {
        html += addUserBucketRoleEditRowHtml(entry, idx);
    });
    html += '</div>';
    container.innerHTML = html;
    initAddUserBucketRoleDropdowns(container);
}

function syncAddUserBucketRolesOverridesFromEditForm() {
    if (!addUserBucketRolesEditing) return;
    var defaultRole = getAddUserDefaultRole();
    var selectedIds = getSelectedBucketIdsFromPanel(document.getElementById('addUserBucketsPanel'));
    var next = {};
    document.querySelectorAll('#addUserBucketRolesEditRows .file-info-acl-edit-row').forEach(function(row) {
        var bucketDd = row.querySelector('[data-bucket-role="bucket"]');
        var roleDd = row.querySelector('[data-bucket-role="role"]');
        var bucketId = getAddUserBucketRoleDropdownValue(bucketDd);
        var role = getAddUserBucketRoleDropdownValue(roleDd);
        if (!bucketId || !role || !selectedIds[bucketId] || role === defaultRole) return;
        next[bucketId] = role;
    });
    addUserBucketRolesOverrides = next;
}

function renderAddUserBucketRolesPanel() {
    if (addUserBucketRolesEditing) {
        renderAddUserBucketRolesEdit();
    } else {
        renderAddUserBucketRolesView();
    }
}

function removeAddUserBucketRoleEditRow(row) {
    var rows = document.getElementById('addUserBucketRolesEditRows');
    if (!row || !rows) return;
    row.remove();
    syncAddUserBucketRolesOverridesFromEditForm();
    if (!rows.querySelectorAll('.file-info-acl-edit-row').length) {
        addUserBucketRolesEditShowRows = false;
        renderAddUserBucketRolesEdit();
    }
}

function addUserBucketRolesAddRow() {
    var container = document.getElementById('addUserBucketRolesGrants');
    if (!addUserBucketRolesEditShowRows) {
        addUserBucketRolesEditShowRows = true;
        renderAddUserBucketRolesEdit();
    }
    if (!document.getElementById('addUserBucketRolesEditRows') && container) {
        container.innerHTML = '<div id="addUserBucketRolesEditRows"></div>';
    }
    var rows = document.getElementById('addUserBucketRolesEditRows');
    if (!rows) return;
    var idx = rows.querySelectorAll('.file-info-acl-edit-row').length;
    var div = document.createElement('div');
    div.innerHTML = addUserBucketRoleEditRowHtml(defaultAddUserBucketRoleEditRow(), idx);
    var row = div.firstElementChild;
    rows.appendChild(row);
    initAddUserBucketRoleDropdowns(row);
}

function enterAddUserBucketRolesEdit() {
    addUserBucketRolesEditing = true;
    addUserBucketRolesEditShowRows = addUserBucketRolesEntriesFromOverrides().length > 0;
    renderAddUserBucketRolesEdit();
}

function addUserBucketRolesAddCustomRole() {
    var bucketsPanel = document.getElementById('addUserBucketsPanel');
    if (Object.keys(getSelectedBucketIdsFromPanel(bucketsPanel)).length === 0) {
        showAddUserBucketRolesNoBucketsToast();
        return;
    }
    if (!addUserBucketRolesEditing) {
        enterAddUserBucketRolesEdit();
    }
    addUserBucketRolesAddRow();
}

function closeAddUserBucketRolesEditor() {
    if (addUserBucketRolesEditing) syncAddUserBucketRolesOverridesFromEditForm();
    addUserBucketRolesEditing = false;
    addUserBucketRolesEditShowRows = false;
    closeAllAddUserBucketRoleAclDropdowns();
    renderAddUserBucketRolesView();
}

function setAddUserBucketRolesRoleOptions(roleOptions) {
    if (roleOptions) addUserBucketRolesRoleOptions = roleOptions;
}

function loadAddUserBucketRolesOverrides(grantsMap) {
    addUserBucketRolesOverrides = overridesFromGrantsMap(grantsMap || {}, getAddUserDefaultRole());
    renderAddUserBucketRolesPanel();
}

function onAddUserBucketsSelectionChanged(roleOptions) {
    setAddUserBucketRolesRoleOptions(roleOptions);
    var bucketsPanel = document.getElementById('addUserBucketsPanel');
    if (Object.keys(getSelectedBucketIdsFromPanel(bucketsPanel)).length === 0) {
        closeAddUserBucketRolesEditor();
        addUserBucketRolesOverrides = {};
        renderAddUserBucketRolesPanel();
        return;
    }
    if (addUserBucketRolesEditing) {
        syncAddUserBucketRolesOverridesFromEditForm();
        var selectedIds = getSelectedBucketIdsFromPanel(bucketsPanel);
        Object.keys(addUserBucketRolesOverrides).forEach(function(bucketId) {
            if (!selectedIds[bucketId]) delete addUserBucketRolesOverrides[bucketId];
        });
        renderAddUserBucketRolesEdit();
    } else {
        var defaultRole = getAddUserDefaultRole();
        var selectedIds = getSelectedBucketIdsFromPanel(bucketsPanel);
        Object.keys(addUserBucketRolesOverrides).forEach(function(bucketId) {
            if (!selectedIds[bucketId]) delete addUserBucketRolesOverrides[bucketId];
        });
        addUserBucketRolesOverrides = overridesFromGrantsMap(addUserBucketRolesOverrides, defaultRole);
        renderAddUserBucketRolesView();
    }
}

function onAddUserDefaultRoleChanged(roleOptions) {
    setAddUserBucketRolesRoleOptions(roleOptions);
    if (addUserBucketRolesEditing) {
        syncAddUserBucketRolesOverridesFromEditForm();
        addUserBucketRolesOverrides = overridesFromGrantsMap(addUserBucketRolesOverrides, getAddUserDefaultRole());
        renderAddUserBucketRolesEdit();
    } else {
        addUserBucketRolesOverrides = overridesFromGrantsMap(addUserBucketRolesOverrides, getAddUserDefaultRole());
        renderAddUserBucketRolesView();
    }
}

function ensureAddUserBucketRolesRemoveDelegation() {
    var container = document.getElementById('addUserBucketRolesGrants');
    if (!container || container._addUserBrRemoveDelegated) return;
    container._addUserBrRemoveDelegated = true;
    container.addEventListener('click', function(ev) {
        var btn = ev.target.closest('.file-info-acl-remove');
        if (!btn || !addUserBucketRolesEditing) return;
        ev.preventDefault();
        ev.stopPropagation();
        var row = btn.closest('.file-info-acl-edit-row');
        if (row) removeAddUserBucketRoleEditRow(row);
    });
}

function wireAddUserBucketRolesControls() {
    var addBtn = document.getElementById('addUserEditBucketRolesBtn');
    if (addBtn && !addBtn._addUserBucketRolesBtnBound) {
        addBtn._addUserBucketRolesBtnBound = true;
        addBtn.addEventListener('click', addUserBucketRolesAddCustomRole);
    }
    ensureAddUserBucketRolesRemoveDelegation();
    bindAddUserBucketRolesScrollChaining();
}

function bucketRolesMapFromList(list) {
    var out = {};
    (list || []).forEach(function(item) {
        if (item && item.bucket_id) {
            out[String(item.bucket_id)] = item.role || 'storage_viewer';
        }
    });
    return out;
}

function collectAddUserBucketRoles() {
    if (addUserBucketRolesEditing) syncAddUserBucketRolesOverridesFromEditForm();
    var defaultRole = getAddUserDefaultRole();
    return Object.keys(addUserBucketRolesOverrides)
        .filter(function(bucketId) { return addUserBucketRolesOverrides[bucketId] && addUserBucketRolesOverrides[bucketId] !== defaultRole; })
        .map(function(bucketId) {
            return {
                bucket_id: bucketId,
                role: addUserBucketRolesOverrides[bucketId]
            };
        });
}

function getUserFormSelectedCloudIds(cloudsPanel) {
    if (!cloudsPanel) return [];
    return Array.from(cloudsPanel.querySelectorAll('input:checked')).map(function(c) { return c.value; });
}

function userFormHasSelectedClouds(cloudsPanel) {
    return getUserFormSelectedCloudIds(cloudsPanel).length > 0;
}

function syncAddUserBucketsTriggerState(cloudsPanel) {
    var trigger = document.getElementById('addUserBucketsTrigger');
    if (!trigger) return;
    var enabled = userFormHasSelectedClouds(cloudsPanel);
    trigger.disabled = !enabled;
    if (!enabled) {
        var wrap = document.getElementById('addUserBucketsWrap');
        if (wrap) {
            wrap.classList.remove('open');
            if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
        }
    }
}

function renderAddUserBucketsPanelNoClouds(bucketsPanel, bucketsLabel, t) {
    if (bucketsPanel) {
        bucketsPanel.innerHTML = '';
        var hint = document.createElement('div');
        hint.className = 'dropdown-search-empty';
        hint.textContent = (t && t['modal.user_buckets_select_cloud_first']) || 'Select a cloud first';
        bucketsPanel.appendChild(hint);
    }
    if (bucketsLabel) {
        bucketsLabel.textContent = '—';
        bucketsLabel.classList.remove('has-selection');
    }
}

function getSelectedBucketIdsFromPanel(bucketsPanel) {
    var selectedIds = {};
    if (!bucketsPanel) return selectedIds;
    Array.from(bucketsPanel.querySelectorAll('input[type="checkbox"]:checked'))
        .filter(function(inp) { return inp.value && inp.value !== '*'; })
        .forEach(function(inp) { selectedIds[inp.value] = true; });
    return selectedIds;
}

function resetAddUserModalForm() {
    closeAllAddUserDropdownPanels();
    var bucketsLabel = document.getElementById('addUserBucketsLabel');
    var cloudsLabel = document.getElementById('addUserCloudsLabel');
    var roleLabel = document.getElementById('addUserRoleLabel');
    var roleValueInput = document.getElementById('addUserRoleValue');
    var rolePanel = document.getElementById('addUserRolePanel');
    var bucketsPanel = document.getElementById('addUserBucketsPanel');
    var cloudsPanel = document.getElementById('addUserCloudsPanel');
    var bucketsWrap = document.getElementById('addUserBucketsWrap');
    var cloudsWrap = document.getElementById('addUserCloudsWrap');
    var roleWrap = document.getElementById('addUserRoleWrap');
    if (bucketsLabel) {
        bucketsLabel.textContent = '—';
        bucketsLabel.classList.remove('has-selection');
    }
    if (cloudsLabel) {
        cloudsLabel.textContent = '—';
        cloudsLabel.classList.remove('has-selection');
    }
    if (roleLabel) {
        roleLabel.textContent = '—';
        roleLabel.classList.remove('has-selection');
    }
    if (roleValueInput) roleValueInput.value = 'storage_viewer';
    if (rolePanel) {
        rolePanel.innerHTML = '';
        rolePanel.classList.add('hidden');
        rolePanel.style.maxHeight = '';
    }
    if (bucketsPanel) {
        bucketsPanel.innerHTML = '';
        bucketsPanel.classList.add('hidden');
        bucketsPanel.style.maxHeight = '';
        delete bucketsPanel._dropdownSearchQuery;
    }
    if (cloudsPanel) {
        cloudsPanel.innerHTML = '';
        cloudsPanel.classList.add('hidden');
        cloudsPanel.style.maxHeight = '';
        delete cloudsPanel._dropdownSearchQuery;
    }
    [bucketsWrap, cloudsWrap, roleWrap].forEach(function(wrap) {
        if (wrap) wrap.classList.remove('open');
    });
    closeAddUserBucketRolesEditor();
    addUserBucketRolesOverrides = {};
    addUserBucketRolesRoleOptions = [];
    var errEl = document.getElementById('addUserError');
    if (errEl) errEl.textContent = '';
    var fullNameEl = document.getElementById('addUserFullName');
    if (fullNameEl) fullNameEl.value = '';
    var emailEl = document.getElementById('addUserEmail');
    if (emailEl) emailEl.value = '';
    syncAddUserBucketsTriggerState(cloudsPanel);
    renderAddUserBucketRolesPanel();
}

function loadSettingsUsers() {
    window.settingsPanelState.currentTab = 'users';
    if (typeof window.resetSettingsSearchLayout === 'function') window.resetSettingsSearchLayout();
    var settingsToolbar = document.getElementById('secondaryToolbar');
    var settingsContentInner = document.getElementById('settingsContentInner');
    var settingsSearchInput = document.getElementById('settingsSearchInput');
    var settingsSearchClear = document.getElementById('settingsSearchClear');
    if (!settingsContentInner) return;
    setSettingsToolbarVisibleFallback(false);
    const t = window.I18N || {};
    if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
    settingsContentInner.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin empty-state-icon"></i><div>' + (t['settings.loading'] || 'Loading...') + '</div></div>';
    Promise.all([
        fetch('/api/settings/users', { credentials: 'include' }).then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(new Error(j.error || r.statusText)))),
        fetch('/api/settings/options/buckets', { credentials: 'include' }).then(function(r) { return r.ok ? r.json() : { items: [] }; })
    ])
        .then(function(results) {
            var data = results[0];
            var optData = results[1] || {};
            var bucketOptions = Array.isArray(optData.items) ? optData.items : [];
            const items = data.items || [];
            window._settingsUsersSnapshot = items.map(function(row) { return row.username; });
            setSettingsMenuCountById('settingsCountUsers', items.length);
            if (items.length === 0) {
                settingsContentInner.innerHTML = '<div class="content-empty">' + (t['settings.no_users'] || 'No records') + '</div>';
                setSettingsToolbarVisibleFallback(true, { searchLocked: true });
                if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
                return;
            }
            setSettingsToolbarVisibleFallback(true, { searchLocked: false });
            if (settingsSearchInput) settingsSearchInput.value = '';
            if (settingsSearchClear) settingsSearchClear.classList.add('hidden');
            var editTitle = t['settings.edit_user'] || 'Edit';
            var deleteTitle = t['settings.delete_user'] || 'Delete';
            let html = '<table class="content-table"><thead><tr>'
                + '<th><div class="content-table-header">' + (t['settings.table_username'] || 'User') + '</div></th>'
                + '<th><div class="content-table-header">' + (t['settings.table_role'] || 'Role') + '</div></th>'
                + '<th><div class="content-table-header">' + (t['settings.table_buckets'] || 'Buckets') + '</div></th>'
                + '<th><div class="content-table-header">' + (t['settings.table_clouds'] || 'Clouds') + '</div></th>'
                + '<th class="settings-col-last-login"><div class="content-table-header">' + (t['settings.table_last_login'] || 'Last login') + '</div></th>'
                + '</tr></thead><tbody id="settingsTableBody">';
            items.forEach(row => {
                const buckets = formatUserBucketsCellDisplay(row.buckets, bucketOptions, t, row.clouds);
                const clouds = (Array.isArray(row.clouds) && row.clouds.length) ? row.clouds.join(', ') : '—';
                const lastLogin = formatUserLastLoginCell(row.last_login_at);
                const unRaw = String(row.username || '');
                const un = escapeHtml(unRaw.toLowerCase());
                const unAttr = escapeHtml(unRaw);
                const isAdminUser = unRaw.toLowerCase() === 'admin';
                const canEdit = canEditTargetUser(row.username);
                const adminDeleteTitle = (t['error.cannot_delete_admin'] || deleteTitle).replace(/"/g, '&quot;');
                const adminEditTitle = (t['error.cannot_edit_admin'] || editTitle).replace(/"/g, '&quot;');
                html += '<tr class="settings-user-row" data-username="' + unAttr + '"'
                    + ' data-can-edit="' + (canEdit ? '1' : '0') + '"'
                    + ' data-can-delete="' + (isAdminUser ? '0' : '1') + '"'
                    + ' data-edit-denied-title="' + adminEditTitle + '"'
                    + ' data-delete-denied-title="' + adminDeleteTitle + '"'
                    + '><td>' + un + '</td><td>' + escapeHtml(formatUserRoleCellDisplay(row, t)) + '</td><td class="content-table-cell-multiline">' + escapeHtml(buckets) + '</td><td>' + escapeHtml(clouds) + '</td><td class="settings-col-last-login">' + escapeHtml(lastLogin) + '</td></tr>';
            });
            html += '</tbody></table>';
            settingsContentInner.innerHTML = html;
            if (typeof window.onSettingsTableRendered === 'function') window.onSettingsTableRendered();
        })
        .catch(() => {
            setSettingsMenuCountById('settingsCountUsers', 0);
            settingsContentInner.innerHTML = '<div class="content-empty">' + (t['settings.error_load'] || 'Error loading or access denied') + '</div>';
            if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
        });
}
/** Сортировка прав по алфавиту (локализованная подпись, иначе id). */
function sortRolePermissionIds(perms, t) {
    t = t || {};
    return perms.slice().sort(function(a, b) {
        var la = (t['perm.' + a] || a).toLowerCase();
        var lb = (t['perm.' + b] || b).toLowerCase();
        return la.localeCompare(lb, undefined, { sensitivity: 'base' });
    });
}
function formatRolePermissionsCell(perms, t) {
    t = t || {};
    if (!Array.isArray(perms) || perms.length === 0) return '—';
    return sortRolePermissionIds(perms, t).map(function(p) {
        return t['perm.' + p] || p;
    }).join(', ');
}

var ROLE_PERM_GROUPS = [
    {
        id: 'copy',
        labelKey: 'perm.group.copy',
        permIds: ['copy_file', 'copy_files_multi', 'copy_folder', 'copy_folder_multi']
    },
    {
        id: 'move',
        labelKey: 'perm.group.move',
        permIds: ['move_file', 'move_files_multi', 'move_folder', 'move_folder_multi']
    },
    {
        id: 'delete',
        labelKey: 'perm.group.delete',
        permIds: ['delete_file', 'delete_files_multi', 'delete_folder', 'delete_folder_multi']
    },
    {
        id: 'upload',
        labelKey: 'perm.group.upload',
        permIds: ['upload_files', 'upload_folder']
    },
    {
        id: 'create',
        labelKey: 'perm.group.create',
        permIds: ['create_folder']
    },
    {
        id: 'add',
        labelKey: 'perm.group.add',
        permIds: ['add_bucket']
    },
    {
        id: 'download',
        labelKey: 'perm.group.download',
        permIds: ['download_file', 'download_files_multi', 'download_folder']
    },
    {
        id: 'preview',
        labelKey: 'perm.group.preview',
        permIds: ['preview']
    },
    {
        id: 'other',
        labelKey: 'perm.group.other',
        permIds: ['edit_file_acl']
    }
];

function sortRolePermItems(items) {
    return items.slice().sort(function(a, b) {
        var la = (a.label || a.id || '').toLowerCase();
        var lb = (b.label || b.id || '').toLowerCase();
        return la.localeCompare(lb, undefined, { sensitivity: 'base' });
    });
}

function appendRolePermCheckbox(container, item, selectedSet) {
    var fg = document.createElement('div');
    fg.className = 'form-group form-group-checkbox role-perm-form-group';
    var lab = document.createElement('label');
    lab.className = 'lables role-perm-option';
    var inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'checkbox';
    inp.value = item.id;
    if (selectedSet[item.id]) inp.checked = true;
    var span = document.createElement('span');
    span.textContent = item.label || item.id;
    lab.appendChild(inp);
    lab.appendChild(span);
    fg.appendChild(lab);
    container.appendChild(fg);
}

function buildRolePermBlock(title, items, selectedSet) {
    var section = document.createElement('section');
    section.className = 'file-info-acl-block role-perm-block';

    var panel = document.createElement('div');
    panel.className = 'file-info-acl-panel';

    var table = document.createElement('div');
    table.className = 'file-info-acl-table';

    var head = document.createElement('div');
    head.className = 'file-info-acl-head modal-field';
    var headLabel = document.createElement('span');
    headLabel.className = 'lables';
    headLabel.textContent = title;
    head.appendChild(headLabel);

    var grants = document.createElement('div');
    grants.className = 'role-perm-grants';
    sortRolePermItems(items).forEach(function(item) {
        appendRolePermCheckbox(grants, item, selectedSet);
    });

    table.appendChild(head);
    table.appendChild(grants);
    panel.appendChild(table);
    section.appendChild(panel);
    return section;
}
function loadSettingsRoles() {
    window.settingsPanelState.currentTab = 'roles';
    if (typeof window.resetSettingsSearchLayout === 'function') window.resetSettingsSearchLayout();
    var settingsToolbar = document.getElementById('secondaryToolbar');
    var settingsContentInner = document.getElementById('settingsContentInner');
    var settingsSearchInput = document.getElementById('settingsSearchInput');
    var settingsSearchClear = document.getElementById('settingsSearchClear');
    if (!settingsContentInner) return;
    setSettingsToolbarVisibleFallback(false);
    const t = window.I18N || {};
    if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
    settingsContentInner.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin empty-state-icon"></i><div>' + (t['settings.loading'] || 'Loading...') + '</div></div>';
    fetch('/api/settings/roles', { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : r.json().then(function(j) { return Promise.reject(new Error(j.error || r.statusText)); }); })
        .then(function(data) {
            var items = data.items || [];
            if (items.length === 0) {
                setSettingsMenuCountById('settingsCountRoles', 0);
                settingsContentInner.innerHTML = '<div class="content-empty">' + (t['settings.no_roles'] || 'No records') + '</div>';
                setSettingsToolbarVisibleFallback(true, { searchLocked: true });
                if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
                return;
            }
            window._settingsRolesSnapshot = items.map(function(row) { return row.name; });
            setSettingsMenuCountById('settingsCountRoles', items.length);
            setSettingsToolbarVisibleFallback(true, { searchLocked: false });
            if (settingsSearchInput) settingsSearchInput.value = '';
            if (settingsSearchClear) settingsSearchClear.classList.add('hidden');
            var editTitle = t['settings.edit_role'] || 'Edit';
            var deleteTitle = t['settings.delete_role'] || 'Delete';
            var permTh = t['settings.table_permissions'] || 'Permissions';
            var html = '<table class="content-table"><thead><tr>'
                + '<th><div class="content-table-header">' + (t['settings.table_role'] || 'Role') + '</div></th>'
                + '<th><div class="content-table-header">' + permTh + '</div></th>'
                + '</tr></thead><tbody id="settingsTableBody">';
            items.forEach(function(row) {
                var rn = row.name || '';
                var rnAttr = rn.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                var isAdminRole = String(rn).trim().toLowerCase() === 'admin';
                var adminRoleDeleteTitle = (t['error.cannot_delete_admin_role'] || deleteTitle).replace(/"/g, '&quot;');
                var canEditRole = canEditTargetRole(rn);
                var adminRoleEditTitle = (t['error.cannot_edit_admin_role'] || editTitle).replace(/"/g, '&quot;');
                html += '<tr data-role-name="' + rnAttr + '"'
                    + ' data-can-edit="' + (canEditRole ? '1' : '0') + '"'
                    + ' data-can-delete="' + (isAdminRole ? '0' : '1') + '"'
                    + ' data-edit-denied-title="' + adminRoleEditTitle + '"'
                    + ' data-delete-denied-title="' + adminRoleDeleteTitle + '"'
                    + '><td>' + escapeHtml(rn) + '</td><td>' + escapeHtml(formatRolePermissionsCell(row.permissions, t)) + '</td></tr>';
            });
            html += '</tbody></table>';
            settingsContentInner.innerHTML = html;
            if (typeof window.onSettingsTableRendered === 'function') window.onSettingsTableRendered();
        })
        .catch(function() {
            setSettingsMenuCountById('settingsCountRoles', 0);
            settingsContentInner.innerHTML = '<div class="content-empty">' + (t['settings.error_load'] || 'Error loading or access denied') + '</div>';
            if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
        });
}

function setSettingsToolbarVisibleFallback(visible, options) {
    if (typeof window.setSettingsToolbarState === 'function') {
        window.setSettingsToolbarState(visible, options);
        return;
    }
    if (typeof window.setSettingsToolbarVisible === 'function') {
        window.setSettingsToolbarVisible(visible, options);
    }
}

function loadSettingsClouds() {
    window.settingsPanelState.currentTab = 'clouds';
    if (typeof window.resetSettingsSearchLayout === 'function') window.resetSettingsSearchLayout();
    var settingsContentInner = document.getElementById('settingsContentInner');
    var settingsSearchInput = document.getElementById('settingsSearchInput');
    var settingsSearchClear = document.getElementById('settingsSearchClear');
    if (!settingsContentInner) return;
    setSettingsToolbarVisibleFallback(false);
    var t = window.I18N || {};
    if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
    settingsContentInner.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin empty-state-icon"></i><div>' + (t['settings.loading'] || 'Loading...') + '</div></div>';
    fetch('/api/settings/clouds', { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : r.json().then(function(j) { return Promise.reject(new Error(j.error || r.statusText)); }); })
        .then(function(data) {
            var items = Array.isArray(data.items) ? data.items : [];
            window._settingsCloudsSnapshot = items.map(function(row) { return row.cloud_id; });
            setSettingsMenuCountById('settingsCountClouds', items.length);
            if (items.length === 0) {
                var emptyHint = t['settings.no_clouds_hint'] || '';
                settingsContentInner.innerHTML =
                    '<div class="content-empty">' +
                    '<div>' + (t['settings.no_clouds'] || 'No records') + '</div>' +
                    (emptyHint ? '<div class="content-empty-hint">' + escapeHtml(emptyHint) + '</div>' : '') +
                    '</div>';
                setSettingsToolbarVisibleFallback(true, { searchLocked: true });
                if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
                return;
            }
            setSettingsToolbarVisibleFallback(true, { searchLocked: false });
            if (settingsSearchInput) settingsSearchInput.value = '';
            if (settingsSearchClear) settingsSearchClear.classList.add('hidden');
            var html = '<table class="content-table"><thead><tr>'
                + '<th><div class="content-table-header">' + (t['settings.table_cloud_id'] || 'Cloud ID') + '</div></th>'
                + '<th class="settings-col-display"><div class="content-table-header">' + (t['settings.table_display_name'] || 'Display Name') + '</div></th>'
                + '<th><div class="content-table-header">' + (t['settings.table_endpoint'] || 'Endpoint') + '</div></th>'
                + '</tr></thead><tbody id="settingsTableBody">';
            items.forEach(function(row) {
                var cloudId = (row && row.cloud_id) ? String(row.cloud_id) : '';
                var cloudIdAttr = cloudId.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                var display = (row && (row.display_name || row.name)) ? String(row.display_name || row.name) : cloudId;
                var endpointList = (row && Array.isArray(row.endpoint_url)) ? row.endpoint_url : splitCloudEndpoints(row && row.endpoint_url);
                var endpointText = endpointList.length ? endpointList.join(', ') : '—';
                html += '<tr data-cloud-id="' + cloudIdAttr + '">';
                html += '<td>' + escapeHtml(cloudId) + '</td>';
                html += '<td class="settings-col-display">' + escapeHtml(display) + '</td>';
                html += '<td>' + escapeHtml(endpointText) + '</td>';
                html += '</tr>';
            });
            html += '</tbody></table>';
            settingsContentInner.innerHTML = html;
            if (typeof window.onSettingsTableRendered === 'function') window.onSettingsTableRendered();
        })
        .catch(function() {
            setSettingsMenuCountById('settingsCountClouds', 0);
            settingsContentInner.innerHTML = '<div class="content-empty">' + (t['settings.error_load'] || 'Error loading or access denied') + '</div>';
            if (typeof window.onSettingsTableCleared === 'function') window.onSettingsTableCleared();
        });
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
/** Собрать buckets/clouds из чекбоксов модалки пользователя (add/edit). */
function collectUserFormAcl(bucketsPanel, cloudsPanel) {
    var clouds = Array.from((cloudsPanel && cloudsPanel.querySelectorAll('input:checked')) || []).map(function(inp) { return inp.value; });
    if (clouds.indexOf('*') !== -1) clouds = ['*'];
    if (clouds.length === 0) {
        return { buckets: [], clouds: [] };
    }
    var buckets = Array.from((bucketsPanel && bucketsPanel.querySelectorAll('input:checked')) || []).map(function(inp) { return inp.value; });
    if (buckets.indexOf('*') !== -1) buckets = ['*'];
    return { buckets: buckets, clouds: clouds };
}
/**
 * Совпадение записи из user.buckets с элементом /api/settings/options/buckets.
 * В ACL могут быть: id бакета, «cloud_id:display_name», «cloud_id:bucket_name», только display_name или bucket_name.
 */
function userBucketTokenMatchesOption(token, item) {
    if (token == null || token === '') return false;
    if (!item) return false;
    var s = String(token).trim();
    if (s === '*') return true;
    var id = String(item.id != null ? item.id : '');
    if (id && s === id) return true;
    var cid = String(item.cloud_id != null ? item.cloud_id : '');
    var disp = String(item.display_name != null ? item.display_name : '');
    var bname = (item.bucket_name != null && String(item.bucket_name).trim() !== '') ? String(item.bucket_name).trim() : '';
    if (disp && s === disp) return true;
    if (bname && s === bname) return true;
    var ci = s.indexOf(':');
    if (ci > 0) {
        var pCloud = s.slice(0, ci).trim();
        var pRest = s.slice(ci + 1).trim();
        if (pCloud === cid && pRest) {
            if (pRest === disp) return true;
            if (bname && pRest === bname) return true;
        }
    }
    return false;
}
/**
 * Колонка «Бакеты»: строки вида
 *   cloud_id: bucket_name1, bucket_name2, ...
 * bucket_name берётся из опций бакетов (S3-имя); для токена без совпадения — как в ACL.
 */
function isReservedRoleName(name) {
    return String(name || '').trim().toLowerCase() === 'custom';
}

function formatUserRoleCellDisplay(row, t) {
    t = t || {};
    if (row && row.has_custom_roles) {
        return t['role.custom'] || 'custom';
    }
    return (row && row.role) ? row.role : '—';
}

function formatUserLastLoginCell(iso) {
    if (!iso) return '—';
    if (typeof window.formatDate === 'function') {
        return window.formatDate(iso);
    }
    try {
        return new Date(iso).toLocaleString();
    } catch (e) {
        return '—';
    }
}

function openSettingsUserInfoModal(username) {
    if (!username) return;
    var t = window.I18N || {};
    fetch('/api/settings/users/' + encodeURIComponent(username), { credentials: 'include' })
        .then(function(r) {
            if (!r.ok) {
                return r.json().then(function(j) { return Promise.reject(new Error((j && j.error) || r.statusText)); });
            }
            return r.json();
        })
        .then(function(user) {
            if (!user || !user.username) return;
            if (typeof window.showUserDetailsModal === 'function') {
                window.showUserDetailsModal(user, { showAccountDates: true });
            }
        })
        .catch(function() {
            if (typeof window.showError === 'function') {
                window.showError(t['settings.error_load'] || 'Error loading or access denied');
            }
        });
}

function formatUserBucketsCellDisplay(buckets, bucketOptions, i18n, clouds) {
    i18n = i18n || {};
    if (!Array.isArray(buckets) || buckets.length === 0) return '—';
    if (buckets.indexOf('*') !== -1) {
        var cloudList = Array.isArray(clouds) ? clouds.filter(function(c) { return c != null && String(c).trim() !== ''; }) : [];
        if (!cloudList.length || cloudList.indexOf('*') !== -1) return '*';
        var uniqClouds = [];
        cloudList.forEach(function(c) {
            var s = String(c).trim();
            if (!s || s === '*' || uniqClouds.indexOf(s) !== -1) return;
            uniqClouds.push(s);
        });
        if (!uniqClouds.length) return '*';
        return uniqClouds.map(function(cid) {
            return cid + ': *';
        }).join('\n');
    }
    var opts = bucketOptions || [];
    function optionBucketName(o) {
        if (!o) return '';
        var bn = (o.bucket_name != null && String(o.bucket_name).trim() !== '') ? String(o.bucket_name).trim() : '';
        return bn || (o.display_name != null ? String(o.display_name) : '');
    }
    function resolveBare(token) {
        var i, o, matches = [];
        for (i = 0; i < opts.length; i++) {
            o = opts[i];
            if (o.id === token) return { cloud_id: o.cloud_id, option: o };
        }
        for (i = 0; i < opts.length; i++) {
            o = opts[i];
            if (token === o.display_name) matches.push(o);
            else if (o.bucket_name && token === o.bucket_name) matches.push(o);
        }
        if (matches.length === 1) return { cloud_id: matches[0].cloud_id, option: matches[0] };
        return null;
    }
    function bucketNameForCloudDisplay(cloudId, displayOrKey) {
        var i, o;
        for (i = 0; i < opts.length; i++) {
            o = opts[i];
            if (String(o.cloud_id) !== String(cloudId)) continue;
            if (String(o.display_name) === String(displayOrKey)) return optionBucketName(o);
        }
        return String(displayOrKey);
    }
    var groups = {};
    var order = [];
    buckets.forEach(function(b) {
        if (b == null || b === '') return;
        var s = String(b);
        var cloudId, nameInCell;
        var ci = s.indexOf(':');
        if (ci > 0) {
            cloudId = s.slice(0, ci);
            var rest = s.slice(ci + 1);
            if (String(rest).trim() === '*') {
                nameInCell = '*';
            } else {
                nameInCell = bucketNameForCloudDisplay(cloudId, rest) || rest;
            }
        } else {
            var hit = resolveBare(s);
            if (hit) {
                cloudId = hit.cloud_id;
                nameInCell = optionBucketName(hit.option);
            } else {
                cloudId = '__unknown__';
                nameInCell = s;
            }
        }
        if (nameInCell === '') return;
        if (!groups[cloudId]) {
            groups[cloudId] = [];
            order.push(cloudId);
        }
        var arr = groups[cloudId];
        if (arr.indexOf(nameInCell) === -1) arr.push(nameInCell);
    });
    if (!order.length) return '—';
    // Если по облаку выбраны все известные бакеты, показываем кратко: cloud_id: *
    order.forEach(function(cid) {
        if (cid === '__unknown__') return;
        var selected = groups[cid] || [];
        if (selected.indexOf('*') !== -1) {
            groups[cid] = ['*'];
            return;
        }
        var allForCloud = [];
        opts.forEach(function(o) {
            if (String(o.cloud_id) !== String(cid)) return;
            var n = optionBucketName(o);
            if (!n || allForCloud.indexOf(n) !== -1) return;
            allForCloud.push(n);
        });
        if (!allForCloud.length) return;
        var selectedSet = {};
        selected.forEach(function(n) { selectedSet[String(n)] = true; });
        var hasAll = allForCloud.every(function(n) { return !!selectedSet[String(n)]; });
        if (hasAll) groups[cid] = ['*'];
    });
    var unkLabel = i18n['settings.buckets_unknown_cloud'] || 'Other';
    return order.map(function(cid) {
        var head = cid === '__unknown__' ? unkLabel : cid;
        return head + ': ' + groups[cid].join(', ');
    }).join('\n');
}
function fetchRoleOptionsForUserForm() {
    var builtinOrder = ['admin', 'storage_admin', 'storage_editor', 'storage_viewer'];
    function rankRole(id) {
        var i = builtinOrder.indexOf(id);
        return i === -1 ? 100 : i;
    }
    return fetch('/api/settings/options/roles', { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : { items: [] }; })
        .then(function(data) {
            var raw = Array.isArray(data.items) ? data.items : [];
            var ids = raw.map(function(it) {
                return String(it.id != null ? it.id : it);
            });
            if (ids.length === 0) {
                ids = builtinOrder.slice();
            }
            var seen = {};
            var unique = [];
            ids.forEach(function(id) {
                if (id && !seen[id]) {
                    seen[id] = true;
                    unique.push(id);
                }
            });
            unique.sort(function(a, b) {
                var ra = rankRole(a);
                var rb = rankRole(b);
                if (ra !== rb) return ra - rb;
                return a.localeCompare(b, undefined, { sensitivity: 'base' });
            });
            return unique.map(function(id) {
                return { value: id, label: id };
            });
        });
}
function hideRoleEditModal() {
    var m = document.getElementById('roleEditModal');
    if (m) m.style.display = 'none';
    var o = document.getElementById('roleEditOriginalName');
    if (o) o.value = '';
    var ne = document.getElementById('roleEditNameInput');
    if (ne) { ne.value = ''; ne.disabled = false; }
    var err = document.getElementById('roleEditError');
    if (err) err.textContent = '';
}
function fillRolePermissionsPanel(selectedSet) {
    var panel = document.getElementById('roleEditPermissionsPanel');
    if (!panel) return Promise.resolve();
    var t = window.I18N || {};
    return fetch('/api/settings/options/role-permissions', { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : { items: [] }; })
        .then(function(data) {
            var items = Array.isArray(data.items) ? data.items : [];
            var itemsById = {};
            items.forEach(function(it) {
                if (it && it.id) itemsById[it.id] = it;
            });

            var assigned = {};
            var blocks = [];
            panel.innerHTML = '';

            ROLE_PERM_GROUPS.forEach(function(group) {
                var groupItems = group.permIds
                    .map(function(pid) { return itemsById[pid]; })
                    .filter(Boolean);
                group.permIds.forEach(function(pid) { assigned[pid] = true; });
                if (groupItems.length === 0) return;
                var title = t[group.labelKey] || group.labelKey;
                blocks.push({
                    title: title,
                    element: buildRolePermBlock(title, groupItems, selectedSet)
                });
            });

            var extraItems = items.filter(function(it) {
                return it && it.id && !assigned[it.id];
            });
            if (extraItems.length > 0) {
                var otherTitle = t['perm.group.other'] || 'Other';
                blocks.push({
                    title: otherTitle,
                    element: buildRolePermBlock(otherTitle, extraItems, selectedSet)
                });
            }

            blocks.sort(function(a, b) {
                return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
            });
            blocks.forEach(function(block) {
                panel.appendChild(block.element);
            });
        });
}
function openAddRoleModal(permissionsPreset) {
    var t = window.I18N || {};
    var preset = permissionsPreset || {};
    document.getElementById('roleEditError').textContent = '';
    document.getElementById('roleEditOriginalName').value = '';
    document.getElementById('roleEditNameInput').value = '';
    document.getElementById('roleEditNameInput').disabled = false;
    document.getElementById('roleEditModalTitle').textContent = t['modal.add_role'] || 'Add role';
    document.getElementById('roleEditModalIcon').className = 'fa-solid fa-user-shield modal-icon modal-icon-info';
    setModalSubmitBtn(document.getElementById('roleEditSubmitBtn'), t['settings.add'] || 'Add', 'add');
    fillRolePermissionsPanel(preset).then(function() {
        document.getElementById('roleEditModal').style.display = 'flex';
    });
}
function openCopyRoleModal(roleName) {
    var t = window.I18N || {};
    document.getElementById('roleEditError').textContent = '';
    document.getElementById('roleEditOriginalName').value = '';
    document.getElementById('roleEditNameInput').value = '';
    document.getElementById('roleEditNameInput').disabled = false;
    document.getElementById('roleEditModalTitle').textContent = t['modal.copy_role'] || 'Copy role';
    document.getElementById('roleEditModalIcon').className = 'fa-solid fa-copy modal-icon modal-icon-info';
    setModalSubmitBtn(document.getElementById('roleEditSubmitBtn'), t['settings.add'] || 'Add', 'add');
    fetch('/api/settings/roles/' + encodeURIComponent(roleName), { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function(row) {
            var sel = {};
            (Array.isArray(row.permissions) ? row.permissions : []).forEach(function(p) { sel[p] = true; });
            return fillRolePermissionsPanel(sel);
        })
        .then(function() {
            document.getElementById('roleEditModal').style.display = 'flex';
        })
        .catch(function() {
            toastFormError(t['settings.error_load'] || t['notification.error'] || '');
            document.getElementById('roleEditModal').style.display = 'flex';
        });
}
function openEditRoleModal(roleName) {
    var t = window.I18N || {};
    if (!canEditTargetRole(roleName)) {
        if (typeof window.showError === 'function') window.showError(t['error.cannot_edit_admin_role'] || '');
        return;
    }
    document.getElementById('roleEditError').textContent = '';
    document.getElementById('roleEditOriginalName').value = roleName;
    document.getElementById('roleEditNameInput').value = roleName;
    document.getElementById('roleEditNameInput').disabled = true;
    document.getElementById('roleEditModalTitle').textContent = t['modal.edit_role'] || 'Edit role';
    document.getElementById('roleEditModalIcon').className = 'fa-solid fa-pen-to-square modal-icon modal-icon-info';
    setModalSubmitBtn(document.getElementById('roleEditSubmitBtn'), t['modal.update'] || 'Update', 'update');
    fetch('/api/settings/roles/' + encodeURIComponent(roleName), { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function(row) {
            var sel = {};
            (Array.isArray(row.permissions) ? row.permissions : []).forEach(function(p) { sel[p] = true; });
            return fillRolePermissionsPanel(sel);
        })
        .then(function() {
            document.getElementById('roleEditModal').style.display = 'flex';
        })
        .catch(function() {
            toastFormError(t['settings.error_load'] || t['notification.error'] || '');
            document.getElementById('roleEditModal').style.display = 'flex';
        });
}
function confirmDeleteRole(roleName) {
    var t = window.I18N || {};
    if (String(roleName || '').trim().toLowerCase() === 'admin') {
        if (typeof window.showError === 'function') window.showError(t['error.cannot_delete_admin_role'] || '');
        return;
    }
    var msg = (t['delete.confirm_role'] || 'Delete role "{name}"?').replace('{name}', roleName);
    if (typeof showConfirmModal === 'function') {
        showConfirmModal(msg, function() {
            fetch('/api/settings/roles/' + encodeURIComponent(roleName), { method: 'DELETE', credentials: 'include' })
                .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
                .then(function(res) {
                    if (res.ok) {
                        loadSettingsRoles();
                        if (typeof showInfo === 'function') showInfo(t['notification.operation_ok'] || 'Success');
                    } else {
                        toastFormError((res.data && res.data.error) || t['notification.error'] || '');
                    }
                });
        }, 'delete');
    }
}

function hideCloudEditModal() {
    var m = document.getElementById('cloudEditModal');
    if (m) m.style.display = 'none';
    var orig = document.getElementById('cloudEditOriginalId');
    if (orig) orig.value = '';
    var idEl = document.getElementById('cloudEditIdInput');
    if (idEl) {
        idEl.value = '';
        idEl.disabled = false;
    }
    var nameEl = document.getElementById('cloudEditDisplayNameInput');
    if (nameEl) nameEl.value = '';
    var epEl = document.getElementById('cloudEditEndpointInput');
    if (epEl) epEl.value = '';
    setCloudEditPublicUrl(false);
    resetCloudEndpointsInputs(['']);
    var err = document.getElementById('cloudEditError');
    if (err) err.textContent = '';
}

function cloudPublicUrlValueFromRaw(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 't';
}

function setCloudEditPublicUrl(value) {
    var on = !!value;
    var hidden = document.getElementById('cloudEditPublicUrlEnabled');
    var label = document.getElementById('cloudEditPublicUrlLabel');
    var panel = document.getElementById('cloudEditPublicUrlPanel');
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

function getCloudEditPublicUrl() {
    var hidden = document.getElementById('cloudEditPublicUrlEnabled');
    return cloudPublicUrlValueFromRaw(hidden ? hidden.value : 'false');
}

function initCloudEditPublicUrlDropdown() {
    var wrap = document.getElementById('cloudEditPublicUrlWrap');
    var trigger = document.getElementById('cloudEditPublicUrlTrigger');
    var panel = document.getElementById('cloudEditPublicUrlPanel');
    if (!wrap || !trigger || !panel || wrap._publicUrlDdBound) return;
    wrap._publicUrlDdBound = true;
    trigger.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var willOpen = !wrap.classList.contains('open');
        wrap.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(wrap);
        }
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
            setCloudEditPublicUrl(item.getAttribute('data-value') === 'true');
            wrap.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
            panel.classList.add('hidden');
            if (typeof window.resetDropdownMenuOverlay === 'function') {
                window.resetDropdownMenuOverlay(wrap);
            }
        });
    });
    document.addEventListener('click', function (e) {
        if (!wrap.classList.contains('open')) return;
        if (e.target.closest && e.target.closest('#cloudEditPublicUrlWrap')) return;
        wrap.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        panel.classList.add('hidden');
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(wrap);
        }
    });
}

function splitCloudEndpoints(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(function(v) { return (v == null ? '' : String(v)).trim(); }).filter(Boolean);
    }
    return String(value).split(/\s+/).map(function(v) { return v.trim(); }).filter(Boolean);
}

function getCloudEndpointRows() {
    return Array.from(document.querySelectorAll('#cloudEditEndpointsList .cloud-endpoint-row'));
}

function updateCloudEndpointButtons() {
    var rows = getCloudEndpointRows();
    rows.forEach(function(row, idx) {
        var input = row.querySelector('.cloud-endpoint-input');
        if (input) {
            if (idx === 0) input.id = 'cloudEditEndpointInput';
            else input.removeAttribute('id');
        }
        var btn = row.querySelector('button');
        if (!btn) return;
        if (idx === rows.length - 1) {
            btn.className = 'btn cloud-endpoint-add-btn';
            btn.textContent = '+';
            btn.setAttribute('aria-label', 'Add endpoint');
            btn.onclick = function() { addCloudEndpointInput(''); };
        } else {
            btn.className = 'btn cloud-endpoint-remove-btn';
            btn.textContent = '-';
            btn.setAttribute('aria-label', 'Remove endpoint');
            btn.onclick = function() {
                row.remove();
                if (getCloudEndpointRows().length === 0) addCloudEndpointInput('');
                updateCloudEndpointButtons();
            };
        }
    });
}

function addCloudEndpointInput(value, asPrimary) {
    var list = document.getElementById('cloudEditEndpointsList');
    if (!list) return;
    var row = document.createElement('div');
    row.className = 'cloud-endpoint-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control cloud-endpoint-input';
    input.autocomplete = 'off';
    input.maxLength = 512;
    input.placeholder = 'https://...';
    input.value = value || '';
    if (asPrimary) input.id = 'cloudEditEndpointInput';
    var btn = document.createElement('button');
    btn.type = 'button';
    row.appendChild(input);
    row.appendChild(btn);
    list.appendChild(row);
    updateCloudEndpointButtons();
}

function resetCloudEndpointsInputs(values) {
    var list = document.getElementById('cloudEditEndpointsList');
    if (!list) return;
    list.innerHTML = '';
    var endpoints = Array.isArray(values) ? values.filter(function(v) { return String(v || '').trim(); }) : [];
    if (!endpoints.length) endpoints = [''];
    endpoints.forEach(function(endpoint, idx) { addCloudEndpointInput(endpoint, idx === 0); });
}

function getCloudEndpointValues() {
    var rows = getCloudEndpointRows();
    var seen = {};
    var out = [];
    rows.forEach(function(row) {
        var input = row.querySelector('.cloud-endpoint-input');
        var v = (input && input.value || '').trim();
        if (!v || seen[v]) return;
        seen[v] = true;
        out.push(v);
    });
    return out;
}

function openAddCloudModal() {
    var t = window.I18N || {};
    var title = document.getElementById('cloudEditModalTitle');
    var icon = document.getElementById('cloudEditModalIcon');
    var submit = document.getElementById('cloudEditSubmitBtn');
    var idEl = document.getElementById('cloudEditIdInput');
    var nameEl = document.getElementById('cloudEditDisplayNameInput');
    var epEl = document.getElementById('cloudEditEndpointInput');
    var orig = document.getElementById('cloudEditOriginalId');
    var err = document.getElementById('cloudEditError');
    if (orig) orig.value = '';
    if (idEl) {
        idEl.value = '';
        idEl.disabled = false;
    }
    if (nameEl) nameEl.value = '';
    if (epEl) epEl.value = '';
    setCloudEditPublicUrl(false);
    resetCloudEndpointsInputs(['']);
    if (err) err.textContent = '';
    if (title) title.textContent = t['modal.add_cloud'] || 'Add cloud';
    if (icon) icon.className = 'fa-solid fa-cloud modal-icon modal-icon-info';
    if (submit) setModalSubmitBtn(submit, t['settings.add'] || 'Add', 'add');
    var modal = document.getElementById('cloudEditModal');
    if (modal) modal.style.display = 'flex';
}

function openCopyCloudModal(cloudId) {
    var t = window.I18N || {};
    var title = document.getElementById('cloudEditModalTitle');
    var icon = document.getElementById('cloudEditModalIcon');
    var submit = document.getElementById('cloudEditSubmitBtn');
    var idEl = document.getElementById('cloudEditIdInput');
    var nameEl = document.getElementById('cloudEditDisplayNameInput');
    var orig = document.getElementById('cloudEditOriginalId');
    var err = document.getElementById('cloudEditError');
    if (orig) orig.value = '';
    if (idEl) {
        idEl.value = '';
        idEl.disabled = false;
    }
    if (nameEl) nameEl.value = '';
    resetCloudEndpointsInputs(['']);
    setCloudEditPublicUrl(false);
    if (err) err.textContent = '';
    if (title) title.textContent = t['modal.copy_cloud'] || 'Copy cloud';
    if (icon) icon.className = 'fa-solid fa-copy modal-icon modal-icon-info';
    if (submit) setModalSubmitBtn(submit, t['settings.add'] || 'Add', 'add');
    fetch('/api/settings/clouds/' + encodeURIComponent(cloudId), { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : r.json().then(function(j) { return Promise.reject(new Error(j.error || r.statusText)); }); })
        .then(function(row) {
            if (nameEl) nameEl.value = row.display_name || row.name || cloudId;
            var endpointList = (row && Array.isArray(row.endpoint_url)) ? row.endpoint_url : splitCloudEndpoints(row && row.endpoint_url);
            resetCloudEndpointsInputs(endpointList.length ? endpointList : ['']);
            setCloudEditPublicUrl(cloudPublicUrlValueFromRaw(row && row.public_url_enabled));
            var modal = document.getElementById('cloudEditModal');
            if (modal) modal.style.display = 'flex';
        })
        .catch(function(e) {
            toastFormError((e && e.message) || t['settings.error_load'] || t['notification.error'] || '');
        });
}

function openEditCloudModal(cloudId) {
    var t = window.I18N || {};
    var title = document.getElementById('cloudEditModalTitle');
    var icon = document.getElementById('cloudEditModalIcon');
    var submit = document.getElementById('cloudEditSubmitBtn');
    var idEl = document.getElementById('cloudEditIdInput');
    var nameEl = document.getElementById('cloudEditDisplayNameInput');
    var epEl = document.getElementById('cloudEditEndpointInput');
    var orig = document.getElementById('cloudEditOriginalId');
    var err = document.getElementById('cloudEditError');
    if (orig) orig.value = cloudId || '';
    if (idEl) {
        idEl.value = cloudId || '';
        idEl.disabled = true;
    }
    if (nameEl) nameEl.value = '';
    if (epEl) epEl.value = '';
    resetCloudEndpointsInputs(['']);
    setCloudEditPublicUrl(false);
    if (err) err.textContent = '';
    if (title) title.textContent = t['modal.edit_cloud'] || 'Edit cloud';
    if (icon) icon.className = 'fa-solid fa-pen-to-square modal-icon modal-icon-info';
    if (submit) setModalSubmitBtn(submit, t['modal.update'] || 'Update', 'update');
    fetch('/api/settings/clouds/' + encodeURIComponent(cloudId), { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : r.json().then(function(j) { return Promise.reject(new Error(j.error || r.statusText)); }); })
        .then(function(row) {
            if (nameEl) nameEl.value = row.display_name || row.name || cloudId;
            var endpointList = (row && Array.isArray(row.endpoint_url)) ? row.endpoint_url : splitCloudEndpoints(row && row.endpoint_url);
            if (epEl) epEl.value = endpointList[0] || '';
            resetCloudEndpointsInputs(endpointList);
            setCloudEditPublicUrl(cloudPublicUrlValueFromRaw(row && row.public_url_enabled));
            var modal = document.getElementById('cloudEditModal');
            if (modal) modal.style.display = 'flex';
        })
        .catch(function(e) {
            toastFormError((e && e.message) || t['settings.error_load'] || t['notification.error'] || '');
        });
}

function confirmDeleteCloud(cloudId) {
    var t = window.I18N || {};
    var msg = (t['delete.confirm_cloud'] || 'Delete cloud "{name}"?').replace('{name}', cloudId || '');
    if (typeof showConfirmModal === 'function') {
        showConfirmModal(msg, function() {
            fetch('/api/settings/clouds/' + encodeURIComponent(cloudId), { method: 'DELETE', credentials: 'include' })
                .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
                .then(function(res) {
                    if (res.ok) {
                        loadSettingsClouds();
                        if (typeof showInfo === 'function') showInfo(t['notification.operation_ok'] || 'Success');
                    } else {
                        toastFormError((res.data && res.data.error) || t['notification.error'] || '');
                    }
                });
        }, 'delete');
    }
}
function attachBucketsSearchToDropdownPanel(panel, t, wrap) {
    if (!panel) return;
    wrap = wrap || panel.closest('.dropdown');
    var trigger = wrap ? wrap.querySelector('.dropdown-trigger') : null;
    var triggerLabel = trigger ? trigger.querySelector('span') : null;
    if (!trigger) return;
    var options = Array.from(panel.querySelectorAll('.dropdown-item'));
    if (options.length === 0) return;
    var searchInput = trigger.querySelector('.dropdown-trigger-search');
    if (!searchInput) {
        searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'search-input search-input-in-trigger dropdown-trigger-search hidden';
        searchInput.autocomplete = 'off';
        var icon = trigger.querySelector('.dropdown-icon');
        if (icon) trigger.insertBefore(searchInput, icon);
        else trigger.appendChild(searchInput);
    }
    searchInput.classList.add('search-input', 'search-input-in-trigger', 'dropdown-trigger-search');
    searchInput.placeholder = (t && t['buckets.search_placeholder']) || 'Search buckets';
    var noResults = document.createElement('div');
    noResults.className = 'dropdown-search-empty hidden';
    noResults.textContent = (t && t['search.nothing_found']) || 'Nothing found';
    var oldNoResults = panel.querySelector('.dropdown-search-empty');
    if (oldNoResults) oldNoResults.remove();
    panel.prepend(noResults);
    function updateFilter() {
        var query = (searchInput.value || '').trim().toLowerCase();
        panel._dropdownSearchQuery = query;
        var visible = 0;
        options.forEach(function(opt) {
            var cb = opt.querySelector('input[type="checkbox"]');
            var isAllOption = !!(cb && cb.value === '*');
            if (!query || isAllOption) {
                opt.classList.remove('hidden');
                visible++;
                return;
            }
            var searchText = (opt.getAttribute('data-search-text') || '').trim().toLowerCase();
            var text = (opt.textContent || '').trim().toLowerCase();
            var valueText = cb ? String(cb.value || '').toLowerCase() : '';
            var show = text.indexOf(query) !== -1;
            if (!show && searchText) show = searchText.indexOf(query) !== -1;
            if (!show && valueText) show = valueText.indexOf(query) !== -1;
            opt.classList.toggle('hidden', !show);
            if (show) visible++;
        });
        noResults.classList.toggle('hidden', visible > 0);
    }
    function setSearchMode(enabled) {
        if (enabled) {
            searchInput.classList.remove('hidden');
            if (triggerLabel) triggerLabel.classList.add('hidden');
            requestAnimationFrame(function() { searchInput.focus(); });
        } else {
            searchInput.value = '';
            searchInput.classList.add('hidden');
            if (triggerLabel) triggerLabel.classList.remove('hidden');
            updateFilter();
        }
    }
    searchInput.addEventListener('input', updateFilter);
    searchInput.addEventListener('keydown', function(ev) { ev.stopPropagation(); });
    searchInput.addEventListener('click', function(ev) { ev.stopPropagation(); });
    updateFilter();
    if (typeof panel._dropdownSearchQuery !== 'string') panel._dropdownSearchQuery = '';
    panel._dropdownSearchSetMode = setSearchMode;
}

/** Выбранные бакеты — сразу после пункта «Все» при раскрытии dropdown. */
function sortSelectedBucketsToTop(panel) {
    if (!panel) return;
    var items = Array.from(panel.querySelectorAll('.dropdown-item'));
    if (!items.length) return;
    var allOpt = null;
    var selected = [];
    var unselected = [];
    items.forEach(function(opt) {
        var cb = opt.querySelector('input[type="checkbox"]');
        if (cb && cb.value === '*') {
            allOpt = opt;
            return;
        }
        if (cb && cb.checked) selected.push(opt);
        else unselected.push(opt);
    });
    if (!selected.length) return;
    var fragment = document.createDocumentFragment();
    var noResults = panel.querySelector('.dropdown-search-empty');
    if (noResults) fragment.appendChild(noResults);
    if (allOpt) fragment.appendChild(allOpt);
    selected.forEach(function(el) { fragment.appendChild(el); });
    unselected.forEach(function(el) { fragment.appendChild(el); });
    panel.appendChild(fragment);
}

function toggleAddUserDropdown(wrap, panel, otherWraps) {
    var otherList = Array.isArray(otherWraps) ? otherWraps : [otherWraps];
    var isOpen = wrap.classList.contains('open');
    closeAllAddUserBucketRoleAclDropdowns();
    otherList.forEach(function(w) {
        if (!w) return;
        w.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(w);
        var op = w.querySelector('.dropdown-menu');
        if (op && op._dropdownSearchSetMode) op._dropdownSearchSetMode(false);
    });
    if (isOpen) {
        wrap.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
        if (panel._dropdownSearchSetMode) panel._dropdownSearchSetMode(false);
    } else {
        if (panel && panel.id === 'addUserBucketsPanel') {
            sortSelectedBucketsToTop(panel);
        }
        wrap.classList.add('open');
        if (panel._dropdownSearchSetMode) panel._dropdownSearchSetMode(true);
        panel.classList.remove('hidden');
        if (typeof window.fitDropdownMenuOverlay === 'function') window.fitDropdownMenuOverlay(wrap);
    }
}
function isAddUserDropdownUiTarget(el) {
    if (!el || !el.closest) return false;
    // Role/clouds/buckets + LDAP results (not under .dropdown).
    return !!(
        el.closest('.dropdown') ||
        el.closest('.add-user-username-search') ||
        el.closest('#addUserLdapResults')
    );
}
function closeAllAddUserDropdownPanels() {
    closeAllAddUserBucketRoleAclDropdowns();
    closeAddUserLdapResults();
    var idsW = ['addUserBucketsWrap', 'addUserCloudsWrap', 'addUserRoleWrap'];
    idsW.forEach(function(id) {
        var w = document.getElementById(id);
        if (!w) return;
        w.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(w);
        var p = w.querySelector('.dropdown-menu');
        if (p && p._dropdownSearchSetMode) p._dropdownSearchSetMode(false);
    });
}
function detachAddUserModalFocusClose() {
    var um = document.getElementById('addUserModal');
    if (um && um._userFocusClose) {
        um.removeEventListener('focusin', um._userFocusClose, true);
        delete um._userFocusClose;
    }
    if (um && um._userClickClose) {
        um.removeEventListener('click', um._userClickClose, true);
        delete um._userClickClose;
    }
}
function attachAddUserModalFocusClose() {
    var um = document.getElementById('addUserModal');
    detachAddUserModalFocusClose();
    um._userFocusClose = function(ev) {
        if (um.style.display === 'none') return;
        if (!um.contains(ev.target)) return;
        if (isAddUserDropdownUiTarget(ev.target)) return;
        closeAllAddUserDropdownPanels();
    };
    um.addEventListener('focusin', um._userFocusClose, true);
    um._userClickClose = function(ev) {
        if (um.style.display === 'none') return;
        if (!um.contains(ev.target)) return;
        if (isAddUserDropdownUiTarget(ev.target)) return;
        closeAllAddUserDropdownPanels();
    };
    um.addEventListener('click', um._userClickClose, true);
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
function resetAddUserPasswordVisibility() {
    var input = document.getElementById('addUserPassword');
    var btn = document.getElementById('addUserPasswordToggle');
    if (!input || !btn) return;
    input.type = 'password';
    btn.setAttribute('aria-pressed', 'false');
    var t = window.I18N || {};
    var showLabel = t['modal.password_show'] || 'Show password';
    btn.setAttribute('aria-label', showLabel);
    btn.title = showLabel;
    setFormControlRevealLabel(btn, showLabel);
    setFormControlRevealIcon(btn, false);
}

/** Случайный пароль для новой / копируемой УЗ (буквы + цифры, без неоднозначных символов). */
function generateRandomPassword(length) {
    length = length || 12;
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    var bytes = new Uint8Array(length);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(bytes);
    } else {
        for (var i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var j = 0; j < length; j++) {
        out += alphabet[bytes[j] % alphabet.length];
    }
    return out;
}

function fillAddUserGeneratedPassword() {
    var input = document.getElementById('addUserPassword');
    if (!input) return;
    input.value = generateRandomPassword(12);
    resetAddUserPasswordVisibility();
}
function toggleAddUserPasswordVisibility() {
    var input = document.getElementById('addUserPassword');
    var btn = document.getElementById('addUserPasswordToggle');
    if (!input || !btn) return;
    var t = window.I18N || {};
    var showLabel = t['modal.password_show'] || 'Show password';
    var hideLabel = t['modal.password_hide'] || 'Hide password';
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
function hideAddUserModal() {
    closeAllAddUserDropdownPanels();
    var modal = document.getElementById('addUserModal');
    detachAddUserModalFocusClose();
    if (modal._userDocClickClose) {
        document.removeEventListener('click', modal._userDocClickClose);
        delete modal._userDocClickClose;
    }
    modal.style.display = 'none';
    resetAddUserModalForm();
    var editInput = document.getElementById('addUserEditUsername');
    if (editInput) editInput.value = '';
    var un = document.getElementById('addUserUsername');
    if (un) { un.disabled = false; un.value = ''; }
    applyAddUserLdapAvailability(true);
    var pw = document.getElementById('addUserPassword');
    if (pw) { pw.required = true; pw.placeholder = ''; pw.value = ''; }
    resetAddUserPasswordVisibility();
    var hint = document.getElementById('addUserPasswordHint');
    if (hint) hint.classList.add('hidden');
    var titleEl = document.getElementById('addUserModalTitle');
    var iconEl = document.getElementById('addUserModalIcon');
    var btnEl = document.getElementById('addUserSubmitBtn');
    var t = window.I18N || {};
    if (titleEl) titleEl.textContent = t['modal.add_user'] || 'Add user';
    if (iconEl) { iconEl.className = 'fa-solid fa-user-plus modal-icon modal-icon-info'; }
    if (btnEl) setModalSubmitBtn(btnEl, t['settings.add'] || 'Add', 'add');
}

function setAddUserLdapSearchVisible(visible) {
    var btn = document.getElementById('addUserLdapSearchBtn');
    var wrap = document.querySelector('.add-user-username-search');
    if (btn) {
        btn.classList.toggle('hidden', !visible);
        if (!visible) btn.disabled = true;
    }
    if (wrap) wrap.classList.toggle('add-user-username-search-no-ldap', !visible);
    if (!visible) closeAddUserLdapResults();
}

/** Search is blocked only when LDAP is not configured — status probe timeout/error must not block lookup. */
function isAddUserLdapSearchAllowed(ldap) {
    if (!ldap) return true;
    return ldap.status !== 'not_configured';
}

function setAddUserLdapSearchBusy(busy) {
    var btn = document.getElementById('addUserLdapSearchBtn');
    if (!btn || btn.classList.contains('hidden')) return;
    if (busy) {
        btn.disabled = true;
        return;
    }
    var ldap = typeof window.getCachedLdapStatus === 'function' ? window.getCachedLdapStatus() : null;
    btn.disabled = !isAddUserLdapSearchAllowed(ldap);
}

function applyAddUserLdapAvailability(modeAllows) {
    var btn = document.getElementById('addUserLdapSearchBtn');
    var t = window.I18N || {};
    var defaultTitle = t['modal.user_ldap_search'] || 'Search LDAP';
    if (!modeAllows) {
        setAddUserLdapSearchVisible(false);
        return;
    }
    setAddUserLdapSearchVisible(true);
    function applyLdapState(ldap) {
        if (!btn || btn.classList.contains('hidden')) return;
        var allowed = isAddUserLdapSearchAllowed(ldap);
        btn.disabled = !allowed;
        var title = allowed
            ? defaultTitle
            : ((ldap && ldap.detail) || t['error.ldap_not_configured'] || 'LDAP lookup is not configured');
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.classList.toggle('add-user-ldap-search-unavailable', !allowed);
    }
    var cached = typeof window.getCachedLdapStatus === 'function' ? window.getCachedLdapStatus() : null;
    if (cached) applyLdapState(cached);
    else applyLdapState(null);
    if (typeof window.prefetchServicesStatus === 'function') {
        window.prefetchServicesStatus().then(function () {
            applyLdapState(typeof window.getCachedLdapStatus === 'function' ? window.getCachedLdapStatus() : null);
        });
    }
}

var ADD_USER_LDAP_QUERY_MIN_LENGTH = 5;

function closeAddUserLdapResults() {
    var panel = document.getElementById('addUserLdapResults');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.innerHTML = '';
}

function applyAddUserLdapUser(user) {
    var usernameEl = document.getElementById('addUserUsername');
    var fullNameEl = document.getElementById('addUserFullName');
    var emailEl = document.getElementById('addUserEmail');
    var t = window.I18N || {};
    if (!user) return;
    if (usernameEl && user.username) usernameEl.value = user.username;
    if (fullNameEl) fullNameEl.value = user.display_name || '';
    if (emailEl) emailEl.value = user.email || '';
    closeAddUserLdapResults();
    if (typeof showSuccess === 'function') {
        showSuccess(t['modal.user_ldap_found'] || 'User details loaded from LDAP');
    }
}

function renderAddUserLdapResults(users, count) {
    var panel = document.getElementById('addUserLdapResults');
    var t = window.I18N || {};
    if (!panel) return;
    var total = typeof count === 'number' ? count : (users || []).length;
    var headerLabel = (t['modal.user_ldap_matches'] || 'Matches: {count}').replace('{count}', String(total));
    var itemsHtml = (users || []).map(function (user) {
        var username = user.username || '';
        var displayName = user.display_name || username;
        var email = user.email || '';
        var meta = username + (email ? ' · ' + email : '');
        return (
            '<button type="button" class="dropdown-item add-user-ldap-result-item" role="option"' +
            ' data-username="' + escapeAddUserHtml(username) + '"' +
            ' data-display-name="' + escapeAddUserHtml(displayName) + '"' +
            ' data-email="' + escapeAddUserHtml(email) + '">' +
            '<span class="add-user-ldap-result-name">' + escapeAddUserHtml(displayName) + '</span>' +
            '<span class="add-user-ldap-result-meta">' + escapeAddUserHtml(meta) + '</span>' +
            '</button>'
        );
    }).join('');
    panel.innerHTML =
        '<div class="add-user-ldap-results-header">' + escapeAddUserHtml(headerLabel) + '</div>' +
        itemsHtml;
    panel.classList.remove('hidden');
    panel.querySelectorAll('.add-user-ldap-result-item').forEach(function (item) {
        item.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            applyAddUserLdapUser({
                username: item.getAttribute('data-username') || '',
                display_name: item.getAttribute('data-display-name') || '',
                email: item.getAttribute('data-email') || ''
            });
        });
    });
}

function lookupAddUserFromLdap() {
    var t = window.I18N || {};
    var usernameEl = document.getElementById('addUserUsername');
    var btn = document.getElementById('addUserLdapSearchBtn');
    if (!usernameEl || usernameEl.disabled) return;
    if (btn && (btn.disabled || btn.classList.contains('hidden'))) {
        if (typeof showError === 'function') {
            showError(btn.title || t['error.ldap_not_configured'] || 'LDAP lookup is not configured');
        }
        return;
    }
    var username = (usernameEl.value || '').trim();
    closeAddUserLdapResults();
    if (!username) {
        if (typeof showError === 'function') {
            showError(t['error.username_required'] || 'Username is required');
        }
        usernameEl.focus();
        return;
    }
    if (username.length < ADD_USER_LDAP_QUERY_MIN_LENGTH) {
        if (typeof showError === 'function') {
            showError(t['error.ldap_query_too_short'] || 'Enter at least 5 characters for LDAP search');
        }
        usernameEl.focus();
        return;
    }
    setAddUserLdapSearchBusy(true);
    fetch('/api/settings/users/ldap-lookup?username=' + encodeURIComponent(username), {
        credentials: 'include',
        cache: 'no-store'
    })
        .then(function (r) {
            return r.json().then(function (data) {
                return { ok: r.ok, status: r.status, data: data };
            });
        })
        .then(function (res) {
            setAddUserLdapSearchBusy(false);
            if (!res.ok) {
                var err = (res.data && res.data.error) || t['error.ldap_lookup_failed'] || 'LDAP lookup failed';
                if (typeof showError === 'function') showError(err);
                return;
            }
            var data = res.data || {};
            var users = Array.isArray(data.users) ? data.users : [];
            var count = typeof data.count === 'number' ? data.count : users.length;
            if (!users.length) {
                if (typeof showError === 'function') {
                    showError(t['error.ldap_user_not_found'] || 'User not found in LDAP');
                }
                return;
            }
            if (users.length === 1) {
                applyAddUserLdapUser(users[0]);
                return;
            }
            renderAddUserLdapResults(users, count);
        })
        .catch(function () {
            setAddUserLdapSearchBusy(false);
            if (typeof showError === 'function') {
                showError(t['msg.network_error'] || t['notification.error'] || 'Network error');
            }
        });
}

function wireAddUserLdapSearch() {
    if (window._addUserLdapSearchBound) return;
    window._addUserLdapSearchBound = true;
    var btn = document.getElementById('addUserLdapSearchBtn');
    var usernameEl = document.getElementById('addUserUsername');
    if (btn) {
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            lookupAddUserFromLdap();
        });
    }
    if (usernameEl) {
        usernameEl.addEventListener('input', function () {
            closeAddUserLdapResults();
        });
        usernameEl.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                closeAddUserLdapResults();
                return;
            }
            if (ev.key !== 'Enter') return;
            // In add/copy mode Enter triggers LDAP lookup instead of submitting the form.
            if (usernameEl.disabled) return;
            var editUsername = (document.getElementById('addUserEditUsername') || {}).value || '';
            if (editUsername) return;
            ev.preventDefault();
            lookupAddUserFromLdap();
        });
    }
    document.addEventListener('click', function (ev) {
        var wrap = document.querySelector('.add-user-username-search');
        var panel = document.getElementById('addUserLdapResults');
        if (!wrap || !panel || panel.classList.contains('hidden')) return;
        if (wrap.contains(ev.target)) return;
        closeAddUserLdapResults();
    });
}
function openEditUserModal(username, mode) {
    mode = mode || 'edit';
    var isCopy = mode === 'copy';
    if (!isCopy && !canEditTargetUser(username)) {
        if (typeof showInfo === 'function') {
            showInfo((window.I18N && window.I18N['error.cannot_edit_admin']) || (window.I18N && window.I18N['error.access_denied']) || 'Access denied');
        }
        return;
    }
    var t = window.I18N || {};
    wireAddUserLdapSearch();
    document.getElementById('addUserEditUsername').value = isCopy ? '' : username;
    document.getElementById('addUserUsername').value = isCopy ? '' : username;
    document.getElementById('addUserUsername').disabled = !isCopy;
    applyAddUserLdapAvailability(isCopy);
    closeAddUserLdapResults();
    if (isCopy) {
        fillAddUserGeneratedPassword();
        document.getElementById('addUserPassword').required = true;
        document.getElementById('addUserPassword').placeholder = '';
        var fullNameClear = document.getElementById('addUserFullName');
        if (fullNameClear) fullNameClear.value = '';
        var emailClear = document.getElementById('addUserEmail');
        if (emailClear) emailClear.value = '';
    } else {
        document.getElementById('addUserPassword').value = '';
        document.getElementById('addUserPassword').required = false;
        document.getElementById('addUserPassword').placeholder = t['modal.password_optional'] || '';
        resetAddUserPasswordVisibility();
    }
    var hint = document.getElementById('addUserPasswordHint');
    if (hint) hint.classList.toggle('hidden', isCopy);
    document.getElementById('addUserModalTitle').textContent = isCopy
        ? (t['modal.copy_user'] || 'Copy user')
        : (t['modal.edit_user'] || 'Edit user');
    var iconEl = document.getElementById('addUserModalIcon');
    if (iconEl) {
        iconEl.className = (isCopy ? 'fa-solid fa-clone' : 'fa-solid fa-pen-to-square') + ' modal-icon modal-icon-info';
    }
    setModalSubmitBtn(
        document.getElementById('addUserSubmitBtn'),
        isCopy ? (t['settings.add'] || 'Add') : (t['modal.update'] || 'Update'),
        isCopy ? 'add' : 'update'
    );
    document.getElementById('addUserError').textContent = '';
    var bucketsLabel = document.getElementById('addUserBucketsLabel');
    var cloudsLabel = document.getElementById('addUserCloudsLabel');
    var roleLabel = document.getElementById('addUserRoleLabel');
    var roleValueInput = document.getElementById('addUserRoleValue');
    var rolePanel = document.getElementById('addUserRolePanel');
    var roleWrap = document.getElementById('addUserRoleWrap');
    var bucketsPanel = document.getElementById('addUserBucketsPanel');
    var cloudsPanel = document.getElementById('addUserCloudsPanel');
    var bucketsWrap = document.getElementById('addUserBucketsWrap');
    var cloudsWrap = document.getElementById('addUserCloudsWrap');
    bucketsLabel.textContent = '—';
    bucketsLabel.classList.remove('has-selection');
    cloudsLabel.textContent = '—';
    cloudsLabel.classList.remove('has-selection');
    [roleWrap, bucketsWrap, cloudsWrap].forEach(function(wrap) {
        if (!wrap) return;
        wrap.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
    });
    if (bucketsPanel) bucketsPanel.innerHTML = '';
    if (cloudsPanel) cloudsPanel.innerHTML = '';
    if (rolePanel) rolePanel.innerHTML = '';
    closeAddUserBucketRolesEditor();
    addUserBucketRolesOverrides = {};
    addUserBucketRolesRoleOptions = [];
    syncAddUserBucketsTriggerState(cloudsPanel);
    var allLabel = t['settings.all'] || 'All';
    Promise.all([
        fetch('/api/settings/users/' + encodeURIComponent(username), { credentials: 'include' }).then(function(r) { return r.json(); }),
        fetch('/api/settings/options/buckets', { credentials: 'include' }).then(function(r) { return r.json(); }),
        fetch('/api/settings/options/clouds', { credentials: 'include' }).then(function(r) { return r.json(); }),
        fetchRoleOptionsForUserForm()
    ]).then(function(results) {
        var user = results[0] && results[0].username ? results[0] : null;
        var bucketItems = (results[1] && results[1].items) ? results[1].items : [];
        var cloudItems = (results[2] && results[2].items) ? results[2].items : [];
        var roleOptions = results[3] || [];
        var userRole = (user && user.role) ? user.role : 'storage_viewer';
        roleValueInput.value = userRole;
        rolePanel.innerHTML = '';
        roleOptions.forEach(function(opt) {
            var lab = document.createElement('div');
            lab.className = 'dropdown-item' + (opt.value === userRole ? ' selected' : '');
            lab.setAttribute('role', 'option');
            lab.textContent = opt.label;
            lab.dataset.value = opt.value;
            lab.addEventListener('click', function() {
                roleValueInput.value = opt.value;
                roleLabel.textContent = opt.label;
                rolePanel.querySelectorAll('.dropdown-item').forEach(function(o) { o.classList.remove('selected'); });
                lab.classList.add('selected');
                roleWrap.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(roleWrap);
                onAddUserDefaultRoleChanged(roleOptions);
            });
            rolePanel.appendChild(lab);
        });
        var currentRoleLabel = (roleOptions[0] && roleOptions[0].label) ? roleOptions[0].label : userRole;
        for (var i = 0; i < roleOptions.length; i++) {
            if (roleOptions[i].value === userRole) { currentRoleLabel = roleOptions[i].label; break; }
        }
        if (!roleOptions.some(function(o) { return o.value === userRole; })) {
            var orphanLab = document.createElement('div');
            orphanLab.className = 'dropdown-item selected';
            orphanLab.setAttribute('role', 'option');
            orphanLab.textContent = userRole;
            orphanLab.dataset.value = userRole;
            orphanLab.addEventListener('click', function() {
                roleValueInput.value = userRole;
                roleLabel.textContent = userRole;
                rolePanel.querySelectorAll('.dropdown-item').forEach(function(o) { o.classList.remove('selected'); });
                orphanLab.classList.add('selected');
                roleWrap.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(roleWrap);
                onAddUserDefaultRoleChanged(roleOptions);
            });
            rolePanel.appendChild(orphanLab);
            currentRoleLabel = userRole;
        }
        roleLabel.textContent = currentRoleLabel;
        roleLabel.classList.add('has-selection');
        var emailEl = document.getElementById('addUserEmail');
        var fullNameEl = document.getElementById('addUserFullName');
        // Copy = new identity (LDAP search); edit keeps existing profile fields.
        if (isCopy) {
            if (emailEl) emailEl.value = '';
            if (fullNameEl) fullNameEl.value = '';
            applyAddUserLdapAvailability(true);
            var usernameElCopy = document.getElementById('addUserUsername');
            if (usernameElCopy) {
                usernameElCopy.disabled = false;
                usernameElCopy.focus();
            }
        } else {
            if (emailEl) emailEl.value = (user && user.email) ? String(user.email).trim() : '';
            if (fullNameEl) fullNameEl.value = (user && user.display_name) ? String(user.display_name).trim() : '';
            applyAddUserLdapAvailability(false);
        }
        var userClouds = (user && Array.isArray(user.clouds)) ? user.clouds : [];
        var userBuckets = (user && Array.isArray(user.buckets)) ? user.buckets : [];
        var userBucketRolesMap = bucketRolesMapFromList(user && user.bucket_roles);
        cloudsPanel.innerHTML = '';
        var optAllC = document.createElement('label');
        optAllC.className = 'lables dropdown-item';
        optAllC.innerHTML = '<input type="checkbox" class="checkbox" value="*" data-label="' + allLabel.replace(/"/g, '&quot;') + '"> <span>' + allLabel + '</span>';
        var allChecked = userClouds.indexOf('*') !== -1;
        optAllC.querySelector('input').checked = allChecked;
        optAllC.addEventListener('change', function() {
            var cb = optAllC.querySelector('input');
            cloudsPanel.querySelectorAll('input').forEach(function(inp) { inp.checked = cb.checked; });
            updateCloudsLabel();
            rebuildBucketsPanelForEdit();
        });
        cloudsPanel.appendChild(optAllC);
        cloudItems.forEach(function(item) {
            var lab = document.createElement('label');
            lab.className = 'lables dropdown-item';
            lab.innerHTML = '<input type="checkbox" class="checkbox" value="' + (item.id + '').replace(/"/g, '&quot;') + '" data-label="' + (item.label + '').replace(/"/g, '&quot;') + '"> <span>' + (item.label || item.id) + '</span>';
            lab.querySelector('input').checked = allChecked || userClouds.indexOf(item.id) !== -1;
            lab.querySelector('input').addEventListener('change', function() {
                var allCb = optAllC.querySelector('input');
                if (allCb && allCb.checked) allCb.checked = false;
                updateCloudsLabel();
                rebuildBucketsPanelForEdit();
            });
            cloudsPanel.appendChild(lab);
        });
        function updateCloudsLabel() {
            var ch = cloudsPanel.querySelectorAll('input:checked');
            var vals = Array.from(ch).map(function(c) { return c.value; });
            if (vals.indexOf('*') !== -1 || vals.length === 0) {
                cloudsLabel.textContent = '—';
                cloudsLabel.classList.remove('has-selection');
            } else {
                cloudsLabel.textContent = vals.length === 1 ? (cloudsPanel.querySelector('input:checked').getAttribute('data-label') || vals[0]) : ((t['settings.selected_count'] || '{n} selected').replace('{n}', vals.length));
                cloudsLabel.classList.add('has-selection');
            }
        }
        function getSelectedClouds() {
            return getUserFormSelectedCloudIds(cloudsPanel);
        }
        function rebuildBucketsPanelForEdit(preserveSelection) {
            var selectedClouds = getSelectedClouds();
            syncAddUserBucketsTriggerState(cloudsPanel);
            if (selectedClouds.length === 0) {
                renderAddUserBucketsPanelNoClouds(bucketsPanel, bucketsLabel, t);
                onAddUserBucketsSelectionChanged(roleOptions);
                return;
            }
            var showAll = selectedClouds.indexOf('*') !== -1;
            var filtered = showAll ? bucketItems : bucketItems.filter(function(item) { return selectedClouds.indexOf(item.cloud_id || '') !== -1; });
            var keptIds = {};
            if (preserveSelection !== false) {
                var kept = bucketsPanel.querySelectorAll('input:checked');
                Array.from(kept).forEach(function(inp) {
                    if (inp && inp.value && inp.value !== '*') keptIds[inp.value] = true;
                });
            }
            var prevAllCb = bucketsPanel.querySelector('input[value="*"]');
            var bucketsAllMode = preserveSelection !== false && prevAllCb
                ? prevAllCb.checked
                : (Object.keys(keptIds).length === 0 && userBuckets.indexOf('*') !== -1);
            bucketsPanel.innerHTML = '';
            var optAllB = document.createElement('label');
            optAllB.className = 'lables dropdown-item';
            optAllB.innerHTML = '<input type="checkbox" class="checkbox" value="*" data-label="' + allLabel.replace(/"/g, '&quot;') + '"> <span>' + allLabel + '</span>';
            optAllB.querySelector('input').checked = bucketsAllMode;
            optAllB.addEventListener('change', function() {
                var cb = optAllB.querySelector('input');
                var query = String(bucketsPanel._dropdownSearchQuery || '').trim();
                var targets = Array.from(
                    bucketsPanel.querySelectorAll(query ? '.dropdown-item:not(.hidden) input[type="checkbox"]' : '.dropdown-item input[type="checkbox"]')
                ).filter(function(inp) { return inp.value !== '*'; });
                targets.forEach(function(inp) { inp.checked = cb.checked; });
                var allNonAll = Array.from(bucketsPanel.querySelectorAll('.dropdown-item input[type="checkbox"]'))
                    .filter(function(inp) { return inp.value !== '*'; });
                cb.checked = allNonAll.length > 0 && allNonAll.every(function(inp) { return inp.checked; });
                updateBucketsLabel();
                onAddUserBucketsSelectionChanged(roleOptions);
            });
            bucketsPanel.appendChild(optAllB);
            filtered.forEach(function(item) {
                var lab = document.createElement('label');
                lab.className = 'lables dropdown-item';
                var cloudId = (item.cloud_id != null) ? (item.cloud_id + '').replace(/"/g, '&quot;') : '';
                var displayLabel = (item.label || item.id || '').toString().replace(/\s*\([^)]*\)\s*$/, '').trim() || (item.id || '').toString();
                lab.innerHTML = '<input type="checkbox" class="checkbox" value="' + (item.id + '').replace(/"/g, '&quot;') + '" data-label="' + displayLabel.replace(/"/g, '&quot;') + '" data-cloud-id="' + cloudId + '"> <span>' + displayLabel + '</span>';
                var searchParts = [
                    item.id,
                    item.label,
                    item.bucket_name,
                    item.display_name,
                    item.cloud_id,
                    item.name
                ].filter(function(v) { return v != null && String(v).trim() !== ''; });
                lab.setAttribute('data-search-text', searchParts.join(' ').toLowerCase());
                var itemId = String(item.id != null ? item.id : '');
                var checked = bucketsAllMode
                    || !!keptIds[itemId]
                    || userBuckets.some(function(tok) { return userBucketTokenMatchesOption(tok, item); });
                lab.querySelector('input').checked = checked;
                lab.querySelector('input').addEventListener('change', function() {
                    var allCb = optAllB.querySelector('input');
                    if (allCb && allCb.checked) allCb.checked = false;
                    updateBucketsLabel();
                    onAddUserBucketsSelectionChanged(roleOptions);
                });
                bucketsPanel.appendChild(lab);
            });
            if (bucketsAllMode) {
                var allNonAllAfter = Array.from(bucketsPanel.querySelectorAll('.dropdown-item input[type="checkbox"]'))
                    .filter(function(inp) { return inp.value !== '*'; });
                allNonAllAfter.forEach(function(inp) { inp.checked = true; });
            }
            function updateBucketsLabel() {
                var checked = bucketsPanel.querySelectorAll('input:checked');
                var vals = Array.from(checked).map(function(c) { return c.value; });
                if (vals.indexOf('*') !== -1 || vals.length === 0) {
                    bucketsLabel.textContent = '—';
                    bucketsLabel.classList.remove('has-selection');
                } else {
                    bucketsLabel.textContent = vals.length === 1 ? (bucketsPanel.querySelector('input:checked').getAttribute('data-label') || vals[0]) : ((t['settings.selected_count'] || '{n} selected').replace('{n}', vals.length));
                    bucketsLabel.classList.add('has-selection');
                }
            }
            updateBucketsLabel();
            attachBucketsSearchToDropdownPanel(bucketsPanel, t, bucketsWrap);
            onAddUserBucketsSelectionChanged(roleOptions);
        }
        setAddUserBucketRolesRoleOptions(roleOptions);
        loadAddUserBucketRolesOverrides(userBucketRolesMap);
        updateCloudsLabel();
        rebuildBucketsPanelForEdit(false);
        document.getElementById('addUserRoleTrigger').onclick = function(ev) { ev.stopPropagation(); toggleAddUserDropdown(roleWrap, rolePanel, [cloudsWrap, bucketsWrap]); };
        document.getElementById('addUserCloudsTrigger').onclick = function(ev) { ev.stopPropagation(); toggleAddUserDropdown(cloudsWrap, cloudsPanel, [bucketsWrap, roleWrap]); };
        document.getElementById('addUserBucketsTrigger').onclick = function(ev) {
            if (ev.currentTarget.disabled) return;
            ev.stopPropagation();
            toggleAddUserDropdown(bucketsWrap, bucketsPanel, [cloudsWrap, roleWrap]);
        };
        var addUserModalEdit = document.getElementById('addUserModal');
        function closeDropdownsEdit(e) {
            if (isAddUserDropdownUiTarget(e && e.target)) return;
            closeAllAddUserDropdownPanels();
            document.removeEventListener('click', closeDropdownsEdit);
            if (addUserModalEdit._userDocClickClose === closeDropdownsEdit) delete addUserModalEdit._userDocClickClose;
        }
        if (addUserModalEdit._userDocClickClose) {
            document.removeEventListener('click', addUserModalEdit._userDocClickClose);
        }
        addUserModalEdit._userDocClickClose = closeDropdownsEdit;
        setTimeout(function() { document.addEventListener('click', closeDropdownsEdit); }, 0);
        attachAddUserModalFocusClose();
        addUserModalEdit.style.display = 'flex';
    }).catch(function() {
        toastFormError((window.I18N && window.I18N['error.load_user_or_options_failed']) || '');
        document.getElementById('addUserModal').style.display = 'flex';
    });
}
function confirmDeleteUser(username) {
    var t = window.I18N || {};
    var msg = (t['delete.confirm_one'] || 'Are you sure you want to delete "{name}"?').replace('{name}', username);
    if (typeof showConfirmModal === 'function') {
        showConfirmModal(msg, function() {
            fetch('/api/settings/users/' + encodeURIComponent(username), { method: 'DELETE', credentials: 'include' })
                .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
                .then(function(res) {
                    if (res.ok) {
                        loadSettingsUsers();
                        if (typeof showInfo === 'function') showInfo(t['notification.operation_ok'] || 'Success');
                    } else {
                        toastFormError((res.data && res.data.error) || t['notification.error'] || '');
                    }
                });
        }, 'delete');
    }
}

function initSettingsUsersRoles() {
    if (window._settingsUsersRolesListeners) return;
    window._settingsUsersRolesListeners = true;
    wireAddUserBucketRolesControls();
    wireAddUserLdapSearch();
    var settingsAddBtn = document.getElementById('settingsAddBtn');
    var settingsContentInner = document.getElementById('settingsContentInner');
if (settingsAddBtn) {
    settingsAddBtn.addEventListener('click', function() {
        if (window.settingsPanelState.currentTab === 'clouds') {
            openAddCloudModal();
        } else if (window.settingsPanelState.currentTab === 'users') {
            wireAddUserLdapSearch();
            document.getElementById('addUserError').textContent = '';
            document.getElementById('addUserUsername').value = '';
            document.getElementById('addUserUsername').disabled = false;
            applyAddUserLdapAvailability(true);
            closeAddUserLdapResults();
            document.getElementById('addUserFullName').value = '';
            var emailElAdd = document.getElementById('addUserEmail');
            if (emailElAdd) emailElAdd.value = '';
            fillAddUserGeneratedPassword();
            closeAddUserBucketRolesEditor();
            addUserBucketRolesOverrides = {};
            addUserBucketRolesRoleOptions = [];
            var bucketsLabel = document.getElementById('addUserBucketsLabel');
            var cloudsLabel = document.getElementById('addUserCloudsLabel');
            var bucketsPanel = document.getElementById('addUserBucketsPanel');
            var cloudsPanel = document.getElementById('addUserCloudsPanel');
            var bucketsWrap = document.getElementById('addUserBucketsWrap');
            var cloudsWrap = document.getElementById('addUserCloudsWrap');
            var roleLabel = document.getElementById('addUserRoleLabel');
            var rolePanel = document.getElementById('addUserRolePanel');
            var roleWrap = document.getElementById('addUserRoleWrap');
            var roleValueInput = document.getElementById('addUserRoleValue');
            roleValueInput.value = 'storage_viewer';
            bucketsLabel.textContent = '—';
            bucketsLabel.classList.remove('has-selection');
            cloudsLabel.textContent = '—';
            cloudsLabel.classList.remove('has-selection');
            [roleWrap, bucketsWrap, cloudsWrap].forEach(function(wrap) {
                if (!wrap) return;
                wrap.classList.remove('open');
                if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(wrap);
            });
            syncAddUserBucketsTriggerState(cloudsPanel);
            var t = window.I18N || {};
            var allLabel = t['settings.all'] || 'All';
            rolePanel.innerHTML = '';
            Promise.all([
                fetch('/api/settings/options/buckets', { credentials: 'include' }).then(function(r) { return r.json(); }),
                fetch('/api/settings/options/clouds', { credentials: 'include' }).then(function(r) { return r.json(); }),
                fetchRoleOptionsForUserForm()
            ]).then(function(results) {
                var bucketItems = (results[0] && results[0].items) ? results[0].items : [];
                var cloudItems = (results[1] && results[1].items) ? results[1].items : [];
                var roleOptions = results[2] || [];
                rolePanel.innerHTML = '';
                roleOptions.forEach(function(opt) {
                    var lab = document.createElement('div');
                    lab.className = 'lables dropdown-item';
                    lab.setAttribute('role', 'option');
                    lab.textContent = opt.label;
                    lab.dataset.value = opt.value;
                    if (opt.value === roleValueInput.value) lab.classList.add('selected');
                    lab.addEventListener('click', function() {
                        roleValueInput.value = opt.value;
                        roleLabel.textContent = opt.label;
                        roleLabel.classList.add('has-selection');
                        rolePanel.querySelectorAll('.dropdown-item').forEach(function(o) { o.classList.remove('selected'); });
                        lab.classList.add('selected');
                        roleWrap.classList.remove('open');
                        if (typeof window.resetDropdownMenuOverlay === 'function') window.resetDropdownMenuOverlay(roleWrap);
                        onAddUserDefaultRoleChanged(roleOptions);
                    });
                    rolePanel.appendChild(lab);
                });
                var currentRoleLabel = (roleOptions[0] && roleOptions[0].label) ? roleOptions[0].label : '—';
                for (var ri = 0; ri < roleOptions.length; ri++) {
                    if (roleOptions[ri].value === roleValueInput.value) { currentRoleLabel = roleOptions[ri].label; break; }
                }
                roleLabel.textContent = currentRoleLabel;
                roleLabel.classList.add('has-selection');
                function getSelectedClouds() {
                    return getUserFormSelectedCloudIds(cloudsPanel);
                }
                function rebuildBucketsPanel() {
                    var selectedClouds = getSelectedClouds();
                    syncAddUserBucketsTriggerState(cloudsPanel);
                    if (selectedClouds.length === 0) {
                        renderAddUserBucketsPanelNoClouds(bucketsPanel, bucketsLabel, t);
                        onAddUserBucketsSelectionChanged(roleOptions);
                        return;
                    }
                    var showAll = selectedClouds.indexOf('*') !== -1;
                    var kept = bucketsPanel.querySelectorAll('input:checked');
                    var keptIds = {};
                    Array.from(kept).forEach(function(inp) { keptIds[inp.value] = true; });
                    var filtered = showAll ? bucketItems : bucketItems.filter(function(item) { return selectedClouds.indexOf(item.cloud_id || '') !== -1; });
                    bucketsPanel.innerHTML = '';
                    var optAll = document.createElement('label');
                    optAll.className = 'lables dropdown-item';
                    optAll.innerHTML = '<input type="checkbox" class="checkbox" value="*" data-label="' + allLabel.replace(/"/g, '&quot;') + '"> <span>' + allLabel + '</span>';
                    optAll.addEventListener('change', function() {
                        var cb = optAll.querySelector('input');
                        var query = String(bucketsPanel._dropdownSearchQuery || '').trim();
                        var targets = Array.from(
                            bucketsPanel.querySelectorAll(query ? '.dropdown-item:not(.hidden) input[type="checkbox"]' : '.dropdown-item input[type="checkbox"]')
                        ).filter(function(inp) { return inp.value !== '*'; });
                        targets.forEach(function(inp) { inp.checked = cb.checked; });
                        var allNonAll = Array.from(bucketsPanel.querySelectorAll('.dropdown-item input[type="checkbox"]'))
                            .filter(function(inp) { return inp.value !== '*'; });
                        cb.checked = allNonAll.length > 0 && allNonAll.every(function(inp) { return inp.checked; });
                        updateBucketsLabel();
                        onAddUserBucketsSelectionChanged(roleOptions);
                    });
                    bucketsPanel.appendChild(optAll);
                    filtered.forEach(function(item) {
                        var lab = document.createElement('label');
                        lab.className = 'lables dropdown-item';
                        var cloudId = (item.cloud_id != null) ? (item.cloud_id + '').replace(/"/g, '&quot;') : '';
                        var displayLabel = (item.label || item.id || '').toString().replace(/\s*\([^)]*\)\s*$/, '').trim() || (item.id || '').toString();
                        lab.innerHTML = '<input type="checkbox" class="checkbox" value="' + (item.id + '').replace(/"/g, '&quot;') + '" data-label="' + displayLabel.replace(/"/g, '&quot;') + '" data-cloud-id="' + cloudId + '"> <span>' + displayLabel + '</span>';
                        var searchParts = [
                            item.id,
                            item.label,
                            item.bucket_name,
                            item.display_name,
                            item.cloud_id,
                            item.name
                        ].filter(function(v) { return v != null && String(v).trim() !== ''; });
                        lab.setAttribute('data-search-text', searchParts.join(' ').toLowerCase());
                        var inp = lab.querySelector('input');
                        if (keptIds[inp.value]) inp.checked = true;
                        inp.addEventListener('change', function() {
                            var allCb = optAll.querySelector('input');
                            if (allCb && allCb.checked) allCb.checked = false;
                            updateBucketsLabel();
                            onAddUserBucketsSelectionChanged(roleOptions);
                        });
                        bucketsPanel.appendChild(lab);
                    });
                    function updateBucketsLabel() {
                        var checked = bucketsPanel.querySelectorAll('input:checked');
                        var vals = Array.from(checked).map(function(c) { return c.value; });
                        if (vals.indexOf('*') !== -1 || vals.length === 0) {
                            bucketsLabel.textContent = '—';
                            bucketsLabel.classList.remove('has-selection');
                        } else {
                            bucketsLabel.textContent = vals.length === 1 ? (bucketsPanel.querySelector('input:checked').getAttribute('data-label') || vals[0]) : ((t['settings.selected_count'] || '{n} selected').replace('{n}', vals.length));
                            bucketsLabel.classList.add('has-selection');
                        }
                    }
                    updateBucketsLabel();
                    attachBucketsSearchToDropdownPanel(bucketsPanel, t, bucketsWrap);
                    onAddUserBucketsSelectionChanged(roleOptions);
                }
                function buildPanel(panel, items, allLabelText, labelEl, optExtra) {
                    panel.innerHTML = '';
                    var optAll = document.createElement('label');
                    optAll.className = 'lables dropdown-item';
                    optAll.innerHTML = '<input type="checkbox" class="checkbox" value="*" data-label="' + allLabelText.replace(/"/g, '&quot;') + '"> <span>' + allLabelText + '</span>';
                    optAll.addEventListener('change', function() {
                        var cb = optAll.querySelector('input');
                        var query = String(panel._dropdownSearchQuery || '').trim();
                        var targets = Array.from(
                            panel.querySelectorAll(query ? '.dropdown-item:not(.hidden) input[type="checkbox"]' : '.dropdown-item input[type="checkbox"]')
                        ).filter(function(inp) { return inp.value !== '*'; });
                        targets.forEach(function(inp) { inp.checked = cb.checked; });
                        var allNonAll = Array.from(panel.querySelectorAll('.dropdown-item input[type="checkbox"]'))
                            .filter(function(inp) { return inp.value !== '*'; });
                        cb.checked = allNonAll.length > 0 && allNonAll.every(function(inp) { return inp.checked; });
                        updateLabel();
                        if (optExtra && optExtra.onAllChange) optExtra.onAllChange();
                    });
                    panel.appendChild(optAll);
                    items.forEach(function(item) {
                        var lab = document.createElement('label');
                        lab.className = 'lables dropdown-item';
                        var cloudId = (item.cloud_id != null) ? (item.cloud_id + '').replace(/"/g, '&quot;') : '';
                        lab.innerHTML = '<input type="checkbox" class="checkbox" value="' + (item.id + '').replace(/"/g, '&quot;') + '" data-label="' + (item.label + '').replace(/"/g, '&quot;') + '" data-cloud-id="' + cloudId + '"> <span>' + (item.label || item.id) + '</span>';
                        lab.querySelector('input').addEventListener('change', function() {
                            var allCb = optAll.querySelector('input');
                            if (allCb && allCb.checked) allCb.checked = false;
                            updateLabel();
                            if (optExtra && optExtra.onChange) optExtra.onChange();
                        });
                        panel.appendChild(lab);
                    });
                    function updateLabel() {
                        var checked = panel.querySelectorAll('input:checked');
                        var vals = Array.from(checked).map(function(c) { return c.value; });
                        if (vals.indexOf('*') !== -1 || vals.length === 0) {
                            labelEl.textContent = '—';
                            labelEl.classList.remove('has-selection');
                        } else {
                            labelEl.textContent = vals.length === 1 ? (panel.querySelector('input:checked').getAttribute('data-label') || vals[0]) : ((t['settings.selected_count'] || '{n} selected').replace('{n}', vals.length));
                            labelEl.classList.add('has-selection');
                        }
                    }
                    return updateLabel;
                }
                buildPanel(cloudsPanel, cloudItems, allLabel, cloudsLabel, {
                    onChange: rebuildBucketsPanel,
                    onAllChange: rebuildBucketsPanel
                });
                rebuildBucketsPanel();
                document.getElementById('addUserRoleTrigger').onclick = function(e) { e.stopPropagation(); toggleAddUserDropdown(roleWrap, rolePanel, [cloudsWrap, bucketsWrap]); };
                document.getElementById('addUserBucketsTrigger').onclick = function(e) {
                    if (e.currentTarget.disabled) return;
                    e.stopPropagation();
                    toggleAddUserDropdown(bucketsWrap, bucketsPanel, [cloudsWrap, roleWrap]);
                };
                document.getElementById('addUserCloudsTrigger').onclick = function(e) { e.stopPropagation(); toggleAddUserDropdown(cloudsWrap, cloudsPanel, [bucketsWrap, roleWrap]); };
                var addUserModalEl = document.getElementById('addUserModal');
                function closeDropdowns(e) {
                    if (isAddUserDropdownUiTarget(e && e.target)) return;
                    closeAllAddUserDropdownPanels();
                    document.removeEventListener('click', closeDropdowns);
                    if (addUserModalEl._userDocClickClose === closeDropdowns) delete addUserModalEl._userDocClickClose;
                }
                if (addUserModalEl._userDocClickClose) {
                    document.removeEventListener('click', addUserModalEl._userDocClickClose);
                }
                addUserModalEl._userDocClickClose = closeDropdowns;
                setTimeout(function() { document.addEventListener('click', closeDropdowns); }, 0);
                attachAddUserModalFocusClose();
                setAddUserBucketRolesRoleOptions(roleOptions);
                addUserBucketRolesOverrides = {};
                renderAddUserBucketRolesView();
                onAddUserBucketsSelectionChanged(roleOptions);
                addUserModalEl.style.display = 'flex';
            }).catch(function() {
                toastFormError((window.I18N && window.I18N['error.load_options_failed']) || '');
                document.getElementById('addUserModal').style.display = 'flex';
            });
        } else if (window.settingsPanelState.currentTab === 'roles') {
            openAddRoleModal();
        } else if (window.settingsPanelState.currentTab === 'search') {
            return;
        } else {
            if (typeof window.openAddBucketModal === 'function') window.openAddBucketModal();
        }
    });
}

document.getElementById('addUserCancelBtn').addEventListener('click', hideAddUserModal);
var addUserPasswordToggle = document.getElementById('addUserPasswordToggle');
if (addUserPasswordToggle) addUserPasswordToggle.addEventListener('click', toggleAddUserPasswordVisibility);
var addUserForm = document.getElementById('addUserForm');
if (addUserForm) {
    addUserForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var submitBtn = document.getElementById('addUserSubmitBtn');
        if (submitBtn) submitBtn.click();
    });
}
document.getElementById('addUserSubmitBtn').addEventListener('click', function() {
    var editUsername = (document.getElementById('addUserEditUsername') && document.getElementById('addUserEditUsername').value) || '';
    var isEdit = editUsername.length > 0;
    var username = (document.getElementById('addUserUsername').value || '').trim();
    var password = document.getElementById('addUserPassword').value;
    var fullNameInput = document.getElementById('addUserFullName');
    var fullName = fullNameInput ? (fullNameInput.value || '').trim() : '';
    var emailInput = document.getElementById('addUserEmail');
    var email = emailInput ? (emailInput.value || '').trim() : '';
    var role = (document.getElementById('addUserRoleValue').value || 'storage_viewer').trim();
    var bucketsPanel = document.getElementById('addUserBucketsPanel');
    var cloudsPanel = document.getElementById('addUserCloudsPanel');
    var acl = collectUserFormAcl(bucketsPanel, cloudsPanel);
    var buckets = acl.buckets;
    var clouds = acl.clouds;
    var errEl = document.getElementById('addUserError');
    if (errEl) errEl.textContent = '';
    if (!isEdit && !username) { toastFormError((window.I18N && window.I18N['error.username_required']) || ''); return; }
    if (!isEdit && isUsernameTaken(username)) { toastFormError((window.I18N && window.I18N['error.user_exists']) || ''); return; }
    if (!isEdit && !password) { toastFormError((window.I18N && window.I18N['error.password_required']) || ''); return; }
    var url = isEdit ? ('/api/settings/users/' + encodeURIComponent(editUsername)) : '/api/settings/users';
    var method = isEdit ? 'PUT' : 'POST';
    var body = {
        role: role,
        buckets: buckets,
        clouds: clouds,
        bucket_roles: collectAddUserBucketRoles(),
        email: email || null,
        display_name: fullName || null
    };
    if (!isEdit) {
        body.username = username;
        body.password = password;
    } else if (password && String(password).trim()) {
        body.password = password;
    }
    fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
    }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(res) {
        if (res.ok) {
            if (res.data && res.data.session_updated) {
                window.availableBuckets = [];
                window.bucketsSidebarLoaded = false;
                if (typeof window.checkAuthentication === 'function') {
                    window.checkAuthentication().catch(function() {});
                } else if (typeof window.loadBuckets === 'function') {
                    window.loadBuckets();
                }
            }
            hideAddUserModal();
            loadSettingsUsers();
            if (typeof showSuccess === 'function') showSuccess(window.I18N && window.I18N['notification.operation_ok'] ? window.I18N['notification.operation_ok'] : 'Success');
        } else {
            toastFormError((res.data && res.data.error) || ((window.I18N && window.I18N['notification.error']) || ''));
        }
    }).catch(function() {
        toastFormError((window.I18N && window.I18N['msg.network_error']) || '');
    });
});

if (settingsContentInner) {
    settingsContentInner.addEventListener('click', function(e) {
        var userRow = e.target && e.target.closest && e.target.closest('tr.settings-user-row');
        if (!userRow || !settingsContentInner.contains(userRow)) return;
        var rowUsername = userRow.getAttribute('data-username');
        if (!rowUsername) return;
        openSettingsUserInfoModal(rowUsername);
    });
}
var roleEditCancelBtn = document.getElementById('roleEditCancelBtn');
if (roleEditCancelBtn) roleEditCancelBtn.addEventListener('click', hideRoleEditModal);
var roleEditSubmitBtn = document.getElementById('roleEditSubmitBtn');
if (roleEditSubmitBtn) {
    roleEditSubmitBtn.addEventListener('click', function() {
        var t = window.I18N || {};
        var orig = (document.getElementById('roleEditOriginalName') && document.getElementById('roleEditOriginalName').value) || '';
        var isEdit = orig.length > 0;
        var nameInput = (document.getElementById('roleEditNameInput') && document.getElementById('roleEditNameInput').value || '').trim();
        var panel = document.getElementById('roleEditPermissionsPanel');
        var errEl = document.getElementById('roleEditError');
        var perms = panel ? Array.from(panel.querySelectorAll('input[type=checkbox]:checked')).map(function(i) { return i.value; }) : [];
        if (errEl) errEl.textContent = '';
        if (!isEdit && !nameInput) {
            toastFormError(t['error.role_name_invalid'] || 'Invalid name');
            return;
        }
        if (!isEdit && isReservedRoleName(nameInput)) {
            toastFormError(t['error.role_name_reserved'] || 'This role name is reserved');
            return;
        }
        var url = isEdit ? ('/api/settings/roles/' + encodeURIComponent(orig)) : '/api/settings/roles';
        var method = isEdit ? 'PUT' : 'POST';
        var body = isEdit ? JSON.stringify({ permissions: perms }) : JSON.stringify({ name: nameInput, permissions: perms });
        fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: body
        }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
            .then(function(res) {
                if (res.ok) {
                    hideRoleEditModal();
                    loadSettingsRoles();
                    if (typeof showSuccess === 'function') showSuccess(t['notification.operation_ok'] || 'Success');
                } else {
                    toastFormError((res.data && res.data.error) || ((window.I18N && window.I18N['notification.error']) || ''));
                }
            }).catch(function() {
                toastFormError(t['msg.network_error'] || '');
            });
    });
}
var cloudEditCancelBtn = document.getElementById('cloudEditCancelBtn');
if (cloudEditCancelBtn) cloudEditCancelBtn.addEventListener('click', hideCloudEditModal);
var cloudEditSubmitBtn = document.getElementById('cloudEditSubmitBtn');
if (cloudEditSubmitBtn) {
    cloudEditSubmitBtn.addEventListener('click', function() {
        var t = window.I18N || {};
        var orig = (document.getElementById('cloudEditOriginalId') && document.getElementById('cloudEditOriginalId').value || '').trim();
        var isEdit = orig.length > 0;
        var idEl = document.getElementById('cloudEditIdInput');
        var nameEl = document.getElementById('cloudEditDisplayNameInput');
        var errEl = document.getElementById('cloudEditError');
        var cloudId = (idEl && idEl.value || '').trim();
        var displayName = (nameEl && nameEl.value || '').trim();
        var endpoints = getCloudEndpointValues();
        var publicUrlEnabled = getCloudEditPublicUrl();
        if (errEl) errEl.textContent = '';
        if (!cloudId) {
            toastFormError(t['error.cloud_id_invalid'] || 'Cloud ID is required');
            return;
        }
        var url = isEdit ? ('/api/settings/clouds/' + encodeURIComponent(orig)) : '/api/settings/clouds';
        var method = isEdit ? 'PUT' : 'POST';
        var body = isEdit
            ? { display_name: displayName || cloudId, endpoint_url: endpoints, public_url_enabled: publicUrlEnabled }
            : { cloud_id: cloudId, display_name: displayName || cloudId, endpoint_url: endpoints, public_url_enabled: publicUrlEnabled };
        fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
        }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
            .then(function(res) {
                if (res.ok) {
                    window.availableBuckets = [];
                    window.bucketsSidebarLoaded = false;
                    if (typeof window.loadBuckets === 'function') {
                        window.loadBuckets();
                    }
                    hideCloudEditModal();
                    loadSettingsClouds();
                    if (typeof showSuccess === 'function') showSuccess(t['notification.operation_ok'] || 'Success');
                } else {
                    toastFormError((res.data && res.data.error) || ((window.I18N && window.I18N['notification.error']) || ''));
                }
            }).catch(function() {
                toastFormError(t['msg.network_error'] || '');
            });
    });
}
initCloudEditPublicUrlDropdown();
}

    window.loadSettingsUsers = loadSettingsUsers;
    window.loadSettingsRoles = loadSettingsRoles;
    window.loadSettingsClouds = loadSettingsClouds;
    window.hideAddUserModal = hideAddUserModal;
    window.hideCloudEditModal = hideCloudEditModal;
    window.initSettingsUsersRoles = initSettingsUsersRoles;
    window.openEditUserModal = openEditUserModal;
    window.confirmDeleteUser = confirmDeleteUser;
    window.openEditRoleModal = openEditRoleModal;
    window.openCopyRoleModal = openCopyRoleModal;
    window.confirmDeleteRole = confirmDeleteRole;
    window.openEditCloudModal = openEditCloudModal;
    window.openCopyCloudModal = openCopyCloudModal;
    window.confirmDeleteCloud = confirmDeleteCloud;
    window.openSettingsUserInfoModal = openSettingsUserInfoModal;
})();
