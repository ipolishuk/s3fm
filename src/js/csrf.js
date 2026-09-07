/**
 * CSRF token bootstrap + fetch wrapper helpers.
 * Depends on meta[name=csrf-token] and optional window.__csrfToken from template.
 */
(function (global) {
    'use strict';

    function readMetaCsrf() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? (meta.getAttribute('content') || '') : '';
    }

    function setCsrfToken(token) {
        if (!token) return;
        global.__csrfToken = token;
        var meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) meta.setAttribute('content', token);
    }

    if (!global.__csrfToken) {
        global.__csrfToken = readMetaCsrf();
    }
    global.setCsrfToken = setCsrfToken;

    global.S3FM = global.S3FM || {};
    global.S3FM.setCsrfToken = setCsrfToken;
    global.S3FM.getCsrfToken = function () {
        return global.__csrfToken || readMetaCsrf() || '';
    };

    /**
     * Patch window.fetch once: attach X-CSRF-Token on mutating requests.
     * onActivity — optional callback (e.g. session keepalive).
     */
    function installFetchCsrf(onActivity) {
        if (global.__s3fmFetchPatched) return;
        global.__s3fmFetchPatched = true;
        var originalFetch = global.fetch;
        global.fetch = function () {
            var args = Array.prototype.slice.call(arguments);
            if (typeof onActivity === 'function') {
                try { onActivity(); } catch (_e) {}
            }
            var input = args[0];
            var init = args[1] ? Object.assign({}, args[1]) : {};
            var method = (init.method || 'GET').toUpperCase();
            if (typeof input === 'object' && input && input.method) {
                method = String(input.method || method).toUpperCase();
            }
            var mutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
            var token = global.S3FM.getCsrfToken();
            if (mutating && token) {
                var headers = new Headers(init.headers || (typeof input === 'object' && input && input.headers) || undefined);
                if (!headers.has('X-CSRF-Token')) {
                    headers.set('X-CSRF-Token', token);
                }
                init.headers = headers;
                args[1] = init;
            }
            return originalFetch.apply(this, args);
        };
    }

    global.S3FM.installFetchCsrf = installFetchCsrf;
})(typeof window !== 'undefined' ? window : this);
