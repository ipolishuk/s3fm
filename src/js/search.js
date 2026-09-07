/**
 * Поиск по файлам в выбранном бакете (поле #searchInput).
 * Загружается после основного inline-скрипта index.html — использует глобальные
 * currentBucket, currentPath, selectionMode, loadFiles, formatDate, … и window.I18N.
 */
(function () {
    'use strict';

    if (!window.fileSearch) {
        window.fileSearch = { mode: false, query: '', timeout: null };
    }

    function I18N() {
        return window.I18N || {};
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

    function highlightSearchMatch(text, query) {
        if (!query) {
            return escapeHtml(text);
        }
        var str = String(text);
        var lowerText = str.toLowerCase();
        var lowerQuery = String(query).toLowerCase();
        if (!lowerQuery || lowerText.indexOf(lowerQuery) === -1) {
            return escapeHtml(str);
        }
        var result = '';
        var i = 0;
        while (i < str.length) {
            var matchIdx = lowerText.indexOf(lowerQuery, i);
            if (matchIdx === -1) {
                result += escapeHtml(str.slice(i));
                break;
            }
            result += escapeHtml(str.slice(i, matchIdx));
            result +=
                '<span class="search-highlight">' +
                escapeHtml(str.slice(matchIdx, matchIdx + lowerQuery.length)) +
                '</span>';
            i = matchIdx + lowerQuery.length;
        }
        return result;
    }

    function handleSearchInput() {
        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        if (!searchInput || !clearSearchBtn) return;
        var query = searchInput.value.trim();

        if (query.length > 0) {
            clearSearchBtn.style.display = 'flex';
        } else {
            clearSearchBtn.style.display = 'none';
            if (window.fileSearch.mode) {
                exitSearchMode();
            }
        }
    }

    function clearSearchNow() {
        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        if (!searchInput || !clearSearchBtn) return;

        searchInput.value = '';
        clearSearchBtn.style.display = 'none';

        if (window.fileSearch.timeout) {
            clearTimeout(window.fileSearch.timeout);
            window.fileSearch.timeout = null;
        }

        searchInput.focus();
        exitSearchMode();
    }

    function updateSearchBreadcrumb(query, totalItems) {
        var breadcrumb = document.getElementById('breadcrumb');
        if (!breadcrumb) return;
        var tr = I18N();

        breadcrumb.innerHTML = '';

        if (window.fileSearch.mode) {
            breadcrumb.innerHTML =
                '<div class="search-results-header">' +
                '<i class="fa-solid fa-magnifying-glass"></i>' +
                '<span>' + (tr['search.results_for'] || '') + ' </span>' +
                '<span class="search-results-value">' + String(query).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' +
                '<span> | </span>' +
                '<span>' + (tr['search.found'] || '') + '</span>' +
                '<span class="search-results-value">' + totalItems + '</span>' +
                '</div>';
            breadcrumb.style.display = 'flex';
        }
    }

    function handleSearchKeyup(event) {
        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        if (!searchInput || !clearSearchBtn) return;
        var query = searchInput.value.trim();

        if (query.length > 0) {
            clearSearchBtn.style.display = 'flex';
        } else {
            clearSearchBtn.style.display = 'none';
            if (window.fileSearch.mode) {
                exitSearchMode();
            }
            return;
        }

        if (window.fileSearch.timeout) {
            clearTimeout(window.fileSearch.timeout);
        }

        if (event.key === 'Escape') {
            clearSearch();
            return;
        }

        if (event.key === 'Enter') {
            performSearch(query);
            return;
        }

        if ((event.key === 'Backspace' || event.key === 'Delete') && query === '') {
            if (window.fileSearch.mode) {
                exitSearchMode();
            }
            return;
        }

        window.fileSearch.timeout = setTimeout(function () {
            var currentQuery = document.getElementById('searchInput').value.trim();
            if (currentQuery === '') {
                if (window.fileSearch.mode) {
                    exitSearchMode();
                }
            } else {
                performSearch(currentQuery);
            }
        }, 500);
    }

    async function performSearch(query) {
        if (!(typeof window.__getCurrentBucket === 'function' ? window.__getCurrentBucket() : currentBucket) || !query) {
            return;
        }

        var currentInputValue = document.getElementById('searchInput').value.trim();
        if (currentInputValue !== query) {
            return;
        }

        try {
            window.fileSearch.query = query;
            window.fileSearch.mode = true;

            if (window.__paginationBridge && typeof window.__paginationBridge.setState === 'function') {
                window.__paginationBridge.setState({
                    nextContinuationToken: '',
                    isTruncated: false,
                    loadedItemsCount: 0
                });
            } else {
                nextContinuationToken = '';
                isTruncated = false;
                loadedItemsCount = 0;
            }
            window.loadedItemsCount = 0;

            var tr = I18N();
            var fileList = document.getElementById('fileList');
            fileList.innerHTML =
                '<div class="empty-state">' +
                '<i class="fa-solid fa-spinner fa-spin empty-state-icon"></i>' +
                '<div>' + (tr['files.searching'] || '').replace('{query}', String(query).replace(/</g, '&lt;')) + '</div>' +
                '</div>';

            document.getElementById('filesHeader').style.display = 'none';
            if (typeof window.updateFilesPaginationUI === 'function') {
                window.updateFilesPaginationUI();
            }

            document.getElementById('breadcrumb').innerHTML = '';
            document.getElementById('breadcrumb').style.display = 'none';

            var response = await fetch('/api/search?bucket=' + encodeURIComponent((typeof window.__getCurrentBucket === 'function' ? window.__getCurrentBucket() : currentBucket) || '') + '&q=' + encodeURIComponent(query), {
                credentials: 'include'
            });

            var checkInputValue = document.getElementById('searchInput').value.trim();
            if (checkInputValue !== query) {
                return;
            }

            if (response.status === 401) {
                window.location.href = '/login';
                return;
            }

            var data = await response.json();

            if (response.ok) {
                var finalInputValue = document.getElementById('searchInput').value.trim();
                if (finalInputValue !== query) {
                    return;
                }

                if (window.__paginationBridge && typeof window.__paginationBridge.setState === 'function') {
                    window.__paginationBridge.setState({ loadedItemsCount: data.total_folders + data.total_files });
                } else {
                    loadedItemsCount = data.total_folders + data.total_files;
                }
                window.loadedItemsCount = data.total_folders + data.total_files;

                displaySearchResults(data);

                if (typeof window.updateFilesPaginationUI === 'function') {
                    window.updateFilesPaginationUI();
                }
            } else {
                window.showError((tr['msg.search_failed'] || '') + ': ' + (data.error || tr['msg.unknown_error'] || ''));
                exitSearchMode();
            }
        } catch (error) {
            window.showError((I18N()['msg.search_failed'] || '') + ': ' + error.message);
            exitSearchMode();
        }
    }

    function escapePathForDataAttr(path) {
        return String(path || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    function goToFolderFromSearch(folderPath, targetItemPath) {
        if (window.event) {
            window.event.stopPropagation();
        }

        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        searchInput.value = '';
        clearSearchBtn.style.display = 'none';

        if (window.fileSearch.timeout) {
            clearTimeout(window.fileSearch.timeout);
            window.fileSearch.timeout = null;
        }

        window.fileSearch.mode = false;
        window.fileSearch.query = '';

        if ((window.selectionMode || (typeof window.__getSelectionMode === 'function' && window.__getSelectionMode()))
            && typeof window.toggleSelectionMode === 'function') {
            if (typeof window.__setSelectionMode === 'function') window.__setSelectionMode(true);
            else window.selectionMode = true;
            window.toggleSelectionMode();
        }

        var breadcrumb = document.getElementById('breadcrumb');
        if (breadcrumb) {
            breadcrumb.innerHTML = '';
            breadcrumb.style.display = 'none';
        }

        window.pendingFileListReveal = targetItemPath ? targetItemPath : null;
        window.loadFiles(folderPath);
        var bucketId = typeof window.__getCurrentBucket === 'function' ? window.__getCurrentBucket() : currentBucket;
        window.updateURL(bucketId, folderPath);
    }

    function displaySearchResults(data) {
        var fileList = document.getElementById('fileList');
        var totalItems = data.total_folders + data.total_files;
        var tr = I18N();

        if (totalItems === 0) {
            fileList.innerHTML =
                '<div class="empty-state">' +
                '<i class="fa-solid fa-magnifying-glass empty-state-icon"></i>' +
                '<div>' + (tr['files.no_search_results'] || '').replace('{query}', String(data.query || '').replace(/</g, '&lt;')) + '</div>' +
                '</div>';

            document.getElementById('filesHeader').style.display = 'none';

            setTimeout(function () {
                updateSearchBreadcrumb(data.query, 0);
            }, 10);

            return;
        }

        fileList.innerHTML = '';

        var searchQuery = data.query || window.fileSearch.query || '';
        var fragment = document.createDocumentFragment();

        data.folders.forEach(function (folder) {
            var folderDiv = document.createElement('div');
            folderDiv.className = 'folder-item folder-item-search-result';
            folderDiv.dataset.path = folder.path || '';
            var attrPath = escapePathForDataAttr(folder.path);
            var highlightedName = highlightSearchMatch(folder.name, searchQuery);
            var modifiedDate = folder.last_modified ? window.formatDate(folder.last_modified) : '—';
            var folderSize = folder.size > 0 ? formatFileSize(folder.size) : '—';

            var fullPath = folder.path;
            var pathParts = fullPath.split('/').filter(function (p) { return p && p !== ''; });
            var isInRootBucket = pathParts.length === 1;
            var parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') + '/' : '';
            var enterFolderPath = fullPath;

            var folderId = 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            var canSelectFolder = typeof window.canSelectFoldersInSelectionMode === 'function'
                ? window.canSelectFoldersInSelectionMode()
                : false;

            var folderInfoInner =
                selectionMode
                    ? '<label class="lables" style="display: flex; align-items: center; gap: 8px; flex: 1;">' +
                      '<input type="checkbox" class="checkbox list-checkbox" id="' +
                      folderId +
                      '" data-path="' +
                      attrPath +
                      '" data-type="folder" ' +
                      (!canSelectFolder
                          ? 'disabled title="' +
                            (tr['files.select_folders_requires_permissions'] || '').replace(/"/g, '&quot;') +
                            '"'
                          : '') +
                      ' style="margin: 0;">' +
                      '<i class="fa-solid fa-folder folder-icon"></i>' +
                      '<div style="flex: 1; min-width: 0;">' +
                      '<div class="search-result-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
                      highlightedName +
                      '</div>' +
                      '<div style="font-size: 11px; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 2px;">' +
                      '<i class="fa-solid fa-folder folder-icon"></i> ' +
                      (isInRootBucket ? '..' : parentPath) +
                      '</div></div></label>'
                    : '<i class="fa-solid fa-folder folder-icon"></i>' +
                      '<div style="flex: 1; min-width: 0;">' +
                      '<div class="search-result-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
                      highlightedName +
                      '</div>' +
                      '<div style="font-size: 11px; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 2px;">' +
                      '<i class="fa-solid fa-folder folder-icon"></i> ' +
                      (isInRootBucket ? '..' : parentPath) +
                      '</div></div>';

            folderDiv.onclick = function (e) {
                if (selectionMode || e.target.closest('.list-checkbox, label')) {
                    return;
                }
                goToFolderFromSearch(enterFolderPath, '');
            };

            folderDiv.innerHTML =
                '<div class="folder-info">' +
                folderInfoInner +
                '</div>' +
                '<div class="file-size">' + folderSize + '</div>' +
                '<div class="folder-modified">' + modifiedDate + '</div>';

            fragment.appendChild(folderDiv);
        });

        data.files.forEach(function (file) {
            var fileDiv = document.createElement('div');
            fileDiv.className = 'file-item';
            fileDiv.dataset.path = file.path || '';
            fileDiv.dataset.size = file.size != null ? String(file.size) : '';
            fileDiv.dataset.lastModified = file.last_modified || '';
            var attrPath = escapePathForDataAttr(file.path);
            var highlightedName = highlightSearchMatch(file.name, searchQuery);
            var modifiedDate = file.last_modified ? window.formatDate(file.last_modified) : '—';

            var fullPath = file.path;
            var pathParts = fullPath.split('/').filter(function (p) { return p && p !== ''; });
            var isInRootBucket = pathParts.length === 1;
            var folderPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') + '/' : '';

            var fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            var canSelect = typeof window.canSelectFilesInSelectionMode === 'function'
                && window.canSelectFilesInSelectionMode();

            fileDiv.onclick = function (e) {
                if (selectionMode || e.target.closest('.list-checkbox, label')) {
                    return;
                }
                // Same as former folder-open: open parent folder and reveal this file
                goToFolderFromSearch(folderPath, file.path);
            };

            fileDiv.innerHTML =
                '<div class="file-info">' +
                (selectionMode
                    ? '<label class="lables" style="display: flex; align-items: center; gap: 8px; flex: 1;">' +
                      '<input type="checkbox" class="checkbox list-checkbox" id="' +
                      fileId +
                      '" data-path="' +
                      attrPath +
                      '" data-type="file" ' +
                      (!canSelect
                          ? 'disabled title="' +
                            (tr['files.select_files_requires_permissions'] || 'Selection requires permissions').replace(/"/g, '&quot;') +
                            '"'
                          : '') +
                      ' style="margin: 0;">' +
                      '<i class="fa-solid fa-file file-icon"></i>' +
                      '<div style="flex: 1; min-width: 0;">' +
                      '<div class="search-result-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
                      highlightedName +
                      '</div>' +
                      '<div style="font-size: 11px; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 2px;">' +
                      '<i class="fa-solid fa-folder folder-icon"></i> ' +
                      (isInRootBucket ? '..' : folderPath) +
                      '</div></div></label>'
                    : '<i class="fa-solid fa-file file-icon"></i>' +
                      '<div style="flex: 1; min-width: 0;">' +
                      '<div class="search-result-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
                      highlightedName +
                      '</div>' +
                      '<div style="font-size: 11px; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 2px;">' +
                      '<i class="fa-solid fa-folder folder-icon"></i> ' +
                      (isInRootBucket ? '..' : folderPath) +
                      '</div></div>') +
                '</div>' +
                '<div class="file-size">' +
                formatFileSize(file.size) +
                '</div>' +
                '<div class="file-modified">' +
                modifiedDate +
                '</div>';

            fragment.appendChild(fileDiv);
        });

        fileList.appendChild(fragment);

        document.getElementById('filesHeader').style.display = 'grid';

        window.updateSelectAllContainer();

        if ((window.selectionMode || (typeof window.__getSelectionMode === 'function' && window.__getSelectionMode()))
            && typeof window.updateItemsForSelectionMode === 'function') {
            window.updateItemsForSelectionMode();
        }

        setTimeout(function () {
            updateSearchBreadcrumb(data.query, totalItems);
        }, 10);
    }

    function clearSearch() {
        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        if (!searchInput || !clearSearchBtn) return;

        searchInput.value = '';
        clearSearchBtn.style.display = 'none';

        if (window.fileSearch.timeout) {
            clearTimeout(window.fileSearch.timeout);
            window.fileSearch.timeout = null;
        }

        searchInput.focus();
        exitSearchMode();
    }

    function exitSearchMode() {
        if (window.fileSearch.timeout) {
            clearTimeout(window.fileSearch.timeout);
            window.fileSearch.timeout = null;
        }

        window.fileSearch.mode = false;
        window.fileSearch.query = '';
        window.pendingFileListReveal = null;

        var searchInput = document.getElementById('searchInput');
        var clearSearchBtn = document.getElementById('clearSearchBtn');
        if (searchInput && clearSearchBtn) {
            searchInput.value = '';
            clearSearchBtn.style.display = 'none';
        }

        if (window.selectionMode || (typeof window.__getSelectionMode === 'function' && window.__getSelectionMode())) {
            if (typeof window.toggleSelectionMode === 'function') {
                if (typeof window.__setSelectionMode === 'function') window.__setSelectionMode(true);
                else window.selectionMode = true;
                window.toggleSelectionMode();
            } else {
                if (typeof window.__setSelectionMode === 'function') window.__setSelectionMode(false);
                else { selectionMode = false; window.selectionMode = false; }
                document.body.classList.remove('selection-mode');
                window.clearSelectionWithoutBlocking();
                window.blockActionButtons(false);
                window.updateItemsForNormalMode();
                if (typeof window.setupUserPermissions === 'function') {
                    window.setupUserPermissions();
                }
            }
        }

        document.getElementById('breadcrumb').innerHTML = '';
        document.getElementById('breadcrumb').style.display = 'none';

        var _bucket = typeof window.__getCurrentBucket === 'function' ? window.__getCurrentBucket() : currentBucket;
        var _path = typeof window.__getCurrentPath === 'function' ? window.__getCurrentPath() : currentPath;
        if (_bucket && _path !== undefined) {
            window.loadFiles(_path);
        }
    }

    window.handleSearchInput = handleSearchInput;
    window.handleSearchKeyup = handleSearchKeyup;
    window.clearSearchNow = clearSearchNow;
    window.performSearch = performSearch;
    window.exitSearchMode = exitSearchMode;
    window.clearSearch = clearSearch;
    window.updateSearchBreadcrumb = updateSearchBreadcrumb;
    window.goToFolderFromSearch = goToFolderFromSearch;
})();
