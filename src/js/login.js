(function () {
    'use strict';

    function i18n() {
        return window.I18N || {};
    }

    function updateLoginPasswordToggleState() {
        var input = document.getElementById('password');
        var btn = document.getElementById('loginPasswordToggle');
        if (!input || !btn) return;

        var icon = btn.querySelector('i');
        var t = i18n();
        var showLabel = t['modal.password_show'] || 'Show password';
        var hideLabel = t['modal.password_hide'] || 'Hide password';
        var isHidden = input.type === 'password';

        btn.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
        btn.setAttribute('aria-label', isHidden ? showLabel : hideLabel);
        btn.title = isHidden ? showLabel : hideLabel;

        if (icon) {
            icon.classList.remove('fa-eye', 'fa-eye-slash');
            icon.classList.add(isHidden ? 'fa-eye' : 'fa-eye-slash');
        }
    }

    function toggleLoginPasswordVisibility() {
        var input = document.getElementById('password');
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        updateLoginPasswordToggleState();
        input.focus();
    }

    function setupLanguageDropdown() {
        var container = document.querySelector('.login-controls .lang-dropdown');
        var trigger = document.getElementById('loginLangTrigger');
        var menu = document.getElementById('loginLangMenu');
        if (!container || !trigger || !menu) return;

        function closeMenu() {
            container.classList.remove('open');
            if (typeof window.resetDropdownMenuOverlay === 'function') {
                window.resetDropdownMenuOverlay(container);
            } else {
                menu.classList.add('hidden');
                trigger.setAttribute('aria-expanded', 'false');
            }
        }

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = menu.classList.contains('hidden');
            if (willOpen) {
                container.classList.add('open');
                menu.classList.remove('hidden');
                trigger.setAttribute('aria-expanded', 'true');
                if (typeof window.fitDropdownMenuOverlay === 'function') {
                    window.fitDropdownMenuOverlay(container);
                }
            } else {
                closeMenu();
            }
        });

        menu.querySelectorAll('.lang-dropdown-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var lang = btn.getAttribute('data-lang');
                if (lang) window.location.href = '?lang=' + lang;
            });
        });

        document.addEventListener('click', function (e) {
            if (!container.contains(e.target)) closeMenu();
        });
    }

    function setLoginBtnLabel(loginBtn, label) {
        if (!loginBtn) return;
        var labelEl = loginBtn.querySelector('.login-btn-label');
        if (labelEl) {
            labelEl.textContent = label;
        } else {
            loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> ' + label;
        }
    }

    function openLoginForm() {
        var panel = document.getElementById('loginFormPanel');
        var loginBtn = document.getElementById('loginBtn');
        var usernameEl = document.getElementById('username');
        if (!panel || panel.classList.contains('is-open')) return;

        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
        if (loginBtn) {
            var submitLabel = loginBtn.getAttribute('data-label-submit') || (i18n()['login.submit'] || 'Log in');
            loginBtn.type = 'submit';
            loginBtn.setAttribute('aria-expanded', 'true');
            setLoginBtnLabel(loginBtn, submitLabel);
        }
        window.setTimeout(function () {
            if (usernameEl) usernameEl.focus();
        }, 280);
    }

    function setupLoginFormReveal() {
        var loginBtn = document.getElementById('loginBtn');
        var panel = document.getElementById('loginFormPanel');
        if (!loginBtn || !panel) return;

        loginBtn.addEventListener('click', function (e) {
            if (panel.classList.contains('is-open')) return;
            e.preventDefault();
            openLoginForm();
        });
    }

    function setupLoginSubmit() {
        var loginForm = document.getElementById('loginForm');
        if (!loginForm) return;

        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var panel = document.getElementById('loginFormPanel');
            if (!panel || !panel.classList.contains('is-open')) return;

            var usernameEl = document.getElementById('username');
            var passwordEl = document.getElementById('password');
            var loginBtn = document.getElementById('loginBtn');
            if (!usernameEl || !passwordEl || !loginBtn) return;

            var t = i18n();
            var username = usernameEl.value;
            var password = passwordEl.value;
            var submitLabel = loginBtn.getAttribute('data-label-submit') || (t['login.submit'] || 'Log in');

            loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span class="login-btn-label">' +
                (t['login.logging_in'] || 'Logging in...') + '</span>';
            loginBtn.disabled = true;
            if (typeof window.hideNotification === 'function') window.hideNotification();

            try {
                var response = await fetch('/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ username: username, password: password })
                });

                var data = {};
                try {
                    data = await response.json();
                } catch (_parseErr) {
                    data = {};
                }

                if (response.ok) {
                    window.location.href = '/';
                } else if (typeof window.showError === 'function') {
                    window.showError(data.error || t['login.error_invalid']);
                }
            } catch (error) {
                if (typeof window.showError === 'function') {
                    window.showError((t['login.error_network'] || 'Network error') + ': ' + error.message);
                }
            } finally {
                loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> <span class="login-btn-label">' +
                    submitLabel + '</span>';
                loginBtn.disabled = false;
            }
        });
    }

    function setupSsoSubmit() {
        var ssoForm = document.getElementById('loginSsoForm');
        var ssoBtn = document.getElementById('ssoLoginBtn');
        if (!ssoForm || !ssoBtn) return;

        ssoForm.addEventListener('submit', function () {
            var t = i18n();
            var loginBtn = document.getElementById('loginBtn');
            ssoBtn.disabled = true;
            ssoBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span class="login-btn-label">' +
                (t['login.logging_in'] || 'Signing in...') + '</span>';
            if (loginBtn) loginBtn.disabled = true;
        });
    }

    function showSsoErrorFromQuery() {
        var params = new URLSearchParams(window.location.search);
        var code = params.get('sso_error');
        if (!code || typeof window.showError !== 'function') return;

        var t = i18n();
        var key = 'login.sso_error_' + code;
        var msg = t[key] || t['login.sso_error_generic'] || 'SSO login failed';
        var ssoUser = params.get('sso_user') || '';
        if (ssoUser) {
            msg = msg.replace(/\{username\}/g, ssoUser);
        }
        window.showError(msg);

        params.delete('sso_error');
        params.delete('sso_user');
        var qs = params.toString();
        var next = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        window.history.replaceState({}, '', next);
    }

    function init() {
        var themeToggleBtn = document.getElementById('themeToggleBtn');
        var loginPasswordToggle = document.getElementById('loginPasswordToggle');
        var closeBtn = document.getElementById('loginNotificationCloseBtn');

        if (themeToggleBtn && window.ThemeManager) {
            window.ThemeManager.bindThemeToggle('themeToggleBtn', 'themeToggleIcon');
        }
        if (loginPasswordToggle) loginPasswordToggle.addEventListener('click', toggleLoginPasswordVisibility);
        if (closeBtn && typeof window.hideNotification === 'function') {
            closeBtn.addEventListener('click', window.hideNotification);
        }

        updateLoginPasswordToggleState();
        setupLanguageDropdown();
        setupLoginFormReveal();
        setupLoginSubmit();
        setupSsoSubmit();
        showSsoErrorFromQuery();
    }

    init();
})();
