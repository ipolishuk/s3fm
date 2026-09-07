/**
 * Session idle timer, keepalive ping, and timeout logout helpers.
 * Depends on: I18N, showSessionExpiredNotification, showConfirmModal (optional for logout).
 * Uses window.fileManagerCurrentUser as the signed-in user signal.
 */
(function (global) {
    'use strict';

    var sessionTimeoutMinutes = 60;
    var sessionTimer = null;
    var sessionWarningShown = false;
    var sessionWarningTimer = null;
    var sessionRefreshInterval = null;
    var lastActivityTime = Date.now();
    var SESSION_REFRESH_INTERVAL_MS = 2 * 60 * 1000;

    function currentUser() {
        return global.fileManagerCurrentUser || null;
    }

    function hideSessionWarning() {
        var notification = document.getElementById('sessionWarningNotification');
        if (notification) {
            notification.classList.remove('show');
            setTimeout(function () {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }
        sessionWarningShown = false;

        if (sessionWarningTimer) {
            clearTimeout(sessionWarningTimer);
            sessionWarningTimer = null;
        }

        if (global.sessionCountdownInterval) {
            clearInterval(global.sessionCountdownInterval);
            global.sessionCountdownInterval = null;
        }
    }

    function startCountdownTimer(seconds) {
        var timeLeft = seconds;
        var timerElement = document.getElementById('sessionTimer');

        if (global.sessionCountdownInterval) {
            clearInterval(global.sessionCountdownInterval);
        }

        global.sessionCountdownInterval = setInterval(function () {
            if (!timerElement) {
                clearInterval(global.sessionCountdownInterval);
                return;
            }

            timeLeft--;
            var minutes = Math.floor(timeLeft / 60);
            var secs = timeLeft % 60;
            timerElement.textContent = minutes + ':' + (secs < 10 ? '0' : '') + secs;

            if (timeLeft <= 0) {
                clearInterval(global.sessionCountdownInterval);
            }
        }, 1000);

        return global.sessionCountdownInterval;
    }

    function showSessionWarning() {
        if (sessionWarningShown) return;
        sessionWarningShown = true;

        var I18N = global.I18N || {};
        var notification = document.createElement('div');
        notification.className = 'notification warning session-warning';
        notification.id = 'sessionWarningNotification';
        notification.innerHTML =
            '<div class="notification-icon"><i class="fa-solid fa-clock"></i></div>' +
            '<div class="notification-content">' +
            '<h4 class="notification-title">' + (I18N['session.warning_title'] || '') + '</h4>' +
            '<p class="notification-message">' + (I18N['session.warning_message'] || '') + '</p>' +
            '<div id="sessionTimer">5:00</div>' +
            '</div>' +
            '<button class="notification-close" onclick="hideSessionWarning()">' +
            '<i class="fa-solid fa-xmark"></i></button>';

        document.body.appendChild(notification);
        setTimeout(function () {
            notification.classList.add('show');
        }, 100);

        startCountdownTimer(5 * 60);

        notification.addEventListener('click', function (e) {
            if (!e.target.closest('.notification-close')) {
                updateSessionActivity();
            }
        });
    }

    function stopSessionRefreshInterval() {
        if (sessionRefreshInterval) {
            clearInterval(sessionRefreshInterval);
            sessionRefreshInterval = null;
        }
    }

    function startSessionTimer() {
        hideSessionWarning();
        if (sessionTimer) clearTimeout(sessionTimer);
        if (sessionWarningTimer) clearTimeout(sessionWarningTimer);
        sessionWarningShown = false;

        var logoutTime = sessionTimeoutMinutes * 60 * 1000;
        sessionTimer = setTimeout(function () {
            if (currentUser()) logoutDueToTimeout();
        }, logoutTime);
        lastActivityTime = Date.now();
    }

    function startSessionRefreshInterval() {
        stopSessionRefreshInterval();
        sessionRefreshInterval = setInterval(function () {
            if (!currentUser()) return;
            fetch('/api/check-auth', { credentials: 'include' })
                .then(function (response) {
                    if (!response.ok) return null;
                    return response.json();
                })
                .then(function (data) {
                    if (data && data.authenticated) {
                        updateSessionActivity();
                    }
                })
                .catch(function () { /* ignore network errors */ });
        }, SESSION_REFRESH_INTERVAL_MS);
    }

    function updateSessionActivity() {
        hideSessionWarning();
        startSessionTimer();
    }

    function logoutDueToTimeout() {
        stopSessionRefreshInterval();
        if (typeof global.showSessionExpiredNotification === 'function') {
            global.showSessionExpiredNotification();
        }
        setTimeout(function () {
            fetch('/api/logout', { method: 'POST', credentials: 'include' })
                .catch(function (error) {
                    console.error('Logout error:', error);
                })
                .then(function () {
                    global.location.href = '/login';
                });
        }, 5000);
    }

    function clearSessionTimers() {
        stopSessionRefreshInterval();
        if (sessionTimer) {
            clearTimeout(sessionTimer);
            sessionTimer = null;
        }
        if (sessionWarningTimer) {
            clearTimeout(sessionWarningTimer);
            sessionWarningTimer = null;
        }
        hideSessionWarning();
    }

    function setSessionTimeoutMinutes(minutes) {
        var n = Number(minutes);
        if (n > 0) {
            sessionTimeoutMinutes = n;
        }
    }

    function configureSessionFromAuth(data) {
        if (!data || !data.APP_SESSION_TIMEOUT_MINUTES) return;
        setSessionTimeoutMinutes(data.APP_SESSION_TIMEOUT_MINUTES);
        startSessionTimer();
        startSessionRefreshInterval();
    }

    async function refreshSession() {
        try {
            var response = await fetch('/api/check-auth', { credentials: 'include' });
            if (response.ok) {
                var data = await response.json();
                if (data.authenticated) {
                    updateSessionActivity();
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error('Session refresh error:', error);
            return false;
        }
    }

    function bindActivityListeners() {
        document.addEventListener('click', function (e) {
            if (
                !e.target.closest('.notification') &&
                !e.target.closest('.notification-close') &&
                !e.target.closest('#sessionWarningNotification')
            ) {
                updateSessionActivity();
            }
        });
        document.addEventListener('keydown', function () {
            updateSessionActivity();
        });
        document.addEventListener('scroll', function () {
            updateSessionActivity();
        });
        if (global.S3FM && typeof global.S3FM.installFetchCsrf === 'function') {
            global.S3FM.installFetchCsrf(updateSessionActivity);
        }
    }

    document.addEventListener('DOMContentLoaded', bindActivityListeners);

    global.hideSessionWarning = hideSessionWarning;
    global.showSessionWarning = showSessionWarning;
    global.startSessionTimer = startSessionTimer;
    global.startSessionRefreshInterval = startSessionRefreshInterval;
    global.stopSessionRefreshInterval = stopSessionRefreshInterval;
    global.updateSessionActivity = updateSessionActivity;
    global.logoutDueToTimeout = logoutDueToTimeout;
    global.clearSessionTimers = clearSessionTimers;
    global.setSessionTimeoutMinutes = setSessionTimeoutMinutes;
    global.configureSessionFromAuth = configureSessionFromAuth;
    global.refreshSession = refreshSession;

    global.S3FM = global.S3FM || {};
    global.S3FM.session = {
        startTimer: startSessionTimer,
        startRefreshInterval: startSessionRefreshInterval,
        stopRefreshInterval: stopSessionRefreshInterval,
        updateActivity: updateSessionActivity,
        configureFromAuth: configureSessionFromAuth,
        clearTimers: clearSessionTimers,
        refresh: refreshSession,
        logoutDueToTimeout: logoutDueToTimeout,
        getLastActivityTime: function () { return lastActivityTime; },
    };
})(window);
