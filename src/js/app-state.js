/**
 * Shared mutable UI state and bridges (classic script — vars are global).
 */
var currentPath = '';
var currentBucket = '';
window.fileManagerCurrentBucketId = '';
window.fileManagerCurrentBucketName = '';
window.fileManagerCurrentPath = '';
var selectionMode = false;
window.selectionMode = false;
var selectedItems = new Set();
window.selectedItems = selectedItems;
window.prefixWideSelection = false;
window.selectAllScopeLoading = false;
window.lastClickedSelectionElementId = null;
window.pendingShiftRangeClickTarget = null;
window.shiftRangeApplying = false;
var currentUser = null;

window.availableBuckets = window.availableBuckets || [];
window.fileSearch = window.fileSearch || { mode: false, query: '', timeout: null };

var filesLimit = 50;
var currentFilesPage = 1;
var filesPageStartTokens = [''];
var nextContinuationToken = '';
var isTruncated = false;
var hasPrevFilesPage = false;
var hasNextFilesPage = false;
var isFilesPageLoading = false;
var loadedItemsCount = 0;
window.loadedItemsCount = 0;
window.pendingFileListReveal = null;

window.__getCurrentUser = function () { return currentUser; };
window.__setCurrentUser = function (user) {
    currentUser = user || null;
    window.fileManagerCurrentUser = currentUser;
};
window.__getCurrentBucket = function () { return currentBucket; };
window.__setCurrentBucket = function (value) {
    currentBucket = value || '';
    window.fileManagerCurrentBucketId = currentBucket;
    window.currentBucket = currentBucket;
};
window.__getCurrentPath = function () { return currentPath; };
window.__setCurrentPath = function (value) {
    currentPath = value || '';
    window.fileManagerCurrentPath = currentPath;
    window.currentPath = currentPath;
};
window.__resetBucketPagingState = function () {
    nextContinuationToken = '';
    isTruncated = false;
    loadedItemsCount = 0;
    window.loadedItemsCount = 0;
};
window.__getSelectionMode = function () { return selectionMode; };
window.__setSelectionMode = function (value) {
    selectionMode = !!value;
    window.selectionMode = selectionMode;
};
window.__setSelectedItems = function (set) {
    selectedItems = set instanceof Set ? set : new Set(set || []);
    window.selectedItems = selectedItems;
};
window.__getSelectedItems = function () { return selectedItems; };
window.__paginationBridge = {
    getState: function () {
        return {
            currentBucket: currentBucket,
            currentPath: currentPath,
            currentFilesPage: currentFilesPage,
            filesPageStartTokens: filesPageStartTokens,
            nextContinuationToken: nextContinuationToken,
            isTruncated: isTruncated,
            hasPrevFilesPage: hasPrevFilesPage,
            hasNextFilesPage: hasNextFilesPage,
            isFilesPageLoading: isFilesPageLoading,
            filesLimit: filesLimit,
            loadedItemsCount: loadedItemsCount
        };
    },
    setState: function (patch) {
        if (!patch) return;
        if (Object.prototype.hasOwnProperty.call(patch, 'currentFilesPage')) currentFilesPage = patch.currentFilesPage;
        if (Object.prototype.hasOwnProperty.call(patch, 'filesPageStartTokens')) filesPageStartTokens = patch.filesPageStartTokens;
        if (Object.prototype.hasOwnProperty.call(patch, 'nextContinuationToken')) nextContinuationToken = patch.nextContinuationToken;
        if (Object.prototype.hasOwnProperty.call(patch, 'isTruncated')) isTruncated = patch.isTruncated;
        if (Object.prototype.hasOwnProperty.call(patch, 'hasPrevFilesPage')) hasPrevFilesPage = patch.hasPrevFilesPage;
        if (Object.prototype.hasOwnProperty.call(patch, 'hasNextFilesPage')) hasNextFilesPage = patch.hasNextFilesPage;
        if (Object.prototype.hasOwnProperty.call(patch, 'isFilesPageLoading')) isFilesPageLoading = patch.isFilesPageLoading;
        if (Object.prototype.hasOwnProperty.call(patch, 'loadedItemsCount')) {
            loadedItemsCount = patch.loadedItemsCount;
            window.loadedItemsCount = loadedItemsCount;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'filesLimit')) filesLimit = patch.filesLimit;
    },
    loadFiles: function (path, options) {
        return typeof window.loadFiles === 'function' ? window.loadFiles(path, options) : Promise.resolve();
    },
    i18n: function () { return window.I18N || {}; }
};
