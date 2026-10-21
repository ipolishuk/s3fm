/**
 * Копирование и перемещение объектов между бакетами / путями.
 * Move на сервере = copy + delete в src; UI отличается конфигом.
 */
(function () {
    'use strict';

    var I18N = window.I18N || {};

    function t(key, fallback) {
        return I18N[key] || fallback || key;
    }

    function tk(prefix, suffix, fallback) {
        return I18N[prefix + '.' + suffix] || fallback || (prefix + '.' + suffix);
    }

    function id(prefix, name) {
        return prefix + name;
    }

    function getCurrentBucketId() {
        if (typeof window.__getCurrentBucket === 'function') {
            return window.__getCurrentBucket() || '';
        }
        return window.currentBucket || window.fileManagerCurrentBucketId || '';
    }

    function getCurrentPathValue() {
        if (typeof window.__getCurrentPath === 'function') {
            return window.__getCurrentPath() || '';
        }
        return typeof window.currentPath === 'string' ? window.currentPath : '';
    }

    function getBucketLabel(bucketId) {
        var list = window.availableBuckets || [];
        var bucket = list.find(function (b) { return b && b.bucket_id === bucketId; });
        if (!bucket) return bucketId || '—';
        return bucket.display_name || bucket.name || bucket.bucket_id;
    }

    function getBucketCloudId(bucket) {
        if (!bucket) return '';
        return String(bucket.cloud_id || bucket.group || '').trim();
    }

    function getCloudLabel(cloud) {
        if (!cloud) return '—';
        return cloud.cloud_name || cloud.cloud_id || '—';
    }

    function formatPathLabel(prefix, path) {
        var p = (path || '').trim();
        if (!p) return '/' + tk(prefix, 'dst_root', 'Root');
        return '/' + p.replace(/\/$/, '');
    }

    function getDestinationBuckets(requireFolderUpload) {
        return (window.availableBuckets || []).filter(function (b) {
            if (!b || !b.bucket_id) return false;
            if (!window.userHasPermission('upload_files', b.bucket_id)) return false;
            if (requireFolderUpload) {
                return window.userHasPermission('upload_folder', b.bucket_id)
                    || window.userHasPermission('create_folder', b.bucket_id);
            }
            return true;
        });
    }

    function getDestinationClouds(buckets) {
        var byId = {};
        var order = [];
        (buckets || []).forEach(function (b) {
            var cid = getBucketCloudId(b);
            if (!cid || byId[cid]) return;
            byId[cid] = {
                cloud_id: cid,
                cloud_name: b.cloud_name || b.group_name || cid
            };
            order.push(cid);
        });
        return order.map(function (cid) { return byId[cid]; });
    }

    function filterBucketsByCloud(buckets, cloudId) {
        var cid = String(cloudId || '').trim();
        if (!cid) return buckets.slice();
        return buckets.filter(function (b) { return getBucketCloudId(b) === cid; });
    }

    function getSelectedItems() {
        var selectedItems = window.selectedItems;
        if (!selectedItems || typeof selectedItems.forEach !== 'function') return [];
        var items = [];
        selectedItems.forEach(function (itemKey) {
            try {
                var item = JSON.parse(itemKey);
                if (item && item.path) items.push(item);
            } catch (e) { /* ignore */ }
        });
        return items.filter(function (item) { return item.path && item.path.trim() !== ''; });
    }

    function canSelectFilesInSelectionMode(bucketId) {
        var bid = (bucketId || '').trim();
        if (!bid) return false;
        return window.userHasPermission('download_files_multi', bid)
            || window.userHasPermission('delete_files_multi', bid)
            || window.userHasPermission('copy_files_multi', bid)
            || window.userHasPermission('copy_file', bid)
            || window.userHasPermission('move_files_multi', bid)
            || window.userHasPermission('move_file', bid)
            || window.userHasPermission('edit_file_acl', bid);
    }

    function canSelectFoldersInSelectionMode(bucketId) {
        var bid = (bucketId || '').trim();
        if (!bid) return false;
        return window.userHasPermission('delete_folder_multi', bid)
            || window.userHasPermission('copy_folder_multi', bid)
            || window.userHasPermission('copy_folder', bid)
            || window.userHasPermission('move_folder_multi', bid)
            || window.userHasPermission('move_folder', bid)
            || window.userHasPermission('edit_file_acl', bid);
    }

    function canEnterSelectionMode(bucketId) {
        var bid = (bucketId || '').trim();
        if (!bid) return false;
        return canSelectFilesInSelectionMode(bid)
            || canSelectFoldersInSelectionMode(bid);
    }

    function hasFileCopyPerm(bucketId) {
        return window.userHasPermission('copy_file', bucketId)
            || window.userHasPermission('copy_files_multi', bucketId);
    }

    function hasFolderCopyPerm(bucketId) {
        return window.userHasPermission('copy_folder', bucketId)
            || window.userHasPermission('copy_folder_multi', bucketId);
    }

    function hasFileMovePerm(bucketId) {
        return window.userHasPermission('move_file', bucketId)
            || window.userHasPermission('move_files_multi', bucketId);
    }

    function hasFolderMovePerm(bucketId) {
        return window.userHasPermission('move_folder', bucketId)
            || window.userHasPermission('move_folder_multi', bucketId);
    }

    function canCopySelected(filesCount, foldersCount) {
        return !getCopyDisableReason(filesCount, foldersCount);
    }

    function getCopyDisableReason(filesCount, foldersCount) {
        if (filesCount + foldersCount === 0) {
            return t('files.bulk_acl_select_min_files', 'Select at least one item');
        }
        var srcBucket = getCurrentBucketId();
        if (!srcBucket) return t('msg.select_bucket_first', 'Select a bucket');

        if (filesCount > 0) {
            var canCopyFiles = filesCount === 1
                ? hasFileCopyPerm(srcBucket)
                : window.userHasPermission('copy_files_multi', srcBucket);
            if (!canCopyFiles) {
                return t('error.access_denied', 'Access denied');
            }
        }
        if (foldersCount > 0) {
            var canCopyFolders = foldersCount === 1
                ? hasFolderCopyPerm(srcBucket)
                : window.userHasPermission('copy_folder_multi', srcBucket);
            if (!canCopyFolders) {
                return t('error.access_denied', 'Access denied');
            }
        }
        if (getDestinationBuckets(foldersCount > 0).length < 1) {
            return t('copy.need_upload', 'Copy also requires upload_files on a destination bucket');
        }
        return '';
    }

    function canMoveSelected(filesCount, foldersCount) {
        return !getMoveDisableReason(filesCount, foldersCount);
    }

    function getMoveDisableReason(filesCount, foldersCount) {
        if (filesCount + foldersCount === 0) {
            return t('files.bulk_acl_select_min_files', 'Select at least one item');
        }
        var srcBucket = getCurrentBucketId();
        if (!srcBucket) return t('msg.select_bucket_first', 'Select a bucket');

        if (filesCount > 0) {
            var canMoveFiles = filesCount === 1
                ? hasFileMovePerm(srcBucket)
                : window.userHasPermission('move_files_multi', srcBucket);
            var canDeleteFiles = filesCount === 1
                ? (window.userHasPermission('delete_file', srcBucket)
                    || window.userHasPermission('delete_files_multi', srcBucket))
                : window.userHasPermission('delete_files_multi', srcBucket);
            if (!canMoveFiles) {
                return t('error.access_denied', 'Access denied');
            }
            if (!canDeleteFiles) {
                return t('move.need_delete', 'Move also requires delete permission');
            }
        }
        if (foldersCount > 0) {
            var canMoveFolders = foldersCount === 1
                ? hasFolderMovePerm(srcBucket)
                : window.userHasPermission('move_folder_multi', srcBucket);
            var canDeleteFolders = foldersCount === 1
                ? (window.userHasPermission('delete_folder', srcBucket)
                    || window.userHasPermission('delete_folder_multi', srcBucket))
                : window.userHasPermission('delete_folder_multi', srcBucket);
            if (!canMoveFolders) {
                return t('error.access_denied', 'Access denied');
            }
            if (!canDeleteFolders) {
                return t('move.need_delete', 'Move also requires delete permission');
            }
        }
        if (getDestinationBuckets(foldersCount > 0).length < 1) {
            return t('move.need_upload', 'Move also requires upload_files on a destination bucket');
        }
        return '';
    }

    function createTransferController(cfg) {
        var prefix = cfg.prefix;
        var state = {
            dstCloudId: '',
            dstBucketId: '',
            dstPath: '',
            hasFolders: false,
            pendingItems: null
        };

        function setError(message) {
            var el = document.getElementById(id(prefix, 'ObjectsError'));
            if (el) {
                el.textContent = '';
                el.style.display = 'none';
            }
            if (!message) return;
            if (typeof window.showError === 'function') {
                window.showError(message);
            }
        }

        function closeDropdown(kind) {
            var wrap = document.getElementById(id(prefix, 'Dst' + kind + 'Wrap'));
            var panel = document.getElementById(id(prefix, 'Dst' + kind + 'Panel'));
            if (wrap) wrap.classList.remove('open');
            if (panel) panel.classList.add('hidden');
            if (panel && panel._dropdownSearchSetMode) panel._dropdownSearchSetMode(false);
            if (wrap && typeof window.resetDropdownMenuOverlay === 'function') {
                window.resetDropdownMenuOverlay(wrap);
            }
        }

        function closeDstBucketDropdown() {
            closeDropdown('Bucket');
        }

        function closeDstCloudDropdown() {
            closeDropdown('Cloud');
        }

        function closeAllDstDropdowns() {
            closeDstCloudDropdown();
            closeDstBucketDropdown();
        }

        function attachDstBucketSearch(panel, wrap) {
            if (!panel || !wrap) return;
            var trigger = document.getElementById(id(prefix, 'DstBucketTrigger'));
            var triggerLabel = document.getElementById(id(prefix, 'DstBucketLabel'));
            if (!trigger) return;

            var searchInput = trigger.querySelector('.dropdown-trigger-search');
            if (!searchInput) {
                searchInput = document.createElement('input');
                searchInput.type = 'text';
                searchInput.className = 'search-input search-input-in-trigger dropdown-trigger-search hidden';
                searchInput.autocomplete = 'off';
                var icon = trigger.querySelector('.dropdown-icon');
                if (icon) trigger.insertBefore(searchInput, icon);
                else trigger.appendChild(searchInput);
                searchInput.addEventListener('input', updateFilter);
                searchInput.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
                searchInput.addEventListener('click', function (ev) { ev.stopPropagation(); });
            }
            searchInput.placeholder = t('buckets.search_placeholder', 'Search buckets');

            var noResults = panel.querySelector('.dropdown-search-empty');
            if (!noResults) {
                noResults = document.createElement('div');
                noResults.className = 'dropdown-search-empty hidden';
                panel.prepend(noResults);
            }
            noResults.textContent = t('search.nothing_found', 'Nothing found');

            function updateFilter() {
                var query = (searchInput.value || '').trim().toLowerCase();
                var options = Array.from(panel.querySelectorAll('.dropdown-item'));
                var visible = 0;
                options.forEach(function (opt) {
                    var searchText = (opt.getAttribute('data-search-text') || '').trim().toLowerCase();
                    var text = (opt.textContent || '').trim().toLowerCase();
                    var show = !query || text.indexOf(query) !== -1;
                    if (!show && searchText) show = searchText.indexOf(query) !== -1;
                    opt.classList.toggle('hidden', !show);
                    if (show) visible++;
                });
                noResults.classList.toggle('hidden', visible > 0);
            }

            function setSearchMode(enabled) {
                if (enabled) {
                    searchInput.classList.remove('hidden');
                    if (triggerLabel) triggerLabel.classList.add('hidden');
                    requestAnimationFrame(function () { searchInput.focus(); });
                } else {
                    searchInput.value = '';
                    searchInput.classList.add('hidden');
                    if (triggerLabel) triggerLabel.classList.remove('hidden');
                    updateFilter();
                }
            }

            panel._dropdownSearchSetMode = setSearchMode;
            updateFilter();
        }

        function bindDropdownToggle(kind, onOpen) {
            var wrap = document.getElementById(id(prefix, 'Dst' + kind + 'Wrap'));
            var panel = document.getElementById(id(prefix, 'Dst' + kind + 'Panel'));
            var trigger = document.getElementById(id(prefix, 'Dst' + kind + 'Trigger'));
            if (!wrap || !panel || !trigger) return;
            var boundKey = prefix + kind + 'DropdownBound';
            if (wrap.dataset[boundKey]) return;
            wrap.dataset[boundKey] = '1';
            trigger.addEventListener('click', function (e) {
                e.stopPropagation();
                var willOpen = !wrap.classList.contains('open');
                closeAllDstDropdowns();
                if (willOpen) {
                    wrap.classList.add('open');
                    panel.classList.remove('hidden');
                    if (typeof onOpen === 'function') onOpen(panel);
                    if (typeof window.fitDropdownMenuOverlay === 'function') {
                        window.fitDropdownMenuOverlay(wrap);
                    }
                }
            });
            document.addEventListener('click', function (e) {
                if (wrap.classList.contains('open') && !wrap.contains(e.target)) {
                    closeDropdown(kind);
                }
            });
        }

        function rebuildDstCloudDropdown(clouds, selectedCloudId) {
            var panel = document.getElementById(id(prefix, 'DstCloudPanel'));
            var label = document.getElementById(id(prefix, 'DstCloudLabel'));
            var hidden = document.getElementById(id(prefix, 'DstCloudValue'));
            if (!panel || !label || !hidden) return;

            panel.innerHTML = '';
            if (!clouds.length) {
                label.textContent = tk(prefix, 'dst_select_cloud', 'Select cloud');
                label.classList.remove('has-selection');
                hidden.value = '';
                state.dstCloudId = '';
                return;
            }

            var selectedId = selectedCloudId || hidden.value || state.dstCloudId || clouds[0].cloud_id;
            if (!clouds.some(function (c) { return c.cloud_id === selectedId; })) {
                selectedId = clouds[0].cloud_id;
            }
            hidden.value = selectedId;
            state.dstCloudId = selectedId;
            var selectedCloud = clouds.find(function (c) { return c.cloud_id === selectedId; }) || clouds[0];
            label.textContent = getCloudLabel(selectedCloud);
            label.classList.add('has-selection');

            clouds.forEach(function (cloud) {
                var item = document.createElement('div');
                item.className = 'dropdown-item' + (cloud.cloud_id === selectedId ? ' selected' : '');
                item.setAttribute('role', 'option');
                var text = getCloudLabel(cloud);
                item.textContent = text;
                item.dataset.cloudId = cloud.cloud_id;
                item.addEventListener('click', function () {
                    if (state.dstCloudId === cloud.cloud_id) {
                        closeDstCloudDropdown();
                        return;
                    }
                    hidden.value = cloud.cloud_id;
                    state.dstCloudId = cloud.cloud_id;
                    label.textContent = text;
                    label.classList.add('has-selection');
                    closeDstCloudDropdown();
                    state.dstBucketId = '';
                    var bucketHidden = document.getElementById(id(prefix, 'DstBucketValue'));
                    if (bucketHidden) bucketHidden.value = '';
                    state.dstPath = '';
                    rebuildDstBucketDropdown(state.hasFolders, { keepCloud: true });
                    loadDstFolders();
                });
                panel.appendChild(item);
            });

            bindDropdownToggle('Cloud');
        }

        function rebuildDstBucketDropdown(hasFolders, options) {
            options = options || {};
            var panel = document.getElementById(id(prefix, 'DstBucketPanel'));
            var label = document.getElementById(id(prefix, 'DstBucketLabel'));
            var hidden = document.getElementById(id(prefix, 'DstBucketValue'));
            var wrap = document.getElementById(id(prefix, 'DstBucketWrap'));
            if (!panel || !label || !hidden) return;

            var allBuckets = getDestinationBuckets(hasFolders);
            var clouds = getDestinationClouds(allBuckets);
            var preferredCloud = '';
            if (options.keepCloud) {
                preferredCloud = state.dstCloudId;
            } else {
                var currentBucket = (window.availableBuckets || []).find(function (b) {
                    return b && b.bucket_id === getCurrentBucketId();
                });
                preferredCloud = getBucketCloudId(currentBucket);
            }
            if (!options.keepCloud) {
                rebuildDstCloudDropdown(clouds, preferredCloud);
            }

            var buckets = filterBucketsByCloud(allBuckets, state.dstCloudId);
            panel.innerHTML = '';
            if (allBuckets.length === 0 || buckets.length === 0) {
                label.textContent = tk(prefix, 'dst_no_buckets', 'No buckets available for upload');
                label.classList.remove('has-selection');
                hidden.value = '';
                state.dstBucketId = '';
                return;
            }

            var selectedId = hidden.value || state.dstBucketId || buckets[0].bucket_id;
            if (!buckets.some(function (b) { return b.bucket_id === selectedId; })) {
                selectedId = buckets[0].bucket_id;
            }
            hidden.value = selectedId;
            state.dstBucketId = selectedId;
            label.textContent = getBucketLabel(selectedId);
            label.classList.add('has-selection');

            buckets.forEach(function (bucket) {
                var item = document.createElement('div');
                item.className = 'dropdown-item' + (bucket.bucket_id === selectedId ? ' selected' : '');
                item.setAttribute('role', 'option');
                var text = getBucketLabel(bucket.bucket_id);
                item.textContent = text;
                item.dataset.bucketId = bucket.bucket_id;
                item.dataset.optionLabel = text;
                item.setAttribute('data-search-text', text.toLowerCase());
                item.addEventListener('click', function () {
                    hidden.value = bucket.bucket_id;
                    state.dstBucketId = bucket.bucket_id;
                    label.textContent = text;
                    label.classList.add('has-selection');
                    closeDstBucketDropdown();
                    state.dstPath = '';
                    loadDstFolders();
                });
                panel.appendChild(item);
            });

            attachDstBucketSearch(panel, wrap);
            bindDropdownToggle('Bucket', function (bucketPanel) {
                if (bucketPanel._dropdownSearchSetMode) bucketPanel._dropdownSearchSetMode(true);
            });
        }

        function renderDstBreadcrumb() {
            var el = document.getElementById(id(prefix, 'DstBreadcrumb'));
            if (!el) return;
            el.innerHTML = '';
            var rootBtn = document.createElement('button');
            rootBtn.type = 'button';
            rootBtn.className = 'btn copy-dst-crumb';
            rootBtn.textContent = tk(prefix, 'dst_root', 'Root');
            rootBtn.addEventListener('click', function () {
                state.dstPath = '';
                loadDstFolders();
            });
            el.appendChild(rootBtn);

            var parts = (state.dstPath || '').replace(/\/$/, '').split('/').filter(Boolean);
            var acc = '';
            parts.forEach(function (part) {
                acc += part + '/';
                var sep = document.createElement('span');
                sep.className = 'copy-dst-crumb-sep';
                sep.textContent = '/';
                el.appendChild(sep);
                (function (pathSnapshot) {
                    var btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn copy-dst-crumb';
                    btn.textContent = part;
                    btn.addEventListener('click', function () {
                        state.dstPath = pathSnapshot;
                        loadDstFolders();
                    });
                    el.appendChild(btn);
                })(acc);
            });
        }

        async function loadDstFolders() {
            var listEl = document.getElementById(id(prefix, 'DstFolderList'));
            if (!listEl) return;
            if (!state.dstBucketId) {
                listEl.innerHTML = '<div class="copy-dst-empty">' + tk(prefix, 'dst_select_bucket', 'Select bucket') + '</div>';
                return;
            }
            listEl.innerHTML = '<div class="copy-dst-empty">' + tk(prefix, 'dst_loading', 'Loading folders...') + '</div>';
            renderDstBreadcrumb();

            try {
                var params = new URLSearchParams({
                    bucket: state.dstBucketId,
                    prefix: state.dstPath || '',
                    limit: '200'
                });
                var response = await fetch('/files?' + params.toString(), { credentials: 'include' });
                var data = await response.json();
                if (!response.ok) throw new Error(data.error || response.statusText);
                listEl.innerHTML = '';
                var folders = data.folders || [];
                if (folders.length === 0) {
                    listEl.innerHTML = '<div class="copy-dst-empty">' + tk(prefix, 'dst_empty', 'No subfolders') + '</div>';
                    return;
                }
                folders.forEach(function (folder) {
                    var row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'copy-dst-folder-item btn';
                    row.innerHTML = '<i class="fa-solid fa-folder folder-icon"></i><span></span>';
                    row.querySelector('span').textContent = folder.name || folder.path;
                    row.addEventListener('click', function () {
                        state.dstPath = folder.path || '';
                        loadDstFolders();
                    });
                    listEl.appendChild(row);
                });
            } catch (err) {
                listEl.innerHTML = '<div class="copy-dst-empty">' + (err.message || tk(prefix, 'error', 'Failed')) + '</div>';
            }
        }

        function renderSrcSummary(items) {
            var bucketEl = document.getElementById(id(prefix, 'SrcBucketValue'));
            var pathEl = document.getElementById(id(prefix, 'SrcPathValue'));
            var itemsEl = document.getElementById(id(prefix, 'SrcItemsValue'));
            if (bucketEl) bucketEl.textContent = getBucketLabel(getCurrentBucketId());
            if (pathEl) pathEl.textContent = formatPathLabel(prefix, getCurrentPathValue());
            if (itemsEl) {
                itemsEl.textContent = tk(prefix, 'items_count', '{count} item(s)')
                    .replace('{count}', String(items.length));
            }
        }

        function normalizeItems(rawItems) {
            if (!Array.isArray(rawItems)) return [];
            return rawItems.filter(function (item) {
                return item && item.path && String(item.path).trim() !== '';
            }).map(function (item) {
                var path = String(item.path).trim();
                var type = item.type === 'folder' || path.endsWith('/') ? 'folder' : 'file';
                return { path: path, type: type };
            });
        }

        function resolveItems(overrideItems) {
            var items = normalizeItems(overrideItems);
            if (items.length) return items;
            return getSelectedItems();
        }

        function showModal(overrideItems) {
            var items = resolveItems(overrideItems);
            if (items.length === 0) return;

            var filesCount = items.filter(function (i) { return i.type === 'file'; }).length;
            var foldersCount = items.length - filesCount;
            if (!cfg.canSelected(filesCount, foldersCount)) return;

            state.pendingItems = items;
            state.hasFolders = foldersCount > 0;
            state.dstPath = '';
            state.dstCloudId = '';
            state.dstBucketId = '';
            setError('');
            renderSrcSummary(items);
            rebuildDstBucketDropdown(state.hasFolders);
            loadDstFolders();

            var modal = document.getElementById(id(prefix, 'ObjectsModal'));
            if (modal) modal.style.display = 'flex';
        }

        function hideModal() {
            if (typeof window.hideModalParamsInfo === 'function') window.hideModalParamsInfo();
            var modal = document.getElementById(id(prefix, 'ObjectsModal'));
            if (modal) modal.style.display = 'none';
            closeAllDstDropdowns();
            setError('');
            state.pendingItems = null;
        }

        async function submit() {
            var items = state.pendingItems && state.pendingItems.length
                ? state.pendingItems
                : getSelectedItems();
            if (items.length === 0) return;
            if (!state.dstBucketId) {
                setError(tk(prefix, 'dst_select_bucket', 'Select bucket'));
                return;
            }

            var srcBucket = getCurrentBucketId();
            var names = items.map(function (item) {
                var parts = item.path.split('/').filter(Boolean);
                return parts.length ? parts[parts.length - 1] : item.path;
            });

            hideModal();

            var body = {
                src_bucket: srcBucket,
                dst_bucket: state.dstBucketId,
                dst_path: state.dstPath || '',
                items: items.map(function (item) {
                    return { path: item.path, type: item.type };
                }),
            };

            var starter = cfg.progressOp === 'copy'
                ? window.OperationJobs.startCopy
                : window.OperationJobs.startMove;

            try {
                await starter(body, names);
            } catch (err) {
                if (typeof window.showError === 'function') {
                    window.showError(tk(prefix, 'error', 'Failed') + ': ' + err.message);
                }
            }
        }

        function updateToolbarButton(filesCount, foldersCount) {
            var btn = document.getElementById(id(prefix, 'SelectedBtn'));
            if (!btn) return;
            var enabled = cfg.canSelected(filesCount, foldersCount);
            btn.disabled = !enabled;
            var toolbarLabel = t(cfg.toolbarKey, prefix);
            if (!enabled) {
                btn.title = toolbarLabel;
                return;
            }
            btn.title = toolbarLabel + ' (' + (filesCount + foldersCount) + ')';
        }

        document.addEventListener('DOMContentLoaded', function () {
            var modal = document.getElementById(id(prefix, 'ObjectsModal'));
            if (modal) {
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) hideModal();
                });
            }
        });

        return {
            showModal: showModal,
            hideModal: hideModal,
            submit: submit,
            updateToolbarButton: updateToolbarButton
        };
    }

    var copy = createTransferController({
        prefix: 'copy',
        progressOp: 'copy',
        toolbarKey: 'toolbar.copy',
        canSelected: canCopySelected
    });

    var move = createTransferController({
        prefix: 'move',
        progressOp: 'move',
        toolbarKey: 'toolbar.move',
        canSelected: canMoveSelected
    });

    window.showCopyObjectsModal = copy.showModal;
    window.hideCopyObjectsModal = copy.hideModal;
    window.submitCopyObjects = copy.submit;
    window.updateCopyToolbarButton = copy.updateToolbarButton;

    window.showMoveObjectsModal = move.showModal;
    window.hideMoveObjectsModal = move.hideModal;
    window.submitMoveObjects = move.submit;
    window.updateMoveToolbarButton = move.updateToolbarButton;

    window.canCopySelected = canCopySelected;
    window.canMoveSelected = canMoveSelected;
    window.getCopyDisableReason = getCopyDisableReason;
    window.getMoveDisableReason = getMoveDisableReason;
    window.canSelectFilesInSelectionMode = canSelectFilesInSelectionMode;
    window.canSelectFoldersInSelectionMode = canSelectFoldersInSelectionMode;
    window.canEnterSelectionMode = canEnterSelectionMode;
})();
