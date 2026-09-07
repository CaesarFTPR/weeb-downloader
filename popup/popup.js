// WeebCentral Kindle Downloader - Popup Script

const DEFAULT_SETTINGS = {
  format: 'cbz', // 'cbz' | 'zip' | 'images'
  packageMode: 'cumulative_tome', // 'cumulative_tome' | 'individual' | 'single_volume'
  folderName: '{title}',
  optimizeKindle: true,
  optimizedFormat: 'webp',
  maxResolution: 1680,
  imageQuality: 0.75,
  grayscale: true,
  cleanPaper: true,
  sharpenEink: true,
  filenameTemplate: '{chapter}',
  sshHost: 'kindle.local',
  sshPort: 2222,
  sshUser: 'root',
  sshPassword: '',
  sshKeyPath: '',
  remotePath: '/mnt/us/koreader/',
  localDownloads: '~/Downloads',
  saveToPc: true,
  saveToKindle: true,
  skipExisting: true
};

const sessionStore = chrome.storage.session || chrome.storage.local;

let currentManga = null;
let allChapters = [];
let selectedChapterIds = new Set();
let downloadedChapterIds = new Set();
let chapterSourceMap = new Map(); // chapterId -> { pc: boolean, kindle: boolean }
let isDownloading = false;
let wasDownloading = false;
let cancelRequested = false;
let hideDownloaded = false;
let currentReadingProgress = null;
let currentSettings = { ...DEFAULT_SETTINGS };

// DOM Elements
const elements = {
  // Header & Tabs
  btnPopout: document.getElementById('btn-popout'),
  tabBtnChapters: document.getElementById('tab-btn-chapters'),
  tabBtnSettings: document.getElementById('tab-btn-settings'),
  tabChapters: document.getElementById('tab-chapters'),
  tabSettings: document.getElementById('tab-settings'),
  statusBanner: document.getElementById('status-banner'),

  // Manga Info
  mangaCard: document.getElementById('manga-card'),
  mangaCover: document.getElementById('manga-cover'),
  mangaTitle: document.getElementById('manga-title'),
  chapterCountBadge: document.getElementById('chapter-count-badge'),
  selectionCountBadge: document.getElementById('selection-count-badge'),
  readingProgressBadge: document.getElementById('reading-progress-badge'),

  // Controls
  rangeInput: document.getElementById('range-input'),
  btnApplyRange: document.getElementById('btn-apply-range'),
  btnScanArchives: document.getElementById('btn-scan-archives'),
  btnSelectAll: document.getElementById('btn-select-all'),
  btnSelectNone: document.getElementById('btn-select-none'),
  btnSelectNext5: document.getElementById('btn-select-next-5'),
  btnSelectNext10: document.getElementById('btn-select-next-10'),
  btnInvertSelection: document.getElementById('btn-invert-selection'),
  btnSelectNew: document.getElementById('btn-select-new'),
  filterInput: document.getElementById('filter-input'),
  btnClearFilter: document.getElementById('btn-clear-filter'),
  btnToggleHideDownloaded: document.getElementById('btn-toggle-hide-downloaded'),
  iconToggleHide: document.getElementById('icon-toggle-hide'),
  textToggleHide: document.getElementById('text-toggle-hide'),

  // Chapter List
  chapterListLoading: document.getElementById('chapter-list-loading'),
  chapterListNotSeries: document.getElementById('chapter-list-not-series'),
  chapterList: document.getElementById('chapter-list'),

  // Progress & Actions
  progressContainer: document.getElementById('progress-container'),
  progressStatusText: document.getElementById('progress-status-text'),
  progressPercentText: document.getElementById('progress-percent-text'),
  progressBar: document.getElementById('progress-bar'),
  btnCancelDownload: document.getElementById('btn-cancel-download'),
  btnDownload: document.getElementById('btn-download'),
  btnDownloadLabel: document.getElementById('btn-download-label'),
  btnDeleteSelected: document.getElementById('btn-delete-selected'),
  btnDeleteLabel: document.getElementById('btn-delete-label'),

  // Delete Modal
  deleteModal: document.getElementById('delete-modal'),
  btnCloseDeleteModal: document.getElementById('btn-close-delete-modal'),
  btnCancelDelete: document.getElementById('btn-cancel-delete'),
  deleteModalSummary: document.getElementById('delete-modal-summary'),
  btnConfirmDeletePc: document.getElementById('btn-confirm-delete-pc'),
  btnConfirmDeleteKindle: document.getElementById('btn-confirm-delete-kindle'),
  btnConfirmDeleteBoth: document.getElementById('btn-confirm-delete-both'),

  // Target Devices Selector
  targetSavePc: document.getElementById('target-save-pc'),
  targetSaveKindle: document.getElementById('target-save-kindle'),
  labelTargetPc: document.getElementById('label-target-pc'),
  labelTargetKindle: document.getElementById('label-target-kindle'),
  destinationBarContainer: document.getElementById('destination-bar-container'),

  // Kindle Transfer Card
  btnTransferKindle: document.getElementById('btn-transfer-kindle'),
  btnCopyScp: document.getElementById('btn-copy-scp'),
  transferStatus: document.getElementById('transfer-status'),

  // Destination Picker
  destinationPathDisplay: document.getElementById('destination-path-display'),
  btnBrowseDestination: document.getElementById('btn-browse-destination'),
  btnSettingsBrowseDownloads: document.getElementById('btn-settings-browse-downloads'),

  // Settings
  settingFormat: document.getElementById('setting-format'),
  settingPackageMode: document.getElementById('setting-package-mode'),
  settingFolderName: document.getElementById('setting-folder-name'),
  settingFilenameTemplate: document.getElementById('setting-filename-template'),
  settingSkipExisting: document.getElementById('setting-skip-existing'),
  settingOptimizeKindle: document.getElementById('setting-optimize-kindle'),
  optimizationOptions: document.getElementById('optimization-options'),
  settingOptimizedFormat: document.getElementById('setting-optimized-format'),
  settingMaxResolution: document.getElementById('setting-max-resolution'),
  settingImageQuality: document.getElementById('setting-image-quality'),
  settingGrayscale: document.getElementById('setting-grayscale'),
  settingCleanPaper: document.getElementById('setting-clean-paper'),
  settingSharpenEink: document.getElementById('setting-sharpen-eink'),
  settingSshHost: document.getElementById('setting-ssh-host'),
  settingSshPort: document.getElementById('setting-ssh-port'),
  settingSshUser: document.getElementById('setting-ssh-user'),
  settingSshPassword: document.getElementById('setting-ssh-password'),
  settingSshKeyPath: document.getElementById('setting-ssh-key-path'),
  settingRemotePath: document.getElementById('setting-remote-path'),
  settingLocalDownloads: document.getElementById('setting-local-downloads'),
  btnTestSsh: document.getElementById('btn-test-ssh'),
  sshTestResult: document.getElementById('ssh-test-result'),
  btnSaveSettings: document.getElementById('btn-save-settings')
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();

  // Check ongoing background download state
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_STATE' });
    if (res && res.state && (res.state.isDownloading || res.state.percent > 0)) {
      syncDownloadState(res.state);
    }
  } catch (e) {}

  initPageDetection();
});

/**
 * Setup UI Event Listeners
 */
