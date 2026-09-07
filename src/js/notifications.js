(function () {
    'use strict';

    function i18n() {
        return window.I18N || {};
    }

    function getNotificationElements() {
        var notification = document.getElementById('notification');
        if (!notification) return null;
        return {
            notification: notification,
            titleEl: document.getElementById('notificationTitle'),
            messageEl: document.getElementById('notificationMessage'),
            iconEl: document.getElementById('notificationIcon')
        };
    }

    window.hideNotification = function () {
        var els = getNotificationElements();
        if (!els) return;
        els.notification.classList.remove('show');
        if (els.notification.timeoutId) {
            clearTimeout(els.notification.timeoutId);
            els.notification.timeoutId = null;
        }
    };

    window.showNotification = function (title, message, type) {
        type = type || 'success';
        var els = getNotificationElements();
        if (!els) return;
        var tr = i18n();

        if (els.titleEl) els.titleEl.textContent = title || tr['notification.success'];
        if (els.messageEl) els.messageEl.textContent = message || tr['notification.operation_ok'];

        els.notification.className = 'notification';
        els.notification.classList.add(type);

        if (els.iconEl) {
            var icons = {
                success: 'fa-solid fa-check',
                error: 'fa-solid fa-xmark',
                warning: 'fa-solid fa-triangle-exclamation',
                info: 'fa-solid fa-info'
            };
            els.iconEl.className = icons[type] || icons.success;
        }

        if (els.notification.timeoutId) {
            clearTimeout(els.notification.timeoutId);
        }

        els.notification.classList.add('show');

        var timeoutDuration = type === 'error' ? 5000 : 4000;
        els.notification.timeoutId = setTimeout(window.hideNotification, timeoutDuration);
    };

    window.showSuccess = function (message, duration) {
        duration = duration === undefined ? 4000 : duration;
        window.showNotification(i18n()['notification.success'], message, 'success');
        if (duration !== 4000) {
            var els = getNotificationElements();
            if (!els) return;
            if (els.notification.timeoutId) clearTimeout(els.notification.timeoutId);
            els.notification.timeoutId = setTimeout(window.hideNotification, duration);
        }
    };

    window.showError = function (message, duration) {
        duration = duration === undefined ? 5000 : duration;
        window.showNotification(i18n()['notification.error'], message, 'error');
        if (duration !== 5000) {
            var els = getNotificationElements();
            if (!els) return;
            if (els.notification.timeoutId) clearTimeout(els.notification.timeoutId);
            els.notification.timeoutId = setTimeout(window.hideNotification, duration);
        }
    };

    window.showWarning = function (message, duration) {
        duration = duration === undefined ? 5000 : duration;
        window.showNotification(i18n()['notification.warning'], message, 'warning');
        if (duration !== 5000) {
            var els = getNotificationElements();
            if (!els) return;
            if (els.notification.timeoutId) clearTimeout(els.notification.timeoutId);
            els.notification.timeoutId = setTimeout(window.hideNotification, duration);
        }
    };

    window.showInfo = function (message, duration) {
        duration = duration === undefined ? 5000 : duration;
        window.showNotification(i18n()['notification.info'], message, 'info');
        if (duration !== 5000) {
            var els = getNotificationElements();
            if (!els) return;
            if (els.notification.timeoutId) clearTimeout(els.notification.timeoutId);
            els.notification.timeoutId = setTimeout(window.hideNotification, duration);
        }
    };

    window.showSessionExpiredNotification = function () {
        var tr = i18n();
        var notification = document.createElement('div');
        notification.className = 'notification error session-expired';
        notification.innerHTML =
            '<div class="notification-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>' +
            '<div class="notification-content">' +
            '<h4 class="notification-title">' + (tr['session.expired_title'] || '') + '</h4>' +
            '<p class="notification-message">' + (tr['session.expired_message'] || '') + '</p>' +
            '</div>';

        document.body.appendChild(notification);

        setTimeout(function () {
            notification.classList.add('show');
        }, 100);

        setTimeout(function () {
            notification.classList.remove('show');
            setTimeout(function () {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 5000);
    };
})();
