/**
 * Shared DOM/string helpers for the UI (escapeHtml / escapeAttr).
 */

(function (global) {
    'use strict';

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    /** Skeleton table for settings panels (buckets/users/roles/clouds/search). */
    function buildSettingsTableSkeletonHtml(options) {
        options = options || {};
        var cols = Math.max(2, parseInt(options.cols, 10) || 5);
        var rows = Math.max(1, parseInt(options.rows, 10) || 8);
        var label = options.label
            || ((global.I18N || {})['settings.loading'])
            || 'Loading...';
        function bar() {
            return '<div class="settings-table-skeleton-bar"></div>';
        }
        var body = '';
        var r;
        var c;
        for (r = 0; r < rows; r++) {
            body += '<div class="settings-table-skeleton-row">';
            for (c = 0; c < cols; c++) {
                body += bar();
            }
            body += '</div>';
        }
        return (
            '<div class="settings-table-skeleton" role="status" aria-busy="true" aria-label="' +
            escapeAttr(label) +
            '" style="--settings-skeleton-cols:' + cols + '">' +
            body +
            '</div>'
        );
    }

    global.S3FM = global.S3FM || {};
    global.S3FM.escapeHtml = escapeHtml;
    global.S3FM.escapeAttr = escapeAttr;
    global.S3FM.buildSettingsTableSkeletonHtml = buildSettingsTableSkeletonHtml;
    // Совместимость со старым кодом
    global.escapeHtml = global.escapeHtml || escapeHtml;
    global.buildSettingsTableSkeletonHtml = buildSettingsTableSkeletonHtml;
})(typeof window !== 'undefined' ? window : this);