function setupEventListeners() {
  // Standalone Pop-out Window
  if (elements.btnPopout) {
    if (window.location.search.includes('standalone=true')) {
      elements.btnPopout.style.display = 'none';
    } else {
      elements.btnPopout.addEventListener('click', () => {
        chrome.windows.create({
          url: chrome.runtime.getURL('popup/popup.html?standalone=true'),
          type: 'popup',
          width: 500,
          height: 630
        });
        window.close();
      });
    }
  }

  // Background download progress updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'DOWNLOAD_PROGRESS') {
      syncDownloadState(msg.state);
    } else if (msg.action === 'ARCHIVES_AUTO_SCANNED') {
      if (currentManga && currentManga.seriesId === msg.seriesId) {
        loadSavedDownloadedChapters(currentManga.seriesId).then(() => {
          renderChapterList();
        });
      }
    }
  });

  // Tab Switching
  elements.tabBtnChapters.addEventListener('click', () => switchTab('chapters'));
  elements.tabBtnSettings.addEventListener('click', () => switchTab('settings'));

  // Selection
  elements.btnApplyRange.addEventListener('click', applyRangeSelection);
  if (elements.btnScanArchives) {
    elements.btnScanArchives.addEventListener('click', () => scanArchivesAndMarkChapters(true));
  }
  elements.rangeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyRangeSelection();
  });
  elements.btnSelectAll.addEventListener('click', selectAllChapters);
  elements.btnSelectNone.addEventListener('click', selectNoneChapters);
  if (elements.btnSelectNext5) {
    elements.btnSelectNext5.addEventListener('click', () => selectNextChapters(5));
  }
  if (elements.btnSelectNext10) {
    elements.btnSelectNext10.addEventListener('click', () => selectNextChapters(10));
  }
  elements.btnInvertSelection.addEventListener('click', invertChapterSelection);
  if (elements.btnSelectNew) {
    elements.btnSelectNew.addEventListener('click', selectNewChapters);
  }
  elements.filterInput.addEventListener('input', () => {
    if (elements.btnClearFilter) {
      elements.btnClearFilter.classList.toggle('hidden', !elements.filterInput.value);
    }
    applyChapterFilter();
  });
  if (elements.btnClearFilter) {
    elements.btnClearFilter.addEventListener('click', () => {
      elements.filterInput.value = '';
      elements.btnClearFilter.classList.add('hidden');
      applyChapterFilter();
      elements.filterInput.focus();
    });
  }
  if (elements.btnToggleHideDownloaded) {
    elements.btnToggleHideDownloaded.addEventListener('click', () => {
      hideDownloaded = !hideDownloaded;
      updateHideDownloadedButton();
      renderChapterList();
    });
  }

  // Target Devices Checkboxes
  if (elements.targetSavePc) {
    elements.targetSavePc.addEventListener('change', () => {
      if (!elements.targetSavePc.checked && !elements.targetSaveKindle.checked) {
        elements.targetSaveKindle.checked = true;
        showBanner('Select at least one destination (PC or Kindle)', 'info', 2000);
      }
      updateTargetDeviceUI();
    });
  }

  if (elements.targetSaveKindle) {
    elements.targetSaveKindle.addEventListener('change', () => {
      if (!elements.targetSaveKindle.checked && !elements.targetSavePc.checked) {
        elements.targetSavePc.checked = true;
        showBanner('Select at least one destination (PC or Kindle)', 'info', 2000);
      }
      updateTargetDeviceUI();
    });
  }

  // Actions
  elements.btnDownload.addEventListener('click', startDownloadPipeline);
  elements.btnCancelDownload.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD_PIPELINE' });
    showBanner('Cancelling download...', 'info');
  });

  // Kindle Actions
  elements.btnTransferKindle.addEventListener('click', transferToKindle);
  elements.btnCopyScp.addEventListener('click', copyScpCommand);

  // Delete Actions
  if (elements.btnDeleteSelected) {
    elements.btnDeleteSelected.addEventListener('click', openDeleteModal);
  }
  if (elements.btnCloseDeleteModal) {
    elements.btnCloseDeleteModal.addEventListener('click', closeDeleteModal);
  }
  if (elements.btnCancelDelete) {
    elements.btnCancelDelete.addEventListener('click', closeDeleteModal);
  }
  if (elements.deleteModal) {
    elements.deleteModal.addEventListener('click', (e) => {
      if (e.target === elements.deleteModal) {
        closeDeleteModal();
      }
    });
  }
  if (elements.btnConfirmDeletePc) {
    elements.btnConfirmDeletePc.addEventListener('click', () => executeDeleteChapters('pc'));
  }
  if (elements.btnConfirmDeleteKindle) {
    elements.btnConfirmDeleteKindle.addEventListener('click', () => executeDeleteChapters('kindle'));
  }
  if (elements.btnConfirmDeleteBoth) {
    elements.btnConfirmDeleteBoth.addEventListener('click', () => executeDeleteChapters('both'));
  }

  // Settings Actions
  if (elements.btnBrowseDestination) {
    elements.btnBrowseDestination.addEventListener('click', pickLocalDownloadFolder);
  }
  if (elements.destinationPathDisplay) {
    elements.destinationPathDisplay.addEventListener('click', pickLocalDownloadFolder);
  }
  if (elements.btnSettingsBrowseDownloads) {
    elements.btnSettingsBrowseDownloads.addEventListener('click', pickLocalDownloadFolder);
  }
  if (elements.settingFolderName) {
    elements.settingFolderName.addEventListener('input', () => {
      currentSettings.folderName = elements.settingFolderName.value.trim() || '{title}';
      updateDestinationPathDisplay();
    });
  }
  if (elements.settingLocalDownloads) {
    elements.settingLocalDownloads.addEventListener('input', () => {
      currentSettings.localDownloads = elements.settingLocalDownloads.value.trim() || '~/Downloads';
      updateDestinationPathDisplay();
    });
  }

  if (elements.settingOptimizeKindle) {
    elements.settingOptimizeKindle.addEventListener('change', () => {
      if (elements.optimizationOptions) {
        elements.optimizationOptions.classList.toggle('hidden', !elements.settingOptimizeKindle.checked);
      }
    });
  }
  elements.btnTestSsh.addEventListener('click', testSshConnection);
  elements.btnSaveSettings.addEventListener('click', saveSettings);

  // Status banner click to dismiss
  if (elements.statusBanner) {
    elements.statusBanner.addEventListener('click', () => {
      if (bannerTimer) {
        clearTimeout(bannerTimer);
        bannerTimer = null;
      }
      elements.statusBanner.className = 'status-banner hidden';
    });
  }
}

/**
 * Synchronize UI with Background Download State
 */
function syncDownloadState(state) {
  if (!state) return;

  if (state.isDownloading) {
    wasDownloading = true;
    isDownloading = true;
    elements.progressContainer.classList.remove('hidden');
    elements.progressBar.style.width = `${state.percent}%`;
    elements.progressPercentText.textContent = `${state.percent}%`;
    elements.progressStatusText.textContent = state.statusText || 'Downloading in background...';
    elements.btnDownload.disabled = true;
  } else if (state.isCompleted) {
    isDownloading = false;
    elements.progressBar.style.width = '100%';
    elements.progressPercentText.textContent = '100%';
    elements.progressStatusText.textContent = state.statusText || 'Completed!';
    elements.btnDownload.disabled = selectedChapterIds.size === 0;
    setTimeout(() => {
      if (!isDownloading) {
        elements.progressContainer.classList.add('hidden');
      }
    }, 5000);
    if (currentManga && currentManga.seriesId) {
      loadSavedDownloadedChapters(currentManga.seriesId).then(() => {
        renderChapterList();
      });
      // Automatically trigger archive check on PC and Kindle if a download just finished
      if (wasDownloading) {
        wasDownloading = false;
        scanArchivesAndMarkChapters(false);
      }
    }
  } else if (state.error) {
    wasDownloading = false;
    isDownloading = false;
    elements.progressStatusText.textContent = `Error: ${state.error}`;
    elements.btnDownload.disabled = selectedChapterIds.size === 0;
  } else {
    isDownloading = false;
    elements.btnDownload.disabled = selectedChapterIds.size === 0;
  }
}

/**
 * Switch Navigation Tab
 */
function switchTab(tab) {
  if (tab === 'chapters') {
    elements.tabBtnChapters.classList.add('active');
    elements.tabBtnSettings.classList.remove('active');
    elements.tabChapters.classList.add('active');
    elements.tabSettings.classList.remove('active');
  } else {
    elements.tabBtnChapters.classList.remove('active');
    elements.tabBtnSettings.classList.add('active');
    elements.tabChapters.classList.remove('active');
    elements.tabSettings.classList.add('active');
  }
}

/**
 * Show temporary top banner message
 */
