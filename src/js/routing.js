// URL / history routing
function getSettingsTabFromLocation() {
    var pathname = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
    if (pathname === '/settings') return 'buckets';
    if (pathname === '/settings/buckets') return 'buckets';
    if (pathname === '/settings/clouds') return 'clouds';
    if (pathname === '/settings/users') return 'users';
    if (pathname === '/settings/roles') return 'roles';
    if (pathname === '/settings/search') return 'search';
    if (pathname === '/settings/status') return 'status';
    var h = window.location.hash || '';
    if (h === '#settings/clouds') return 'clouds';
    if (h === '#settings/users') return 'users';
    if (h === '#settings/roles') return 'roles';
    if (h === '#settings/search') return 'search';
    if (h === '#settings/status') return 'status';
    if (h === '#settings' || h === '#settings/buckets') return 'buckets';
    return '';
}

function getSettingsPath(tab) {
    if (tab === 'clouds') return '/settings/clouds';
    if (tab === 'users') return '/settings/users';
    if (tab === 'roles') return '/settings/roles';
    if (tab === 'search') return '/settings/search';
    if (tab === 'status') return '/settings/status';
    return '/settings/buckets';
}

function updateSettingsURL(tab, replaceState = true) {
    var path = getSettingsPath(tab);
    var current = (window.location.pathname || '/') + (window.location.search || '');
    var target = path + (window.location.search || '');
    var state = {
        bucket: currentBucket || '',
        path: currentPath || '',
        settingsTab: tab || 'buckets',
        timestamp: Date.now()
    };
    var method = replaceState ? window.history.replaceState : window.history.pushState;
    if (current === target) {
        window.history.replaceState(state, I18N['app.title'] || 'S3 File Manager', target);
        return;
    }
    method.call(window.history, state, I18N['app.title'] || 'S3 File Manager', target);
}

/** Сегмент /bucket/<slug>: только bucket_name. */
function bucketSlugForUrl(bucketId) {
    var bid = (bucketId || '').trim();
    if (!bid) return '';
    var list = window.availableBuckets || [];
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (b && b.bucket_id === bid) {
            return (b.bucket_name || b.name || '').trim();
        }
    }
    if (
        bid === (window.fileManagerCurrentBucketId || '')
        && typeof window.fileManagerCurrentBucketName === 'string'
        && window.fileManagerCurrentBucketName.trim()
    ) {
        return window.fileManagerCurrentBucketName.trim();
    }
    return '';
}

/** Найти бакет по сегменту URL (только bucket_name). */
function findBucketByRouteSlug(slug) {
    var key = (slug || '').trim();
    if (!key) return null;
    var list = window.availableBuckets || [];
    for (var i = 0; i < list.length; i++) {
        var byName = list[i];
        if (!byName) continue;
        var bn = (byName.bucket_name || byName.name || '').trim();
        if (bn && bn === key) return byName;
    }
    return null;
}

/** Разобрать /bucket/<name>/… из pathname → { bucketId, path } или null. */
function routeStateFromPathname(pathname) {
    var segments = String(pathname || '').split('/').filter(function (s) { return s; });
    if (segments.length < 2 || segments[0] !== 'bucket') return null;
    var slug = decodeURIComponent(segments[1]);
    var bucket = findBucketByRouteSlug(slug);
    if (!bucket || !bucket.bucket_id) return null;
    var path = '';
    if (segments.length > 2) {
        path = segments.slice(2).map(function (s) {
            return decodeURIComponent(s);
        }).join('/') + '/';
    }
    return { bucketId: bucket.bucket_id, path: path, slug: slug };
}

