/**
 * Фоновые задачи upload/delete/copy/move/acl: job_id + SSE, reconnect после refresh.
 */
(function () {
    'use strict';

    var PB = window.ProgressBars;
    var I18N = window.I18N || {};
    var _streams = Object.create(null);
    var _handles = Object.create(null);
    var _SEEN_KEY = 's3fmOperationJobsSeen';
    var _reconcileTimer = null;
    var RECONCILE_MS = 5000;

    function tr(key, fallback) {
        return I18N[key] || fallback || key;
    }

    function markSeen(jobId) {
        if (!jobId) return;
        try {
            var seen = JSON.parse(sessionStorage.getItem(_SEEN_KEY) || '[]');
            if (seen.indexOf(jobId) === -1) seen.push(jobId);
            sessionStorage.setItem(_SEEN_KEY, JSON.stringify(seen.slice(-100)));
        } catch (e) { /* ignore */ }
    }

    function isSeen(jobId) {
        try {
            var seen = JSON.parse(sessionStorage.getItem(_SEEN_KEY) || '[]');
            return seen.indexOf(jobId) !== -1;
        } catch (e) {
            return false;
        }
    }

    function closeStream(jobId) {
        if (_streams[jobId]) {
            _streams[jobId].close();
            delete _streams[jobId];
        }
    }

    function hasOpenHandles() {
        var keys = Object.keys(_handles);
        for (var i = 0; i < keys.length; i++) {
            if (_handles[keys[i]] && !_handles[keys[i]].finished) return true;
        }
        return false;
    }

    function scheduleReconcile() {
        if (_reconcileTimer) return;
        _reconcileTimer = window.setInterval(function () {
            if (!hasOpenHandles()) {
                window.clearInterval(_reconcileTimer);
                _reconcileTimer = null;
                return;
            }
            reconcileStaleHandles();
        }, RECONCILE_MS);
    }

    function ensureHandle(jobId, op, displayNames) {
        if (_handles[jobId]) return _handles[jobId];
        var pb = PB.create(op, displayNames || [], {
            instanceId: jobId,
            collapsed: true,
            onCancel: function () { cancelJob(jobId); },
        });
        _handles[jobId] = {
            jobId: jobId,
            op: op,
            pb: pb,
            streamState: { current: 0, total: 0, done: null },
            finished: false,
            cancelRequested: false,
            cancelling: false,
            abortController: null,
        };
        scheduleReconcile();
        return _handles[jobId];
    }

    function postCancel(jobId) {
        return fetch('/files/operation-jobs/' + encodeURIComponent(jobId) + '/cancel', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
        }).then(function (response) {
            return response.json().then(function (data) {
                return { ok: response.ok, data: data };
            });
        });
    }

    function cancelJob(jobId) {
        var handle = _handles[jobId];
        if (!handle || handle.finished || handle.cancelling) return;

        // Сразу показываем «Отмена…» — не ждём ответ сервера / SSE
        handle.cancelling = true;
        handle.cancelRequested = true;
        handle.pb.setCancelling(true);

        if (String(jobId).indexOf('_pending_') === 0) {
            if (handle.abortController) {
                try { handle.abortController.abort(); } catch (e) { /* ignore */ }
            }
            // Сразу закрываем pending-тост — не ждём abort fetch
            finishHandle(handle, false, null, { cancelled: true });
            return;
        }

        postCancel(jobId).then(function (res) {
            if (handle.finished) return;
            if (!res.ok) {
                restoreAfterCancelFailed(handle);
                // Job мог уже завершиться (SSE terminal потерян) — не оставляем тост навсегда
                finishIfJobInactive(jobId, handle, res.data && res.data.error);
                return;
            }
            // Не ждём SSE: сервер принял отмену — сразу закрываем тост
            finishHandle(handle, false, null, { cancelled: true });
        }).catch(function () {
            if (handle.finished) return;
            restoreAfterCancelFailed(handle);
            finishIfJobInactive(jobId, handle, null);
        });
    }

    function restoreAfterCancelFailed(handle) {
        if (!handle || handle.finished) return;
        handle.cancelling = false;
        handle.cancelRequested = false;
        handle.pb.setCancelling(false);
        var st = handle.streamState || {};
        handle.pb.setProgress(st.current || 0, st.total || 0, {
            totalPending: !!st.totalPending,
        });
    }

    function finishIfJobInactive(jobId, handle, cancelError) {
        if (!handle || handle.finished) return;
        fetch('/files/operation-jobs/active', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (handle.finished) return;
                var items = data.items || [];
                var stillActive = items.some(function (item) { return item.job_id === jobId; });
                if (!stillActive) {
                    finishHandle(handle, false, null, { cancelled: true });
                    return;
                }
                if (cancelError && typeof window.showError === 'function') {
                    window.showError(cancelError || tr('progress.cancel_not_available', 'Cannot cancel operation'));
                }
            })
            .catch(function () {
                if (handle.finished) return;
                if (cancelError && typeof window.showError === 'function') {
                    window.showError(cancelError || tr('progress.cancel_not_available', 'Cannot cancel operation'));
                }
            });
    }

    // pending дольше этого — worker не забрал job (тост иначе висит вечно)
    var PENDING_STUCK_MS = 10 * 60 * 1000;

    function reconcileStaleHandles() {
        fetch('/files/operation-jobs/active', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var active = Object.create(null);
                (data.items || []).forEach(function (item) {
                    if (item.job_id) active[item.job_id] = item;
                });
                Object.keys(_handles).forEach(function (jobId) {
                    var handle = _handles[jobId];
                    if (!handle || handle.finished) return;
                    if (String(jobId).indexOf('_pending_') === 0) return;
                    var item = active[jobId];
                    if (!item) {
                        // Сервер уже не считает job активным, а тост ещё открыт
                        finishHandle(handle, false, null, null);
                        return;
                    }
                    // Зависший pending: worker не claim'ит (нет процесса / очередь)
                    if (item.status === 'pending' && item.created_at) {
                        var createdMs = Number(item.created_at) * 1000;
                        if (createdMs > 0 && (Date.now() - createdMs) >= PENDING_STUCK_MS) {
                            finishHandle(
                                handle,
                                true,
                                tr('progress.worker_unavailable', 'Background worker is not processing jobs'),
                            );
                        }
                    }
                });
            })
            .catch(function () { /* ignore */ });
    }

    function replayHistory(handle, history) {
        if (!history || !history.length) return;
        history.forEach(function (event) {
            if (event.type === 'snapshot' || event.type === 'ping') return;
            applyEvent(handle, event);
        });
    }

    function applyEvent(handle, event) {
        if (!event || !event.type) return;
        if (event.type === 'snapshot') {
            replayHistory(handle, event.history || []);
            return;
        }
        if (event.type === 'ping') return;

        try {
            handle.streamState = PB.handleTransferStreamEvent(handle.pb, event, handle.streamState);
        } catch (err) {
            finishHandle(handle, true, err.message);
            return;
        }

        if (event.type === 'done') {
            finishHandle(handle, false, null, event);
        } else if (event.type === 'cancelled') {
            finishHandle(handle, false, null, { cancelled: true });
        } else if (event.type === 'error') {
            finishHandle(handle, true, event.error || tr('notification.error', 'Error'));
        }
    }

    function finishHandle(handle, isError, errorMessage, doneEvent) {
        if (!handle || handle.finished) return;
        handle.finished = true;
        markSeen(handle.jobId);
        closeStream(handle.jobId);

        var op = handle.op;
        var onAfter = function () {
            if (op === 'upload' && typeof window.__transferUploadOnSuccess === 'function') {
                window.__transferUploadOnSuccess();
            } else if (op === 'acl' || op === 'delete' || op === 'copy' || op === 'move') {
                if (typeof window.resetSelectionAfterMultiFileAction === 'function') {
                    window.resetSelectionAfterMultiFileAction();
                } else {
                    if (typeof window.clearSelectionWithoutBlocking === 'function') {
                        window.clearSelectionWithoutBlocking();
                    }
                    if (window.fileSearch && window.fileSearch.mode && typeof window.performSearch === 'function') {
                        window.performSearch(window.fileSearch.query);
                    } else if (typeof window.loadFiles === 'function') {
                        var path = typeof window.__getCurrentPath === 'function'
                            ? window.__getCurrentPath()
                            : (window.currentPath || '');
                        window.loadFiles(path || '');
                    }
                    if (window.selectionMode && typeof window.toggleSelectionMode === 'function') {
                        window.toggleSelectionMode();
                    }
                }
            }
            delete _handles[handle.jobId];
        };

        if (doneEvent && doneEvent.cancelled) {
            handle.pb.setTitle(tr('progress.cancelled', 'Cancelled'));
            handle.pb.finish({ onAfter: onAfter, delay: 1500 });
            return;
        }

        if (isError) {
            if (typeof window.showError === 'function') {
                window.showError(String(errorMessage || tr('notification.error', 'Error')));
            }
            handle.pb.finish({ error: true, errorBar: true, onAfter: onAfter });
            return;
        }

        if (op === 'acl' && doneEvent) {
            var applied = doneEvent.applied || 0;
            var errCount = (doneEvent.errors || []).length;
            if (applied > 0 && errCount > 0 && typeof window.showError === 'function') {
                var total = doneEvent.total || handle.streamState.total || applied;
                window.showError(
                    (tr('files.bulk_acl_saved_partial', 'ACL applied to {ok} of {total} files; {failed} failed') || '')
                        .replace('{ok}', String(applied))
                        .replace('{total}', String(total))
                        .replace('{failed}', String(errCount)) +
                        ((doneEvent.errors && doneEvent.errors[0]) ? ': ' + doneEvent.errors[0] : ''),
                );
            } else if (applied === 0 && errCount > 0 && typeof window.showError === 'function') {
                window.showError(doneEvent.errors.join('\n'));
            }
            handle.pb.finish({
                error: applied === 0 && errCount > 0,
                errorBar: applied === 0 && errCount > 0,
                onAfter: onAfter,
            });
            return;
        }

        if (doneEvent && doneEvent.errors && doneEvent.errors.length && typeof window.showError === 'function') {
            window.showError(doneEvent.errors.join('\n'));
        }

        handle.pb.finish({ onAfter: onAfter });
    }

    function subscribe(jobId, op, displayNames, reconnect) {
        if (isSeen(jobId) && reconnect) return;
        if (_streams[jobId]) return;

        var handle = ensureHandle(jobId, op, displayNames);

        if (typeof EventSource === 'undefined') {
            finishHandle(handle, true, tr('notification.error', 'Error'));
            return;
        }

        var es = new EventSource('/files/operation-jobs/' + encodeURIComponent(jobId) + '/events');
        _streams[jobId] = es;

        es.onmessage = function (msg) {
            var event;
            try {
                event = JSON.parse(msg.data);
            } catch (e) {
                return;
            }
            applyEvent(handle, event);
        };

        es.onerror = function () {
            if (handle.finished) {
                closeStream(jobId);
                return;
            }
            // EventSource сам переподключается; если job уже не active — закрываем тост
            fetch('/files/operation-jobs/active', { credentials: 'include' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (handle.finished) {
                        closeStream(jobId);
                        return;
                    }
                    var items = data.items || [];
                    var stillActive = items.some(function (item) { return item.job_id === jobId; });
                    if (!stillActive) {
                        finishHandle(handle, true, tr('notification.error', 'Error'));
                    }
                })
                .catch(function () { /* ignore */ });
        };
    }

    function resumeActive() {
        fetch('/files/operation-jobs/active', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                (data.items || []).forEach(function (item) {
                    if (!item.job_id || isSeen(item.job_id)) return;
                    subscribe(item.job_id, item.op, item.display_names || [], true);
                });
                if (hasOpenHandles()) scheduleReconcile();
            })
            .catch(function () { /* ignore */ });
    }

    function postJson(url, body, signal) {
        var opts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify(body || {}),
        };
        if (signal) opts.signal = signal;
        return fetch(url, opts).then(function (response) {
            return response.json().then(function (data) {
                return { response: response, data: data };
            });
        });
    }

    function resolveDisplayNames(body, displayNames) {
        var names = displayNames;
        if (!names || !names.length) {
            names = (body && body.display_names) || [];
        }
        return Array.isArray(names) ? names : [];
    }

    function createPendingProgress(op, pendingId, names) {
        return PB.create(op, names, {
            instanceId: pendingId,
            initialText: tr('progress.preparing', 'Preparing…'),
            collapsed: true,
            onCancel: function () { cancelJob(pendingId); },
        });
    }

    function createPendingHandle(op, pendingId, names) {
        var pb = createPendingProgress(op, pendingId, names);
        var abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        _handles[pendingId] = {
            jobId: pendingId,
            op: op,
            pb: pb,
            streamState: { current: 0, total: 0, done: null },
            finished: false,
            cancelRequested: false,
            cancelling: false,
            abortController: abortController,
        };
        scheduleReconcile();
        return pb;
    }

    function dropPendingHandle(pendingId) {
        var pending = _handles[pendingId];
        if (pending) {
            pending.finished = true;
            delete _handles[pendingId];
        }
    }

    function migratePending(pendingId, jobId) {
        var pending = _handles[pendingId];
        if (!pending) return;
        _handles[jobId] = pending;
        _handles[jobId].jobId = jobId;
        _handles[jobId].abortController = null;
        delete _handles[pendingId];
        pending.pb.setOnCancel(function () { cancelJob(jobId); });
        if (pending.cancelRequested) {
            cancelJob(jobId);
        }
    }

    function finishPendingAsCancelled(pendingId, pb) {
        var handle = _handles[pendingId];
        if (handle && !handle.finished) {
            finishHandle(handle, false, null, { cancelled: true });
            return;
        }
        dropPendingHandle(pendingId);
        if (pb) {
            pb.setTitle(tr('progress.cancelled', 'Cancelled'));
            pb.finish({ delay: 1500 });
        }
    }

    function isAbortError(err) {
        return !!(err && (err.name === 'AbortError' || err.code === 20));
    }

    function clearSelectionOnBulkStart(op) {
        if (op !== 'acl' && op !== 'delete' && op !== 'copy' && op !== 'move') return;
        if (typeof window.clearSelectionOnBulkOpStart === 'function') {
            Promise.resolve(window.clearSelectionOnBulkOpStart()).catch(function () { /* ignore */ });
            return;
        }
        if (typeof window.clearSelectionWithoutBlocking === 'function') {
            window.clearSelectionWithoutBlocking();
        }
        if (window.selectionMode && typeof window.toggleSelectionMode === 'function') {
            Promise.resolve(window.toggleSelectionMode()).catch(function () { /* ignore */ });
        }
    }

    function startPendingJob(op, url, errorKey, body, displayNames) {
        var names = resolveDisplayNames(body, displayNames);
        body.display_names = names;

        var pendingId = '_pending_' + op + '_' + Date.now();
        var pb = createPendingHandle(op, pendingId, names);
        var pending = _handles[pendingId];
        var signal = pending && pending.abortController ? pending.abortController.signal : null;
        var jobId = null;

        return postJson(url, body, signal).then(function (res) {
            if (res.response.status === 401) {
                dropPendingHandle(pendingId);
                pb.hide();
                window.location.href = '/login';
                return;
            }
            if (!res.response.ok) {
                var handleErr = _handles[pendingId];
                if (handleErr && !handleErr.finished) {
                    finishHandle(handleErr, true, (res.data && res.data.error) || tr(errorKey, 'Operation failed'));
                } else {
                    dropPendingHandle(pendingId);
                    pb.finish({ error: true, errorBar: true });
                }
                throw new Error((res.data && res.data.error) || tr(errorKey, 'Operation failed'));
            }
            jobId = res.data.job_id;
            migratePending(pendingId, jobId);
            subscribe(jobId, op, names, false);
            // Select снимаем сразу при старте job, а не после тоста
            clearSelectionOnBulkStart(op);
            return res.data;
        }).catch(function (err) {
            if (isAbortError(err) || (_handles[pendingId] && _handles[pendingId].cancelRequested && !jobId)) {
                finishPendingAsCancelled(pendingId, pb);
                return;
            }
            var handle = _handles[pendingId] || (jobId && _handles[jobId]);
            if (handle && !handle.finished) {
                finishHandle(handle, true, err && err.message ? err.message : tr(errorKey, 'Operation failed'));
                return;
            }
            if (handle && handle.finished) {
                // Ошибка уже показана в then/finishHandle — не дублируем через caller
                return;
            }
            if (pb && !jobId) {
                dropPendingHandle(pendingId);
                pb.finish({ error: true, errorBar: true });
            }
            throw err;
        });
    }

    function startTransfer(op, url, errorKey, body, displayNames) {
        body = body || {};
        body.stream = true;
        return startPendingJob(op, url, errorKey, body, displayNames);
    }

    function startCopy(body, displayNames) {
        return startTransfer('copy', '/files/copy', 'copy.error', body, displayNames);
    }

    function startMove(body, displayNames) {
        return startTransfer('move', '/files/move', 'move.error', body, displayNames);
    }

    function startDelete(body, displayNames) {
        return startPendingJob('delete', '/files/delete-batch', 'delete.error', body, displayNames);
    }

    function startAcl(body, displayNames) {
        return startPendingJob('acl', '/api/files/metadata/acl-batch', 'notification.error', body, displayNames);
    }

    async function startUpload(fileDescriptors, options) {
        var folderMode = !!(options && options.folderMode);
        var bucket = typeof window.__getCurrentBucket === 'function'
            ? window.__getCurrentBucket()
            : (window.currentBucket || '');
        var basePath = folderMode && typeof window.getUploadBasePath === 'function'
            ? window.getUploadBasePath()
            : (typeof window.__getCurrentPath === 'function' ? window.__getCurrentPath() : (window.currentPath || ''));
        var labels = (fileDescriptors || []).map(function (d) { return d.label; });

        var pendingId = '_pending_upload_' + Date.now();
        var pb = createPendingHandle('upload', pendingId, labels);
        var pending = _handles[pendingId];
        var signal = pending && pending.abortController ? pending.abortController.signal : null;
        var jobId = null;

        try {
            var createRes = await postJson('/files/upload-jobs', {
                bucket: bucket,
                path: basePath,
                folder_upload: folderMode,
                display_names: labels,
                total: fileDescriptors.length,
            }, signal);

            if (createRes.response.status === 401) {
                dropPendingHandle(pendingId);
                pb.hide();
                window.location.href = '/login';
                return;
            }
            if (!createRes.response.ok) {
                var createHandle = _handles[pendingId];
                if (createHandle && !createHandle.finished) {
                    finishHandle(
                        createHandle,
                        true,
                        (createRes.data && createRes.data.error) || tr('msg.upload_failed', 'Upload failed')
                    );
                } else {
                    dropPendingHandle(pendingId);
                    pb.finish({ error: true, errorBar: true });
                }
                throw new Error((createRes.data && createRes.data.error) || tr('msg.upload_failed', 'Upload failed'));
            }

            jobId = createRes.data.job_id;
            migratePending(pendingId, jobId);
            subscribe(jobId, 'upload', labels, false);

            for (var i = 0; i < fileDescriptors.length; i++) {
                var handleLoop = _handles[jobId];
                if (handleLoop && (handleLoop.cancelRequested || handleLoop.cancelling || handleLoop.finished)) {
                    break;
                }
                var descriptor = fileDescriptors[i];
                var formData = new FormData();
                if (descriptor.formFilename) {
                    formData.append('file', descriptor.file, descriptor.formFilename);
                } else {
                    formData.append('file', descriptor.file);
                }
                formData.append('job_id', jobId);
                formData.append('file_index', String(i));

                var response = await fetch('/files/upload', {
                    method: 'POST',
                    credentials: 'include',
                    body: formData,
                });

                if (response.status === 401) {
                    var h401 = _handles[jobId];
                    if (h401 && !h401.finished) {
                        h401.finished = true;
                        closeStream(jobId);
                        h401.pb.hide();
                        delete _handles[jobId];
                    }
                    window.location.href = '/login';
                    return;
                }
                if (response.status === 413) {
                    throw new Error(tr('msg.upload_error_server', 'Upload failed'));
                }
                if (!response.ok && response.status !== 202) {
                    var errData = {};
                    try {
                        errData = await response.json();
                    } catch (e) { /* ignore */ }
                    throw new Error(errData.error || tr('msg.upload_failed', 'Upload failed'));
                }
            }

            var handleAfter = _handles[jobId];
            if (handleAfter && !handleAfter.finished && !handleAfter.cancelling && !handleAfter.cancelRequested) {
                await fetch('/files/upload-jobs/' + encodeURIComponent(jobId) + '/seal', {
                    method: 'POST',
                    credentials: 'include',
                });
            }
        } catch (err) {
            if (isAbortError(err) || (_handles[pendingId] && _handles[pendingId].cancelRequested && !jobId)) {
                finishPendingAsCancelled(pendingId, pb);
                return;
            }
            var handle = (jobId && _handles[jobId]) || _handles[pendingId];
            if (handle && !handle.finished) {
                if (jobId) {
                    postCancel(jobId).catch(function () { /* ignore */ });
                }
                finishHandle(handle, true, err && err.message ? err.message : tr('msg.upload_failed', 'Upload failed'));
                return;
            }
            if (handle && handle.finished) {
                return;
            }
            if (pb) {
                dropPendingHandle(pendingId);
                pb.finish({ error: true, errorBar: true });
            }
            throw err;
        }
    }

    function hasActive(op) {
        var keys = Object.keys(_handles);
        for (var i = 0; i < keys.length; i++) {
            var h = _handles[keys[i]];
            if (h && !h.finished && (!op || h.op === op)) return true;
        }
        return false;
    }

    window.OperationJobs = {
        startCopy: startCopy,
        startMove: startMove,
        startDelete: startDelete,
        startAcl: startAcl,
        startUpload: startUpload,
        resumeActive: resumeActive,
        hasActive: hasActive,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', resumeActive);
    } else {
        resumeActive();
    }
})();
