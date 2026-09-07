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
        };
        return _handles[jobId];
    }

    function cancelJob(jobId) {
        var handle = _handles[jobId];
        if (!handle || handle.finished || handle.cancelling) return;

        if (String(jobId).indexOf('_pending_') === 0) {
            handle.cancelRequested = true;
            handle.pb.setCancelling(true);
            return;
        }

        handle.cancelling = true;
        handle.pb.setCancelling(true);

        fetch('/files/operation-jobs/' + encodeURIComponent(jobId) + '/cancel', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
        }).then(function (response) {
            return response.json().then(function (data) {
                return { ok: response.ok, data: data };
            });
        }).then(function (res) {
            if (!res.ok) {
                handle.cancelling = false;
                handle.pb.setCancelling(false);
                if (typeof window.showError === 'function') {
                    window.showError(
                        (res.data && res.data.error) || tr('progress.cancel_not_available', 'Cannot cancel operation')
                    );
                }
            }
        }).catch(function () {
            handle.cancelling = false;
            handle.pb.setCancelling(false);
        });
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
        if (handle.finished) return;
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

        if (typeof EventSource === 'undefined') return;

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
            }
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
            })
            .catch(function () { /* ignore */ });
    }

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify(body || {}),
        }).then(function (response) {
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
        _handles[pendingId] = {
            jobId: pendingId,
            op: op,
            pb: pb,
            streamState: { current: 0, total: 0, done: null },
            finished: false,
            cancelRequested: false,
            cancelling: false,
        };
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
        delete _handles[pendingId];
        pending.pb.setOnCancel(function () { cancelJob(jobId); });
        if (pending.cancelRequested) {
            cancelJob(jobId);
        }
    }

    function startPendingJob(op, url, errorKey, body, displayNames) {
        var names = resolveDisplayNames(body, displayNames);
        body.display_names = names;

        var pendingId = '_pending_' + op + '_' + Date.now();
        var pb = createPendingHandle(op, pendingId, names);

        return postJson(url, body).then(function (res) {
            if (res.response.status === 401) {
                dropPendingHandle(pendingId);
                pb.hide();
                window.location.href = '/login';
                return;
            }
            if (!res.response.ok) {
                dropPendingHandle(pendingId);
                pb.finish({ error: true, errorBar: true });
                throw new Error((res.data && res.data.error) || tr(errorKey, 'Operation failed'));
            }
            var jobId = res.data.job_id;
            migratePending(pendingId, jobId);
            subscribe(jobId, op, names, false);
            return res.data;
        }).catch(function (err) {
            dropPendingHandle(pendingId);
            if (pb) {
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

        var createRes;
        try {
            createRes = await postJson('/files/upload-jobs', {
                bucket: bucket,
                path: basePath,
                folder_upload: folderMode,
                display_names: labels,
                total: fileDescriptors.length,
            });
        } catch (err) {
            dropPendingHandle(pendingId);
            pb.finish({ error: true, errorBar: true });
            throw err;
        }

        if (createRes.response.status === 401) {
            dropPendingHandle(pendingId);
            pb.hide();
            window.location.href = '/login';
            return;
        }
        if (!createRes.response.ok) {
            dropPendingHandle(pendingId);
            pb.finish({ error: true, errorBar: true });
            throw new Error((createRes.data && createRes.data.error) || tr('msg.upload_failed', 'Upload failed'));
        }

        var jobId = createRes.data.job_id;
        migratePending(pendingId, jobId);
        subscribe(jobId, 'upload', labels, false);

        for (var i = 0; i < fileDescriptors.length; i++) {
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

        await fetch('/files/upload-jobs/' + encodeURIComponent(jobId) + '/seal', {
            method: 'POST',
            credentials: 'include',
        });
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
