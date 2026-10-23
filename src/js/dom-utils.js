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

    /** Центрированный empty-state с новым ui-spinner (вместо FA / skeleton). */
    function buildEmptyStateSpinnerHtml(message) {
        var text = message != null && String(message) !== '' ? String(message) : '';
        return (
            '<div class="empty-state">' +
            '<span class="ui-spinner empty-state-icon" aria-hidden="true"></span>' +
            (text ? '<div>' + escapeHtml(text) + '</div>' : '') +
            '</div>'
        );
    }

    global.S3FM = global.S3FM || {};
    global.S3FM.escapeHtml = escapeHtml;
    global.S3FM.escapeAttr = escapeAttr;
    global.S3FM.buildEmptyStateSpinnerHtml = buildEmptyStateSpinnerHtml;
    // Совместимость со старым кодом
    global.escapeHtml = global.escapeHtml || escapeHtml;
    global.buildEmptyStateSpinnerHtml = buildEmptyStateSpinnerHtml;
})(typeof window !== 'undefined' ? window : this);
