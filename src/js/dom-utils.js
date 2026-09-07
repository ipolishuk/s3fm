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

    global.S3FM = global.S3FM || {};
    global.S3FM.escapeHtml = escapeHtml;
    global.S3FM.escapeAttr = escapeAttr;
    // Совместимость со старым кодом
    global.escapeHtml = global.escapeHtml || escapeHtml;
})(typeof window !== 'undefined' ? window : this);