function updateURL(bucketId = '', path = '', replaceState = false) {
    try {
        // Пока пользователь в /settings/* или /help/*, фоновые обновления URL
        // не должны перетирать адрес.
        if (!replaceState && (getSettingsTabFromLocation() || getHelpTabFromLocation())) {
            return;
        }
        // Устаревший вызов после смены бакета (loadFiles/selectBucket race)
        if (bucketId && bucketId.trim()) {
            var liveBucket = '';
            if (typeof window.__getCurrentBucket === 'function') {
                liveBucket = window.__getCurrentBucket() || '';
            } else {
                liveBucket = window.currentBucket || window.fileManagerCurrentBucketId || '';
            }
            if (liveBucket && liveBucket !== bucketId) {
                return;
            }
        }
        // Если нет бакета - это главная страница
        if (!bucketId || bucketId.trim() === '') {
            var homeMethod = replaceState ? window.history.replaceState : window.history.pushState;
            homeMethod.call(window.history,
                {
                    bucket: '',
                    path: '',
                    timestamp: Date.now()
                },
                I18N['app.title'] || 'S3 File Manager',
                '/'
            );
            document.title = I18N['app.title'] || 'S3 File Manager';
            return;
        }

        // В адресной строке — bucket_name; в history.state — bucket_id
        const slug = bucketSlugForUrl(bucketId);
        if (!slug) {
            console.warn('updateURL: no bucket_name for', bucketId);
            return;
        }
        const encodedBucket = encodeURIComponent(slug);
        let url = `/bucket/${encodedBucket}`;

        // Если есть путь, добавляем его
        if (path && path.trim() !== '') {
            // Убираем начальные и конечные слеши
            let cleanPath = path.replace(/^\/+|\/+$/g, '');

            if (cleanPath) {
                // Кодируем каждый сегмент пути отдельно
                const pathSegments = cleanPath.split('/');
                const encodedSegments = pathSegments.map(segment =>
                    encodeURIComponent(segment)
                );
                url += '/' + encodedSegments.join('/');
            }

            // Добавляем завершающий слеш для папок
            if (path.endsWith('/') && !url.endsWith('/')) {
                url += '/';
            }
        }

        const isSameURL = window.location.pathname === url;

        // Используем replaceState или pushState
        const stateUpdateMethod = replaceState
            ? window.history.replaceState
            : (isSameURL ? window.history.replaceState : window.history.pushState);

        const bucketTabLabel = window.getTabTitleBucketLabel(bucketId);
        const pageTitle = `${bucketTabLabel} - ${I18N['app.title'] || 'S3 File Manager'}`;

        // Обновляем историю браузера
        stateUpdateMethod.call(window.history,
            {
                bucket: bucketId,
                path: path,
                timestamp: Date.now()
            },
            pageTitle,
            url
        );

        // Обновляем заголовок вкладки (bucket_name, не bucket_id)
        document.title = pageTitle;

    } catch (error) {
        console.error('Error updating URL:', error);
    }
}
window.updateURL = updateURL;
window.bucketSlugForUrl = bucketSlugForUrl;
window.findBucketByRouteSlug = findBucketByRouteSlug;
window.routeStateFromPathname = routeStateFromPathname;

// Обработчик событий изменения истории
window.addEventListener('popstate', function(event) {
    console.log('popstate event triggered:', event.state);
    var helpTab = getHelpTabFromLocation();
    if (helpTab) {
        if (typeof window.openHelpByRoute === 'function') {
            window.openHelpByRoute(helpTab);
        }
        return;
    }
    var helpViewEl = document.getElementById('helpView');
    if (helpViewEl && !helpViewEl.classList.contains('hidden')) {
        helpViewEl.classList.add('hidden');
        var containerForHelp = document.querySelector('.container-content');
        if (containerForHelp) containerForHelp.classList.remove('hidden');
    }
    var settingsTab = getSettingsTabFromLocation();
    if (settingsTab) {
        if (typeof window.openSettingsByRoute === 'function') {
            window.openSettingsByRoute(settingsTab);
        }
        return;
    }
    // Ушли с /settings/* по истории: возвращаем файловый экран.
    var settingsView = document.getElementById('settingsView');
    var containerContent = document.querySelector('.container-content');
    if (settingsView && !settingsView.classList.contains('hidden')) {
        settingsView.classList.add('hidden');
        if (containerContent) containerContent.classList.remove('hidden');
        if (typeof window.updateFilesPaginationUI === 'function') {
            window.updateFilesPaginationUI();
        }
        window.availableBuckets = [];
        window.bucketsSidebarLoaded = false;
        if (typeof window.loadBuckets === 'function') {
            window.loadBuckets();
        }
    }

    // Состояние из history.state или из pathname (null state после полной перезагрузки)
    var state = event.state || null;
    var pathSegments = String(window.location.pathname || '').split('/').filter(function (s) {
        return s;
    });
    var urlLooksLikeBucket = pathSegments.length >= 2 && pathSegments[0] === 'bucket';

    function resolveNavTarget() {
        var bucketId = (state && state.bucket) || '';
        var path = (state && state.path) || '';
        if (!bucketId) {
            var fromUrl = routeStateFromPathname(window.location.pathname);
            if (fromUrl) {
                bucketId = fromUrl.bucketId;
                path = fromUrl.path;
            }
        }
        return { bucketId: bucketId, path: path };
    }

    function applyBucketNavigation(bucketId, path, bucketConfig) {
        if (currentBucket !== bucketId) {
            window.selectBucket(bucketConfig, path || '');
        } else {
            window.loadFiles(path || '');
        }
    }

    function navigateFromResolved(target) {
        var bucketId = target.bucketId;
        var path = target.path;
        console.log('State from history:', { bucketId: bucketId, path: path, state: state });

        if (!bucketId) {
            if (urlLooksLikeBucket) {
                var slug = decodeURIComponent(pathSegments[1] || '');
                window.showWarning(I18N['msg.bucket_not_found_or_unavailable'].replace('{name}', slug));
            }
            window.goToHome({ replaceState: true });
            return;
        }

        var bucketConfig = (window.availableBuckets || []).find(function (b) {
            return b && b.bucket_id === bucketId;
        });
        if (bucketConfig) {
            applyBucketNavigation(bucketId, path, bucketConfig);
            return;
        }

        console.warn('Bucket "' + bucketId + '" not found in availableBuckets');
        window.loadBuckets().then(function () {
            var refreshed = (window.availableBuckets || []).find(function (b) {
                return b && b.bucket_id === bucketId;
            });
            if (refreshed) {
                applyBucketNavigation(bucketId, path, refreshed);
            } else {
                var label = bucketId;
                var fromUrlAgain = routeStateFromPathname(window.location.pathname);
                if (fromUrlAgain && fromUrlAgain.slug) label = fromUrlAgain.slug;
                window.showWarning(I18N['msg.bucket_not_found_or_unavailable'].replace('{name}', label));
                window.goToHome();
            }
        });
    }

    var target = resolveNavTarget();
    if (!target.bucketId && urlLooksLikeBucket && !(window.availableBuckets || []).length) {
        // Список ещё пуст (например сразу после выхода из settings) — дождаться и разобрать URL
        var loadPromise = typeof window.loadBuckets === 'function'
            ? window.loadBuckets()
            : Promise.resolve();
        Promise.resolve(loadPromise).then(function () {
            navigateFromResolved(resolveNavTarget());
        });
        return;
    }
    navigateFromResolved(target);
});

