/**
 * Breadcrumb navigation for the files panel.
 * Depends on window: renderHomeBreadcrumb, clearSelection, exitSearchMode,
 * loadFiles, updateURL, toggleSelectionMode, getTabTitleBucketLabel.
 */
(function (global) {
    'use strict';

    function getBucket() {
        if (typeof global.__getCurrentBucket === 'function') return global.__getCurrentBucket() || '';
        return global.fileManagerCurrentBucketId || '';
    }

    function setPath(value) {
        if (typeof global.__setCurrentPath === 'function') global.__setCurrentPath(value || '');
    }

    function htmlEscapeBreadcrumb(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getBreadcrumbRootLabel() {
        var getTabTitleBucketLabel = global.getTabTitleBucketLabel;
        var bucket = getBucket();
        var label = typeof getTabTitleBucketLabel === 'function' ? getTabTitleBucketLabel(bucket) : '';
        if (label && label !== bucket) return label;
        var b = (global.availableBuckets || []).find(function (x) {
            return x && x.bucket_id === bucket;
        });
        if (b && b.display_name) return String(b.display_name).trim();
        return label || bucket;
    }

    function updateBreadcrumb(path) {
        var breadcrumb = document.getElementById('breadcrumb');
        var searchInput = document.getElementById('searchInput');
        var hasActiveSearch = searchInput && searchInput.value.trim() !== '';

        breadcrumb.innerHTML = '';

        if (!getBucket()) {
            if (typeof global.renderHomeBreadcrumb === 'function') global.renderHomeBreadcrumb();
            return;
        }

        if (hasActiveSearch) {
            breadcrumb.style.display = 'none';
            return;
        }

        var rootLabel = getBreadcrumbRootLabel();
        var rootLabelEsc = htmlEscapeBreadcrumb(rootLabel);

        var breadcrumbHtml =
            '<a onclick="handleBreadcrumbClick(\'\')" title="' + rootLabelEsc + '">' +
            '<span class="breadcrumb-link">' +
            '<i class="fa-solid fa-house"></i>' +
            '<span class="breadcrumb-text">' + rootLabelEsc + '</span>' +
            '</span></a>';

        if (path && path !== '') {
            var parts = path.split('/').filter(function (p) { return p; });
            var accum = '';
            parts.forEach(function (part) {
                accum += part + '/';
                var safePart = part.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                var safePath = accum.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                breadcrumbHtml +=
                    '<span class="breadcrumb-separator"><i class="fa-solid fa-chevron-right"></i></span>' +
                    '<a onclick="handleBreadcrumbClick(\'' + safePath + '\')" title="' + safePart + '">' +
                    '<span class="breadcrumb-link">' +
                    '<i class="fa-solid fa-folder"></i>' +
                    '<span class="breadcrumb-text">' + safePart + '</span>' +
                    '</span></a>';
            });
        }

        breadcrumb.innerHTML = breadcrumbHtml;
        breadcrumb.style.display = 'flex';
    }

    function handleBreadcrumbClick(path) {
        var cleanPath = path.trim();

        if (typeof global.clearSelection === 'function') global.clearSelection();

        if (global.fileSearch && global.fileSearch.mode && typeof global.exitSearchMode === 'function') {
            global.exitSearchMode();
        }

        if (global.selectionMode && typeof global.toggleSelectionMode === 'function') {
            global.selectionMode = true;
            global.toggleSelectionMode();
        }

        setPath(cleanPath);

        if (typeof global.loadFiles === 'function') global.loadFiles(cleanPath);
        if (typeof global.updateURL === 'function') global.updateURL(getBucket(), cleanPath, false);
    }

    global.htmlEscapeBreadcrumb = htmlEscapeBreadcrumb;
    global.getBreadcrumbRootLabel = getBreadcrumbRootLabel;
    global.updateBreadcrumb = updateBreadcrumb;
    global.handleBreadcrumbClick = handleBreadcrumbClick;
})(window);
