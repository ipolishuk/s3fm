(function () {
    'use strict';

    var THEME_STORAGE_KEY = 's3fm-theme';
    var themeChangingTimer = null;

    function i18n() {
        return window.I18N || {};
    }

    function getEffectiveTheme() {
        var attrTheme = document.documentElement.getAttribute('data-theme');
        if (attrTheme === 'dark' || attrTheme === 'light') return attrTheme;
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        return 'light';
    }

    function updateThemeToggle(btnId, iconId) {
        var buttonId = btnId || 'themeToggleBtn';
        var iconElementId = iconId || 'themeToggleIcon';
        var iconEl = document.getElementById(iconElementId);
        var btnEl = document.getElementById(buttonId);
        if (!iconEl || !btnEl) return;

        var t = i18n();
        var isDark = getEffectiveTheme() === 'dark';
        var label = isDark ? (t['nav.theme_light'] || 'Light theme') : (t['nav.theme_dark'] || 'Dark theme');

        btnEl.title = label;
        btnEl.setAttribute('aria-label', label);
        iconEl.classList.remove('fa-solid', 'fa-regular', 'fa-moon', 'fa-sun');
        iconEl.classList.add('fa-solid', isDark ? 'fa-sun' : 'fa-moon');
    }

    function applyTheme(theme, options) {
        var opts = options || {};
        var normalized = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', normalized);
        updateThemeToggle(opts.btnId, opts.iconId);
    }

    function toggleTheme(options) {
        var opts = options || {};
        var root = document.documentElement;
        if (themeChangingTimer) {
            clearTimeout(themeChangingTimer);
            themeChangingTimer = null;
        }

        root.classList.add('theme-changing');

        // Даём браузеру применить transition-класс до смены CSS-переменных
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                var nextTheme = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
                applyTheme(nextTheme, opts);
                try {
                    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
                } catch (e) {}

                themeChangingTimer = setTimeout(function () {
                    root.classList.remove('theme-changing');
                    themeChangingTimer = null;
                }, 420);
            });
        });
    }

    function bindThemeToggle(btnId, iconId) {
        var buttonId = btnId || 'themeToggleBtn';
        var iconElementId = iconId || 'themeToggleIcon';
        var btn = document.getElementById(buttonId);
        if (!btn) return;
        updateThemeToggle(buttonId, iconElementId);
        btn.addEventListener('click', function () {
            toggleTheme({ btnId: buttonId, iconId: iconElementId });
        });
    }

    window.ThemeManager = {
        getEffectiveTheme: getEffectiveTheme,
        applyTheme: applyTheme,
        updateThemeToggle: updateThemeToggle,
        toggleTheme: toggleTheme,
        bindThemeToggle: bindThemeToggle
    };
})();
