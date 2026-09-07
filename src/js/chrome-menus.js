/**
 * Top-bar chrome menus: language, user, upload.
 * Depends on: I18N, logout, updateSettingsMenuItemVisibility, isCurrentUserAdmin,
 * showCreateFolderModal, ThemeManager, fit/resetDropdownMenuOverlay.
 */
(function (global) {
    'use strict';

// Выпадающее меню выбора языка
function setupLangDropdown() {
    const container = document.querySelector('.lang-dropdown');
    const trigger = document.getElementById('langDropdownTrigger');
    const menu = document.getElementById('langDropdownMenu');
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

    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        const willOpen = menu.classList.contains('hidden');
        if (willOpen) {
            document.dispatchEvent(new CustomEvent('dropdown:open', { detail: { source: 'lang' } }));
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

    menu.querySelectorAll('.lang-dropdown-item').forEach(function(btn) {
        btn.addEventListener('click', async function(e) {
            e.stopPropagation();
            const lang = this.getAttribute('data-lang');
            if (!lang) return;
            closeMenu();
            try {
                const res = await fetch('/api/set-locale', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ locale: lang }),
                    credentials: 'same-origin'
                });
                if (res.ok) {
                    window.location.reload();
                    return;
                }
            } catch (err) {}
            var sep = window.location.search ? '&' : '?';
            window.location.href = (window.location.pathname || '/') + window.location.search + sep + 'lang=' + lang;
        });
    });

    document.addEventListener('click', function(e) {
        if (container.contains(e.target)) return;
        closeMenu();
    });

    document.addEventListener('dropdown:open', function(e) {
        if (!e || !e.detail || e.detail.source === 'lang') return;
        closeMenu();
    });
}

function setupUserMenuDropdown() {
    const container = document.getElementById('userMenuDropdown');
    const trigger = document.getElementById('userInfoBtn');
    const menu = document.getElementById('userMenuDropdownMenu');
    const userInfoItem = document.getElementById('userInfoMenuItem');
    const settingsItem = document.getElementById('settingsMenuItem');
    const helpItem = document.getElementById('helpMenuItem');
    const logoutItem = document.getElementById('logoutMenuItem');
    if (!container || !trigger || !menu) return;
    updateSettingsMenuItemVisibility();

    function closeMenu() {
        container.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function') {
            window.resetDropdownMenuOverlay(container);
        } else {
            menu.classList.add('hidden');
            trigger.setAttribute('aria-expanded', 'false');
        }
    }

    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        updateSettingsMenuItemVisibility();
        const willOpen = !container.classList.contains('open');
        if (willOpen) {
            document.dispatchEvent(new CustomEvent('dropdown:open', { detail: { source: 'user' } }));
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

    if (userInfoItem) {
        userInfoItem.addEventListener('click', function() {
            closeMenu();
            if (typeof window.showUserInfoModal === 'function') {
                window.showUserInfoModal();
            }
        });
    }

    if (logoutItem) {
        logoutItem.addEventListener('click', function() {
            closeMenu();
            logout();
        });
    }

    if (settingsItem) {
        settingsItem.addEventListener('click', function() {
            if (!isCurrentUserAdmin()) {
                settingsItem.classList.add('hidden');
                closeMenu();
                return;
            }
            closeMenu();
        });
    }

    if (helpItem) {
        helpItem.addEventListener('click', function() {
            closeMenu();
        });
    }

    document.addEventListener('click', function(e) {
        if (container.classList.contains('open') && !container.contains(e.target)) closeMenu();
    });

    document.addEventListener('dropdown:open', function(e) {
        if (!e || !e.detail || e.detail.source === 'user') return;
        closeMenu();
    });
}

// Выпадающее меню кнопки «Загрузка» (файлы / папка)
function setupUploadDropdown() {
    const container = document.getElementById('uploadDropdown');
    const trigger = document.getElementById('uploadBtn');
    const menu = document.getElementById('uploadDropdownMenu');
    const uploadFilesOption = document.getElementById('uploadFilesOption');
    const uploadFolderOption = document.getElementById('uploadFolderOption');
    const createFolderOption = document.getElementById('createFolderOption');
    const addBucketOption = document.getElementById('addBucketOption');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
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

    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        if (trigger.disabled) return;
        const willOpen = !container.classList.contains('open');
        if (willOpen) {
            document.dispatchEvent(new CustomEvent('dropdown:open', { detail: { source: 'upload' } }));
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

    if (uploadFilesOption && fileInput) {
        uploadFilesOption.addEventListener('click', function() {
            if (uploadFilesOption.disabled) return;
            closeMenu();
            fileInput.click();
        });
    }
    if (uploadFolderOption && folderInput) {
        uploadFolderOption.addEventListener('click', function() {
            if (uploadFolderOption.disabled) return;
            closeMenu();
            folderInput.click();
        });
    }
    if (createFolderOption) {
        createFolderOption.addEventListener('click', function() {
            if (createFolderOption.disabled) return;
            closeMenu();
            if (typeof window.showCreateFolderModal === "function") window.showCreateFolderModal();
        });
    }
    if (addBucketOption) {
        addBucketOption.addEventListener('click', function() {
            if (addBucketOption.disabled || addBucketOption.classList.contains('hidden')) return;
            closeMenu();
            if (typeof window.openAddBucketModal === 'function') {
                window.openAddBucketModal();
            }
        });
    }

    document.addEventListener('click', function(e) {
        if (container.classList.contains('open') && !container.contains(e.target)) closeMenu();
    });

    document.addEventListener('dropdown:open', function(e) {
        if (!e || !e.detail || e.detail.source === 'upload') return;
        closeMenu();
    });
}


    global.setupLangDropdown = setupLangDropdown;
    global.setupUserMenuDropdown = setupUserMenuDropdown;
    global.setupUploadDropdown = setupUploadDropdown;

    function bootChromeMenus() {
        setupLangDropdown();
        if (global.ThemeManager) {
            global.ThemeManager.bindThemeToggle('themeToggleBtn', 'themeToggleIcon');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootChromeMenus);
    } else {
        bootChromeMenus();
    }
})(window);
