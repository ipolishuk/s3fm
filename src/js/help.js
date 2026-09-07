/**
 * Страница справки: документация и поддержка (аналогично settings).
 */
(function () {
    'use strict';

    var docSectionsCache = null;
    var supportSectionsCache = null;

    function tr(key, fallback) {
        var v = (window.I18N || {})[key];
        return v != null && v !== '' ? v : (fallback || key);
    }

    function escapeHtml(text) {
        if (window.S3FM && typeof window.S3FM.escapeHtml === 'function') {
            return window.S3FM.escapeHtml(text);
        }
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderHelpSection(title, bodyHtml, options) {
        options = options || {};
        var attrs = options.searchable ? ' data-help-section="1"' : '';
        var headHtml = title
            ? '<div class="help-section-head"><span class="lables">' + escapeHtml(title) + '</span></div>'
            : '';
        return (
            '<section class="help-section"' + attrs + '>' +
            '<div class="help-section-card">' +
            headHtml +
            '<div class="help-section-body help-md">' + bodyHtml + '</div>' +
            '</div></section>'
        );
    }

    function renderSections(container, sections, searchable) {
        container.innerHTML = sections.map(function (section) {
            return renderHelpSection(section.title, section.html || '', { searchable: !!searchable });
        }).join('');
    }

    function fetchHelpSections(url, callback) {
        fetch(url, { credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('help load failed');
                return res.json();
            })
            .then(function (data) {
                callback(data.sections || [], false);
            })
            .catch(function () {
                callback([], true);
            });
    }

    function sectionMatchesQuery(section, query) {
        if (!query) return true;
        return (section.textContent || '').toLowerCase().indexOf(query) !== -1;
    }

    function getHelpTabFromLocation() {
        var pathname = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
        if (pathname === '/help') return 'documentation';
        if (pathname === '/help/documentation') return 'documentation';
        if (pathname === '/help/support') return 'support';
        var h = window.location.hash || '';
        if (h === '#help/support') return 'support';
        if (h === '#help' || h === '#help/documentation') return 'documentation';
        return '';
    }

    function getHelpPath(tab) {
        return tab === 'support' ? '/help/support' : '/help/documentation';
    }

    function updateHelpURL(tab, replaceState) {
        var path = getHelpPath(tab);
        var current = (window.location.pathname || '/') + (window.location.search || '');
        var target = path + (window.location.search || '');
        var state = {
            bucket: (typeof window.__getCurrentBucket === 'function' ? window.__getCurrentBucket() : '') || '',
            path: (typeof window.__getCurrentPath === 'function' ? window.__getCurrentPath() : '') || '',
            helpTab: tab || 'documentation',
            timestamp: Date.now(),
        };
        var method = replaceState ? window.history.replaceState : window.history.pushState;
        if (current === target) {
            window.history.replaceState(state, tr('app.title', 'S3 File Manager'), target);
            return;
        }
        method.call(window.history, state, tr('app.title', 'S3 File Manager'), target);
    }

    window.getHelpTabFromLocation = getHelpTabFromLocation;

    function setupHelpPanel() {
        var helpBtn = document.getElementById('helpMenuItem');
        var helpView = document.getElementById('helpView');
        var containerContent = document.querySelector('.container-content');
        var settingsView = document.getElementById('settingsView');
        var appTitleLink = document.querySelector('.app-title a');
        var helpItemDocumentation = document.getElementById('helpItemDocumentation');
        var helpItemSupport = document.getElementById('helpItemSupport');
        var helpContentInner = document.getElementById('helpContentInner');
        var helpNoResults = document.getElementById('helpNoResults');
        var helpToolbar = document.getElementById('helpToolbar');
        var helpDocSearchInput = document.getElementById('helpDocSearchInput');
        var helpDocSearchClear = document.getElementById('helpDocSearchClear');
        if (!helpBtn || !helpView || !containerContent || !helpContentInner) return;

        var docSearchQuery = '';

        function updateDocSearchClear() {
            if (!helpDocSearchClear) return;
            var q = (helpDocSearchInput && helpDocSearchInput.value || '').trim();
            helpDocSearchClear.classList.toggle('hidden', !q);
        }

        function applyDocumentationSearch(query) {
            docSearchQuery = (query || '').trim();
            var qLower = docSearchQuery.toLowerCase();
            var sections = helpContentInner.querySelectorAll('[data-help-section]');
            var visible = 0;
            sections.forEach(function (section) {
                var show = sectionMatchesQuery(section, qLower);
                section.classList.toggle('hidden', !show);
                if (show) visible += 1;
            });
            if (helpNoResults) {
                helpNoResults.classList.toggle('hidden', !qLower || visible > 0);
            }
            helpContentInner.classList.toggle('hidden', !!qLower && visible === 0);
        }

        function setHelpToolbarVisible(tab) {
            if (!helpToolbar) return;
            helpToolbar.classList.toggle('hidden', tab !== 'documentation');
        }

        function setActiveTab(tab) {
            if (helpItemDocumentation) {
                helpItemDocumentation.classList.toggle('active', tab === 'documentation');
            }
            if (helpItemSupport) {
                helpItemSupport.classList.toggle('active', tab === 'support');
            }
        }

        function showSections(sections, loadError, errorKey, searchable, loadingDone) {
            if (loadError || !sections.length) {
                helpContentInner.innerHTML = '<div class="content-empty">' +
                    escapeHtml(tr(errorKey, 'Failed to load')) + '</div>';
            } else {
                renderSections(helpContentInner, sections, searchable);
            }
            helpContentInner.classList.remove('hidden');
            if (loadingDone) loadingDone();
        }

        function showDocumentationSections(sections, loadError) {
            showSections(sections, loadError, 'help.doc_load_error', true, function () {
                applyDocumentationSearch(docSearchQuery);
            });
        }

        function showSupportSections(sections, loadError) {
            showSections(sections, loadError, 'help.support_load_error', false);
        }

        function renderTab(tab) {
            if (helpNoResults) helpNoResults.classList.add('hidden');
            setHelpToolbarVisible(tab);

            if (tab === 'support') {
                docSearchQuery = '';
                if (helpDocSearchInput) helpDocSearchInput.value = '';
                updateDocSearchClear();

                if (supportSectionsCache) {
                    showSupportSections(supportSectionsCache, false);
                    return;
                }

                helpContentInner.innerHTML = '<div class="content-empty">' +
                    escapeHtml(tr('help.support_loading', 'Loading...')) + '</div>';
                helpContentInner.classList.remove('hidden');
                fetchHelpSections('/api/help/support', function (sections, loadError) {
                    supportSectionsCache = sections;
                    if (getHelpTabFromLocation() !== 'support') return;
                    showSupportSections(sections, loadError);
                });
                return;
            }

            if (helpDocSearchInput && helpDocSearchInput.value !== docSearchQuery) {
                helpDocSearchInput.value = docSearchQuery;
            }
            updateDocSearchClear();

            if (docSectionsCache) {
                showDocumentationSections(docSectionsCache, false);
                return;
            }

            helpContentInner.innerHTML = '<div class="content-empty">' +
                escapeHtml(tr('help.doc_loading', 'Loading...')) + '</div>';
            helpContentInner.classList.remove('hidden');
            fetchHelpSections('/api/help/documentation', function (sections, loadError) {
                docSectionsCache = sections;
                if (getHelpTabFromLocation() !== 'documentation') return;
                showDocumentationSections(sections, loadError);
            });
        }

        function openHelp(activeTab, options) {
            options = options || {};
            var urlMode = options.urlMode || 'replace';
            var tab = activeTab || getHelpTabFromLocation() || 'documentation';
            if (settingsView) settingsView.classList.add('hidden');
            containerContent.classList.add('hidden');
            var appFooter = document.getElementById('appFooter');
            if (appFooter) appFooter.classList.add('hidden');
            helpView.classList.remove('hidden');
            setActiveTab(tab);
            renderTab(tab);
            if (urlMode === 'push') updateHelpURL(tab, false);
            else if (urlMode === 'replace') updateHelpURL(tab, true);
        }

        function closeHelp() {
            helpView.classList.add('hidden');
            if (helpToolbar) helpToolbar.classList.add('hidden');
            containerContent.classList.remove('hidden');
            if (typeof window.updateFilesPaginationUI === 'function') {
                window.updateFilesPaginationUI();
            }
            if (typeof window.updateURL === 'function') {
                var bucket = (typeof window.__getCurrentBucket === 'function' ? window.__getCurrentBucket() : '') || '';
                var path = (typeof window.__getCurrentPath === 'function' ? window.__getCurrentPath() : '') || '';
                window.updateURL(bucket, path, true);
            }
        }

        function onDocSearchInput() {
            docSearchQuery = helpDocSearchInput ? helpDocSearchInput.value : '';
            updateDocSearchClear();
            applyDocumentationSearch(docSearchQuery);
        }

        if (helpDocSearchInput) {
            helpDocSearchInput.addEventListener('input', onDocSearchInput);
            helpDocSearchInput.addEventListener('keyup', onDocSearchInput);
        }
        if (helpDocSearchClear) {
            helpDocSearchClear.addEventListener('click', function () {
                if (helpDocSearchInput) {
                    helpDocSearchInput.value = '';
                    helpDocSearchInput.focus();
                }
                onDocSearchInput();
            });
        }

        window.openHelpByRoute = function (tab) {
            openHelp(tab, { urlMode: 'none' });
        };

        window.closeHelpPanel = closeHelp;

        window.invalidateHelpCache = function () {
            docSectionsCache = null;
            supportSectionsCache = null;
        };

        helpBtn.addEventListener('click', function () {
            openHelp('documentation', { urlMode: 'push' });
        });

        var helpBackBtn = document.getElementById('helpBackBtn');
        if (helpBackBtn) helpBackBtn.addEventListener('click', closeHelp);

        if (appTitleLink) {
            appTitleLink.addEventListener('click', function (e) {
                if (helpView.classList.contains('hidden')) return;
                e.preventDefault();
                closeHelp();
            });
        }

        if (helpItemDocumentation) {
            helpItemDocumentation.addEventListener('click', function () {
                openHelp('documentation', { urlMode: 'push' });
            });
        }
        if (helpItemSupport) {
            helpItemSupport.addEventListener('click', function () {
                openHelp('support', { urlMode: 'push' });
            });
        }

        if (getHelpTabFromLocation()) {
            openHelp(null, { urlMode: 'replace' });
        }
    }

    window.setupHelpPanel = setupHelpPanel;
})();
