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

function updateURL(bucketId = '', path = '', replaceState = false) {
    try {
        // Пока пользователь в /settings/* или /help/*, фоновые обновления URL
        // не должны перетирать адрес.
        if (!replaceState && (getSettingsTabFromLocation() || getHelpTabFromLocation())) {
            return;
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

        // Кодируем bucket_id
        const encodedBucket = encodeURIComponent(bucketId);
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

    // Получаем состояние из истории
    const state = event.state;

    if (state) {
        const bucketId = state.bucket || '';
        const path = state.path || '';

        console.log('State from history:', { bucketId, path });

        if (bucketId) {
            // Есть бакет в состоянии - загружаем его
            const bucketConfig = window.availableBuckets.find(b => b.bucket_id === bucketId);
            if (bucketConfig) {
                // Если бакет отличается от текущего, выбираем его
                if (currentBucket !== bucketId) {
                    window.selectBucket(bucketConfig).then(() => {
                        // После выбора бакета загружаем путь если есть
                        if (path) {
                            setTimeout(() => {
                                window.loadFiles(path);
                            }, 100);
                        }
                    });
                } else {
                    // Тот же бакет, просто загружаем путь
                    if (path) {
                        window.loadFiles(path);
                    } else {
                        // Пустая строка - корень бакета
                        window.loadFiles('');
                    }
                }
            } else {
                // Бакет не найден в доступных бакетах
                console.warn(`Bucket "${bucketId}" not found in availableBuckets`);

                // Пробуем перезагрузить бакеты
                window.loadBuckets().then(() => {
                    const refreshedBucketConfig = window.availableBuckets.find(b => b.bucket_id === bucketId);
                    if (refreshedBucketConfig) {
                        window.selectBucket(refreshedBucketConfig).then(() => {
                            if (path) {
                                setTimeout(() => {
                                    window.loadFiles(path);
                                }, 100);
                            }
                        });
                    } else {
                        window.showWarning(I18N['msg.bucket_not_found_or_unavailable'].replace('{name}', bucketId));
                        window.goToHome();
                    }
                });
            }
        } else {
            // Нет бакета в состоянии - это главная страница
            window.goToHome();
        }
    } else {
        // Нет состояния - это главная страница
        window.goToHome();
    }
});

// Функция обработки состояния из URL
async function handleURLState(bucketId, path = '') {
    console.log('handleURLState called:', bucketId, path);

    // Находим конфигурацию бакета по bucket_id
    const bucketConfig = window.availableBuckets.find(b => b.bucket_id === bucketId);
    if (bucketConfig) {
        // При загрузке из истории используем replaceState=false
        // чтобы сохранить запись в истории браузера
        const shouldReplaceState = false;

        // Выбираем бакет
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
            const bucketId = decodeURIComponent(pathSegments[1]);
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
                const bucketConfig = (window.availableBuckets || []).find(b => b.bucket_id === bucketId);
                if (bucketConfig) {
                    selectStarted = true;
                    // Загружаем бакет и сразу нужный путь (без мелькания корня)
                    window.selectBucket(bucketConfig, path);
                    return true;
                }
                if (window.bucketsSidebarLoaded) {
                    selectStarted = true;
                    window.showWarning(I18N['msg.bucket_not_found_or_unavailable'].replace('{name}', bucketId));
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
