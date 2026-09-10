/**
 * Модальные окна и тост-уведомления (confirm, user info, create folder, notifications).
 * Зависит от window.I18N (задаётся в шаблоне до подключения этого файла).
 */
(function () {
    'use strict';

    var confirmCallback = null;

    function I18N() {
        return window.I18N || {};
    }

    window.showConfirmModal = function (message, callback, type) {
        type = type || 'delete';
        var modal = document.getElementById('confirmModal');
        var messageEl = document.getElementById('confirmMessage');
        var confirmBtn = modal.querySelector('.confirm-action-btn');
        var tr = I18N();

        messageEl.textContent = message;
        confirmCallback = callback;

        if (type === 'logout') {
            confirmBtn.textContent = tr['modal.logout_confirm'] || '';
        } else if (type === 'yes') {
            confirmBtn.textContent = tr['modal.yes'] || 'Yes';
        } else if (type === 'warning' || type === 'reindex') {
            confirmBtn.textContent = tr['modal.reindex'] || tr['settings.search.reindex_one'] || 'Reindex';
        } else {
            confirmBtn.textContent = tr['modal.delete'] || 'Delete';
        }

        modal.style.display = 'flex';
    };

    window.hideConfirmModal = function (confirmed) {
        var modal = document.getElementById('confirmModal');
        modal.style.display = 'none';

        if (confirmed && confirmCallback) {
            confirmCallback();
        }
        confirmCallback = null;
    };

    window.showNotification = function (title, message, type) {
        type = type || 'success';
        var notification = document.getElementById('notification');
        var titleEl = document.getElementById('notificationTitle');
        var messageEl = document.getElementById('notificationMessage');
        var iconEl = document.getElementById('notificationIcon');
        var tr = I18N();

        titleEl.textContent = title || tr['notification.success'];
        messageEl.textContent = message || tr['notification.operation_ok'];

        notification.className = 'notification';
        notification.classList.add(type);

        var icons = {
            success: 'fa-solid fa-check',
            error: 'fa-solid fa-xmark',
            warning: 'fa-solid fa-triangle-exclamation',
            info: 'fa-solid fa-info'
        };
        iconEl.className = icons[type] || icons.success;

        if (notification.timeoutId) {
            clearTimeout(notification.timeoutId);
        }

        notification.classList.add('show');

        var timeoutDuration = 5000;
        switch (type) {
            case 'error':
                timeoutDuration = 5000;
                break;
            case 'warning':
            case 'info':
            case 'success':
                timeoutDuration = 4000;
                break;
        }

        notification.timeoutId = setTimeout(function () {
            window.hideNotification();
        }, timeoutDuration);
    };

    window.hideNotification = function () {
        var notification = document.getElementById('notification');
        notification.classList.remove('show');

        if (notification.timeoutId) {
            clearTimeout(notification.timeoutId);
            notification.timeoutId = null;
        }
    };

    window.showSuccess = function (message, duration) {
        duration = duration === undefined ? 4000 : duration;
        var tr = I18N();
        window.showNotification(tr['notification.success'], message, 'success');
        if (duration !== 4000) {
            var notification = document.getElementById('notification');
            if (notification.timeoutId) {
                clearTimeout(notification.timeoutId);
                notification.timeoutId = setTimeout(function () {
                    window.hideNotification();
                }, duration);
            }
        }
    };

    window.showError = function (message, duration) {
        duration = duration === undefined ? 5000 : duration;
        var notification = document.getElementById('notification');
        if (notification.timeoutId) {
            clearTimeout(notification.timeoutId);
        }
        var tr = I18N();
        window.showNotification(tr['notification.error'], message, 'error');

        if (duration !== 5000) {
            if (notification.timeoutId) {
                clearTimeout(notification.timeoutId);
            }
            notification.timeoutId = setTimeout(function () {
                window.hideNotification();
            }, duration);
        }
    };

    window.showWarning = function (message, duration) {
        duration = duration === undefined ? 5000 : duration;
        var tr = I18N();
        window.showNotification(tr['notification.warning'], message, 'warning');
        if (duration !== 5000) {
            var notification = document.getElementById('notification');
            if (notification.timeoutId) {
                clearTimeout(notification.timeoutId);
                notification.timeoutId = setTimeout(function () {
                    window.hideNotification();
                }, duration);
            }
        }
    };

    window.showInfo = function (message, duration) {
        duration = duration === undefined ? 5000 : duration;
        var tr = I18N();
        window.showNotification(tr['notification.info'], message, 'info');
        if (duration !== 5000) {
            var notification = document.getElementById('notification');
            if (notification.timeoutId) {
                clearTimeout(notification.timeoutId);
                notification.timeoutId = setTimeout(function () {
                    window.hideNotification();
                }, duration);
            }
        }
    };

    function formatUserInfoRoleDisplay(user, tr) {
        tr = tr || I18N();
        if (user && user.has_custom_roles) {
            return tr['role.custom'] || 'custom';
        }
        var role = (user && user.role) ? user.role : '';
        return role || '—';
    }

    function formatUserInfoText(value) {
        var text = (value || '').trim();
        return text || '—';
    }

    function formatUserInfoDate(iso) {
        if (!iso) return '—';
        if (typeof window.formatDate === 'function') {
            return window.formatDate(iso);
        }
        try {
            return new Date(iso).toLocaleString();
        } catch (e) {
            return '—';
        }
    }

    window.showUserDetailsModal = function (data, options) {
        options = options || {};
        var modal = document.getElementById('userInfoModal');
        if (!modal) return;
        data = data || {};

        var modalUserDisplayName = document.getElementById('modalUserDisplayName');
        var modalUserLogin = document.getElementById('modalUserLogin');
        var modalUserRole = document.getElementById('modalUserRole');
        var modalUserEmail = document.getElementById('modalUserEmail');
        var modalUserCreatedAt = document.getElementById('modalUserCreatedAt');
        var modalUserLastLoginAt = document.getElementById('modalUserLastLoginAt');
        var createdRow = document.getElementById('modalUserCreatedAtRow');
        var lastLoginRow = document.getElementById('modalUserLastLoginAtRow');
        var tr = I18N();

        if (modalUserDisplayName) modalUserDisplayName.textContent = formatUserInfoText(data.display_name);
        if (modalUserLogin) {
            var login = formatUserInfoText(data.username);
            modalUserLogin.textContent = login === '—' ? login : String(login).toLowerCase();
        }
        if (modalUserEmail) modalUserEmail.textContent = formatUserInfoText(data.email);
        if (modalUserRole) modalUserRole.textContent = formatUserInfoRoleDisplay(data, tr);

        var showDates = !!options.showAccountDates;
        if (createdRow) createdRow.hidden = !showDates;
        if (lastLoginRow) lastLoginRow.hidden = !showDates;
        if (showDates) {
            if (modalUserCreatedAt) modalUserCreatedAt.textContent = formatUserInfoDate(data.created_at);
            if (modalUserLastLoginAt) modalUserLastLoginAt.textContent = formatUserInfoDate(data.last_login_at);
        }

        modal.style.display = 'flex';
    };

    window.showUserInfoModal = function () {
        window.showUserDetailsModal(window.fileManagerCurrentUser || {}, { showAccountDates: false });
    };

    window.hideUserInfoModal = function () {
        var modal = document.getElementById('userInfoModal');
        modal.style.display = 'none';
    };

    function scrollScrollableAncestors(startEl, deltaY, stopAtEl) {
        var parent = startEl;
        while (parent) {
            if (stopAtEl && parent === stopAtEl) break;
            var style = window.getComputedStyle(parent);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                parent.scrollHeight > parent.clientHeight) {
                var maxScroll = parent.scrollHeight - parent.clientHeight;
                var atTop = parent.scrollTop <= 0;
                var atBottom = parent.scrollTop >= maxScroll - 1;
                if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
                    parent = parent.parentElement;
                    continue;
                }
                parent.scrollTop += deltaY;
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    }

    window.bindModalScrollChaining = function (options) {
        options = options || {};
        var modal = document.getElementById(options.modalId || '');
        var scrollHost = document.getElementById(options.scrollHostId || '');
        var targetSelector = options.targetSelector || '';
        if (!modal || !scrollHost || !targetSelector) return;
        if (modal.dataset.scrollChainingBound === '1') return;
        modal.dataset.scrollChainingBound = '1';
        modal.addEventListener('wheel', function (e) {
            var target = e.target;
            if (!target || !target.closest || !target.closest(targetSelector)) return;
            var deltaY = e.deltaY || 0;
            if (!deltaY) return;
            if (scrollScrollableAncestors(target, deltaY, scrollHost)) {
                e.preventDefault();
                return;
            }
            if (scrollHost.scrollHeight > scrollHost.clientHeight) {
                scrollHost.scrollTop += deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    };

    window.showCreateFolderModal = function () {
        var user = window.fileManagerCurrentUser;
        var tr = I18N();
        var perms = (user && user.permissions) || [];
        if (perms.indexOf('create_folder') === -1) {
            window.showError(tr['msg.admin_only_upload']);
            return;
        }

        var modal = document.getElementById('createFolderModal');
        var folderNameInput = document.getElementById('folderNameInput');
        var errorDiv = document.getElementById('folderNameError');

        folderNameInput.value = '';
        folderNameInput.classList.remove('error');
        errorDiv.style.display = 'none';
        errorDiv.textContent = '';

        modal.style.display = 'flex';
        folderNameInput.focus();
    };

    window.hideCreateFolderModal = function () {
        var modal = document.getElementById('createFolderModal');
        modal.style.display = 'none';
    };

    function getDropdownMenu(dropdownWrap) {
        if (!dropdownWrap) return null;
        var menu = dropdownWrap.querySelector(':scope > .dropdown-menu');
        return menu || dropdownWrap.querySelector('.dropdown-menu');
    }

    function getDropdownTrigger(dropdownWrap) {
        if (!dropdownWrap) return null;
        var menu = getDropdownMenu(dropdownWrap);
        var child = dropdownWrap.firstElementChild;
        while (child) {
            if (child !== menu && child.matches && child.matches(
                'button.dropdown-trigger, .dropdown-trigger, [aria-haspopup], input.bucket-access-user-input, input.search-input'
            )) {
                return child;
            }
            child = child.nextElementSibling;
        }
        return dropdownWrap.querySelector(
            ':scope > .dropdown-trigger, :scope > [aria-haspopup], :scope > input.bucket-access-user-input, :scope > input.search-input'
        );
    }

    function isDropdownOverlayOpen(dropdownWrap) {
        if (!dropdownWrap) return false;
        var menu = getDropdownMenu(dropdownWrap);
        return !!(menu && !menu.classList.contains('hidden') && dropdownWrap.classList.contains('open'));
    }

    function dropdownMenuPrefersRightAlign(dropdownWrap) {
        return dropdownWrap.id === 'userMenuDropdown';
    }

    function alignDropdownMenuHorizontally(menu, rect, margin, preferRight) {
        if (preferRight) {
            // Flush menu right edge to trigger right edge (avoid scrollbar/innerWidth drift)
            menu.style.right = 'auto';
            menu.style.left = rect.left + 'px';
            var menuWidth = menu.getBoundingClientRect().width || menu.offsetWidth || 0;
            var left = rect.right - menuWidth;
            if (left < margin) left = margin;
            menu.style.left = left + 'px';
            return;
        }

        menu.style.left = rect.left + 'px';
        menu.style.right = 'auto';

        var menuRect = menu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth - margin) {
            var flippedLeft = rect.right - (menuRect.width || menu.offsetWidth || 0);
            menu.style.left = Math.max(margin, flippedLeft) + 'px';
            menu.style.right = 'auto';
            return;
        }
        if (menuRect.left < margin) {
            menu.style.left = margin + 'px';
            menu.style.right = 'auto';
        }
    }

    function positionDropdownMenuOverlay(dropdownWrap) {
        if (!dropdownWrap) return;
        var menu = getDropdownMenu(dropdownWrap);
        var trigger = getDropdownTrigger(dropdownWrap);
        if (!menu || !trigger) return;
        var rect = trigger.getBoundingClientRect();
        var margin = 16;
        var isContextMenu = dropdownWrap.classList.contains('context-menu-dropdown');
        var gap = isContextMenu ? 0 : 4;
        var safeB = 0;
        try {
            var sb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-bottom)')) || 0;
            if (!isNaN(sb)) safeB = sb;
        } catch (e) {}
        var availBelow = window.innerHeight - (isContextMenu ? rect.top : rect.bottom) - margin - safeB - gap;
        var availAbove = rect.top - margin - gap;
        var minPx = 120;
        var cap = 480;
        var openUp = availBelow < minPx && availAbove > availBelow;
        var maxH = Math.max(minPx, Math.min(cap, Math.floor(openUp ? availAbove : availBelow)));
        var inModal = dropdownWrap.closest('.modal-body, .modal');
        var preferRight = !inModal && dropdownMenuPrefersRightAlign(dropdownWrap);
        var hasFixedContextMenu = menu.classList.contains('context-menu');

        menu.style.position = 'fixed';
        if (inModal) {
            // Match trigger width; viewport coords (modal must not leave a transform containing block)
            menu.style.width = rect.width + 'px';
            menu.style.minWidth = rect.width + 'px';
            menu.style.maxWidth = '';
            menu.style.left = rect.left + 'px';
            menu.style.right = 'auto';
        } else if (hasFixedContextMenu) {
            // Fixed CSS width (.context-menu) — do not shrink/grow by locale
            menu.style.width = '';
            menu.style.minWidth = '';
            menu.style.maxWidth = '';
            alignDropdownMenuHorizontally(menu, rect, margin, preferRight);
        } else {
            menu.style.width = 'max-content';
            menu.style.minWidth = isContextMenu ? '0' : (rect.width + 'px');
            if (preferRight) {
                menu.style.maxWidth = Math.max(rect.width, rect.right - margin) + 'px';
            } else {
                menu.style.maxWidth = Math.max(rect.width, window.innerWidth - margin * 2) + 'px';
            }
            alignDropdownMenuHorizontally(menu, rect, margin, preferRight);
        }
        menu.style.maxHeight = maxH + 'px';
        menu.style.overflowY = 'auto';
        menu.style.zIndex = 'calc(var(--popup-z-overlay) + 1)';
        if (openUp) {
            menu.style.top = 'auto';
            menu.style.marginTop = '0';
            // Context menu: bottom edge at cursor; button menus: gap above trigger
            menu.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
        } else if (isContextMenu) {
            // Anchor top-left at cursor (not below the 1×1 trigger)
            menu.style.top = rect.top + 'px';
            menu.style.bottom = 'auto';
            menu.style.marginTop = '0';
        } else {
            menu.style.top = (rect.bottom + gap) + 'px';
            menu.style.bottom = 'auto';
            menu.style.marginTop = '';
        }
    }

    function cleanupDropdownMenuOverlayTracking(dropdownWrap) {
        if (!dropdownWrap || !dropdownWrap._dropdownOverlayCleanup) return;
        dropdownWrap._dropdownOverlayCleanup();
        delete dropdownWrap._dropdownOverlayCleanup;
    }

    function trackDropdownMenuOverlay(dropdownWrap) {
        if (!dropdownWrap) return;
        if (dropdownWrap._dropdownOverlayCleanup) return;

        var update = function () {
            if (!isDropdownOverlayOpen(dropdownWrap)) {
                cleanupDropdownMenuOverlayTracking(dropdownWrap);
                return;
            }
            positionDropdownMenuOverlay(dropdownWrap);
        };

        var frame = 0;
        var scheduleUpdate = function () {
            if (frame) return;
            frame = window.requestAnimationFrame(function () {
                frame = 0;
                update();
            });
        };

        window.addEventListener('resize', scheduleUpdate);
        window.addEventListener('scroll', scheduleUpdate, true);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', scheduleUpdate);
        }

        var observer = null;
        if (window.ResizeObserver) {
            observer = new ResizeObserver(scheduleUpdate);
            observer.observe(dropdownWrap);
            var menu = getDropdownMenu(dropdownWrap);
            var trigger = getDropdownTrigger(dropdownWrap);
            if (menu) observer.observe(menu);
            if (trigger) observer.observe(trigger);
        }

        dropdownWrap._dropdownOverlayCleanup = function () {
            window.removeEventListener('resize', scheduleUpdate);
            window.removeEventListener('scroll', scheduleUpdate, true);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', scheduleUpdate);
            }
            if (observer) observer.disconnect();
            if (frame) {
                window.cancelAnimationFrame(frame);
                frame = 0;
            }
        };
    }

    window.resetDropdownMenuOverlay = function (dropdownWrap) {
        if (!dropdownWrap) return;
        cleanupDropdownMenuOverlayTracking(dropdownWrap);
        var menu = getDropdownMenu(dropdownWrap);
        var trigger = getDropdownTrigger(dropdownWrap);
        if (menu) {
            menu.classList.add('hidden');
            menu.style.position = '';
            menu.style.left = '';
            menu.style.width = '';
            menu.style.minWidth = '';
            menu.style.maxWidth = '';
            menu.style.right = '';
            menu.style.top = '';
            menu.style.bottom = '';
            menu.style.marginTop = '';
            menu.style.maxHeight = '';
            menu.style.overflowY = '';
            menu.style.zIndex = '';
        }
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    };

    window.fitDropdownMenuOverlay = function (dropdownWrap) {
        if (!dropdownWrap) return;
        positionDropdownMenuOverlay(dropdownWrap);
        trackDropdownMenuOverlay(dropdownWrap);
    };

})();
