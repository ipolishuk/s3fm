// Primary toolbar lock / search input classes
function ensureUnifiedSearchInputClass(inputId) {
    const input = document.getElementById(inputId);
    if (input && !input.classList.contains('search-input')) {
        input.classList.add('search-input');
    }
}

function ensureUnifiedSearchInputs() {
    ensureUnifiedSearchInputClass('searchInput');
    ensureUnifiedSearchInputClass('bucketSearchInput');
    ensureUnifiedSearchInputClass('settingsSearchInput');
    ensureUnifiedSearchInputClass('helpDocSearchInput');
}

function setMainToolbarLocked(locked) {
    const toolbar = document.getElementById('primaryToolbar');
    if (!toolbar) return;
    toolbar.classList.remove('hidden');
    toolbar.style.display = 'flex';
    toolbar.classList.toggle('toolbar-locked', !!locked);
    toolbar.setAttribute('aria-disabled', locked ? 'true' : 'false');

    const uploadBtn = document.getElementById('uploadBtn');

    const controls = toolbar.querySelectorAll('button, input, select, textarea');
    controls.forEach(el => {
        if (el.classList && el.classList.contains('search-input')) {
            if (typeof window.setSearchFieldLocked === 'function') {
                window.setSearchFieldLocked(el, locked);
            }
            return;
        }
        if (locked) {
            if (!Object.prototype.hasOwnProperty.call(el.dataset, 'preLockDisabled')) {
                el.dataset.preLockDisabled = el.disabled ? '1' : '0';
            }
            el.disabled = true;
        } else if (Object.prototype.hasOwnProperty.call(el.dataset, 'preLockDisabled')) {
            el.disabled = el.dataset.preLockDisabled === '1';
            delete el.dataset.preLockDisabled;
        }
    });

    if (locked) {
        const uploadDropdown = document.getElementById('uploadDropdown');
        const uploadDropdownMenu = document.getElementById('uploadDropdownMenu');
        const clearSearchBtn = document.getElementById('clearSearchBtn');
        if (uploadDropdown) uploadDropdown.classList.remove('open');
        if (typeof window.resetDropdownMenuOverlay === 'function' && uploadDropdown) {
            window.resetDropdownMenuOverlay(uploadDropdown);
        } else {
            if (uploadDropdownMenu) uploadDropdownMenu.classList.add('hidden');
            if (uploadBtn) uploadBtn.setAttribute('aria-expanded', 'false');
        }
        if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
        if (typeof window.setupUserPermissions === 'function') {
            window.setupUserPermissions();
        }
    }
}


window.ensureUnifiedSearchInputs = ensureUnifiedSearchInputs;
window.setMainToolbarLocked = setMainToolbarLocked;
