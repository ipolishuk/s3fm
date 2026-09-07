/**
 * Единый UI прогресс-баров: upload, delete, copy, move, acl.
 * Несколько одновременных задач одного типа — отдельные панели (новые сверху).
 */
(function () {
    'use strict';

    var ALL_OPS = ['upload', 'delete', 'copy', 'move', 'acl'];
    var _instances = [];
    var LIST_INITIAL_SIZE = 100;
    var LIST_BATCH_SIZE = 50;

    var OP_META = {
        upload: {
            plural: ['plural.file_one', 'plural.file_two', 'plural.file_five'],
            progress: 'upload.uploaded_i_of_total',
            completed: 'upload.success_count',
            waiting: 'upload.waiting',
            active: 'msg.uploading',
            done: 'msg.success',
            error: 'notification.error',
            inProgress: 'files.upload_progress'
        },
        delete: {
            plural: ['plural.element_one', 'plural.element_two', 'plural.element_five'],
            progress: 'msg.deleting_count_from',
            progressItemDone: 'msg.deleted_count_from',
            completed: 'msg.deleted_count',
            waiting: 'delete.waiting',
            active: 'delete.deleting',
            done: 'delete.deleted',
            error: 'notification.error',
            inProgress: 'delete.deleting_files'
        },
        copy: {
            plural: ['plural.object_one', 'plural.object_two', 'plural.object_five'],
            progress: 'copy.copying_count_from',
            completed: 'copy.copied_count',
            waiting: 'copy.waiting',
            active: 'copy.copying',
            done: 'copy.copied',
            error: 'copy.error',
            inProgress: 'copy.in_progress',
            counting: 'copy.counting'
        },
        move: {
            plural: ['plural.object_one', 'plural.object_two', 'plural.object_five'],
            progress: 'move.moving_count_from',
            completed: 'move.moved_count',
            waiting: 'move.waiting',
            active: 'move.moving',
            done: 'move.moved',
            error: 'move.error',
            inProgress: 'move.in_progress',
            counting: 'move.counting'
        },
        acl: {
            plural: ['plural.file_one', 'plural.file_two', 'plural.file_five'],
            progress: 'acl.applying_count_from',
            completed: 'acl.completed_count',
            waiting: 'acl.waiting',
            active: 'acl.applying',
            done: 'acl.applied',
            error: 'notification.error',
            inProgress: 'acl.in_progress'
        }
    };

    function i18n() {
        return window.I18N || {};
    }

    function tr(key, fallback) {
        var v = i18n()[key];
        return v != null && v !== '' ? v : (fallback || key);
    }

    function pluralForm(number, one, two, five) {
        if (typeof window.getPluralForm === 'function') {
            return window.getPluralForm(number, one, two, five);
        }
        var n = Math.abs(number);
        n %= 100;
        if (n >= 5 && n <= 20) return five;
        n %= 10;
        if (n === 1) return one;
        if (n >= 2 && n <= 4) return two;
        return five;
    }

    function pluralKeys(op, count) {
        var keys = (OP_META[op] && OP_META[op].plural) || OP_META.delete.plural;
        return pluralForm(count, tr(keys[0]), tr(keys[1]), tr(keys[2]));
    }

    function makeUid(op, options) {
        options = options || {};
        var raw = options.instanceId || options.jobId;
        if (raw != null && String(raw) !== '') {
            return String(raw).replace(/[^a-zA-Z0-9_-]/g, '_');
        }
        return op + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }

    function hideInstance(uid) {
        var inst = _instances.find(function (i) { return i.uid === uid; });
        if (inst && inst.container) {
            inst.container.remove();
        }
        _instances = _instances.filter(function (i) { return i.uid !== uid; });
    }

    function hide(op) {
        _instances.slice().forEach(function (inst) {
            if (!op || inst.op === op) hideInstance(inst.uid);
        });
    }

    function hideAll() {
        _instances.slice().forEach(function (inst) {
            hideInstance(inst.uid);
        });
    }

    function hideAllExcept(op) {
        _instances.slice().forEach(function (inst) {
            if (inst.op !== op) hideInstance(inst.uid);
        });
    }

    function hideLocal() {
        _instances.slice().forEach(function (inst) {
            if (window.OperationJobs && window.OperationJobs.hasActive(inst.op)) {
                return;
            }
            hideInstance(inst.uid);
        });
    }

    function scrollListItemIntoView(listEl, itemEl) {
        if (!listEl || !itemEl) return;
        var pad = 4;
        var listRect = listEl.getBoundingClientRect();
        var itemRect = itemEl.getBoundingClientRect();
        var itemTop = listEl.scrollTop + (itemRect.top - listRect.top);
        var itemBottom = itemTop + itemRect.height;
        var viewTop = listEl.scrollTop;
        var viewBottom = viewTop + listEl.clientHeight;
        if (itemBottom > viewBottom - pad) {
            var maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
            listEl.scrollTop = Math.min(maxScroll, itemBottom - listEl.clientHeight + pad);
        } else if (itemTop < viewTop + pad) {
            listEl.scrollTop = Math.max(0, itemTop - pad);
        }
    }

    function setStatusElement(el, kind, ariaLabel, errorText) {
        if (!el) return;
        el.textContent = '';
        if (kind === 'waiting') {
            el.className = 'progressbar-status';
            el.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
            if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
            else el.removeAttribute('aria-label');
            return;
        }
        if (kind === 'active') {
            el.className = 'progressbar-status pending';
            el.innerHTML = '<i class="fa-solid fa-rotate fa-spin" aria-hidden="true"></i>';
            if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
            else el.removeAttribute('aria-label');
            return;
        }
        if (kind === 'success') {
            el.className = 'progressbar-status success';
            if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
            else el.removeAttribute('aria-label');
            el.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
            return;
        }
        if (kind === 'error') {
            el.className = 'progressbar-status error';
            if (errorText) {
                el.removeAttribute('aria-label');
                el.textContent = errorText;
            } else {
                el.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
                if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
                else el.removeAttribute('aria-label');
            }
        }
    }

    function formatProgressText(op, current, total, options) {
        options = options || {};
        var meta = OP_META[op] || OP_META.delete;
        var pct = total > 0 ? Math.round((current / total) * 100) : 0;

        if (options.complete && meta.completed) {
            if (op === 'upload') {
                return tr(meta.completed, 'Done {count}').replace('{count}', String(current));
            }
            if (op === 'acl') {
                return tr(meta.completed, 'ACL applied to {ok} of {total}')
                    .replace('{ok}', String(current))
                    .replace('{total}', String(total));
            }
            var countLabel = current + ' ' + pluralKeys(op, current);
            return tr(meta.completed, 'Done {count}').replace('{count}', countLabel);
        }

        if (op === 'upload') {
            return tr(meta.progress, '{current}/{total}')
                .replace('{current}', String(current))
                .replace('{total}', String(total))
                .replace('{files_label}', pluralKeys(op, total))
                .replace('{pct}', String(pct));
        }

        if (op === 'acl') {
            return tr(meta.progress, '{current}/{total}')
                .replace('{current}', String(current))
                .replace('{total}', String(total))
                .replace('{pct}', String(pct));
        }

        if (op === 'delete') {
            var elemWord = pluralKeys(op, current);
            var currentLabel = current + ' ' + elemWord;
            var key = options.itemDone ? meta.progressItemDone : meta.progress;
            return tr(key, '{current}/{total}')
                .replace('{current}', currentLabel)
                .replace('{total}', String(total))
                .replace('{pct}', String(pct));
        }

        var objectsWord = pluralKeys(op, total || current);
        if (options.totalPending && !total) {
            return String(current) + ' ' + objectsWord + '…';
        }
        return tr(meta.progress, '{current}/{total}')
            .replace('{current}', String(current))
            .replace('{total}', String(total))
            .replace('{objects}', objectsWord)
            .replace('{pct}', String(pct));
    }

    function splitListNames(names, options) {
        options = options || {};
        var all = names || [];
        var initialSize = options.listInitialSize != null ? options.listInitialSize : LIST_INITIAL_SIZE;
        if (options.lazyList === false || all.length <= initialSize) {
            return { initial: all, pending: [] };
        }
        return {
            initial: all.slice(0, initialSize),
            pending: all.slice(initialSize),
        };
    }

    function create(op, displayNames, options) {
        options = options || {};

        var names = displayNames || [];
        var listParts = splitListNames(names, options);
        var initialNames = listParts.initial;
        var pendingNames = listParts.pending;
        var listBuiltCount = initialNames.length;
        var meta = OP_META[op] || OP_META.delete;
        var uid = makeUid(op, options);
        var id = function (suffix) { return uid + suffix; };

        var container = document.createElement('div');
        container.id = id('ProgressContainer');
        container.className = 'progressbar';
        container.style.display = 'block';
        container.dataset.pbOp = op;
        container.dataset.pbUid = uid;
        container.innerHTML =
            '<div class="progressbar-header">' +
                '<div class="progress-text" id="' + id('ProgressText') + '"></div>' +
                '<div class="progressbar-header-actions">' +
                    '<button type="button" class="progressbar-toggle" id="' + id('ProgressToggle') + '" aria-expanded="true" title="' +
                        tr('progress.collapse_list', 'Collapse file list').replace(/"/g, '&quot;') + '">' +
                        '<i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>' +
                    (options.onCancel
                        ? '<button type="button" class="progressbar-cancel" title="' +
                            tr('progress.cancel_operation', 'Cancel operation').replace(/"/g, '&quot;') + '">' +
                            '<i class="fa-solid fa-xmark" aria-hidden="true"></i></button>'
                        : '') +
                '</div>' +
            '</div>' +
            '<div class="progress-bar"><div class="progress-fill" id="' + id('ProgressBar') + '"></div></div>' +
            '<div id="' + id('FileList') + '" class="progressbar-list"></div>';

        var host = document.getElementById('progressbarFloatingHost');
        if (host) {
            host.insertBefore(container, host.firstChild);
        } else {
            document.body.appendChild(container);
        }

        var toggleBtn = container.querySelector('.progressbar-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var collapsed = container.classList.toggle('progressbar-collapsed');
                toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                toggleBtn.title = collapsed
                    ? tr('progress.expand_list', 'Expand file list')
                    : tr('progress.collapse_list', 'Collapse file list');
                var icon = toggleBtn.querySelector('i');
                if (icon) {
                    icon.className = collapsed
                        ? 'fa-solid fa-chevron-down'
                        : 'fa-solid fa-chevron-up';
                }
            });
            if (options.collapsed) {
                container.classList.add('progressbar-collapsed');
                toggleBtn.setAttribute('aria-expanded', 'false');
                toggleBtn.title = tr('progress.expand_list', 'Expand file list');
                var toggleIcon = toggleBtn.querySelector('i');
                if (toggleIcon) toggleIcon.className = 'fa-solid fa-chevron-down';
            }
        }

        var cancelBtn = container.querySelector('.progressbar-cancel');
        var onCancelFn = typeof options.onCancel === 'function' ? options.onCancel : null;
        if (cancelBtn && onCancelFn) {
            cancelBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (cancelBtn.disabled) return;
                if (onCancelFn) onCancelFn();
            });
        }

        function setControlsDisabled(disabled) {
            if (toggleBtn) toggleBtn.disabled = !!disabled;
            if (cancelBtn) cancelBtn.disabled = !!disabled;
        }

        _instances.push({ uid: uid, op: op, container: container });

        function appendListItemAt(index, name) {
            var listEl = document.getElementById(id('FileList'));
            if (!listEl) return;
            var row = document.createElement('div');
            row.className = 'progressbar-item';
            row.id = id('Item' + index);
            row.setAttribute('data-pb-index', String(index));
            row.innerHTML =
                '<div class="progressbar-name"></div>' +
                '<div class="progressbar-status" id="' + id('ItemStatus' + index) + '"></div>';
            row.querySelector('.progressbar-name').textContent = name;
            listEl.appendChild(row);
            setStatusElement(
                document.getElementById(id('ItemStatus' + index)),
                'waiting',
                tr(meta.waiting, 'Waiting...')
            );
            listBuiltCount = Math.max(listBuiltCount, index + 1);
        }

        function appendListBatch(fromIndex, batchNames) {
            for (var i = 0; i < batchNames.length; i++) {
                appendListItemAt(fromIndex + i, batchNames[i]);
            }
        }

        function ensureListItem(index) {
            if (index < listBuiltCount) return;
            var needed = index + 1;
            while (listBuiltCount < needed && pendingNames.length) {
                var take = Math.min(LIST_BATCH_SIZE, pendingNames.length, needed - listBuiltCount);
                var batch = pendingNames.splice(0, take);
                appendListBatch(listBuiltCount, batch);
            }
        }

        function drainPendingListAsync() {
            if (!pendingNames.length) return;
            window.setTimeout(function () {
                if (!pendingNames.length) return;
                var batch = pendingNames.splice(0, LIST_BATCH_SIZE);
                appendListBatch(listBuiltCount, batch);
                drainPendingListAsync();
            }, 0);
        }

        function setItemStatusLocal(index, kind, errorText) {
            ensureListItem(index);
            var aria = null;
            if (kind === 'waiting') aria = tr(meta.waiting, 'Waiting...');
            else if (kind === 'active') aria = tr(meta.active, '...');
            else if (kind === 'success') aria = tr(meta.done, 'Done');
            else if (kind === 'error' && !errorText) aria = tr(meta.error, 'Error');
            setStatusElement(document.getElementById(id('ItemStatus' + index)), kind, aria, errorText);
        }

        function updateBarLocal(current, total, opts) {
            opts = opts || {};
            var bar = document.getElementById(id('ProgressBar'));
            if (!bar) return;
            var pct;
            if (opts.totalPending && !total) {
                pct = current > 0 ? Math.min(95, Math.max(5, current)) : 0;
            } else {
                pct = total > 0 ? Math.round((current / total) * 100) : 0;
            }
            bar.style.width = pct + '%';
            bar.style.background = '';
        }

        var textEl = document.getElementById(id('ProgressText'));
        if (textEl) {
            textEl.textContent = options.initialText || tr(meta.inProgress, '...');
        }

        var list = document.getElementById(id('FileList'));
        initialNames.forEach(function (name, index) {
            appendListItemAt(index, name);
        });
        if (pendingNames.length) {
            drainPendingListAsync();
        }

        updateBarLocal(0, names.length || 0, {});

        var handle = {
            uid: uid,
            op: op,
            setTitle: function (text) {
                var el = document.getElementById(id('ProgressText'));
                if (el) el.textContent = text;
            },
            setCounting: function () {
                if (meta.counting) handle.setTitle(tr(meta.counting, '...'));
            },
            setProgress: function (current, total, opts) {
                opts = opts || {};
                var textNode = document.getElementById(id('ProgressText'));
                if (textNode) {
                    textNode.textContent = formatProgressText(op, current, total, opts);
                }
                updateBarLocal(current, total, opts);
            },
            setItemStatus: function (index, kind, errorText) {
                ensureListItem(index);
                setItemStatusLocal(index, kind, errorText);
            },
            scrollItemIntoView: function (index) {
                ensureListItem(index);
                scrollListItemIntoView(
                    document.getElementById(id('FileList')),
                    document.getElementById(id('Item' + index))
                );
            },
            setCancelling: function (cancelling) {
                setControlsDisabled(!!cancelling);
            },
            setOnCancel: function (fn) {
                onCancelFn = typeof fn === 'function' ? fn : null;
            },
            finish: function (opts) {
                opts = opts || {};
                setControlsDisabled(true);
                if (opts.message) handle.setTitle(opts.message);
                if (opts.current != null) {
                    updateBarLocal(
                        opts.current,
                        opts.total != null ? opts.total : opts.current,
                        {}
                    );
                } else {
                    var bar = document.getElementById(id('ProgressBar'));
                    if (bar) bar.style.width = '100%';
                }
                if (opts.errorBar) {
                    var errBar = document.getElementById(id('ProgressBar'));
                    if (errBar) errBar.style.background = 'var(--error)';
                }
                var delay = opts.delay != null ? opts.delay : (opts.error ? 5000 : 1000);
                window.setTimeout(function () {
                    hideInstance(uid);
                    if (typeof opts.onAfter === 'function') opts.onAfter();
                }, delay);
            },
            hide: function () {
                hideInstance(uid);
            }
        };

        return handle;
    }

    function handleTransferStreamEvent(pb, event, state) {
        if (!event || !event.type) return state;

        if (event.type === 'counting') {
            pb.setCounting();
            return state;
        }

        if (event.type === 'start') {
            state.total = event.total || 0;
            state.totalPending = !!event.total_pending;
            pb.setProgress(0, state.total, { totalPending: state.totalPending });
            return state;
        }

        if (event.type === 'total') {
            state.total = event.total || 0;
            state.totalPending = false;
            pb.setProgress(state.current || 0, state.total, {});
            return state;
        }

        if (event.type === 'item_start') {
            pb.setItemStatus(event.index, 'active');
            pb.scrollItemIntoView(event.index);
            return state;
        }

        if (event.type === 'progress') {
            state.current = event.current || 0;
            if (event.total != null && !event.total_pending) state.total = event.total;
            if (event.total_pending) state.totalPending = true;
            else if (event.total != null) state.totalPending = false;
            pb.setProgress(state.current, state.total, { totalPending: !!state.totalPending });
            return state;
        }

        if (event.type === 'item_done') {
            pb.setItemStatus(event.index, event.success ? 'success' : 'error');
            pb.scrollItemIntoView(event.index);
            return state;
        }

        if (event.type === 'done') {
            state.done = event;
            if (event.total != null) state.total = event.total;
            state.totalPending = false;
            state.current = event.copied != null
                ? event.copied
                : (event.moved != null
                    ? event.moved
                    : (event.deleted != null
                        ? event.deleted
                        : (event.applied != null
                            ? event.applied
                            : (event.uploaded != null ? event.uploaded : state.current))));
            pb.setProgress(state.current, state.total, { complete: true });
            return state;
        }

        if (event.type === 'error') {
            throw new Error(event.error || tr('notification.error', 'Error'));
        }

        return state;
    }

    window.ProgressBars = {
        create: create,
        hide: hide,
        hideAll: hideAll,
        hideAllExcept: hideAllExcept,
        hideLocal: hideLocal,
        handleTransferStreamEvent: handleTransferStreamEvent
    };
})();