let bannerTimer = null;
function showBanner(message, type = 'info', timeoutMs = 3500) {
  if (bannerTimer) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = `status-banner ${type}`;
  if (timeoutMs > 0) {
    bannerTimer = setTimeout(() => {
      elements.statusBanner.className = 'status-banner hidden';
      bannerTimer = null;
    }, timeoutMs);
  }
}

/**
 * Update the destination folder display on the main Download tab
 */
function updateDestinationPathDisplay() {
  if (!elements.destinationPathDisplay) return;

  const base = (currentSettings.localDownloads || '~/Downloads').replace(/\/+$/, '');
  let targetFolder = currentSettings.folderName || '{title}';
  if (currentManga && currentManga.title) {
    targetFolder = targetFolder.replace('{title}', currentManga.title).trim();
    targetFolder = sanitizeFilename(targetFolder);
  } else {
    targetFolder = targetFolder.replace('{title}', 'Manga');
  }

  const fullPath = `${base}/${targetFolder}/`;
  const displayPath = fullPath.replace(/^\/Users\/[^/]+/, '~');
  elements.destinationPathDisplay.textContent = displayPath;
  elements.destinationPathDisplay.title = `Saving to: ${fullPath} (Click "Browse" to choose another folder)`;
}

/**
 * Update target devices UI (PC / Kindle / Both)
 */
function updateTargetDeviceUI() {
  const savePc = elements.targetSavePc ? elements.targetSavePc.checked : true;
  const saveKindle = elements.targetSaveKindle ? elements.targetSaveKindle.checked : true;

  if (elements.labelTargetPc) {
    elements.labelTargetPc.classList.toggle('active', savePc);
  }
  if (elements.labelTargetKindle) {
    elements.labelTargetKindle.classList.toggle('active', saveKindle);
  }

  if (elements.destinationBarContainer) {
    if (!savePc && saveKindle) {
      elements.destinationBarContainer.style.opacity = '0.55';
      if (elements.destinationPathDisplay) {
        elements.destinationPathDisplay.textContent = 'Direct to Kindle (/mnt/us/koreader/)';
        elements.destinationPathDisplay.title = 'Manga will be transferred directly to Kindle and not saved on PC.';
      }
    } else {
      elements.destinationBarContainer.style.opacity = '1';
      updateDestinationPathDisplay();
    }
  }

  if (elements.btnDownloadLabel) {
    const count = selectedChapterIds.size;
    const countSuffix = count > 0 ? ` (${count})` : '';
    if (savePc && saveKindle) {
      elements.btnDownloadLabel.textContent = `Download to PC & Kindle${countSuffix}`;
    } else if (savePc) {
      elements.btnDownloadLabel.textContent = `Download to PC${countSuffix}`;
    } else if (saveKindle) {
      elements.btnDownloadLabel.textContent = `Download to Kindle${countSuffix}`;
    }
  }

  currentSettings.saveToPc = savePc;
  currentSettings.saveToKindle = saveKindle;

  chrome.storage.sync.set({ weeb_kindle_settings: currentSettings }).catch(() => {});
}

/**
 * Open native OS folder picker dialog to select download directory
 */
async function pickLocalDownloadFolder() {
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'CHOOSE_LOCAL_FOLDER',
      prompt: 'Select download folder for manga:'
    });

    if (res && res.success && res.result && res.result.status === 'success' && res.result.path) {
      const chosenPath = res.result.path.trim();
      currentSettings.localDownloads = chosenPath;
      if (elements.settingLocalDownloads) {
        elements.settingLocalDownloads.value = chosenPath;
      }
      await chrome.storage.sync.set({ weeb_kindle_settings: currentSettings });
      updateDestinationPathDisplay();
      showBanner(`📁 Download folder set to: ${chosenPath}`, 'success', 3000);

      // Load saved downloaded chapters for display
      if (currentManga && currentManga.seriesId) {
        await loadSavedDownloadedChapters(currentManga.seriesId);
        renderChapterList();
      }
      return chosenPath;
    } else if (res && res.result && res.result.status === 'cancelled') {
      return null;
    } else {
      throw new Error(res?.error || res?.result?.message || 'Native host unavailable');
    }
  } catch (err) {
    console.warn('Native folder picker fallback:', err);
    const current = currentSettings.localDownloads || '~/Downloads';
    const entered = window.prompt('Enter local download folder path on your computer:', current);
    if (entered && entered.trim()) {
      const chosenPath = entered.trim();
      currentSettings.localDownloads = chosenPath;
      if (elements.settingLocalDownloads) {
        elements.settingLocalDownloads.value = chosenPath;
      }
      await chrome.storage.sync.set({ weeb_kindle_settings: currentSettings });
      updateDestinationPathDisplay();
      showBanner(`📁 Download folder set to: ${chosenPath}`, 'success', 3000);

      if (currentManga && currentManga.seriesId) {
        await loadSavedDownloadedChapters(currentManga.seriesId);
        renderChapterList();
      }
      return chosenPath;
    }
    return null;
  }
}

/**
 * Load Settings from Chrome Storage
 */
async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get('weeb_kindle_settings');
    if (stored && stored.weeb_kindle_settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...stored.weeb_kindle_settings };
    }
  } catch (e) {
    console.warn('Failed to load settings from storage.sync, using defaults', e);
  }

  // Populate settings form
  elements.settingFormat.value = currentSettings.format;
  elements.settingPackageMode.value = currentSettings.packageMode;
  elements.settingFolderName.value = currentSettings.folderName;
  elements.settingSshHost.value = currentSettings.sshHost;
  elements.settingSshPort.value = currentSettings.sshPort;
  elements.settingSshUser.value = currentSettings.sshUser;
  elements.settingSshPassword.value = currentSettings.sshPassword || '';
  elements.settingSshKeyPath.value = currentSettings.sshKeyPath || '';
  elements.settingRemotePath.value = currentSettings.remotePath;
  elements.settingLocalDownloads.value = currentSettings.localDownloads;
  if (elements.settingSkipExisting) {
    elements.settingSkipExisting.checked = currentSettings.skipExisting !== false;
  }
  if (elements.settingOptimizeKindle) {
    elements.settingOptimizeKindle.checked = currentSettings.optimizeKindle !== false;
    if (elements.optimizationOptions) {
      elements.optimizationOptions.classList.toggle('hidden', !elements.settingOptimizeKindle.checked);
    }
  }
  if (elements.settingOptimizedFormat) {
    elements.settingOptimizedFormat.value = currentSettings.optimizedFormat || 'webp';
  }
  if (elements.settingMaxResolution) {
    elements.settingMaxResolution.value = String(currentSettings.maxResolution !== undefined ? currentSettings.maxResolution : 1680);
  }
  if (elements.settingImageQuality) {
    elements.settingImageQuality.value = String(currentSettings.imageQuality !== undefined ? currentSettings.imageQuality : 0.75);
  }
  if (elements.settingFilenameTemplate) {
    elements.settingFilenameTemplate.value = currentSettings.filenameTemplate || '{chapter}';
  }
  if (elements.settingGrayscale) {
    elements.settingGrayscale.checked = currentSettings.grayscale !== false;
  }
  if (elements.settingCleanPaper) {
    elements.settingCleanPaper.checked = currentSettings.cleanPaper !== false;
  }
  if (elements.settingSharpenEink) {
    elements.settingSharpenEink.checked = currentSettings.sharpenEink !== false;
  }

  updateDestinationPathDisplay();

  if (elements.targetSavePc) {
    elements.targetSavePc.checked = currentSettings.saveToPc !== false;
  }
  if (elements.targetSaveKindle) {
    elements.targetSaveKindle.checked = currentSettings.saveToKindle !== false;
  }
  updateTargetDeviceUI();
}

/**
 * Save Settings to Chrome Storage
 */
