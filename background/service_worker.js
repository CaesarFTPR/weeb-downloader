// Background Service Worker for WeebCentral Kindle Downloader
importScripts('../lib/jszip.min.js');

const NATIVE_HOST_NAME = 'com.weebdownloader.kindle';

console.log('[WeebDownloader] Service worker initialized.');

// Clean up any stale temporary delta downloads from Chrome history
if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.erase) {
  try {
    chrome.downloads.erase({ query: ['delta_'] });
  } catch (e) {}
}

// Active download pipeline state
let downloadState = {
  isDownloading: false,
  cancelRequested: false,
  totalChapters: 0,
  currentChapterIndex: 0,
  currentChapterName: '',
  statusText: '',
  percent: 0,
  completedChapters: [],
  targetFolder: '',
  seriesId: '',
  mangaTitle: '',
  error: null,
  isCompleted: false
};

let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    // Keep MV3 worker alive while downloading
    chrome.runtime.getPlatformInfo(() => {});
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function updateAndBroadcastProgress(statusText, percent, extra = {}) {
  downloadState.statusText = statusText;
  downloadState.percent = Math.max(0, Math.min(100, Math.round(percent)));
  Object.assign(downloadState, extra);

  // Update extension badge
  try {
    if (downloadState.isDownloading) {
      chrome.action.setBadgeText({ text: `${downloadState.percent}%` });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    } else if (downloadState.isCompleted) {
      chrome.action.setBadgeText({ text: '✔' });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '' });
      }, 6000);
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}

  // Broadcast to open popups / windows
  try {
    chrome.runtime.sendMessage({
      action: 'DOWNLOAD_PROGRESS',
      state: downloadState
    }).catch(() => {});
  } catch (e) {}
}

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START_DOWNLOAD_PIPELINE') {
    handleStartDownloadPipeline(request.payload)
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'CANCEL_DOWNLOAD_PIPELINE') {
    downloadState.cancelRequested = true;
    updateAndBroadcastProgress('Cancelling download...', downloadState.percent);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'GET_DOWNLOAD_STATE') {
    sendResponse({ success: true, state: downloadState });
    return true;
  }

  if (request.action === 'SAVE_DOWNLOAD') {
    handleSaveDownload(request)
      .then(downloadId => sendResponse({ success: true, downloadId }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'TEST_KINDLE_SSH') {
    sendNativeMessage({
      action: 'test_connection',
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
      key_path: request.keyPath
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'TRANSFER_TO_KINDLE') {
    sendNativeMessage({
      action: 'scp_transfer',
      host: request.host,
      port: request.port,
      user: request.user,
      local_path: request.localPath,
      remote_path: request.remotePath,
      password: request.password,
      key_path: request.keyPath
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'SET_KINDLE_KEEP_AWAKE') {
    sendNativeMessage({
      action: 'set_kindle_keep_awake',
      enable: request.enable !== false,
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
      key_path: request.keyPath
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'LIST_LOCAL_FILES') {
    sendNativeMessage({
      action: 'list_files',
      path: request.path
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'SCAN_ARCHIVES') {
    sendNativeMessage({
      action: 'scan_archives',
      local_folder: request.localFolder,
      volume_name: request.volumeName,
      remote_folder: request.remoteFolder,
      remote_base: request.remoteBase,
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
      key_path: request.keyPath
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'INSPECT_REMOTE_VOLUME') {
    sendNativeMessage({
      action: 'inspect_remote_volume',
      remote_path: request.remotePath,
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
      key_path: request.keyPath
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'CHOOSE_LOCAL_FOLDER') {
    sendNativeMessage({
      action: 'choose_folder',
      prompt: request.prompt || 'Select download folder for manga:'
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'RELOCATE_FILE') {
    sendNativeMessage({
      action: 'relocate_file',
      source_path: request.source_path,
      dest_dir: request.dest_dir
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'CLEANUP_EMPTY_DIR') {
    sendNativeMessage({
      action: 'cleanup_empty_dir',
      path: request.path
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'DELETE_CHAPTERS') {
    sendNativeMessage({
      action: 'delete_chapters',
      target: request.target,
      local_folder: request.localFolder,
      volume_name: request.volumeName,
      remote_folder: request.remoteFolder,
      remote_base: request.remoteBase,
      chapter_keys: request.chapterKeys,
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
      key_path: request.keyPath
    })
      .then(res => sendResponse({ success: true, result: res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Streaming Transfer Queue for immediate per-chapter transfer to Kindle
 */
class StreamingTransferQueue {
  constructor() {
    this.queue = [];
    this.active = false;
    this.completedCount = 0;
    this.totalEnqueued = 0;
    this.lastError = null;
  }

  enqueue(item) {
    this.queue.push(item);
    this.totalEnqueued++;
    console.log(`[WeebDownloader] Enqueued for Kindle transfer: ${item.filename} (Queue size: ${this.queue.length})`);
    this.process();
  }

  clear() {
    this.queue = [];
    this.active = false;
  }

  hasPending() {
    return this.active || this.queue.length > 0;
  }

  async process() {
    if (this.active || this.queue.length === 0) return;
    this.active = true;

    while (this.queue.length > 0) {
      if (downloadState.cancelRequested) {
        this.clear();
        break;
      }

      const item = this.queue.shift();
      const transferIdx = this.completedCount + 1;
      console.log(`[WeebDownloader] Streaming transfer (${transferIdx}/${this.totalEnqueued}): ${item.filename}`);

      let transferSuccess = false;
      let retryCount = 0;
      const maxRetries = 6;

      while (!transferSuccess && retryCount <= maxRetries) {
        if (downloadState.cancelRequested) break;

        updateAndBroadcastProgress(
          retryCount > 0
            ? `Kindle asleep/reconnecting... Waiting to send ${item.filename} (attempt ${retryCount}/${maxRetries})...`
            : `Uploading to Kindle (${transferIdx}/${this.totalEnqueued}): ${item.filename}`,
          downloadState.percent
        );

        try {
          const res = await sendNativeMessage({
            action: 'scp_transfer',
            host: item.settings.sshHost,
            port: item.settings.sshPort,
            user: item.settings.sshUser,
            local_path: item.localFilePath,
            remote_path: item.remoteFolder,
            password: item.settings.sshPassword,
            key_path: item.settings.sshKeyPath
          });

          if (res && res.status === 'success') {
            transferSuccess = true;
            this.completedCount++;
            console.log(`[WeebDownloader] Successfully transferred ${item.filename} to Kindle`);
            if (item.settings.saveToPc === false && item.localFilePath) {
              try {
                await sendNativeMessage({ action: 'delete_local_file', path: item.localFilePath });
              } catch (e) {}
            }
            break;
          }

          const warnMsg = res?.message || 'Transfer failed';
          const lower = warnMsg.toLowerCase();
          const isNetworkIssue = lower.includes('unreachable') ||
                                 lower.includes('timed out') ||
                                 lower.includes('no route') ||
                                 lower.includes('connection refused') ||
                                 lower.includes('host is down');

          if (isNetworkIssue && retryCount < maxRetries && !downloadState.cancelRequested) {
            retryCount++;
            console.warn(`[WeebDownloader] Kindle unreachable for ${item.filename}. Auto-retry ${retryCount}/${maxRetries} in 5s...`);
            updateAndBroadcastProgress(
              `Kindle asleep/offline. Wake up your Kindle to continue transfer (${retryCount}/${maxRetries})...`,
              downloadState.percent
            );
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          console.warn(`[WeebDownloader] Transfer issue for ${item.filename}:`, warnMsg);
          this.lastError = warnMsg;
          break;
        } catch (err) {
          const lower = (err.message || '').toLowerCase();
          const isNetworkIssue = lower.includes('unreachable') ||
                                 lower.includes('timed out') ||
                                 lower.includes('connection refused');

          if (isNetworkIssue && retryCount < maxRetries && !downloadState.cancelRequested) {
            retryCount++;
            console.warn(`[WeebDownloader] Error transferring ${item.filename}, retrying ${retryCount}/${maxRetries} in 5s:`, err);
            updateAndBroadcastProgress(
              `Kindle asleep/offline. Wake up your Kindle to continue transfer (${retryCount}/${maxRetries})...`,
              downloadState.percent
            );
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          console.error(`[WeebDownloader] Transfer error for ${item.filename}:`, err);
          this.lastError = err.message;
          break;
        }
      }
    }

    this.active = false;
  }

  async waitForAll() {
    while (this.active || this.queue.length > 0) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

/**
 * Main Download Pipeline Execution in Service Worker
 */
async function handleStartDownloadPipeline(payload) {
  const { tabId, chapters, format, packageMode, targetFolder, manga, settings } = payload;

  downloadState = {
    isDownloading: true,
    cancelRequested: false,
    totalChapters: chapters.length,
    currentChapterIndex: 0,
    currentChapterName: '',
    statusText: 'Starting background download...',
    percent: 0,
    completedChapters: [],
    targetFolder,
    seriesId: manga.seriesId,
    mangaTitle: manga.title,
    error: null,
    isCompleted: false
  };

  const transferQueue = new StreamingTransferQueue();

  startKeepAlive();
  updateAndBroadcastProgress('Starting download...', 0);

  const downloadPaths = getDownloadPaths(targetFolder, settings.localDownloads);

  // Run pipeline in background
  (async () => {
    const saveToKindle = Boolean(settings.saveToKindle !== false);

    // Keep Kindle awake during background download and sync session
    if (saveToKindle) {
      sendNativeMessage({
        action: 'set_kindle_keep_awake',
        enable: true,
        host: settings.sshHost || 'kindle.local',
        port: settings.sshPort || 2222,
        user: settings.sshUser || 'root',
        password: settings.sshPassword,
        key_path: settings.sshKeyPath
      }).catch(err => {
        console.warn('[WeebDownloader] Initial Kindle keep-awake ping note:', err);
      });
    }

    try {
      if ((packageMode === 'cumulative_tome' || packageMode === 'single_volume') && (format === 'cbz' || format === 'zip')) {
        await downloadCumulativeTome(tabId, chapters, downloadPaths, format, manga, settings, transferQueue);
      } else {
        await downloadIndividualChapters(tabId, chapters, downloadPaths, format, manga, settings, transferQueue);
      }

      if (!downloadState.cancelRequested) {
        const displayBase = downloadPaths.desiredDir.replace(/^\/Users\/[^/]+/, '~');

        // Check if Kindle sync was requested
        const saveToKindle = Boolean(settings.saveToKindle !== false);
        const saveToPc = Boolean(settings.saveToPc !== false);

        if (saveToKindle && transferQueue.totalEnqueued > 0) {
          if (transferQueue.hasPending()) {
            updateAndBroadcastProgress(
              `Finalizing Kindle Wi-Fi sync (${transferQueue.completedCount}/${transferQueue.totalEnqueued})...`,
              100
            );
            await transferQueue.waitForAll();
          }

          downloadState.isCompleted = true;
          if (!saveToPc) {
            try {
              await sendNativeMessage({ action: 'cleanup_empty_dir', path: downloadPaths.desiredDir });
            } catch (e) {}
            updateAndBroadcastProgress(
              `🎉 Complete! All ${transferQueue.completedCount} chapters downloaded directly to Kindle!`,
              100,
              { isCompleted: true }
            );
          } else if (transferQueue.lastError) {
            updateAndBroadcastProgress(
              `🎉 Saved to ${displayBase}! (Kindle synced ${transferQueue.completedCount}/${transferQueue.totalEnqueued}, note: ${transferQueue.lastError})`,
              100,
              { isCompleted: true }
            );
          } else {
            updateAndBroadcastProgress(
              `🎉 Complete! All ${transferQueue.completedCount} chapters downloaded to PC & synced to Kindle!`,
              100,
              { isCompleted: true }
            );
          }
        } else if (packageMode === 'cumulative_tome' || packageMode === 'single_volume') {
          downloadState.isCompleted = true;
          // In cumulative tome mode, downloadCumulativeTome has already broadcast its specific final progress message
        } else {
          downloadState.isCompleted = true;
          if (!saveToPc && saveToKindle) {
            updateAndBroadcastProgress('🎉 Download complete! Synced to Kindle!', 100, { isCompleted: true });
          } else if (saveToPc && !saveToKindle) {
            updateAndBroadcastProgress(`🎉 Download complete! Saved to ${displayBase}/`, 100, { isCompleted: true });
          } else {
            updateAndBroadcastProgress('🎉 Download complete! Saved to PC & Kindle!', 100, { isCompleted: true });
          }
        }

        // Automatically scan archives on PC and Kindle upon download completion
        try {
          await autoScanArchivesAfterDownload(manga, payload.allChapters || chapters, settings, targetFolder);
          chrome.runtime.sendMessage({
            action: 'ARCHIVES_AUTO_SCANNED',
            seriesId: manga.seriesId
          }).catch(() => {});
        } catch (e) {
          console.warn('[WeebDownloader] autoScanArchivesAfterDownload warning:', e);
        }
      }
    } catch (err) {
      console.error('[WeebDownloader] Background download error:', err);
      downloadState.error = err.message;
      updateAndBroadcastProgress(`Download failed: ${err.message}`, downloadState.percent, { error: err.message });
    } finally {
      // Restore normal Kindle power management so device can sleep when idle
      if (saveToKindle) {
        try {
          await sendNativeMessage({
            action: 'set_kindle_keep_awake',
            enable: false,
            host: settings.sshHost || 'kindle.local',
            port: settings.sshPort || 2222,
            user: settings.sshUser || 'root',
            password: settings.sshPassword,
            key_path: settings.sshKeyPath
          });
          console.log('[WeebDownloader] Restored Kindle power management (sleep allowed)');
        } catch (err) {
          console.warn('[WeebDownloader] Failed to restore Kindle sleep in finally:', err);
        }
      }

      if (downloadPaths && downloadPaths.needsRelocation) {
        try {
          await sendNativeMessage({ action: 'cleanup_empty_dir', path: '~/Downloads/_weeb_staging' });
        } catch (e) {}
      }
      if (settings.localDownloads && !downloadPaths.desiredDir.match(/(?:\/Users\/[^/]+|\/home\/[^/]+|~)?\/Downloads/i)) {
        try {
          await sendNativeMessage({ action: 'cleanup_empty_dir', path: `~/Downloads/${targetFolder}` });
        } catch (e) {}
      }
      downloadState.isDownloading = false;
      stopKeepAlive();
      updateAndBroadcastProgress(downloadState.statusText, downloadState.percent, { isDownloading: false });
    }
  })();

  return { started: true };
}

/**
 * Download each chapter as individual .cbz / .zip / images
 */
async function downloadIndividualChapters(tabId, chapters, downloadPaths, format, manga, settings, transferQueue) {
  const totalChapters = chapters.length;

  for (let chIdx = 0; chIdx < totalChapters; chIdx++) {
    if (downloadState.cancelRequested) {
      updateAndBroadcastProgress('Download cancelled by user.', downloadState.percent);
      break;
    }

    const chapter = chapters[chIdx];
    const cleanChapterName = formatChapterFilename(settings?.filenameTemplate, manga.title, chapter.name, chapter.chapterNumber);

    // Skip already downloaded if setting enabled
    if (settings.skipExisting) {
      const key = 'downloaded_' + manga.seriesId;
      const stored = await chrome.storage.local.get(key);
      const downloadedSet = new Set(stored[key] || []);
      if (downloadedSet.has(chapter.id)) {
        updateAndBroadcastProgress(
          `Skipping ${chapter.name} (already downloaded)`,
          Math.floor(((chIdx + 1) / totalChapters) * 100),
          { currentChapterIndex: chIdx + 1, currentChapterName: chapter.name }
        );
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
    }

    updateAndBroadcastProgress(
      `Chapter ${chIdx + 1}/${totalChapters}: ${chapter.name}`,
      Math.floor((chIdx / totalChapters) * 100),
      { currentChapterIndex: chIdx + 1, currentChapterName: chapter.name }
    );

    // 1. Fetch page URLs
    const imageUrls = await fetchChapterPages(tabId, chapter.url);

    // 2. Download and optimize page images concurrently on-the-fly (6 parallel streams)
    const shouldOptimize = settings && settings.optimizeKindle !== false;
    const pageImages = await downloadImagesConcurrently(
      tabId,
      imageUrls,
      6,
      (completed, total) => {
        updateAndBroadcastProgress(
          shouldOptimize
            ? `[${chIdx + 1}/${totalChapters}] Downloading & optimizing page ${completed}/${total}...`
            : `[${chIdx + 1}/${totalChapters}] Downloading page ${completed}/${total}...`,
          Math.floor(((chIdx + (completed / total)) / totalChapters) * 100),
          { currentChapterIndex: chIdx + 1, currentChapterName: chapter.name }
        );
      },
      shouldOptimize ? settings : null
    );

    if (downloadState.cancelRequested || !pageImages) break;

    if (format === 'cbz' || format === 'zip') {
      const zip = new JSZip();

      updateAndBroadcastProgress(
        `[${chIdx + 1}/${totalChapters}] Packaging ${cleanChapterName}.${format}...`,
        Math.floor(((chIdx + 0.95) / totalChapters) * 100)
      );

      for (let pIdx = 0; pIdx < pageImages.length; pIdx++) {
        if (downloadState.cancelRequested) break;
        const page = pageImages[pIdx];
        const pageFilename = `${String(pIdx + 1).padStart(3, '0')}.${page.ext}`;
        zip.file(pageFilename, page.buffer);
      }

      if (downloadState.cancelRequested) break;

      // ComicInfo.xml metadata for KOReader (series, title, right-to-left manga mode, bookmark)
      const chapterTitle = chapter.name || `Chapter ${chapter.chapterNumber || (chIdx + 1)}`;
      const comicInfoXml = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Title>${escapeXml(chapterTitle)}</Title>
  <Series>${escapeXml(manga.title)}</Series>
  <Number>${escapeXml(chapter.chapterNumber || String(chIdx + 1))}</Number>
  <PageCount>${pageImages.length}</PageCount>
  <Manga>YesAndRightToLeft</Manga>
  <Pages>
    <Page Image="0" Bookmark="${escapeXml(chapterTitle)}" Type="Story" />
  </Pages>
</ComicInfo>`;
      zip.file('ComicInfo.xml', comicInfoXml);

      // toc.ncx for KOReader Table of Contents navigation
      const firstPageFile = `${String(1).padStart(3, '0')}.${pageImages[0]?.ext || 'webp'}`;
      const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${escapeXml(chapter.id || 'chapter')}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="${pageImages.length}"/>
    <meta name="dtb:maxPageNumber" content="${pageImages.length}"/>
  </head>
  <docTitle>
    <text>${escapeXml(chapterTitle)}</text>
  </docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel>
        <text>${escapeXml(chapterTitle)}</text>
      </navLabel>
      <content src="${escapeXml(firstPageFile)}"/>
    </navPoint>
  </navMap>
</ncx>`;
      zip.file('toc.ncx', tocNcx);

      const base64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
      const chromeFolder = downloadPaths.chromeSubfolder;
      const filePath = chromeFolder ? `${chromeFolder}/${cleanChapterName}.${format}` : `${cleanChapterName}.${format}`;

      updateAndBroadcastProgress(
        `Saving ${cleanChapterName}.${format}...`,
        Math.floor(((chIdx + 0.98) / totalChapters) * 100)
      );

      const mimeType = (format === 'cbz') ? 'application/octet-stream' : 'application/zip';
      const saveRes = await saveBase64ToFile(base64, mimeType, filePath);
      await markChapterAsDownloaded(manga.seriesId, chapter.id);
      downloadState.completedChapters.push(chapter.id);

      let finalLocalFilePath = saveRes?.savedPath || `${downloadPaths.desiredDir}/${cleanChapterName}.${format}`;

      // Relocate file if destination is outside Chrome's downloads directory
      if (downloadPaths.needsRelocation && saveRes?.savedPath) {
        try {
          const moveRes = await sendNativeMessage({
            action: 'relocate_file',
            source_path: saveRes.savedPath,
            dest_dir: downloadPaths.desiredDir
          });
          if (moveRes && moveRes.status === 'success' && moveRes.new_path) {
            finalLocalFilePath = moveRes.new_path;
          }
        } catch (e) {
          console.warn('[WeebDownloader] Relocate file error:', e);
        }
      }

      // STREAMING TRANSFER: Send this chapter to Kindle immediately while next chapter downloads!
      if (Boolean(settings.saveToKindle !== false) && transferQueue) {
        const remoteFolder = `${settings.remotePath.replace(/\/+$/, '')}/${downloadState.targetFolder}/`;
        const realFilename = finalLocalFilePath.split(/[/\\]/).pop() || `${cleanChapterName}.${format}`;
        transferQueue.enqueue({
          localFilePath: finalLocalFilePath,
          remoteFolder,
          filename: realFilename,
          settings
        });
      }
    } else {
      // Loose images
      const chromeFolder = downloadPaths.chromeSubfolder;
      let lastSavedPath = null;

      for (let pIdx = 0; pIdx < pageImages.length; pIdx++) {
        if (downloadState.cancelRequested) break;
        const page = pageImages[pIdx];
        const pageFilename = `${String(pIdx + 1).padStart(3, '0')}.${page.ext}`;
        const base64 = arrayBufferToBase64(page.buffer);
        const relDir = chromeFolder ? `${chromeFolder}/${cleanChapterName}` : cleanChapterName;
        const filePath = `${relDir}/${pageFilename}`;
        const saveRes = await saveBase64ToFile(base64, page.mime, filePath);
        if (saveRes?.savedPath) lastSavedPath = saveRes.savedPath;
      }

      if (!downloadState.cancelRequested) {
        await markChapterAsDownloaded(manga.seriesId, chapter.id);
        downloadState.completedChapters.push(chapter.id);

        let finalLocalFolderPath = `${downloadPaths.desiredDir}/${cleanChapterName}`;

        if (downloadPaths.needsRelocation && lastSavedPath) {
          try {
            const stagingChapterDir = lastSavedPath.substring(0, lastSavedPath.lastIndexOf('/'));
            const moveRes = await sendNativeMessage({
              action: 'relocate_file',
              source_path: stagingChapterDir,
              dest_dir: downloadPaths.desiredDir
            });
            if (moveRes && moveRes.status === 'success' && moveRes.new_path) {
              finalLocalFolderPath = moveRes.new_path;
            }
          } catch (e) {
            console.warn('[WeebDownloader] Relocate folder error:', e);
          }
        }

        if (Boolean(settings.saveToKindle !== false) && transferQueue) {
          const remoteFolder = `${settings.remotePath.replace(/\/+$/, '')}/${downloadState.targetFolder}/`;
          transferQueue.enqueue({
            localFilePath: finalLocalFolderPath,
            remoteFolder,
            filename: cleanChapterName,
            settings
          });
        }
      }
    }
  }

  if (!downloadState.cancelRequested) {
    updateAndBroadcastProgress('All chapters downloaded successfully!', 100);
  }
}



function getChapterKey(name) {
  if (!name) return '';
  const s = String(name).toLowerCase().trim();
  if (s.includes('cover') || s.includes('обложк')) return 'cover';
  const stripped = s.replace(/^\d+(?:\.\d+)?[\._\-]\s*/, '');
  const m = stripped.match(/(?:chapter|ch\.?|гл\.?|глава)\s*([\d.]+)/i) ||
            stripped.match(/(\d+(?:\.\d+)?)/) ||
            s.match(/(?:chapter|ch\.?|гл\.?|глава)\s*([\d.]+)/i) ||
            s.match(/(\d+(?:\.\d+)?)/);
  if (m) {
    const val = m[1].replace(/\.$/, '');
    const n = parseFloat(val);
    if (!isNaN(n)) {
      return `ch_${Number.isInteger(n) ? n : n}`;
    }
  }
  return stripped.replace(/\s+/g, '_') || s.replace(/\s+/g, '_');
}

/**
 * Cumulative Manga Tome: Keeps ONE .cbz file per manga, appending new chapters incrementally
 * both locally on PC and directly on Kindle without transferring hundreds of megabytes over Wi-Fi.
 */
async function downloadCumulativeTome(tabId, chapters, downloadPaths, format, manga, settings, transferQueue) {
  const totalChapters = chapters.length;
  const volumeName = `${sanitizeFilename(manga.title)}.${format}`;
  const localVolumePath = `${downloadPaths.desiredDir}/${volumeName}`;

  // 1. Inspect existing local volume (if present)
  let existingInfo = null;
  try {
    const res = await sendNativeMessage({
      action: 'inspect_volume',
      volume_path: localVolumePath
    });
    if (res && res.status === 'success') {
      existingInfo = res;
    }
  } catch (e) {
    console.warn('[WeebDownloader] Could not inspect existing volume:', e);
  }

  const existingExists = Boolean(existingInfo && existingInfo.exists);
  let existingChaptersList = existingExists ? (existingInfo.chapters || []) : [];
  let existingPageCount = existingExists ? (existingInfo.page_count || 0) : 0;

  // Build set of existing chapter keys on PC
  const existingKeys = new Set(existingChaptersList.map(getChapterKey));

  const saveToPc = Boolean(settings.saveToPc !== false);
  const saveToKindle = Boolean(settings.saveToKindle !== false);

  // Load existing source tracking from storage (which chapters are already on PC / Kindle)
  const sourcesKey = 'sources_' + manga.seriesId;
  const storedSources = await chrome.storage.local.get(sourcesKey).catch(() => ({}));
  const sourceMap = storedSources[sourcesKey] || {};

  // Inspect Kindle's existing volume if saving to Kindle
  let kindleKeys = null;
  let kindleExistingChapters = [];
  let kindleExistingPageCount = 0;
  if (saveToKindle) {
    try {
      const scanRes = await sendNativeMessage({
        action: 'scan_archives',
        local_folder: downloadPaths.desiredDir,
        volume_name: volumeName,
        remote_folder: `${settings.remotePath.replace(/\/+$/, '')}/${sanitizeFilename(manga.title)}`,
        remote_base: settings.remotePath.replace(/\/+$/, ''),
        host: settings.sshHost,
        port: settings.sshPort,
        user: settings.sshUser,
        password: settings.sshPassword,
        key_path: settings.sshKeyPath
      });
      if (scanRes && scanRes.status === 'success' && scanRes.kindle?.connected) {
        kindleKeys = new Set(scanRes.kindle.chapter_keys || []);
        if (scanRes.kindle.chapters && scanRes.kindle.chapters.length > 0) {
          kindleExistingChapters = scanRes.kindle.chapters;
        }
        if (scanRes.kindle.total_pages) {
          kindleExistingPageCount = scanRes.kindle.total_pages;
        }
      }
    } catch (e) {
      console.warn('[WeebDownloader] Pre-download Kindle scan check:', e);
    }
  }

  // If saving ONLY to Kindle, load Kindle's existing chapters & page count so
  // ComicInfo.xml and toc.ncx preserve the full cumulative table of contents on Kindle!
  if (!saveToPc && saveToKindle && kindleExistingChapters.length > 0) {
    existingChaptersList = kindleExistingChapters;
    existingPageCount = kindleExistingPageCount;
  }

  // Filter chapters to download based on requested target(s) if skipExisting is enabled:
  // - If saving only to Kindle: only skip if already present on Kindle
  // - If saving only to PC: only skip if already present on PC (or in local volume)
  // - If saving to both: only skip if present on both PC and Kindle
  const chaptersToDownload = [];
  const skippedChapters = [];

  if (settings.skipExisting !== false) {
    for (const ch of chapters) {
      const key = getChapterKey(ch.name || `Chapter ${ch.chapterNumber}`);
      const keyByNum = (ch.chapterNumber !== null && ch.chapterNumber !== undefined)
        ? `ch_${Number.isInteger(ch.chapterNumber) ? ch.chapterNumber : ch.chapterNumber}`
        : '';
      const onPc = existingKeys.has(key) || (keyByNum && existingKeys.has(keyByNum)) || Boolean(sourceMap[ch.id]?.pc);
      const onKindle = kindleKeys
        ? (kindleKeys.has(key) || (keyByNum && kindleKeys.has(keyByNum)))
        : Boolean(sourceMap[ch.id]?.kindle);

      let alreadyHas = false;
      if (saveToPc && saveToKindle) {
        alreadyHas = onPc && onKindle;
      } else if (saveToPc) {
        alreadyHas = onPc;
      } else if (saveToKindle) {
        alreadyHas = onKindle;
      }

      if (alreadyHas) {
        skippedChapters.push(ch);
      } else {
        chaptersToDownload.push(ch);
      }
    }
  } else {
    chaptersToDownload.push(...chapters);
  }

  // If all selected chapters already exist on the target destination:
  if (chaptersToDownload.length === 0) {
    const targetDesc = (!saveToPc && saveToKindle) ? 'Kindle' : (saveToPc && !saveToKindle ? 'PC' : 'PC & Kindle');
    updateAndBroadcastProgress(
      `All ${chapters.length} selected chapter(s) already exist on ${targetDesc}!`,
      100,
      { isCompleted: true }
    );
    for (const ch of chapters) {
      const key = getChapterKey(ch.name || `Chapter ${ch.chapterNumber}`);
      const onPc = existingKeys.has(key) || Boolean(sourceMap[ch.id]?.pc);
      const onKindle = Boolean(sourceMap[ch.id]?.kindle);
      await markChapterAsDownloaded(manga.seriesId, ch.id, { pc: onPc, kindle: onKindle });
    }
    downloadState.completedChapters = chapters.map(c => c.id);
    return;
  }

  if (skippedChapters.length > 0) {
    updateAndBroadcastProgress(
      `Skipping ${skippedChapters.length} existing chapter(s). Downloading ${chaptersToDownload.length} new chapter(s)...`,
      2
    );
  }

  // 2. Setup cumulative state & bookmark tracking
  const currentChaptersList = [...existingChaptersList];
  let globalPageCounter = existingPageCount;
  const seenBookmarkKeys = new Set(currentChaptersList.map(getChapterKey));
  let coverAdded = (currentChaptersList.length > 0) || seenBookmarkKeys.has('cover');
  let knownRemotePath = null;
  const remoteFolder = `${settings.remotePath.replace(/\/+$/, '')}/`;

  // Build existing bookmarks from existing chapters
  const accumulatedBookmarks = [];
  for (const folder of currentChaptersList) {
    const k = getChapterKey(folder);
    let cleanTitle = folder.replace(/^\d+(?:\.\d+)?[\._\-]\s*/, '');
    if (k === 'cover') cleanTitle = 'Обложка (Cover)';
    accumulatedBookmarks.push({
      key: k,
      title: cleanTitle,
      startPage: 0,
      filePath: `${folder}/001.webp`
    });
  }

  // Cover buffer cached for initial chapter delta if not yet in volume
  let coverDataCache = null;
  if (!coverAdded && manga && manga.coverUrl) {
    try {
      updateAndBroadcastProgress('Downloading manga cover poster...', 1);
      const coverData = await fetchImageBytes(tabId, manga.coverUrl);
      let coverExt = getExtensionFromUrl(manga.coverUrl, coverData.mime);
      let coverBuffer = coverData.buffer;
      if (settings && settings.optimizeKindle !== false) {
        const opt = await optimizeImageForKindle(coverBuffer, coverData.mime, settings);
        coverBuffer = opt.buffer;
        if (opt.ext) coverExt = opt.ext;
      }
      coverDataCache = {
        filename: `00. Cover/000_cover.${coverExt}`,
        buffer: coverBuffer
      };
    } catch (e) {
      console.warn('[WeebDownloader] Could not fetch cover poster:', e);
    }
  }

  // 3. Process and stream chapters in optimized batches (5 chapters per sync)
  // Drastically reduces Kindle flash writes (eMMC wear) and SSH connections by up to 80%,
  // completely preventing KOReader UI freezes and I/O lockup on Kindle hardware.
  const BATCH_SIZE = 5;
  const totalToDownload = chaptersToDownload.length;
  let successfulChapters = 0;

  for (let batchStart = 0; batchStart < totalToDownload; batchStart += BATCH_SIZE) {
    if (downloadState.cancelRequested) {
      updateAndBroadcastProgress('Download cancelled by user.', downloadState.percent);
      break;
    }

    const batchChapters = chaptersToDownload.slice(batchStart, batchStart + BATCH_SIZE);
    const batchDeltaZip = new JSZip();
    const batchSuccessfulItems = [];
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalToDownload);

    // If cover hasn't been added to the volume yet, embed it in this delta
    if (!coverAdded && coverDataCache) {
      batchDeltaZip.file(coverDataCache.filename, coverDataCache.buffer);
      if (!seenBookmarkKeys.has('cover')) {
        seenBookmarkKeys.add('cover');
        accumulatedBookmarks.unshift({
          key: 'cover',
          title: 'Обложка (Cover)',
          startPage: 0,
          filePath: coverDataCache.filename
        });
      }
      coverAdded = true;
      globalPageCounter++;
    }

    // Process and download chapters for this batch
    for (let bIdx = 0; bIdx < batchChapters.length; bIdx++) {
      if (downloadState.cancelRequested) break;

      const chIdx = batchStart + bIdx;
      const chapter = batchChapters[bIdx];
      const chNum = (chapter.chapterNumber !== undefined && chapter.chapterNumber !== null)
        ? chapter.chapterNumber
        : (chIdx + 1);
      const nVal = Number(chNum);
      const folderPrefix = Number.isInteger(nVal)
        ? String(nVal).padStart(2, '0')
        : `${String(Math.floor(nVal)).padStart(2, '0')}.${String(chNum).split('.')[1]}`;
      const cleanChTitle = chapter.name || `Глава ${chNum}`;
      const cleanFolderName = `${folderPrefix}. ${sanitizeFilename(cleanChTitle)}`;
      const chapterKey = getChapterKey(cleanChTitle);

      // 3.1. Fetch page image URLs
      let imageUrls;
      try {
        imageUrls = await fetchChapterPages(tabId, chapter.url);
      } catch (e) {
        console.warn(`[WeebDownloader] Skipping chapter ${chapter.name}:`, e);
        continue;
      }

      // 3.2. Concurrently download and optimize images for THIS chapter
      const shouldOptimize = settings && settings.optimizeKindle !== false;
      let pageImages = null;
      try {
        pageImages = await downloadImagesConcurrently(
          tabId,
          imageUrls,
          8,
          (completed, total) => {
            const basePct = Math.floor((chIdx / totalToDownload) * 95);
            const chPct = Math.floor((completed / total) * (95 / totalToDownload));
            updateAndBroadcastProgress(
              shouldOptimize
                ? `[${chIdx + 1}/${totalToDownload}] ${cleanChTitle} (Opt ${completed}/${total})`
                : `[${chIdx + 1}/${totalToDownload}] ${cleanChTitle} (Page ${completed}/${total})`,
              basePct + chPct,
              { currentChapterIndex: chIdx + 1, currentChapterName: chapter.name }
            );
          },
          shouldOptimize ? settings : null
        );
      } catch (err) {
        console.error(`[WeebDownloader] Error downloading chapter ${cleanChTitle}:`, err);
        continue;
      }

      if (downloadState.cancelRequested || !pageImages || pageImages.length === 0) continue;

      const chapterStartPage = globalPageCounter;

      for (let pIdx = 0; pIdx < pageImages.length; pIdx++) {
        const page = pageImages[pIdx];
        const pageFilename = `${String(pIdx + 1).padStart(3, '0')}.${page.ext}`;
        const relativeZipPath = `${cleanFolderName}/${pageFilename}`;
        batchDeltaZip.file(relativeZipPath, page.buffer);
      }
      globalPageCounter += pageImages.length;

      // Register chapter bookmark
      if (!seenBookmarkKeys.has(chapterKey)) {
        seenBookmarkKeys.add(chapterKey);
        accumulatedBookmarks.push({
          key: chapterKey,
          title: cleanChTitle,
          startPage: chapterStartPage,
          filePath: `${cleanFolderName}/001.${pageImages[0]?.ext || 'webp'}`
        });
      }

      batchSuccessfulItems.push({
        chapter,
        cleanChTitle,
        cleanFolderName
      });

      // Brief 100ms breather between chapters within batch
      await new Promise(r => setTimeout(r, 100));
    }

    if (batchSuccessfulItems.length === 0) {
      if (downloadState.cancelRequested) {
        updateAndBroadcastProgress('Download cancelled by user.', downloadState.percent);
        break;
      }
      continue;
    }

    // Sort bookmarks: Cover first, then naturally sorted chapters
    accumulatedBookmarks.sort((a, b) => {
      if (a.key === 'cover') return -1;
      if (b.key === 'cover') return 1;
      const numA = parseFloat(a.key.replace('ch_', '')) || 0;
      const numB = parseFloat(b.key.replace('ch_', '')) || 0;
      return numA - numB;
    });

    // Generate updated ComicInfo.xml and toc.ncx for KOReader
    const pagesXml = accumulatedBookmarks.map(b =>
      `    <Page Image="${b.startPage || 0}" Bookmark="${escapeXml(b.title)}" Type="${b.key === 'cover' ? 'FrontCover' : 'Story'}" />`
    ).join('\n');

    const comicInfoXml = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Title>${escapeXml(manga.title)}</Title>
  <Series>${escapeXml(manga.title)}</Series>
  <PageCount>${globalPageCounter}</PageCount>
  <Manga>YesAndRightToLeft</Manga>
  <Pages>
${pagesXml}
  </Pages>
</ComicInfo>`;
    batchDeltaZip.file('ComicInfo.xml', comicInfoXml);

    const navPointsXml = accumulatedBookmarks.map((b, idx) => `    <navPoint id="navPoint-${idx + 1}" playOrder="${idx + 1}">
      <navLabel>
        <text>${escapeXml(b.title)}</text>
      </navLabel>
      <content src="${escapeXml(b.filePath)}"/>
    </navPoint>`).join('\n');

    const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${escapeXml(manga.seriesId || 'manga-volume')}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="${globalPageCounter}"/>
    <meta name="dtb:maxPageNumber" content="${globalPageCounter}"/>
  </head>
  <docTitle>
    <text>${escapeXml(manga.title)}</text>
  </docTitle>
  <navMap>
${navPointsXml}
  </navMap>
</ncx>`;
    batchDeltaZip.file('toc.ncx', tocNcx);

    // 3.4. Package batch delta and save via Native Host
    const batchLabel = batchSuccessfulItems.length === 1
      ? batchSuccessfulItems[0].cleanChTitle
      : `${batchSuccessfulItems[0].cleanChTitle} - ${batchSuccessfulItems[batchSuccessfulItems.length - 1].cleanChTitle}`;

    updateAndBroadcastProgress(
      `[${batchStart + 1}-${batchEnd}/${totalToDownload}] Packaging batch (${batchSuccessfulItems.length} ch)...`,
      Math.floor(((batchEnd - 0.2) / totalToDownload) * 95)
    );
    const deltaBase64 = await batchDeltaZip.generateAsync({ type: 'base64', compression: 'STORE' });

    const stagingFilename = `delta_${Date.now()}_${batchStart}.${format}`;
    let localDeltaPath = `/tmp/${stagingFilename}`;

    try {
      await saveBase64ViaNativeHost(deltaBase64, localDeltaPath);
    } catch (e) {
      console.warn('[WeebDownloader] Direct native write fallback to chrome.downloads:', e);
      const stagingRel = downloadPaths.chromeSubfolder ? `${downloadPaths.chromeSubfolder}/${stagingFilename}` : stagingFilename;
      const mimeType = (format === 'cbz') ? 'application/octet-stream' : 'application/zip';
      const saveRes = await saveBase64ToFile(deltaBase64, mimeType, stagingRel);
      localDeltaPath = saveRes?.savedPath || `${downloadPaths.desiredDir}/${stagingFilename}`;
    }

    // 3.5. Instant in-place merge on PC and Kindle (low CPU priority nice -n 19, no touch thrashing)
    updateAndBroadcastProgress(
      saveToKindle
        ? `[${batchStart + 1}-${batchEnd}/${totalToDownload}] Merging & syncing ${batchLabel} to Kindle...`
        : `[${batchStart + 1}-${batchEnd}/${totalToDownload}] Merging ${batchLabel} into local tome...`,
      Math.floor((batchEnd / totalToDownload) * 95)
    );

    try {
      const mergeRes = await sendNativeMessage({
        action: 'append_to_volume',
        local_target_cbz: localVolumePath,
        delta_zip_path: localDeltaPath,
        remote_folder: remoteFolder,
        save_to_pc: saveToPc,
        save_to_kindle: saveToKindle,
        host: settings.sshHost,
        port: settings.sshPort,
        user: settings.sshUser,
        password: settings.sshPassword,
        key_path: settings.sshKeyPath,
        known_remote_path: knownRemotePath
      });

      if (mergeRes && mergeRes.kindle_result && mergeRes.kindle_result.remote_target_path) {
        knownRemotePath = mergeRes.kindle_result.remote_target_path;
      }

      const pcSuccess = Boolean(saveToPc && mergeRes && mergeRes.status === 'success');
      const kindleSuccess = Boolean(saveToKindle && mergeRes && mergeRes.kindle_result?.status === 'success');

      if (pcSuccess || kindleSuccess || (!saveToPc && !saveToKindle)) {
        for (const item of batchSuccessfulItems) {
          await markChapterAsDownloaded(manga.seriesId, item.chapter.id, {
            pc: pcSuccess,
            kindle: kindleSuccess
          });
          downloadState.completedChapters.push(item.chapter.id);
          currentChaptersList.push(item.cleanFolderName);
          successfulChapters++;
        }
      } else {
        console.warn(`[WeebDownloader] Merge warning for batch ${batchLabel}:`, mergeRes);
      }
    } catch (mergeErr) {
      console.error(`[WeebDownloader] Merge error on batch ${batchLabel}:`, mergeErr);
    } finally {
      // Clean up batch delta file immediately to keep disk clean
      if (localDeltaPath) {
        try {
          await sendNativeMessage({ action: 'delete_local_file', path: localDeltaPath });
        } catch (e) {}
      }
      if (chrome.downloads && chrome.downloads.erase) {
        try {
          chrome.downloads.erase({ query: ['delta_'] });
        } catch (e) {}
      }
    }

    if (downloadState.cancelRequested) {
      updateAndBroadcastProgress('Download cancelled by user.', downloadState.percent);
      break;
    }

    // Brief 200ms breather between batches
    await new Promise(r => setTimeout(r, 200));
  }

  // 4. Final summary
  if (successfulChapters > 0) {
    const targetDesc = (!saveToPc && saveToKindle) ? 'Kindle' : (saveToPc && !saveToKindle ? 'PC' : 'PC & Kindle');
    updateAndBroadcastProgress(
      `🎉 Complete! ${successfulChapters} chapter(s) saved to ${targetDesc} (${volumeName})!`,
      100,
      { isCompleted: true }
    );
  } else if (!downloadState.cancelRequested) {
    updateAndBroadcastProgress(
      '⚠️ Download completed with no new chapters appended.',
      100,
      { isCompleted: true }
    );
  }
}

/**
 * Automatically inspect cumulative archive on PC and Kindle after download finishes.
 * Updates downloaded chapter IDs and source flags (PC / Kindle) in storage.
 */
async function autoScanArchivesAfterDownload(manga, chaptersList, settings, targetFolder) {
  if (!manga || !chaptersList || chaptersList.length === 0) return;

  try {
    let cleanFolder = targetFolder || settings?.folderName || '{title}';
    cleanFolder = cleanFolder.replace('{title}', manga.title).trim();
    cleanFolder = sanitizeFilename(cleanFolder);

    const localBase = (settings?.localDownloads || '~/Downloads').replace(/\/+$/, '');
    const localFullPath = `${localBase}/${cleanFolder}`;
    const cleanRemoteBase = (settings?.remotePath || '/mnt/us/koreader/').replace(/\/+$/, '');
    const remoteFullPath = `${cleanRemoteBase}/${cleanFolder}`;
    const volumeName = `${sanitizeFilename(manga.title)}.cbz`;

    const res = await sendNativeMessage({
      action: 'scan_archives',
      local_folder: localFullPath,
      volume_name: volumeName,
      remote_folder: remoteFullPath,
      remote_base: cleanRemoteBase,
      host: settings?.sshHost || 'kindle.local',
      port: settings?.sshPort || 2222,
      user: settings?.sshUser || 'root',
      password: settings?.sshPassword || '',
      key_path: settings?.sshKeyPath || ''
    });

    if (res && res.status === 'success') {
      const pcKeys = new Set(res.pc?.chapter_keys || []);
      const kindleKeys = new Set(res.kindle?.chapter_keys || []);
      const kindleChecked = res.kindle?.connected !== false;

      const storageKey = 'downloaded_' + manga.seriesId;
      const sourcesKey = 'sources_' + manga.seriesId;
      const readingKey = 'reading_' + manga.seriesId;

      const existing = await chrome.storage.local.get([storageKey, sourcesKey]);
      const prevSources = existing[sourcesKey] || {};
      const downloadedSet = new Set(existing[storageKey] || []);
      const sourceMap = { ...prevSources };

      chaptersList.forEach(ch => {
        const keyByName = getChapterKey(ch.name);
        const keyByNum = (ch.chapterNumber !== null && ch.chapterNumber !== undefined)
          ? `ch_${Number.isInteger(ch.chapterNumber) ? ch.chapterNumber : ch.chapterNumber}`
          : '';
        const hasPc = (keyByName && pcKeys.has(keyByName)) || (keyByNum && pcKeys.has(keyByNum));
        const hasKindle = kindleChecked
          ? ((keyByName && kindleKeys.has(keyByName)) || (keyByNum && kindleKeys.has(keyByNum)))
          : Boolean(prevSources[ch.id]?.kindle);

        if (hasPc || hasKindle) {
          downloadedSet.add(ch.id);
          sourceMap[ch.id] = { pc: Boolean(hasPc), kindle: Boolean(hasKindle) };
        } else if (kindleChecked) {
          downloadedSet.delete(ch.id);
          delete sourceMap[ch.id];
        }
      });

      const updates = {
        [storageKey]: Array.from(downloadedSet),
        [sourcesKey]: sourceMap
      };
      if (res.kindle?.reading_progress) {
        updates[readingKey] = res.kindle.reading_progress;
      }

      await chrome.storage.local.set(updates);
    }
  } catch (err) {
    console.warn('[WeebDownloader] autoScanArchivesAfterDownload error:', err);
  }
}

/**
 * Fetch image URLs for a chapter (tries active tab, falls back to direct fetch)
 */
async function fetchChapterPages(tabId, chapterUrl) {
  if (tabId) {
    try {
      const pagesRes = await chrome.tabs.sendMessage(tabId, {
        action: 'GET_CHAPTER_PAGES',
        chapterUrl
      });
      if (pagesRes && pagesRes.success && Array.isArray(pagesRes.data) && pagesRes.data.length > 0) {
        return pagesRes.data;
      }
    } catch (e) {
      console.warn('[WeebDownloader] Could not get pages via tab, fetching directly...', e);
    }
  }

  // Direct fetch fallback
  const urlObj = new URL(chapterUrl);
  let cleanPath = urlObj.pathname.replace(/\/+$/, '');
  if (!cleanPath.endsWith('/images')) {
    cleanPath += '/images';
  }
  urlObj.pathname = cleanPath;
  urlObj.searchParams.set('is_prev', 'False');
  urlObj.searchParams.set('reading_style', 'long_strip');

  let response = await fetch(urlObj.toString(), {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'HX-Request': 'true'
    }
  });

  if (!response.ok) {
    response = await fetch(chapterUrl);
  }

  if (!response.ok) {
    throw new Error(`Failed to load chapter reader: HTTP ${response.status}`);
  }

  const html = await response.text();
  const imgRegex = /<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
  const imageUrls = [];
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    let src = match[1];
    if (!src) continue;
    if (src.startsWith('//')) src = 'https:' + src;
    if (src.startsWith('/')) src = 'https://weebcentral.com' + src;

    const lower = src.toLowerCase();
    if (lower.endsWith('.svg') || lower.includes('logo') || lower.includes('avatar') || lower.includes('favicon')) {
      continue;
    }
    imageUrls.push(src);
  }

  if (imageUrls.length === 0) {
    throw new Error('No page images found for chapter.');
  }

  return imageUrls;
}

/**
 * Concurrently download and optimize images with a pool limit (default 8 streams).
 * Supports pipelined on-the-fly image optimization during download for maximum speed.
 */
async function downloadImagesConcurrently(tabId, imageUrls, concurrency = 8, onProgress = null, optimizeSettings = null) {
  const results = new Array(imageUrls.length);
  let currentIndex = 0;
  let completedCount = 0;

  async function worker() {
    while (currentIndex < imageUrls.length) {
      if (downloadState.cancelRequested) break;
      const index = currentIndex++;
      const url = imageUrls[index];

      try {
        let data = await fetchImageBytes(tabId, url);
        let ext = getExtensionFromUrl(url, data.mime);

        if (optimizeSettings && optimizeSettings.optimizeKindle !== false) {
          const opt = await optimizeImageForKindle(data.buffer, data.mime, optimizeSettings);
          data = { buffer: opt.buffer, mime: opt.mime };
          if (opt.ext) ext = opt.ext;
        }

        results[index] = {
          buffer: data.buffer,
          mime: data.mime,
          ext: ext
        };
      } catch (err) {
        console.warn(`[WeebDownloader] Page ${index + 1} failed after retries:`, err);
        // Fallback transparent 1x1 image so that one failed page does not corrupt/cancel the whole tome
        const fallbackBuf = new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
          0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
          0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
          0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
          0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
          0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
        ]).buffer;
        results[index] = {
          buffer: fallbackBuf,
          mime: 'image/png',
          ext: 'png'
        };
      }

      completedCount++;
      if (onProgress) {
        onProgress(completedCount, imageUrls.length);
      }
    }
  }

  const workerCount = Math.min(concurrency, imageUrls.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (downloadState.cancelRequested) return null;
  return results;
}

/**
 * Fetch image as ArrayBuffer (direct fetch, fallback to content script)
 */
async function fetchImageBytes(tabId, url, maxRetries = 5) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (downloadState.cancelRequested) break;

    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      });
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        const mime = res.headers.get('content-type') || 'image/jpeg';
        return { buffer, mime };
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const isRateLimited = e.message && (e.message.includes('429') || e.message.includes('503'));
        const delay = isRateLimited ? Math.min(8000, 1500 * attempt) : (attempt * 800);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // Fallback to content script injection in active tab
  if (tabId && !downloadState.cancelRequested) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, {
          action: 'FETCH_IMAGE_DATA',
          url
        });
        if (res && res.success && res.data) {
          const binaryString = atob(res.data.base64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return { buffer: bytes.buffer, mime: res.data.mime || 'image/jpeg' };
        }
      } catch (err) {
        console.warn(`[WeebDownloader] Content script fetch attempt ${attempt} failed:`, err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw new Error(`Failed to download image ${url} (${lastError ? lastError.message : 'Timeout'})`);
}

/**
 * Detect white/blank scan margins on a page image.
 * Uses a fast downsampled thumbnail pass (<2ms) to find the bounding box of the actual artwork.
 * Limits trimming to at most 15% per side to prevent any risk of cutting dialogue or panels.
 */
function detectContentBoundingBox(bitmap, maxCropPercent = 0.15) {
  const origW = bitmap.width;
  const origH = bitmap.height;
  if (origW < 100 || origH < 100) {
    return { x: 0, y: 0, width: origW, height: origH, cropped: false };
  }

  // Fast thumbnail (max dimension 360px for sub-2ms evaluation)
  const thumbScale = Math.min(1, 360 / Math.max(origW, origH));
  const tw = Math.max(20, Math.round(origW * thumbScale));
  const th = Math.max(20, Math.round(origH * thumbScale));

  const thumbCanvas = new OffscreenCanvas(tw, th);
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  if (!thumbCtx) {
    return { x: 0, y: 0, width: origW, height: origH, cropped: false };
  }

  thumbCtx.drawImage(bitmap, 0, 0, tw, th);
  const imgData = thumbCtx.getImageData(0, 0, tw, th);
  const data = imgData.data;

  // Max margin bounds in thumbnail pixels
  const maxCropTop = Math.floor(th * maxCropPercent);
  const maxCropBottom = Math.floor(th * (1 - maxCropPercent));
  const maxCropLeft = Math.floor(tw * maxCropPercent);
  const maxCropRight = Math.floor(tw * (1 - maxCropPercent));

  // Helper to check if a pixel is white/margin (luma >= 238 or transparent)
  function isMarginPixel(x, y) {
    const idx = (y * tw + x) * 4;
    const a = data[idx + 3];
    if (a < 20) return true;
    const luma = (data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >> 8;
    return luma >= 238;
  }

  // 1. Scan Top Margin
  let top = 0;
  for (let y = 0; y < maxCropTop; y++) {
    let whiteCount = 0;
    for (let x = 0; x < tw; x++) {
      if (isMarginPixel(x, y)) whiteCount++;
    }
    if (whiteCount / tw >= 0.98) {
      top = y + 1;
    } else {
      break;
    }
  }

  // 2. Scan Bottom Margin
  let bottom = th - 1;
  for (let y = th - 1; y >= maxCropBottom; y--) {
    let whiteCount = 0;
    for (let x = 0; x < tw; x++) {
      if (isMarginPixel(x, y)) whiteCount++;
    }
    if (whiteCount / tw >= 0.98) {
      bottom = y - 1;
    } else {
      break;
    }
  }

  const croppedH = Math.max(1, bottom - top + 1);

  // 3. Scan Left Margin
  let left = 0;
  for (let x = 0; x < maxCropLeft; x++) {
    let whiteCount = 0;
    for (let y = top; y <= bottom; y++) {
      if (isMarginPixel(x, y)) whiteCount++;
    }
    if (whiteCount / croppedH >= 0.98) {
      left = x + 1;
    } else {
      break;
    }
  }

  // 4. Scan Right Margin
  let right = tw - 1;
  for (let x = tw - 1; x >= maxCropRight; x--) {
    let whiteCount = 0;
    for (let y = top; y <= bottom; y++) {
      if (isMarginPixel(x, y)) whiteCount++;
    }
    if (whiteCount / croppedH >= 0.98) {
      right = x - 1;
    } else {
      break;
    }
  }

  // Check if margin removed is meaningful (at least 2% on any dimension)
  const totalCropW = left + (tw - 1 - right);
  const totalCropH = top + (th - 1 - bottom);
  if (totalCropW < tw * 0.02 && totalCropH < th * 0.02) {
    return { x: 0, y: 0, width: origW, height: origH, cropped: false };
  }

  // Map back to full bitmap coordinates
  const realX = Math.round(left / thumbScale);
  const realY = Math.round(top / thumbScale);
  const realW = Math.min(origW - realX, Math.round((right - left + 1) / thumbScale));
  const realH = Math.min(origH - realY, Math.round((bottom - top + 1) / thumbScale));

  return {
    x: Math.max(0, realX),
    y: Math.max(0, realY),
    width: Math.max(10, realW),
    height: Math.max(10, realH),
    cropped: true
  };
}

/**
 * Optimize page image for Kindle E-Ink display:
 * - Auto-crops empty scanner borders to enlarge panels and text
 * - Scales down to Kindle resolution (default 1448px native Paperwhite & Basic)
 * - Converts to 8-bit Grayscale matching E-Ink 16 shades
 * - Compresses with high-efficiency WebP/JPEG (~45-65 KB per page)
 */
async function optimizeImageForKindle(arrayBuffer, mime, options = {}) {
  const maxResolution = options.maxResolution !== undefined ? parseInt(options.maxResolution, 10) : 1448;
  const autoCrop = options.autoCrop !== false;
  const isGrayscale = options.grayscale !== false;
  const cleanPaper = options.cleanPaper !== false;
  const sharpenEink = options.sharpenEink !== false;
  const targetFormat = options.optimizedFormat === 'jpeg' ? 'jpeg' : 'webp';
  const outMime = targetFormat === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const outExt = targetFormat === 'jpeg' ? 'jpg' : 'webp';
  const defaultQuality = 0.60;
  const quality = options.imageQuality !== undefined ? parseFloat(options.imageQuality) : defaultQuality;

  // Gracefully fallback if OffscreenCanvas or createImageBitmap is not supported
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { buffer: arrayBuffer, mime, ext: null };
  }

  let bitmap = null;
  try {
    const blob = new Blob([arrayBuffer], { type: mime || 'image/jpeg' });
    bitmap = await createImageBitmap(blob);

    let srcX = 0;
    let srcY = 0;
    let srcW = bitmap.width;
    let srcH = bitmap.height;

    // Fast auto-crop pass: remove white scanner borders to enlarge art and save ~20% size
    if (autoCrop) {
      try {
        const cropBox = detectContentBoundingBox(bitmap, 0.15);
        if (cropBox.cropped) {
          srcX = cropBox.x;
          srcY = cropBox.y;
          srcW = cropBox.width;
          srcH = cropBox.height;
        }
      } catch (e) {
        console.warn('[WeebDownloader] Auto-crop pass warning:', e);
      }
    }

    let targetWidth = srcW;
    let targetHeight = srcH;

    // Scale down proportionally if larger than maxResolution
    if (maxResolution > 0) {
      if (targetHeight > maxResolution && targetHeight >= targetWidth) {
        // Standard vertical page
        const scale = maxResolution / targetHeight;
        targetHeight = maxResolution;
        targetWidth = Math.round(srcW * scale);
      } else if (targetWidth > maxResolution && targetWidth > targetHeight) {
        // Double-page spread
        const scale = maxResolution / targetWidth;
        targetWidth = maxResolution;
        targetHeight = Math.round(srcH * scale);
      }
    }

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: isGrayscale });
    if (!ctx) {
      return { buffer: arrayBuffer, mime, ext: null };
    }

    if (isGrayscale) {
      try {
        ctx.filter = 'grayscale(100%)';
      } catch (e) {}
    }

    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, targetWidth, targetHeight);
    bitmap.close();
    bitmap = null;

    // Fast pixel grayscale pass for guaranteed 100% monochrome output
    if (isGrayscale) {
      try {
        const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        const data = imgData.data;
        const len = data.length;
        // Fast integer arithmetic: Y = (77*R + 150*G + 29*B) >> 8
        if (cleanPaper) {
          // Smart paper white clipping & deep black cleanup:
          // Removes scanner paper noise (>= 235 -> 255) and solidifies deep ink (<= 20 -> 0).
          // Dramatically reduces WebP compression file size and avoids E-Ink dithering/ghosting.
          for (let i = 0; i < len; i += 4) {
            let luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
            if (luma >= 235) {
              luma = 255;
            } else if (luma <= 20) {
              luma = 0;
            }
            data[i] = luma;
            data[i + 1] = luma;
            data[i + 2] = luma;
          }
        } else {
          for (let i = 0; i < len; i += 4) {
            const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
            data[i] = luma;
            data[i + 1] = luma;
            data[i + 2] = luma;
          }
        }

        if (sharpenEink && targetWidth > 2 && targetHeight > 2) {
          // Fast unsharp mask: crisps dialogue text, kanji and fine manga lines on E-Ink
          // Uses threshold diff >= 4 to sharpen real line art without bloating screentone gradients
          const alpha = 0.22;
          const copy = new Uint8Array(len / 4);
          for (let i = 0, p = 0; i < len; i += 4, p++) {
            copy[p] = data[i];
          }
          const w = targetWidth;
          const h = targetHeight;
          for (let y = 1; y < h - 1; y++) {
            const row = y * w;
            for (let x = 1; x < w - 1; x++) {
              const p = row + x;
              const center = copy[p];
              // Skip uniform pure white backgrounds and pure black fills
              if (center >= 253 || center <= 3) continue;
              const neighbors = (copy[p - 1] + copy[p + 1] + copy[p - w] + copy[p + w]) * 0.25;
              const diff = center - neighbors;
              if (Math.abs(diff) < 4) continue; // Noise gate: preserve screentone compressibility
              let val = center + alpha * diff;
              if (val < 0) val = 0;
              else if (val > 255) val = 255;
              const idx = p * 4;
              data[idx] = val;
              data[idx + 1] = val;
              data[idx + 2] = val;
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);
      } catch (e) {
        console.warn('[WeebDownloader] Pixel grayscale pass warning:', e);
      }
    }

    let outBlob = await canvas.convertToBlob({
      type: outMime,
      quality: quality
    });

    if (!outBlob) {
      outBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: 0.60
      });
    }

    const outBuffer = await outBlob.arrayBuffer();

    // CRITICAL SIZE GUARD: Never use re-encoded image if it is larger than original!
    if (outBuffer.byteLength >= arrayBuffer.byteLength) {
      return {
        buffer: arrayBuffer,
        mime: mime,
        ext: null
      };
    }

    return {
      buffer: outBuffer,
      mime: outBlob.type || outMime,
      ext: (outBlob.type && outBlob.type.includes('webp')) ? 'webp' : outExt
    };
  } catch (err) {
    console.warn('[WeebDownloader] Image optimization error, keeping original:', err);
    return {
      buffer: arrayBuffer,
      mime: mime,
      ext: null
    };
  } finally {
    if (bitmap) {
      try {
        bitmap.close();
      } catch (e) {}
    }
  }
}

/**
 * Stream base64 data directly to disk via a persistent Native Messaging port.
 * Uses a single persistent Python process, eliminating process spawn overhead (12x faster).
 */
function streamBase64ViaNativePort(base64Data, targetPath) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      return reject(e);
    }

    const CHUNK_SIZE = 768 * 1024; // 768 KB base64 characters (~576 KB binary)
    const totalLength = base64Data.length;
    let offset = 0;
    let chunkIndex = 0;
    let isCleanedUp = false;

    function cleanup() {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (port) {
        try {
          port.disconnect();
        } catch (e) {}
      }
    }

    port.onDisconnect.addListener(() => {
      if (offset >= totalLength) return; // already completed
      const err = chrome.runtime.lastError?.message || 'Native host port disconnected unexpectedly';
      cleanup();
      reject(new Error(err));
    });

    port.onMessage.addListener(response => {
      if (!response || response.status !== 'success') {
        cleanup();
        return reject(new Error(response?.message || `Failed writing chunk ${chunkIndex} to ${targetPath}`));
      }

      offset += CHUNK_SIZE;
      chunkIndex++;

      if (offset < totalLength) {
        sendNextChunk();
      } else {
        cleanup();
        resolve(targetPath);
      }
    });

    function sendNextChunk() {
      const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
      const append = chunkIndex > 0;
      port.postMessage({
        action: 'write_file_chunk',
        file_path: targetPath,
        chunk_b64: chunk,
        append: append
      });
    }

    // Start sending first chunk
    sendNextChunk();
  });
}

/**
 * Save base64 data directly to disk via Native Messaging host chunks.
 * Tries high-speed persistent port streaming first; falls back to sequential sendNativeMessage.
 * Avoids triggering Chrome's download notification / drawer shelf overlay completely.
 */
async function saveBase64ViaNativeHost(base64Data, targetPath) {
  try {
    return await streamBase64ViaNativePort(base64Data, targetPath);
  } catch (portErr) {
    console.warn('[WeebDownloader] Persistent port streaming fallback to chunked sendNativeMessage:', portErr);
    const CHUNK_SIZE = 768 * 1024;
    const totalLength = base64Data.length;
    let offset = 0;
    let chunkIndex = 0;

    while (offset < totalLength) {
      const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
      const append = chunkIndex > 0;
      const res = await sendNativeMessage({
        action: 'write_file_chunk',
        file_path: targetPath,
        chunk_b64: chunk,
        append: append
      });
      if (!res || res.status !== 'success') {
        throw new Error(res?.message || `Failed to write chunk ${chunkIndex} to ${targetPath}`);
      }
      offset += CHUNK_SIZE;
      chunkIndex++;
    }

    return targetPath;
  }
}

/**
 * Save base64 data to disk via chrome.downloads
 */
function saveBase64ToFile(base64Data, mimeType, filename) {
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  return saveUrlToFile(dataUrl, filename);
}

function saveUrlToFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, downloadId => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!downloadId) {
        return reject(new Error('chrome.downloads failed to start.'));
      }

      let resolved = false;

      const finish = (id) => {
        if (resolved) return;
        resolved = true;
        chrome.downloads.onChanged.removeListener(checkStatus);
        chrome.downloads.search({ id }, items => {
          const savedPath = (items && items[0] && items[0].filename) ? items[0].filename : null;
          if (filename && (filename.includes('delta_') || filename.includes('_weeb_staging'))) {
            try {
              chrome.downloads.erase({ id });
            } catch (e) {}
          }
          resolve({ downloadId: id, savedPath });
        });
      };

      const checkStatus = delta => {
        if (delta.id === downloadId) {
          if (delta.state && delta.state.current === 'complete') {
            finish(downloadId);
          } else if (delta.error && !resolved) {
            resolved = true;
            chrome.downloads.onChanged.removeListener(checkStatus);
            reject(new Error(`Download error: ${delta.error.current}`));
          }
        }
      };
      chrome.downloads.onChanged.addListener(checkStatus);

      // Check immediately in case it finished synchronously
      chrome.downloads.search({ id: downloadId }, items => {
        if (items && items[0] && items[0].state === 'complete') {
          finish(downloadId);
        }
      });
    });
  });
}

/**
 * Mark chapter as downloaded in chrome.storage.local
 */
async function markChapterAsDownloaded(seriesId, chapterId, sources = { pc: true, kindle: false }) {
  if (!seriesId) return;
  try {
    const key = 'downloaded_' + seriesId;
    const srcKey = 'sources_' + seriesId;
    const stored = await chrome.storage.local.get([key, srcKey]);
    const existing = new Set(stored[key] || []);
    existing.add(chapterId);

    const sourceMap = stored[srcKey] || {};
    const prev = sourceMap[chapterId] || {};
    sourceMap[chapterId] = {
      pc: sources.pc !== undefined ? Boolean(sources.pc || prev.pc) : Boolean(prev.pc),
      kindle: sources.kindle !== undefined ? Boolean(sources.kindle || prev.kindle) : Boolean(prev.kindle)
    };

    await chrome.storage.local.set({
      [key]: Array.from(existing),
      [srcKey]: sourceMap
    });
  } catch (e) {
    console.warn('[WeebDownloader] Error saving downloaded chapter:', e);
  }
}

async function markMultipleChaptersAsDownloaded(seriesId, chapterIds, sources = { pc: true, kindle: false }) {
  if (!seriesId || !chapterIds || chapterIds.length === 0) return;
  try {
    const key = 'downloaded_' + seriesId;
    const srcKey = 'sources_' + seriesId;
    const stored = await chrome.storage.local.get([key, srcKey]);
    const existing = new Set(stored[key] || []);
    chapterIds.forEach(id => existing.add(id));

    const sourceMap = stored[srcKey] || {};
    chapterIds.forEach(id => {
      const prev = sourceMap[id] || {};
      sourceMap[id] = {
        pc: sources.pc !== undefined ? Boolean(sources.pc || prev.pc) : Boolean(prev.pc),
        kindle: sources.kindle !== undefined ? Boolean(sources.kindle || prev.kindle) : Boolean(prev.kindle)
      };
    });

    await chrome.storage.local.set({
      [key]: Array.from(existing),
      [srcKey]: sourceMap
    });
  } catch (e) {
    console.warn('[WeebDownloader] Error saving downloaded chapters:', e);
  }
}

/**
 * Convert ArrayBuffer to Base64 efficiently
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Calculate download paths:
 * - If inside ~/Downloads, Chrome downloads directly to the relative subfolder.
 * - If outside ~/Downloads, Chrome downloads to a temporary staging folder (_weeb_staging),
 *   and Native Host relocates completed files to desiredDir and cleans up staging.
 */
function getDownloadPaths(mangaSubfolder, localDownloads) {
  const baseDir = (localDownloads || '~/Downloads').replace(/\/+$/, '');
  const desiredDir = `${baseDir}/${mangaSubfolder}`;

  // Check if desiredDir is inside ~/Downloads
  const downloadsMatch = desiredDir.match(/(?:\/Users\/[^/]+|\/home\/[^/]+|~)?\/Downloads(?:\/(.+))?$/i);

  if (downloadsMatch) {
    const chromeSubfolder = downloadsMatch[1] || '';
    return {
      desiredDir,
      chromeSubfolder,
      needsRelocation: false
    };
  } else {
    return {
      desiredDir,
      chromeSubfolder: '_weeb_staging',
      needsRelocation: true
    };
  }
}

function sanitizeFilename(name) {
  if (!name) return 'untitled';
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format chapter filename according to user template:
 * Tokens: {title}, {chapter}, {number}, {number.2}, {number.3}, {number.4}
 */
function formatChapterFilename(template, mangaTitle, chapterName, chapterNumber) {
  let tmpl = template || '{chapter}';
  const rawNum = chapterNumber !== undefined && chapterNumber !== null ? String(chapterNumber) : '';
  const numVal = parseFloat(rawNum);

  function padNum(n, digits) {
    if (isNaN(n)) return rawNum;
    const intPart = Math.floor(n);
    const decPart = n % 1 !== 0 ? '.' + String(n).split('.')[1] : '';
    return String(intPart).padStart(digits, '0') + decPart;
  }

  const num2 = !isNaN(numVal) ? padNum(numVal, 2) : rawNum;
  const num3 = !isNaN(numVal) ? padNum(numVal, 3) : rawNum;
  const num4 = !isNaN(numVal) ? padNum(numVal, 4) : rawNum;

  let result = tmpl
    .replace(/{title}/g, mangaTitle || '')
    .replace(/{chapter}/g, chapterName || '')
    .replace(/{number\.4}/g, num4)
    .replace(/{number\.3}/g, num3)
    .replace(/{number\.2}/g, num2)
    .replace(/{number}/g, rawNum || chapterName);

  return sanitizeFilename(result);
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getExtensionFromUrl(url, mime) {
  if (mime) {
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('png')) return 'png';
    if (mime.includes('avif')) return 'avif';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  }
  const cleanUrl = url.split('?')[0].split('#')[0];
  const dotIndex = cleanUrl.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = cleanUrl.substring(dotIndex + 1).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return 'jpg';
}

/**
 * Handle saving a file using chrome.downloads API (legacy handler)
 */
async function handleSaveDownload({ blobUrl, dataUrl, filename }) {
  const url = blobUrl || dataUrl;
  if (!url) throw new Error('No URL/data provided for download');
  return saveUrlToFile(url, filename);
}

/**
 * Communicate with Native Messaging host com.weebdownloader.kindle
 */
function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, response => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) {
          return reject(new Error('No response from native messaging host. Is it installed?'));
        }
        resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

