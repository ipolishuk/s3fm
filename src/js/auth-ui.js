// Auth / current user
function isCurrentUserAdmin() {
    return !!(currentUser && String(currentUser.role || '').toLowerCase() === 'admin');
}
function isCurrentUserStorageAdmin() {
    return !!(currentUser && String(currentUser.role || '').toLowerCase() === 'storage_admin');
}
function canOpenSettings() {
    if (isCurrentUserAdmin() || isCurrentUserStorageAdmin()) return true;
    return typeof window.userHasPermission === 'function' && window.userHasPermission('add_bucket');
}
function isSettingsBucketsOnly() {
    return canOpenSettings() && !isCurrentUserAdmin();
}
function updateSettingsMenuItemVisibility() {
    const settingsMenuItem = document.getElementById('settingsMenuItem');
    if (!settingsMenuItem) return;
    const allow = canOpenSettings();
    settingsMenuItem.classList.toggle('hidden', !allow);
    if (allow) {
        settingsMenuItem.style.removeProperty('display');
        settingsMenuItem.removeAttribute('aria-hidden');
        settingsMenuItem.removeAttribute('tabindex');
    } else {
        settingsMenuItem.style.setProperty('display', 'none', 'important');
        settingsMenuItem.setAttribute('aria-hidden', 'true');
        settingsMenuItem.setAttribute('tabindex', '-1');
    }
    applySettingsNavBucketsOnly();
}
function applySettingsNavBucketsOnly() {
    var onlyBuckets = isSettingsBucketsOnly();
    ['settingsItemClouds', 'settingsItemUsers', 'settingsItemRoles', 'settingsItemSearch', 'settingsItemStatus'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', onlyBuckets);
    });
}

function setCurrentUser(user) {
    currentUser = user;
    window.fileManagerCurrentUser = user;
    updateSettingsMenuItemVisibility();
    if (typeof window.updateBucketsAddBtnVisibility === 'function') {
        window.updateBucketsAddBtnVisibility();
    }
}

function getActivePermissions(bucketId) {
    if (!currentUser) return [];
    const bid = bucketId || currentBucket;
    const role = String(currentUser.role || '').toLowerCase();
    if (role === 'admin' || role === 'storage_admin') {
        return currentUser.permissions || [];
    }
    if (bid && currentUser.bucket_permissions && Array.isArray(currentUser.bucket_permissions[bid])) {
        return currentUser.bucket_permissions[bid];
    }
    return currentUser.permissions || [];
}

function userHasPermission(perm, bucketId) {
    return getActivePermissions(bucketId).includes(perm);
}

window.getActivePermissions = getActivePermissions;
window.userHasPermission = userHasPermission;
window.availableBuckets = window.availableBuckets || [];
window.fileSearch = window.fileSearch || { mode: false, query: '', timeout: null };

function displayUserInfo() {
    if (currentUser) {
        const userSection = document.getElementById('userSection');
        const usernameDisplay = document.getElementById('usernameDisplay');

        usernameDisplay.textContent = String(currentUser.username || '').toLowerCase();
        userSection.style.display = 'flex';
        updateSettingsMenuItemVisibility();
    }
}


// Загрузка одной страницы списка файлов
async function checkAuthentication() {
    try {
        const response = await fetch('/api/check-auth', {
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();

            if (data.authenticated) {
                if (data.csrf_token && typeof window.setCsrfToken === 'function') {
                    window.setCsrfToken(data.csrf_token);
                }
                setCurrentUser({
                    username: data.username,
                    role: data.role,
                    permissions: data.permissions || [],
                    bucket_roles: data.bucket_roles || {},
                    bucket_permissions: data.bucket_permissions || {},
                    allowedBuckets: data.allowed_buckets,
                    allowedClouds: data.allowed_clouds,
                    email: data.email || null,
                    display_name: data.display_name || null,
                    has_custom_roles: !!data.has_custom_roles
                });

                // Устанавливаем таймаут сессии и периодическое обновление, пока пользователь на сайте
                if (typeof window.configureSessionFromAuth === 'function') {
                    window.configureSessionFromAuth(data);
                }

                displayUserInfo();
                // Загружаем бакеты после установки currentUser
                await window.loadBuckets();
                return true;
            } else if (data.session_expired) {
                if (typeof window.stopSessionRefreshInterval === 'function') {
                    window.stopSessionRefreshInterval();
                }
                if (typeof window.showSessionExpiredNotification === 'function') {
                    window.showSessionExpiredNotification();
                }
                setTimeout(() => {
                    window.location.href = '/login';
                }, 10000);
                return false;
            }
        }

        window.location.href = '/login';
        return false;
    } catch (error) {
        console.error('Auth check error:', error);
        window.location.href = '/login';
        return false;
    }
}
window.checkAuthentication = checkAuthentication;


// Функция logout с очисткой таймера
async function logout() {
    if (typeof window.clearSessionTimers === 'function') {
        window.clearSessionTimers();
    } else if (typeof window.stopSessionRefreshInterval === 'function') {
        window.stopSessionRefreshInterval();
    }

    // Выполняем стандартный logout
    window.showConfirmModal(
        (window.I18N || {})['msg.confirm_logout'],
        async () => {
            try {
                const response = await fetch('/api/logout', {
                    method: 'POST',
                    credentials: 'include'
                });
                var redirectUrl = '/login';
                try {
                    var data = await response.json();
                    if (data && data.redirect) redirectUrl = data.redirect;
                } catch (_e) {}

                window.location.href = redirectUrl;
            } catch (error) {
                console.error('Logout error:', error);
                window.location.href = '/login';
            }
        },
        'logout'
    );
}

// Инициализация из URL при загрузке страницы

window.isCurrentUserAdmin = isCurrentUserAdmin;
window.isCurrentUserStorageAdmin = isCurrentUserStorageAdmin;
window.canOpenSettings = canOpenSettings;
window.isSettingsBucketsOnly = isSettingsBucketsOnly;
window.applySettingsNavBucketsOnly = applySettingsNavBucketsOnly;
window.updateSettingsMenuItemVisibility = updateSettingsMenuItemVisibility;
window.setCurrentUser = setCurrentUser;
window.displayUserInfo = displayUserInfo;
window.logout = logout;