async function saveSettings() {
  currentSettings = {
    format: elements.settingFormat.value,
    packageMode: elements.settingPackageMode.value,
    folderName: elements.settingFolderName.value.trim() || '{title}',
    filenameTemplate: elements.settingFilenameTemplate ? elements.settingFilenameTemplate.value : '{chapter}',
    skipExisting: elements.settingSkipExisting ? elements.settingSkipExisting.checked : true,
    optimizeKindle: elements.settingOptimizeKindle ? elements.settingOptimizeKindle.checked : true,
    optimizedFormat: elements.settingOptimizedFormat ? elements.settingOptimizedFormat.value : 'webp',
    maxResolution: elements.settingMaxResolution ? parseInt(elements.settingMaxResolution.value, 10) : 1680,
    imageQuality: elements.settingImageQuality ? parseFloat(elements.settingImageQuality.value) : 0.75,
    grayscale: elements.settingGrayscale ? elements.settingGrayscale.checked : true,
    cleanPaper: elements.settingCleanPaper ? elements.settingCleanPaper.checked : true,
    sharpenEink: elements.settingSharpenEink ? elements.settingSharpenEink.checked : true,
    sshHost: elements.settingSshHost.value.trim() || 'kindle.local',
    sshPort: parseInt(elements.settingSshPort.value, 10) || 2222,
    sshUser: elements.settingSshUser.value.trim() || 'root',
    sshPassword: elements.settingSshPassword.value,
    sshKeyPath: elements.settingSshKeyPath.value.trim(),
    remotePath: elements.settingRemotePath.value.trim() || '/mnt/us/koreader/',
    localDownloads: elements.settingLocalDownloads.value.trim() || '~/Downloads',
    saveToPc: elements.targetSavePc ? elements.targetSavePc.checked : (currentSettings.saveToPc !== false),
    saveToKindle: elements.targetSaveKindle ? elements.targetSaveKindle.checked : (currentSettings.saveToKindle !== false)
  };

  try {
    await chrome.storage.sync.set({ weeb_kindle_settings: currentSettings });
    updateDestinationPathDisplay();
    showBanner('✅ Settings saved successfully!', 'success');
  } catch (e) {
    showBanner('❌ Failed to save settings: ' + e.message, 'error');
  }
}

/**
 * Initialize detection of the active WeebCentral tab
 */
async function initPageDetection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('weebcentral.com')) {
    elements.chapterListLoading.classList.add('hidden');
    elements.chapterListNotSeries.classList.remove('hidden');
    elements.mangaTitle.textContent = 'Not a WeebCentral tab';
    return;
  }

  // Fast restore from session cache for instant display
  try {
    const cacheKey = 'cache_tab_' + tab.id;
    const cached = await sessionStore.get(cacheKey);
    if (cached && cached[cacheKey] && cached[cacheKey].url === tab.url) {
      const data = cached[cacheKey];
      currentManga = data.manga;
      allChapters = data.chapters;
      elements.mangaTitle.textContent = currentManga.title;
      elements.mangaTitle.title = currentManga.title;
      if (currentManga.coverUrl) {
        elements.mangaCover.src = currentManga.coverUrl;
      }
      elements.chapterCountBadge.textContent = `${allChapters.length} chapters`;
      elements.chapterListLoading.classList.add('hidden');
      elements.chapterListNotSeries.classList.add('hidden');

      // Restore saved selection
      const selKey = 'selection_' + currentManga.seriesId;
      const storedSel = await sessionStore.get(selKey);
      if (storedSel && Array.isArray(storedSel[selKey])) {
        selectedChapterIds = new Set(storedSel[selKey].filter(id => allChapters.some(c => c.id === id)));
      }
      await loadSavedDownloadedChapters(currentManga.seriesId);
      updateSelectionBadge();
      renderChapterList();
    }
  } catch (e) {}

  // Communicate with content script for fresh data
  try {
    await ensureContentScript(tab.id);
    await loadMangaAndChapters(tab.id);
  } catch (err) {
    console.error('Error loading manga info:', err);
    if (!currentManga) {
      elements.chapterListLoading.classList.add('hidden');
      elements.chapterListNotSeries.classList.remove('hidden');
      elements.chapterListNotSeries.innerHTML = `<p>⚠️ Could not connect to page: ${err.message}</p>`;
      elements.mangaTitle.textContent = 'Error loading page';
    }
  }
}

/**
 * Ensure content script is injected in the tab
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    if (pong && pong.status === 'pong') return;
  } catch (e) {
    // Inject manually if tab was open before extension installed
    console.log('Injecting content script into tab', tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    // Brief delay to allow content script to register listener
    await new Promise(r => setTimeout(r, 150));
  }
}

/**
 * Request manga metadata and chapter list from content script
 */
async function loadMangaAndChapters(tabId) {
  // 1. Get manga info
  const infoRes = await chrome.tabs.sendMessage(tabId, { action: 'GET_MANGA_INFO' });
  if (!infoRes || !infoRes.success) {
    throw new Error(infoRes?.error || 'Could not fetch manga info.');
  }

  currentManga = infoRes.data;
  elements.mangaTitle.textContent = currentManga.title;
  elements.mangaTitle.title = currentManga.title;
  if (currentManga.coverUrl) {
    elements.mangaCover.src = currentManga.coverUrl;
  }

  // If subfolder setting has default placeholder, show manga title
  if (!elements.settingFolderName.value || elements.settingFolderName.value === '{title}') {
    elements.settingFolderName.placeholder = currentManga.title;
  }
  updateDestinationPathDisplay();

  // 2. Get chapter list
  const chaptersRes = await chrome.tabs.sendMessage(tabId, {
    action: 'GET_CHAPTER_LIST',
    seriesId: currentManga.seriesId
  });

  if (!chaptersRes || !chaptersRes.success) {
    throw new Error(chaptersRes?.error || 'Could not fetch chapters.');
  }

  allChapters = chaptersRes.data;
  elements.chapterCountBadge.textContent = `${allChapters.length} chapters`;

  // 3. Load previously saved downloaded chapters from storage (without polling PC or Kindle)
  await loadSavedDownloadedChapters(currentManga.seriesId);

  // Restore selection
  try {
    const selKey = 'selection_' + currentManga.seriesId;
    const storedSel = await sessionStore.get(selKey);
    if (storedSel && Array.isArray(storedSel[selKey])) {
      selectedChapterIds = new Set(storedSel[selKey].filter(id => allChapters.some(c => c.id === id)));
    }
  } catch (e) {}

  // Cache in session store for fast re-open
  sessionStore.set({
    ['cache_tab_' + tabId]: {
      url: currentManga.currentUrl || '',
      manga: currentManga,
      chapters: allChapters
    }
  }).catch(() => {});

  updateSelectionBadge();
  renderChapterList();
}

/**
 * Load saved downloaded chapters and sources from chrome.storage without polling PC or Kindle
 */
async function loadSavedDownloadedChapters(seriesId) {
  try {
    const key = 'downloaded_' + seriesId;
    const srcKey = 'sources_' + seriesId;
    const readKey = 'reading_' + seriesId;
    const stored = await chrome.storage.local.get([key, srcKey, readKey]);
    if (stored[key] && Array.isArray(stored[key])) {
      downloadedChapterIds = new Set(stored[key]);
    } else {
      downloadedChapterIds.clear();
    }
    chapterSourceMap.clear();
    if (stored[srcKey] && typeof stored[srcKey] === 'object') {
      for (const [id, src] of Object.entries(stored[srcKey])) {
        chapterSourceMap.set(id, src);
      }
    }
    if (stored[readKey] && typeof stored[readKey] === 'object') {
      currentReadingProgress = stored[readKey];
      updateReadingProgressBadge(currentReadingProgress);
    } else {
      currentReadingProgress = null;
      updateReadingProgressBadge(null);
    }
  } catch (e) {
    console.warn('Could not load saved chapter history:', e);
  }
}

/**
 * Standardize chapter key (e.g. 'Chapter 1' -> 'ch_1', 'Ch. 281.5' -> 'ch_281.5')
 */