// Функция обработки состояния из URL
async function handleURLState(bucketSlug, path = '') {
    console.log('handleURLState called:', bucketSlug, path);

    const bucketConfig = findBucketByRouteSlug(bucketSlug);
    if (bucketConfig) {
        await window.selectBucket(bucketConfig);

        // Если есть путь, загружаем его
        if (path) {
            // Убедимся, что путь имеет правильный формат
            if (!path.endsWith('/') && path !== '') {
                path += '/';
            }
            setTimeout(() => {
                window.loadFiles(path);
            }, 100);
        }
    }
}


// Настройка прав доступа пользователя (admin, storage_*)
function initializeFromURL() {
    try {
        var helpTab = getHelpTabFromLocation();
        if (helpTab) {
            if (typeof window.openHelpByRoute === 'function') {
                var helpViewEl = document.getElementById('helpView');
                if (!helpViewEl || helpViewEl.classList.contains('hidden')) {
                    window.openHelpByRoute(helpTab);
                }
            }
            return;
        }
        var settingsTab = getSettingsTabFromLocation();
        if (settingsTab) {
            if (typeof window.openSettingsByRoute === 'function') {
                var settingsViewEl = document.getElementById('settingsView');
                if (!settingsViewEl || settingsViewEl.classList.contains('hidden')) {
                    window.openSettingsByRoute(settingsTab);
                }
            }
            return;
        }
        const pathSegments = window.location.pathname.split('/').filter(segment => segment);

        if (pathSegments.length >= 2 && pathSegments[0] === 'bucket') {
            const bucketSlug = decodeURIComponent(pathSegments[1]);
            let path = '';

            if (pathSegments.length > 2) {
                // Восстанавливаем путь из оставшихся сегментов
                const pathParts = pathSegments.slice(2).map(segment => 
                    decodeURIComponent(segment)
                );
                path = pathParts.join('/') + '/';
            }

            let selectStarted = false;
            const selectFromBuckets = () => {
                if (selectStarted) return true;
                const bucketConfig = findBucketByRouteSlug(bucketSlug);
                if (bucketConfig) {
                    selectStarted = true;
                    // Загружаем бакет и сразу нужный путь (без мелькания корня)
                    window.selectBucket(bucketConfig, path);
                    return true;
                }
                if (window.bucketsSidebarLoaded) {
                    selectStarted = true;
                    window.showWarning(I18N['msg.bucket_not_found_or_unavailable'].replace('{name}', bucketSlug));
                    window.goToHome();
                    return true;
                }
                return false;
            };

            // Buckets are usually already loaded by checkAuthentication; poll only as fallback
            if (!selectFromBuckets()) {
                const checkInterval = setInterval(() => {
                    if (selectFromBuckets()) clearInterval(checkInterval);
                }, 50);
                setTimeout(() => clearInterval(checkInterval), 5000);
            }
        } else {
            // Это главная страница
            setTimeout(() => {
                updateURL('', '', true);
            }, 100);
        }
    } catch (error) {
        console.error('Error initializing from URL:', error);
    }
}


window.getSettingsTabFromLocation = getSettingsTabFromLocation;
window.getSettingsPath = getSettingsPath;
window.updateSettingsURL = updateSettingsURL;
window.handleURLState = handleURLState;
window.initializeFromURL = initializeFromURL;