function getChapterKey(name, num) {
  if (num !== undefined && num !== null && !isNaN(num)) {
    const n = Number(num);
    return `ch_${Number.isInteger(n) ? n : n}`;
  }
  if (!name) return '';
  const s = String(name).toLowerCase();
  const m = s.match(/(?:chapter|ch\.?|гл\.?|глава)\s*(\d+(?:\.\d+)?)/i) || s.match(/(\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    return `ch_${Number.isInteger(n) ? n : n}`;
  }
  if (s.includes('cover') || s.includes('обложк')) return 'cover';
  return s.replace(/^\d+[\._\-]\s*/, '').trim();
}

/**
 * Query cumulative archive and chapters across PC and Kindle
 */
async function scanArchivesAndMarkChapters(manualTrigger = false) {
  if (!currentManga || allChapters.length === 0) return;

  if (manualTrigger && elements.btnScanArchives) {
    elements.btnScanArchives.disabled = true;
    elements.btnScanArchives.classList.add('loading');
    elements.btnScanArchives.innerHTML = '<span class="spinner-sm"></span><span>Checking...</span>';
  }

  try {
    let targetFolder = currentSettings.folderName || '{title}';
    targetFolder = targetFolder.replace('{title}', currentManga.title).trim();
    targetFolder = sanitizeFilename(targetFolder);

    const localBase = (currentSettings.localDownloads || '~/Downloads').replace(/\/+$/, '');
    const localFullPath = `${localBase}/${targetFolder}`;
    const cleanRemoteBase = (currentSettings.remotePath || '/mnt/us/koreader/').replace(/\/+$/, '');
    const remoteFullPath = `${cleanRemoteBase}/${targetFolder}`;
    const volumeName = `${sanitizeFilename(currentManga.title)}.cbz`;

    const res = await chrome.runtime.sendMessage({
      action: 'SCAN_ARCHIVES',
      localFolder: localFullPath,
      volumeName: volumeName,
      remoteFolder: remoteFullPath,
      remoteBase: cleanRemoteBase,
      host: currentSettings.sshHost || 'kindle.local',
      port: currentSettings.sshPort || 2222,
      user: currentSettings.sshUser || 'root',
      password: currentSettings.sshPassword || '',
      keyPath: currentSettings.sshKeyPath || ''
    });

    if (res && res.success && res.result && res.result.status === 'success') {
      const data = res.result;
      const pcKeys = new Set(data.pc?.chapter_keys || []);
      const kindleKeys = new Set(data.kindle?.chapter_keys || []);
      const kindleChecked = data.kindle?.connected !== false;

      let matchedCount = 0;
      allChapters.forEach(ch => {
        const keyByName = getChapterKey(ch.name);
        const keyByNum = ch.chapterNumber !== null ? `ch_${Number.isInteger(ch.chapterNumber) ? ch.chapterNumber : ch.chapterNumber}` : '';
        const hasPc = pcKeys.has(keyByName) || (keyByNum && pcKeys.has(keyByNum));
        const hasKindle = kindleChecked
          ? (kindleKeys.has(keyByName) || (keyByNum && kindleKeys.has(keyByNum)))
          : Boolean(chapterSourceMap.get(ch.id)?.kindle);

        if (hasPc || hasKindle) {
          downloadedChapterIds.add(ch.id);
          chapterSourceMap.set(ch.id, { pc: Boolean(hasPc), kindle: Boolean(hasKindle) });
          matchedCount++;
        } else if (kindleChecked) {
          downloadedChapterIds.delete(ch.id);
          chapterSourceMap.delete(ch.id);
        }
      });

      // Save to chrome.storage
      const storageKey = 'downloaded_' + currentManga.seriesId;
      const sourcesKey = 'sources_' + currentManga.seriesId;
      const readKey = 'reading_' + currentManga.seriesId;
      const toSave = {
        [storageKey]: Array.from(downloadedChapterIds),
        [sourcesKey]: Object.fromEntries(chapterSourceMap)
      };
      if (data.kindle?.reading_progress) {
        currentReadingProgress = data.kindle.reading_progress;
        updateReadingProgressBadge(currentReadingProgress);
        toSave[readKey] = currentReadingProgress;
      }
      await chrome.storage.local.set(toSave);

      // Re-render
      renderChapterList();

      if (manualTrigger) {
        const totalFound = (data.all_chapter_keys || []).length;
        const pcCount = pcKeys.size;
        const kindleCount = kindleKeys.size;
        if (data.kindle?.connected === false) {
          showBanner(`Found ${pcCount} chapters in PC archive. (Kindle offline)`, 'info');
        } else if (totalFound === 0) {
          showBanner(`No chapters found in PC or Kindle archives.`, 'info');
        } else {
          let readingMsg = '';
          if (currentReadingProgress && (currentReadingProgress.percent > 0 || currentReadingProgress.last_page > 1)) {
            const chText = currentReadingProgress.chapter ? ` (Ch. ${currentReadingProgress.chapter.replace(/^\d+[\._\-]\s*/, '')})` : '';
            readingMsg = ` | 📖 Reading: ${currentReadingProgress.percent}%${chText}`;
          }
          showBanner(`✅ Checked archives: ${matchedCount} chapters found (PC: ${pcCount}, Kindle: ${kindleCount})${readingMsg}`, 'success');
        }
      }
    } else {
      if (manualTrigger) {
        showBanner(`Could not scan archives: ${res?.error || res?.result?.message || 'Native host error'}`, 'error');
      }
    }
  } catch (err) {
    console.error('Scan archives error:', err);
    if (manualTrigger) {
      showBanner(`Archive scan failed: ${err.message}`, 'error');
    }
  } finally {
    if (elements.btnScanArchives) {
      elements.btnScanArchives.disabled = false;
      elements.btnScanArchives.classList.remove('loading');
      elements.btnScanArchives.innerHTML = '<span class="scan-btn-content">🔍 Check Archives</span>';
    }
  }
}

async function markChapterAsDownloaded(seriesId, chapterId, sources = { pc: true, kindle: false }) {
  downloadedChapterIds.add(chapterId);
  const prev = chapterSourceMap.get(chapterId) || {};
  chapterSourceMap.set(chapterId, {
    pc: sources.pc !== undefined ? Boolean(sources.pc || prev.pc) : Boolean(prev.pc),
    kindle: sources.kindle !== undefined ? Boolean(sources.kindle || prev.kindle) : Boolean(prev.kindle)
  });
  try {
    const key = 'downloaded_' + seriesId;
    const srcKey = 'sources_' + seriesId;
    await chrome.storage.local.set({
      [key]: Array.from(downloadedChapterIds),
      [srcKey]: Object.fromEntries(chapterSourceMap)
    });
  } catch (e) {
    console.warn('Could not save downloaded chapter:', e);
  }
}

async function markMultipleChaptersAsDownloaded(seriesId, chapterIds, sources = { pc: true, kindle: false }) {
  chapterIds.forEach(id => {
    downloadedChapterIds.add(id);
    const prev = chapterSourceMap.get(id) || {};
    chapterSourceMap.set(id, {
      pc: sources.pc !== undefined ? Boolean(sources.pc || prev.pc) : Boolean(prev.pc),
      kindle: sources.kindle !== undefined ? Boolean(sources.kindle || prev.kindle) : Boolean(prev.kindle)
    });
  });
  try {
    const key = 'downloaded_' + seriesId;
    const srcKey = 'sources_' + seriesId;
    await chrome.storage.local.set({
      [key]: Array.from(downloadedChapterIds),
      [srcKey]: Object.fromEntries(chapterSourceMap)
    });
  } catch (e) {
    console.warn('Could not save downloaded chapters:', e);
  }
}

function selectNewChapters() {
  selectedChapterIds.clear();
  allChapters.forEach(c => {
    if (!downloadedChapterIds.has(c.id)) {
      selectedChapterIds.add(c.id);
    }
  });
  renderChapterList();
  showBanner(`Selected ${selectedChapterIds.size} un-downloaded chapters`, 'info');
}

/**
 * Select the next N undownloaded chapters immediately following the last downloaded one.
 */
function selectNextChapters(count) {
  if (!allChapters || allChapters.length === 0) return;

  // Find the index of the last downloaded chapter
  let lastDownloadedIdx = -1;
  for (let i = allChapters.length - 1; i >= 0; i--) {
    if (downloadedChapterIds.has(allChapters[i].id)) {
      lastDownloadedIdx = i;
      break;
    }
  }

  const startIdx = lastDownloadedIdx >= 0 ? lastDownloadedIdx + 1 : 0;
  selectedChapterIds.clear();
  let addedCount = 0;
  let firstSelectedId = null;

  for (let i = startIdx; i < allChapters.length && addedCount < count; i++) {
    const ch = allChapters[i];
    if (!downloadedChapterIds.has(ch.id)) {
      selectedChapterIds.add(ch.id);
      if (!firstSelectedId) firstSelectedId = ch.id;
      addedCount++;
    }
  }

  // If we couldn't find enough from startIdx to end, wrap around and check from beginning
  if (addedCount === 0) {
    for (let i = 0; i < allChapters.length && addedCount < count; i++) {
      const ch = allChapters[i];
      if (!downloadedChapterIds.has(ch.id)) {
        selectedChapterIds.add(ch.id);
        if (!firstSelectedId) firstSelectedId = ch.id;
        addedCount++;
      }
    }
  }

  renderChapterList();

  // Scroll to first selected chapter so the user sees it in view
  if (firstSelectedId) {
    setTimeout(() => {
      const el = elements.chapterList.querySelector(`[data-id="${firstSelectedId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }

  showBanner(`Selected next ${selectedChapterIds.size} chapters`, 'info');
}

/**
 * Render the chapter items into DOM
 */
function renderChapterList() {
  elements.chapterListLoading.classList.add('hidden');
  elements.chapterListNotSeries.classList.add('hidden');
  elements.chapterList.classList.remove('hidden');
  elements.chapterList.innerHTML = '';

  const filterText = elements.filterInput.value.toLowerCase().trim();
  let visibleCount = 0;

  allChapters.forEach((chapter, index) => {
    const isDownloaded = downloadedChapterIds.has(chapter.id);
    if (hideDownloaded && isDownloaded) return;

    const isVisible = !filterText ||
      chapter.name.toLowerCase().includes(filterText) ||
      String(chapter.chapterNumber).includes(filterText);

    if (!isVisible) return;
    visibleCount++;

    const chKey = getChapterKey(chapter.name, chapter.chapterNumber);
    const isCurrentlyReading = Boolean(currentReadingProgress && (
      (currentReadingProgress.chapter_key && currentReadingProgress.chapter_key === chKey) ||
      (currentReadingProgress.chapter && currentReadingProgress.chapter.toLowerCase().includes(chapter.name.toLowerCase()))
    ));

    const item = document.createElement('div');
    item.className = 'chapter-item' +
      (selectedChapterIds.has(chapter.id) ? ' selected' : '') +
      (isDownloaded ? ' downloaded' : '') +
      (isCurrentlyReading ? ' reading-now' : '');
    item.dataset.id = chapter.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'chapter-checkbox';
    checkbox.checked = selectedChapterIds.has(chapter.id);

    const details = document.createElement('div');
    details.className = 'chapter-details';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chapter-name';
    nameSpan.textContent = chapter.name;

    const metaRight = document.createElement('div');
    metaRight.style.display = 'flex';
    metaRight.style.alignItems = 'center';
    metaRight.style.gap = '6px';
    metaRight.style.flexShrink = '0';

    if (isCurrentlyReading) {
      const readingBadge = document.createElement('span');
      readingBadge.className = 'badge-reading-now';
      readingBadge.textContent = '📖 Reading';
      readingBadge.title = `Current reading position in KOReader (${currentReadingProgress.percent}%)`;
      metaRight.appendChild(readingBadge);
    }

    if (isDownloaded) {
      const badge = document.createElement('span');
      badge.className = 'badge-downloaded';
      const src = chapterSourceMap.get(chapter.id);
      if (src && src.kindle && src.pc) {
        badge.textContent = 'PC + Kindle';
        badge.title = 'Saved in archive on PC & Kindle';
      } else if (src && src.kindle) {
        badge.textContent = 'Kindle';
        badge.title = 'Saved in archive on Kindle';
      } else if (src && src.pc) {
        badge.textContent = 'PC';
        badge.title = 'Saved on PC';
      } else {
        badge.textContent = 'Done';
        badge.title = 'Downloaded';
      }
      metaRight.appendChild(badge);
    }

    if (chapter.date) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'chapter-date';
      dateSpan.textContent = formatChapterDate(chapter.date);
      metaRight.appendChild(dateSpan);
    }

    details.appendChild(nameSpan);
    details.appendChild(metaRight);

    item.appendChild(checkbox);
    item.appendChild(details);

    // Toggle on row click or checkbox click
    item.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      toggleChapterSelection(chapter.id, checkbox.checked);
    });

    checkbox.addEventListener('change', () => {
      toggleChapterSelection(chapter.id, checkbox.checked);
    });

    elements.chapterList.appendChild(item);
  });

  if (visibleCount === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'empty-state';
    emptyNotice.style.padding = '30px 16px';
    if (hideDownloaded && allChapters.length > 0 && downloadedChapterIds.size > 0) {
      emptyNotice.innerHTML = `
        <p style="font-size: 13px; font-weight: 600; color: var(--accent-color);">🎉 All visible chapters are downloaded!</p>
        <p style="font-size: 11px; opacity: 0.8;">Click <b>Show All</b> in the filter bar to view downloaded chapters.</p>
      `;
    } else {
      emptyNotice.innerHTML = `<p>No chapters match the current filter.</p>`;
    }
    elements.chapterList.appendChild(emptyNotice);
  }

  updateSelectionBadge();
}

function formatChapterDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  } catch {
    return dateStr;
  }
}

/**
 * Selection Helpers
 */
function toggleChapterSelection(chapterId, isSelected) {
  if (isSelected) {
    selectedChapterIds.add(chapterId);
  } else {
    selectedChapterIds.delete(chapterId);
  }

  const row = elements.chapterList.querySelector(`[data-id="${chapterId}"]`);
  if (row) {
    row.classList.toggle('selected', isSelected);
    const cb = row.querySelector('.chapter-checkbox');
    if (cb) cb.checked = isSelected;
  }

  updateSelectionBadge();
}

function selectAllChapters() {
  allChapters.forEach(c => selectedChapterIds.add(c.id));
  renderChapterList();
}

function selectNoneChapters() {
  selectedChapterIds.clear();
  renderChapterList();
}

function invertChapterSelection() {
  allChapters.forEach(c => {
    if (selectedChapterIds.has(c.id)) {
      selectedChapterIds.delete(c.id);
    } else {
      selectedChapterIds.add(c.id);
    }
  });
  renderChapterList();
}

function applyChapterFilter() {
  renderChapterList();
}

/**
 * Update the reading progress badge on the manga info card
 */
function updateReadingProgressBadge(prog) {
  if (!elements.readingProgressBadge) return;
  if (prog && (prog.percent > 0 || prog.last_page > 1)) {
    const chName = prog.chapter ? prog.chapter.replace(/^\d+[\._\-]\s*/, '') : `p. ${prog.last_page}`;
    elements.readingProgressBadge.textContent = `📖 Kindle: ${prog.percent}% (${chName})`;
    elements.readingProgressBadge.title = `Reading in KOReader: ${prog.percent}% (Page ${prog.last_page}/${prog.total_pages || '?'})`;
    elements.readingProgressBadge.classList.remove('hidden');
  } else {
    elements.readingProgressBadge.classList.add('hidden');
  }
}

/**
 * Update Hide Downloaded button active state and text
 */
function updateHideDownloadedButton() {
  if (elements.btnToggleHideDownloaded) {
    elements.btnToggleHideDownloaded.classList.toggle('active', hideDownloaded);
    if (elements.textToggleHide) {
      elements.textToggleHide.textContent = hideDownloaded ? 'Show All' : 'Hide Done';
    }
    if (elements.iconToggleHide) {
      elements.iconToggleHide.textContent = hideDownloaded ? '👁️‍🗨️' : '👁️';
    }
  }
}

/**
 * Apply Range Selection like "1-10", "1,3,5-8", "25"
 */
function applyRangeSelection() {
  const input = elements.rangeInput.value.trim();
  if (!input) return;

  const parts = input.split(/[,;\s]+/).filter(Boolean);
  const matchedIds = new Set();

  parts.forEach(part => {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseFloat(startStr);
      const end = parseFloat(endStr);
      if (!isNaN(start) && !isNaN(end)) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        allChapters.forEach(ch => {
          if (ch.chapterNumber !== null && ch.chapterNumber >= min && ch.chapterNumber <= max) {
            matchedIds.add(ch.id);
          }
        });
      }
    } else {
      const single = parseFloat(part);
      if (!isNaN(single)) {
        allChapters.forEach(ch => {
          if (ch.chapterNumber === single) {
            matchedIds.add(ch.id);
          }
        });
      }
    }
  });

  if (matchedIds.size === 0) {
    showBanner(`No chapters matched range "${input}"`, 'error');
  } else {
    matchedIds.forEach(id => selectedChapterIds.add(id));
    renderChapterList();
    showBanner(`Selected ${matchedIds.size} chapters from range`, 'success');
  }
}

function saveSelectionToSession() {
  if (currentManga && currentManga.seriesId) {
    const selKey = 'selection_' + currentManga.seriesId;
    sessionStore.set({ [selKey]: Array.from(selectedChapterIds) }).catch(() => {});
  }
}

function updateSelectionBadge() {
  const count = selectedChapterIds.size;
  elements.selectionCountBadge.textContent = `${count} selected`;

  const savePc = elements.targetSavePc ? elements.targetSavePc.checked : true;
  const saveKindle = elements.targetSaveKindle ? elements.targetSaveKindle.checked : true;
  let targetLabel = 'to PC & Kindle';
  if (savePc && !saveKindle) targetLabel = 'to PC';
  else if (!savePc && saveKindle) targetLabel = 'to Kindle';

  elements.btnDownload.innerHTML = `<span class="btn-icon">📥</span> <span id="btn-download-label">Download ${targetLabel} (${count})</span>`;
  elements.btnDownload.disabled = count === 0 || isDownloading;

  if (elements.btnDeleteLabel) {
    elements.btnDeleteLabel.textContent = count > 0 ? `Delete (${count})` : 'Delete';
  }
  if (elements.btnDeleteSelected) {
    elements.btnDeleteSelected.disabled = count === 0 || isDownloading;
  }

  saveSelectionToSession();
}

/**
 * Open Delete Chapters Confirmation Modal
 */
function openDeleteModal() {
  if (selectedChapterIds.size === 0) {
    showBanner('Please select at least one chapter to delete.', 'info');
    return;
  }
  const selectedChapters = allChapters.filter(c => selectedChapterIds.has(c.id));
  const count = selectedChapters.length;

  let summary = '';
  if (count <= 3) {
    summary = selectedChapters.map(c => c.name || `Ch. ${c.chapterNumber}`).join(', ');
  } else {
    const firstTwo = selectedChapters.slice(0, 2).map(c => c.name || `Ch. ${c.chapterNumber}`).join(', ');
    const lastOne = selectedChapters[count - 1].name || `Ch. ${selectedChapters[count - 1].chapterNumber}`;
    summary = `${firstTwo} ... ${lastOne}`;
  }

  if (elements.deleteModalSummary) {
    elements.deleteModalSummary.textContent = `Selected ${count} chapter(s): ${summary}`;
  }

  const savePc = elements.targetSavePc ? elements.targetSavePc.checked : true;
  const saveKindle = elements.targetSaveKindle ? elements.targetSaveKindle.checked : true;

  if (elements.btnConfirmDeletePc) {
    elements.btnConfirmDeletePc.classList.toggle('highlight', savePc && !saveKindle);
  }
  if (elements.btnConfirmDeleteKindle) {
    elements.btnConfirmDeleteKindle.classList.toggle('highlight', !savePc && saveKindle);
  }
  if (elements.btnConfirmDeleteBoth) {
    elements.btnConfirmDeleteBoth.classList.toggle('highlight', savePc && saveKindle);
  }

  if (elements.deleteModal) {
    elements.deleteModal.classList.remove('hidden');
  }
}

/**
 * Close Delete Chapters Confirmation Modal
 */
function closeDeleteModal() {
  if (elements.deleteModal) {
    elements.deleteModal.classList.add('hidden');
  }
}

/**
 * Execute Chapter Deletion from PC, Kindle, or Both
 */
async function executeDeleteChapters(target) {
  if (selectedChapterIds.size === 0 || !currentManga) {
    closeDeleteModal();
    return;
  }

  const selectedChapters = allChapters.filter(c => selectedChapterIds.has(c.id));
  const count = selectedChapters.length;
  const chapterKeys = selectedChapters.map(c => getChapterKey(c.name || `Chapter ${c.chapterNumber}`));

  if (elements.btnConfirmDeletePc) elements.btnConfirmDeletePc.disabled = true;
  if (elements.btnConfirmDeleteKindle) elements.btnConfirmDeleteKindle.disabled = true;
  if (elements.btnConfirmDeleteBoth) elements.btnConfirmDeleteBoth.disabled = true;

  const targetUpper = target === 'pc' ? 'PC' : (target === 'kindle' ? 'Kindle' : 'PC & Kindle');
  if (elements.deleteModalSummary) {
    elements.deleteModalSummary.textContent = `Deleting ${count} chapter(s) from ${targetUpper}...`;
  }

  try {
    let targetFolder = currentSettings.folderName || '{title}';
    targetFolder = targetFolder.replace('{title}', currentManga.title).trim();
    targetFolder = sanitizeFilename(targetFolder);

    const localBase = (currentSettings.localDownloads || '~/Downloads').replace(/\/+$/, '');
    const localFullPath = `${localBase}/${targetFolder}`;
    const cleanRemoteBase = (currentSettings.remotePath || '/mnt/us/koreader/').replace(/\/+$/, '');
    const remoteFullPath = `${cleanRemoteBase}/${targetFolder}`;
    const volumeName = `${sanitizeFilename(currentManga.title)}.cbz`;

    const res = await chrome.runtime.sendMessage({
      action: 'DELETE_CHAPTERS',
      target: target,
      localFolder: localFullPath,
      volumeName: volumeName,
      remoteFolder: remoteFullPath,
      remoteBase: cleanRemoteBase,
      chapterKeys: chapterKeys,
      host: currentSettings.sshHost || 'kindle.local',
      port: currentSettings.sshPort || 2222,
      user: currentSettings.sshUser || 'root',
      password: currentSettings.sshPassword || '',
      keyPath: currentSettings.sshKeyPath || ''
    });

    if (res && res.success && res.result && res.result.status === 'success') {
      selectedChapters.forEach(ch => {
        const src = chapterSourceMap.get(ch.id) || { pc: false, kindle: false };
        if (target === 'pc' || target === 'both') {
          src.pc = false;
        }
        if (target === 'kindle' || target === 'both') {
          src.kindle = false;
        }
        if (!src.pc && !src.kindle) {
          downloadedChapterIds.delete(ch.id);
          chapterSourceMap.delete(ch.id);
        } else {
          chapterSourceMap.set(ch.id, src);
        }
      });

      const storageKey = 'downloaded_' + currentManga.seriesId;
      const sourcesKey = 'sources_' + currentManga.seriesId;
      await chrome.storage.local.set({
        [storageKey]: Array.from(downloadedChapterIds),
        [sourcesKey]: Object.fromEntries(chapterSourceMap)
      });

      selectedChapterIds.clear();
      updateSelectionBadge();
      renderChapterList();

      showBanner(`🗑️ Successfully deleted ${count} chapter(s) from ${targetUpper}!`, 'success');
    } else {
      const errMsg = res?.error || res?.result?.message || 'Deletion failed';
      showBanner(`❌ Failed to delete chapters: ${errMsg}`, 'error');
    }
  } catch (err) {
    showBanner(`❌ Deletion error: ${err.message}`, 'error');
  } finally {
    if (elements.btnConfirmDeletePc) elements.btnConfirmDeletePc.disabled = false;
    if (elements.btnConfirmDeleteKindle) elements.btnConfirmDeleteKindle.disabled = false;
    if (elements.btnConfirmDeleteBoth) elements.btnConfirmDeleteBoth.disabled = false;
    closeDeleteModal();
  }
}

/**
 * Download Pipeline - Delegated to Background Service Worker
 */
async function startDownloadPipeline() {
  if (selectedChapterIds.size === 0) {
    showBanner('Please select at least one chapter to download.', 'error');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showBanner('No active tab found.', 'error');
    return;
  }

  const chaptersToDownload = allChapters.filter(c => selectedChapterIds.has(c.id));
  const format = currentSettings.format;
  const packageMode = currentSettings.packageMode;

  currentSettings.saveToPc = elements.targetSavePc ? elements.targetSavePc.checked : true;
  currentSettings.saveToKindle = elements.targetSaveKindle ? elements.targetSaveKindle.checked : true;

  // Resolve subfolder name
  let targetFolder = currentSettings.folderName || '{title}';
  targetFolder = targetFolder.replace('{title}', currentManga.title).trim();
  targetFolder = sanitizeFilename(targetFolder);

  isDownloading = true;
  cancelRequested = false;
  elements.btnDownload.disabled = true;
  elements.progressContainer.classList.remove('hidden');
  elements.progressBar.style.width = '0%';
  elements.progressPercentText.textContent = '0%';
  elements.progressStatusText.textContent = 'Starting background download...';

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'START_DOWNLOAD_PIPELINE',
      payload: {
        tabId: tab.id,
        chapters: chaptersToDownload,
        allChapters: allChapters,
        format,
        packageMode,
        targetFolder,
        manga: currentManga,
        settings: currentSettings
      }
    });

    if (!res || !res.success) {
      throw new Error(res?.error || 'Failed to start background download');
    }

    showBanner('🚀 Download running in background! Safe to close or switch tabs.', 'info', 3500);
  } catch (err) {
    console.error('Download start error:', err);
    showBanner(`Download failed: ${err.message}`, 'error', 6000);
    isDownloading = false;
    elements.btnDownload.disabled = selectedChapterIds.size === 0;
  }
}

function updateProgress(statusText, percent) {
  elements.progressStatusText.textContent = statusText;
  elements.progressPercentText.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
}

function getExtensionFromUrl(url, mime) {
  if (mime) {
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('png')) return 'png';
    if (mime.includes('avif')) return 'avif';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  }
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  if (clean.endsWith('.avif')) return 'avif';
  return 'jpg';
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Kindle SSH Transfer
 */
async function transferToKindle() {
  let targetFolder = currentSettings.folderName || '{title}';
  if (currentManga) {
    targetFolder = targetFolder.replace('{title}', currentManga.title).trim();
  }
  targetFolder = sanitizeFilename(targetFolder);

  const localBase = currentSettings.localDownloads.replace(/\/+$/, '');
  const localFullPath = `${localBase}/${targetFolder}`;
  const volumeName = `${sanitizeFilename(currentManga?.title || targetFolder)}.${currentSettings.format || 'cbz'}`;

  // For cumulative tome, target the single .cbz file directly
  const pathToSend = (currentSettings.packageMode === 'cumulative_tome')
    ? `${localFullPath}/${volumeName}`
    : localFullPath;

  elements.transferStatus.classList.remove('hidden');
  elements.transferStatus.textContent = '🚀 Initiating Kindle transfer via SCP...';
  elements.transferStatus.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  elements.btnTransferKindle.disabled = true;
  const originalBtnHtml = elements.btnTransferKindle.innerHTML;
  elements.btnTransferKindle.innerHTML = '⏳ Transferring to Kindle...';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'TRANSFER_TO_KINDLE',
      host: currentSettings.sshHost,
      port: currentSettings.sshPort,
      user: currentSettings.sshUser,
      password: currentSettings.sshPassword,
      keyPath: currentSettings.sshKeyPath,
      localPath: pathToSend,
      remotePath: currentSettings.remotePath
    });

    if (response && response.success && response.result) {
      if (response.result.status === 'success') {
        elements.transferStatus.textContent = `✅ ${response.result.message}`;
        showBanner('Manga transferred to Kindle!', 'success');
        scanArchivesAndMarkChapters(false);
      } else {
        elements.transferStatus.textContent = `❌ ${response.result.message}`;
        showBanner('Transfer error (check Native Host / SSH)', 'error');
      }
    } else {
      const err = response?.error || 'Native Messaging Host not reachable. Run ./native_host/install.sh';
      elements.transferStatus.textContent = `⚠️ ${err}`;
      showBanner('Kindle host not detected', 'error');
    }
    elements.transferStatus.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    elements.transferStatus.textContent = `Error: ${err.message}`;
  } finally {
    elements.btnTransferKindle.disabled = false;
    elements.btnTransferKindle.innerHTML = originalBtnHtml;
  }
}

/**
 * Copy SCP command to clipboard
 */
function copyScpCommand() {
  let targetFolder = currentSettings.folderName || '{title}';
  if (currentManga) {
    targetFolder = targetFolder.replace('{title}', currentManga.title).trim();
  }
  targetFolder = sanitizeFilename(targetFolder);

  const localBase = currentSettings.localDownloads.replace(/\/+$/, '');
  const localFullPath = `${localBase}/${targetFolder}`;
  const volumeName = `${sanitizeFilename(currentManga?.title || targetFolder)}.${currentSettings.format || 'cbz'}`;
  const cleanRemote = (currentSettings.remotePath || '/mnt/us/koreader/').replace(/\/+$/, '');

  let scpCmd;
  if (currentSettings.packageMode === 'cumulative_tome') {
    // Single volume mode: copy the .cbz directly to KOReader's manga folder without creating subfolder
    scpCmd = `scp -P ${currentSettings.sshPort} "${localFullPath}/${volumeName}" ${currentSettings.sshUser}@${currentSettings.sshHost}:${cleanRemote}/`;
  } else {
    scpCmd = `scp -r -P ${currentSettings.sshPort} "${localFullPath}" ${currentSettings.sshUser}@${currentSettings.sshHost}:${currentSettings.remotePath}`;
  }

  navigator.clipboard.writeText(scpCmd).then(() => {
    showBanner('📋 SCP command copied to clipboard!', 'success');
    elements.transferStatus.classList.remove('hidden');
    elements.transferStatus.textContent = `Copied: ${scpCmd}`;
  }).catch(() => {
    showBanner('Could not copy command to clipboard.', 'error');
  });
}

/**
 * Test SSH Connection in Settings
 */
async function testSshConnection() {
  elements.sshTestResult.textContent = 'Testing connection...';
  elements.sshTestResult.className = 'test-result-indicator';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'TEST_KINDLE_SSH',
      host: elements.settingSshHost.value.trim() || currentSettings.sshHost,
      port: parseInt(elements.settingSshPort.value, 10) || currentSettings.sshPort,
      user: elements.settingSshUser.value.trim() || currentSettings.sshUser,
      password: elements.settingSshPassword.value || currentSettings.sshPassword,
      keyPath: elements.settingSshKeyPath.value.trim() || currentSettings.sshKeyPath
    });

    if (response && response.success && response.result) {
      if (response.result.status === 'success') {
        elements.sshTestResult.textContent = '✅ Connected!';
        elements.sshTestResult.className = 'test-result-indicator success';
      } else {
        elements.sshTestResult.textContent = `❌ ${response.result.message}`;
        elements.sshTestResult.className = 'test-result-indicator error';
      }
    } else {
      const err = response?.error || 'Native host unavailable. Run ./native_host/install.sh';
      elements.sshTestResult.textContent = `⚠️ ${err}`;
      elements.sshTestResult.className = 'test-result-indicator error';
    }
  } catch (err) {
    elements.sshTestResult.textContent = `⚠️ ${err.message}`;
    elements.sshTestResult.className = 'test-result-indicator error';
  }
}
