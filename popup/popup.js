/**
 * MediaGrabber PRO - Popup Controller
 * Implements reference 2-row card layout, real thumbnails with duration overlays,
 * format/quality dropdown selectors, split download buttons, dismiss actions,
 * and comprehensive bottom toolbar with deep scanner & history.
 */

let activeTabId = null;
let activeTabUrl = '';
let activeTabOrigin = '';
let currentTabMedia = [];
let activeFilter = 'all';
let searchQuery = '';
let currentPreviewMedia = null;
let activeHlsDownloader = null;
let activeJobsPollingInterval = null;

// Multi-Selection state
const selectedMediaIds = new Set();

// Theme State
let currentTheme = 'auto';

// Custom Media Player State
let currentPlayingMediaEl = null;
const playerSpeedOptions = [1.0, 1.25, 1.5, 2.0];
let currentSpeedIdx = 0;
let playerVolumeLevel = 1.0;
let isPlayerMuted = false;
let isTimelineScrubbing = false;

// DOM Elements
const currentDomainEl = document.getElementById('currentDomain');
const mediaContainer = document.getElementById('mediaContainer');
const emptyState = document.getElementById('emptyState');
const batchBar = document.getElementById('batchBar');
const batchInfo = document.getElementById('batchInfo');
const searchInput = document.getElementById('searchInput');

// Theme Elements
const btnThemeToggle = document.getElementById('btnThemeToggle');
const themeIconDark = document.getElementById('themeIconDark');
const themeIconLight = document.getElementById('themeIconLight');
const themeIconAuto = document.getElementById('themeIconAuto');

// Batch Multi-Select Elements
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const btnDeleteSelected = document.getElementById('btnDeleteSelected');
const btnDeleteText = document.getElementById('btnDeleteText');
const btnCopyAll = document.getElementById('btnCopyAll');
const btnCopyText = document.getElementById('btnCopyText');
const btnDownloadAll = document.getElementById('btnDownloadAll');
const btnDownloadText = document.getElementById('btnDownloadText');

// Active Downloads & Policy Notices
const activeDownloadsPanel = document.getElementById('activeDownloadsPanel');
const activeDownloadsList = document.getElementById('activeDownloadsList');
const youtubePolicyNotice = document.getElementById('youtubePolicyNotice');
const btnOpenTestLabFromYt = document.getElementById('btnOpenTestLabFromYt');
const btnSidePanel = document.getElementById('btnSidePanel');

// Counter Badges
const countAllEl = document.getElementById('countAll');
const countVideoEl = document.getElementById('countVideo');
const countAudioEl = document.getElementById('countAudio');
const countStreamEl = document.getElementById('countStream');

// Custom Media Player Elements
const previewModal = document.getElementById('previewModal');
const previewTitle = document.getElementById('previewTitle');
const playerViewport = document.getElementById('playerViewport');
const customPlayerBar = document.getElementById('customPlayerBar');
const playerCurrentTime = document.getElementById('playerCurrentTime');
const playerDuration = document.getElementById('playerDuration');
const playerTimeline = document.getElementById('playerTimeline');
const playerBuffered = document.getElementById('playerBuffered');
const btnPlayerPlayPause = document.getElementById('btnPlayerPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnPlayerReplay = document.getElementById('btnPlayerReplay');
const btnPlayerSpeed = document.getElementById('btnPlayerSpeed');
const btnPlayerMute = document.getElementById('btnPlayerMute');
const iconVolHigh = document.getElementById('iconVolHigh');
const iconVolMuted = document.getElementById('iconVolMuted');
const playerVolume = document.getElementById('playerVolume');
const modalDownloadBtnText = document.getElementById('modalDownloadBtnText');

// Modals
const hlsProgressModal = document.getElementById('hlsProgressModal');
const hlsModalTitle = document.getElementById('hlsModalTitle');
const hlsProgressFill = document.getElementById('hlsProgressFill');
const hlsStatusText = document.getElementById('hlsStatusText');
const hlsPercentText = document.getElementById('hlsPercentText');

const noVideoModal = document.getElementById('noVideoModal');
const historyModal = document.getElementById('historyModal');
const helpModal = document.getElementById('helpModal');
const subtitlesModal = document.getElementById('subtitlesModal');

document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();
  setupEventListeners();
  await initActiveTab();
  await loadTabMedia();
  pollActiveJobs();
});

/**
 * Identify the current active tab
 */
async function initActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) {
      activeTabId = tabs[0].id;
      const rawUrl = tabs[0].url || '';
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        activeTabUrl = rawUrl;
      } else {
        activeTabUrl = '';
      }

      try {
        if (rawUrl.startsWith('http')) {
          const url = new URL(rawUrl);
          activeTabOrigin = url.origin;
          currentDomainEl.textContent = url.hostname.replace('www.', '') || 'Active Web Page';
        } else {
          currentDomainEl.textContent = 'Active Page';
        }
      } catch (e) {
        currentDomainEl.textContent = 'Active Page';
      }

      // YouTube Chrome Web Store Policy check
      if (rawUrl.includes('youtube.com') || rawUrl.includes('youtu.be')) {
        if (youtubePolicyNotice) youtubePolicyNotice.style.display = 'flex';
        if (emptyState) emptyState.style.display = 'none';
      } else {
        if (youtubePolicyNotice) youtubePolicyNotice.style.display = 'none';
      }

      if (activeTabId && activeTabUrl) {
        chrome.runtime.sendMessage({
          action: 'ENSURE_CONTENT_SCRIPT',
          tabId: activeTabId
        }, () => {
          if (chrome.runtime.lastError) {}
        });

        chrome.runtime.sendMessage({
          action: 'SETUP_STREAM_RULES',
          pageUrl: activeTabUrl
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    }
  } catch (err) {
    currentDomainEl.textContent = 'Active Page';
  }
}

/**
 * Polls background service worker for active download jobs
 */
function pollActiveJobs() {
  chrome.runtime.sendMessage({ action: 'GET_ACTIVE_JOBS' }, (res) => {
    if (chrome.runtime.lastError) return;
    const jobs = res?.jobs || [];
    renderActiveJobs(jobs);

    if (jobs.length > 0 && !activeJobsPollingInterval) {
      activeJobsPollingInterval = setInterval(() => {
        chrome.runtime.sendMessage({ action: 'GET_ACTIVE_JOBS' }, (r) => {
          if (chrome.runtime.lastError) {
            clearInterval(activeJobsPollingInterval);
            activeJobsPollingInterval = null;
            return;
          }
          const current = r?.jobs || [];
          renderActiveJobs(current);
          if (current.length === 0) {
            clearInterval(activeJobsPollingInterval);
            activeJobsPollingInterval = null;
          }
        });
      }, 1200);
    } else if (jobs.length === 0 && activeJobsPollingInterval) {
      clearInterval(activeJobsPollingInterval);
      activeJobsPollingInterval = null;
    }
  });
}

/**
 * Renders the active download job cards
 */
function renderActiveJobs(jobs) {
  if (!activeDownloadsPanel || !activeDownloadsList) return;

  if (!jobs || jobs.length === 0) {
    activeDownloadsPanel.style.display = 'none';
    activeDownloadsList.innerHTML = '';
    return;
  }

  activeDownloadsPanel.style.display = 'block';
  activeDownloadsList.innerHTML = '';

  jobs.forEach((job) => {
    const card = document.createElement('div');
    card.className = 'active-dl-card';
    card.dataset.jobId = job.id;

    const percent = Math.min(100, Math.max(0, job.percent || 0));
    let metricsText = '';
    if (job.speed) metricsText += job.speed;
    if (job.eta) metricsText += (metricsText ? ' • ' : '') + job.eta;

    card.innerHTML = `
      <div class="active-dl-top">
        <span class="active-dl-name" title="${escapeHtml(job.filename)}">${escapeHtml(job.filename)}</span>
        <button class="btn-cancel-job" title="Cancel Download">✕</button>
      </div>
      <div class="active-dl-bar-box">
        <div class="active-dl-bar-fill" style="width: ${percent}%;"></div>
      </div>
      <div class="active-dl-footer">
        <span>${escapeHtml(job.text || 'Processing...')}</span>
        <span class="active-dl-metrics">${metricsText || percent + '%'}</span>
      </div>
    `;

    card.querySelector('.btn-cancel-job').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD_JOB', jobId: job.id }, () => {
        showToast('Cancelled background download.');
        pollActiveJobs();
      });
    });

    activeDownloadsList.appendChild(card);
  });
}

/**
 * Starts a background download job that survives popup closure
 */
function startDownloadJob(item, format = 'mp4', saveAs = false) {
  let targetFilename = item.filename;
  if (format === 'm4a' || format === 'mp3') {
    targetFilename = targetFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.' + format;
  } else if (!targetFilename.toLowerCase().endsWith('.mp4')) {
    targetFilename = targetFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.mp4';
  }

  showToast(`Starting ${format.toUpperCase()} download in background... ⚡`);

  chrome.runtime.sendMessage({
    action: 'START_DOWNLOAD_JOB',
    media: item,
    format,
    filename: targetFilename,
    saveAs,
    tabId: activeTabId,
    pageUrl: activeTabUrl
  }, (res) => {
    if (chrome.runtime.lastError) {
      showToast('Error starting download: ' + chrome.runtime.lastError.message);
      return;
    }
    if (res && res.success) {
      showToast('Downloading in background — safe to close popup! ✓');
      pollActiveJobs();
    } else {
      showToast('Failed to start: ' + (res?.error || 'Unknown error'));
    }
  });
}

/**
 * Load media streams detected for current tab
 */
async function loadTabMedia() {
  if (!activeTabId) return;

  chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: activeTabId }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.media) {
      currentTabMedia = res.media;
    } else {
      currentTabMedia = [];
    }
    renderUI();

    // Query active tab video player directly for exact duration and poster
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'GET_PAGE_VIDEO_INFO' }, (pageInfo) => {
        if (!chrome.runtime.lastError && pageInfo && pageInfo.duration) {
          let updated = false;
          currentTabMedia.forEach((m) => {
            if (!m.duration) {
              m.duration = pageInfo.duration;
              m.durationFormatted = MediaDetector.formatDuration(pageInfo.duration);
              updated = true;
            }
            if (!m.poster && pageInfo.poster) {
              m.poster = pageInfo.poster;
              updated = true;
            }
          });
          if (updated) renderUI();
        }
      });
    }

    // Also resolve HLS duration directly from M3U8 chunk list for any stream missing duration
    currentTabMedia.forEach((item) => {
      if (!item.duration && (item.ext === 'm3u8' || item.type === 'stream')) {
        resolveHlsDuration(item);
      }
    });
  });
}

/**
 * Asynchronously calculates total duration from M3U8 chunk definitions
 */
async function resolveHlsDuration(item) {
  if (item.duration) return;
  try {
    const hls = new HLSDownloader({ tabId: activeTabId, pageUrl: activeTabUrl });
    const raw = await hls.fetchResource(item.url, 'text');
    const parsed = hls.parseM3U8(raw, item.url);
    let dur = 0;
    if (!parsed.isMaster && parsed.totalDuration > 0) {
      dur = parsed.totalDuration;
    } else if (parsed.isMaster && parsed.variants && parsed.variants.length > 0) {
      const varRaw = await hls.fetchResource(parsed.variants[0].url, 'text');
      const varParsed = hls.parseM3U8(varRaw, parsed.variants[0].url);
      dur = varParsed.totalDuration || 0;
    }
    if (dur > 0) {
      item.duration = dur;
      item.durationFormatted = MediaDetector.formatDuration(dur);
      const card = document.querySelector(`.media-card[data-id="${item.id}"]`);
      if (card) {
        const textEl = card.querySelector('.duration-val-text');
        if (textEl) textEl.textContent = item.durationFormatted;
      }
    }
  } catch (e) {}
}

/**
 * Setup Click & Input Event Listeners
 */
function setupEventListeners() {
  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      renderUI();
    });
  });

  // Search filter
  const btnClearSearch = document.getElementById('btnClearSearch');
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    if (btnClearSearch) {
      btnClearSearch.style.display = searchQuery ? 'flex' : 'none';
    }
    renderUI();
  });

  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      btnClearSearch.style.display = 'none';
      renderUI();
      searchInput.focus();
    });
  }

  // Header actions
  document.getElementById('btnRefresh').addEventListener('click', () => {
    showToast('Rescanning page for media...');
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'RESCAN_DOM' }, () => {
        if (chrome.runtime.lastError) {}
        setTimeout(loadTabMedia, 500);
      });
    }
  });

  document.getElementById('btnClear').addEventListener('click', () => {
    if (activeTabId) {
      chrome.runtime.sendMessage({ action: 'CLEAR_TAB_MEDIA', tabId: activeTabId }, () => {
        if (chrome.runtime.lastError) {}
        currentTabMedia = [];
        renderUI();
        showToast('Cleared detected media list.');
      });
    }
  });

  document.getElementById('btnOptions').addEventListener('click', openOptionsPage);

  // Theme Toggle Button
  if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', toggleTheme);
  }

  // Side Panel button
  if (btnSidePanel) {
    btnSidePanel.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'OPEN_SIDE_PANEL' }, (res) => {
        if (res && res.success) {
          window.close();
        } else {
          showToast('Side panel opened!');
        }
      });
    });
  }

  // YouTube Notice button
  if (btnOpenTestLabFromYt) {
    btnOpenTestLabFromYt.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('test_lab/test_lab.html') });
    });
  }

  // Listen for background download job progress updates
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'JOB_PROGRESS_UPDATE' ||
        request.action === 'JOB_COMPLETED' ||
        request.action === 'JOB_ERROR' ||
        request.action === 'JOB_CANCELLED') {
      pollActiveJobs();
    }
  });

  // Empty state actions
  document.getElementById('btnForceScan').addEventListener('click', () => {
    document.getElementById('btnRefresh').click();
  });

  document.getElementById('btnOpenTestLab').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('test_lab/test_lab.html') });
  });

  // Batch actions
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', (e) => {
      const filtered = getFilteredMedia();
      if (e.target.checked) {
        filtered.forEach(m => selectedMediaIds.add(m.id));
      } else {
        filtered.forEach(m => selectedMediaIds.delete(m.id));
      }
      document.querySelectorAll('.media-card-checkbox').forEach(cb => {
        const id = cb.dataset.id;
        cb.checked = selectedMediaIds.has(id);
        const card = cb.closest('.media-card');
        if (card) {
          if (cb.checked) card.classList.add('selected');
          else card.classList.remove('selected');
        }
      });
      updateBatchSelectionUI();
    });
  }

  if (btnDeleteSelected) {
    btnDeleteSelected.addEventListener('click', deleteSelectedMedia);
  }

  document.getElementById('btnDownloadAll').addEventListener('click', downloadAllFiltered);
  document.getElementById('btnCopyAll').addEventListener('click', copyAllFiltered);

  // Custom Mini Player Controls
  if (btnPlayerPlayPause) {
    btnPlayerPlayPause.addEventListener('click', togglePlayerPlayPause);
  }
  if (btnPlayerReplay) {
    btnPlayerReplay.addEventListener('click', () => {
      if (currentPlayingMediaEl) {
        currentPlayingMediaEl.currentTime = Math.max(0, currentPlayingMediaEl.currentTime - 10);
      }
    });
  }
  if (btnPlayerSpeed) {
    btnPlayerSpeed.addEventListener('click', cyclePlayerSpeed);
  }
  if (btnPlayerMute) {
    btnPlayerMute.addEventListener('click', togglePlayerMute);
  }
  if (playerVolume) {
    playerVolume.addEventListener('input', (e) => {
      setPlayerVolume(parseFloat(e.target.value));
    });
  }
  if (playerTimeline) {
    playerTimeline.addEventListener('input', (e) => {
      isTimelineScrubbing = true;
      playerCurrentTime.textContent = formatPlayerTime(parseFloat(e.target.value));
    });
    playerTimeline.addEventListener('change', (e) => {
      if (currentPlayingMediaEl) {
        currentPlayingMediaEl.currentTime = parseFloat(e.target.value);
      }
      isTimelineScrubbing = false;
    });
  }

  // Global Keyboard Shortcuts (Esc to close any modal)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllModals();
    }
  });

  // Preview Modal
  document.getElementById('btnClosePreview').addEventListener('click', closePreviewModal);
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) closePreviewModal();
  });
  document.getElementById('btnModalDownload').addEventListener('click', () => {
    if (currentPreviewMedia) {
      if (currentPreviewMedia.ext === 'm3u8') {
        startHlsMp4Conversion(currentPreviewMedia);
      } else {
        triggerDownload(currentPreviewMedia);
      }
      closePreviewModal();
    }
  });

  // HLS Cancel button
  document.getElementById('btnCancelHls').addEventListener('click', () => {
    if (activeHlsDownloader) {
      activeHlsDownloader.cancel();
      hlsProgressModal.style.display = 'none';
      showToast('Conversion cancelled.');
    }
  });

  // Bottom Toolbar Actions
  document.getElementById('btnToolbarSettings').addEventListener('click', openOptionsPage);

  document.getElementById('btnNoVideo').addEventListener('click', () => {
    noVideoModal.style.display = 'flex';
  });
  document.getElementById('btnCloseNoVideo').addEventListener('click', () => {
    noVideoModal.style.display = 'none';
  });

  document.getElementById('btnExecuteDeepScan').addEventListener('click', () => {
    showToast('Probing player iframes & decoders...');
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'DEEP_SCAN' }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
    setTimeout(() => {
      noVideoModal.style.display = 'none';
      loadTabMedia();
      showToast('Deep scan completed! ✨');
    }, 700);
  });

  document.getElementById('btnSubtitles').addEventListener('click', openSubtitlesModal);
  document.getElementById('btnCloseSubtitles').addEventListener('click', () => {
    subtitlesModal.style.display = 'none';
  });

  document.getElementById('btnHistory').addEventListener('click', openHistoryModal);
  document.getElementById('btnCloseHistory').addEventListener('click', () => {
    historyModal.style.display = 'none';
  });

  document.getElementById('btnHistoryOpenFolder').addEventListener('click', openDownloadsFolder);
  document.getElementById('btnOpenFolder').addEventListener('click', openDownloadsFolder);

  document.getElementById('btnClearHistory').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_DOWNLOAD_HISTORY' }, () => {
      openHistoryModal();
      showToast('Download history cleared.');
    });
  });

  document.getElementById('btnToolbarTrash').addEventListener('click', () => {
    document.getElementById('btnClear').click();
  });

  document.getElementById('btnHelp').addEventListener('click', () => {
    helpModal.style.display = 'flex';
  });
  document.getElementById('btnCloseHelp').addEventListener('click', () => {
    helpModal.style.display = 'none';
  });

  // Close menus on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.quality-dropdown-wrapper')) {
      document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.style.display = 'none');
    }
    if (!e.target.closest('.split-dl-container')) {
      document.querySelectorAll('.split-actions-menu').forEach(m => m.style.display = 'none');
    }
  });
}

function openOptionsPage() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options/options.html'));
  }
}

function openDownloadsFolder() {
  chrome.runtime.sendMessage({ action: 'OPEN_DOWNLOADS_FOLDER' }, () => {
    if (chrome.runtime.lastError) {}
  });
}

/**
 * Filter & Search predicate
 */
function getFilteredMedia() {
  const hasFullStream = currentTabMedia.some(m => m.ext === 'm3u8');

  return currentTabMedia.filter((item) => {
    if (hasFullStream && item.isSubChunk) {
      return false;
    }

    let matchesCategory = true;
    if (activeFilter === 'video') {
      matchesCategory = item.type === 'video' || item.ext === 'm3u8' || item.ext === 'mp4' || item.ext === 'webm';
    } else if (activeFilter === 'audio') {
      matchesCategory = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';
    } else if (activeFilter === 'stream') {
      matchesCategory = item.type === 'stream' || item.ext === 'm3u8';
    }

    let matchesSearch = true;
    if (searchQuery) {
      const titleMatch = (item.filename || '').toLowerCase().includes(searchQuery);
      const extMatch = (item.ext || '').toLowerCase().includes(searchQuery);
      const qualityMatch = (item.quality || '').toLowerCase().includes(searchQuery);
      matchesSearch = titleMatch || extMatch || qualityMatch;
    }

    return matchesCategory && matchesSearch;
  });
}

/**
 * Render complete UI
 */
function renderUI() {
  updateCounts();
  const filtered = getFilteredMedia();

  if (filtered.length === 0) {
    emptyState.style.display = 'flex';
    mediaContainer.style.display = 'none';
    batchBar.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  mediaContainer.style.display = 'flex';
  batchBar.style.display = filtered.length > 0 ? 'flex' : 'none';
  batchInfo.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'} ready`;

  mediaContainer.innerHTML = '';
  filtered.forEach((item, index) => {
    const card = createMediaCard(item, index + 1);
    mediaContainer.appendChild(card);
  });
  updateBatchSelectionUI();
}

/**
 * Update filter count badges
 */
function updateCounts() {
  const hasFullStream = currentTabMedia.some(m => m.ext === 'm3u8');
  const validList = currentTabMedia.filter(m => !(hasFullStream && m.isSubChunk));

  const allCount = validList.length;
  const videoCount = validList.filter((m) => m.type === 'video' || m.ext === 'm3u8' || m.ext === 'mp4' || m.ext === 'webm').length;
  const audioCount = validList.filter((m) => m.type === 'audio' || m.ext === 'mp3' || m.ext === 'm4a').length;
  const streamCount = validList.filter((m) => m.type === 'stream' || m.ext === 'm3u8').length;

  countAllEl.textContent = allCount;
  countVideoEl.textContent = videoCount;
  countAudioEl.textContent = audioCount;
  countStreamEl.textContent = streamCount;
}

/**
 * Creates a Rich Video / Audio Thumbnail Element (16:9 matching Image 1)
 */
function createThumbnailElement(item, index) {
  const isAudio = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';
  const isHls = item.ext === 'm3u8' || item.type === 'stream';

  const thumbBox = document.createElement('div');
  thumbBox.className = 'media-thumbnail';
  thumbBox.title = 'Click to preview video in player';

  const durationBadgeText = item.durationFormatted || item.quality || (isHls ? 'HLS' : (item.ext || 'MP4').toUpperCase());

  const metaOverlayHtml = `
    <div class="thumb-meta-overlay">
      <span class="thumb-index-tag">${index}</span>
      <span class="thumb-duration-pill">
        <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        <span class="duration-val-text">${escapeHtml(durationBadgeText)}</span>
      </span>
    </div>
  `;

  if (item.poster) {
    thumbBox.innerHTML = `
      <img src="${escapeHtml(item.poster)}" alt="thumbnail" class="thumb-img" />
      <div class="thumb-overlay"></div>
      <div class="thumb-play-btn">
        <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
      </div>
      ${metaOverlayHtml}
    `;
    const img = thumbBox.querySelector('.thumb-img');
    if (img) {
      img.onerror = () => {
        thumbBox.innerHTML = getFallbackThumbnailHTML(item, isAudio, isHls, metaOverlayHtml);
      };
    }
  } else {
    thumbBox.innerHTML = getFallbackThumbnailHTML(item, isAudio, isHls, metaOverlayHtml);
  }

  thumbBox.addEventListener('click', (e) => {
    e.stopPropagation();
    openPreviewModal(item);
  });

  return thumbBox;
}

function getFallbackThumbnailHTML(item, isAudio, isHls, metaOverlayHtml) {
  return `
    <div style="width: 100%; height: 100%; background: radial-gradient(circle at 30% 30%, #1e293b 0%, #090d16 100%); display: flex; align-items: center; justify-content: center; position: relative;">
      <svg style="width: 24px; height: 24px; color: rgba(255,255,255,0.25);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
        <line x1="7" y1="2" x2="7" y2="22"></line>
        <line x1="17" y1="2" x2="17" y2="22"></line>
        <line x1="2" y1="12" x2="22" y2="12"></line>
      </svg>
    </div>
    <div class="thumb-overlay"></div>
    <div class="thumb-play-btn">
      <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
    </div>
    ${metaOverlayHtml}
  `;
}

/**
 * Create a Reference 2-Row Media Card DOM Element (Matching Image 1)
 */
function createMediaCard(item, index) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = item.id;

  const isHls = item.ext === 'm3u8' || item.type === 'stream';
  const isAudio = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';

  let displayFilename = item.filename;
  if (isHls && !displayFilename.toLowerCase().endsWith('.mp4')) {
    displayFilename = displayFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.mp4';
    item.filename = displayFilename;
  }

  // Trigger background duration resolution if missing
  if (!item.duration && isHls) {
    resolveHlsDuration(item);
  }

  const thumbElem = createThumbnailElement(item, index);
  const protocol = item.protocol || (isHls ? 'HLS' : (isAudio ? 'AUDIO' : 'HTTP'));
  const protocolClass = isHls ? 'hls' : (isAudio ? 'audio' : 'http');
  
  let defaultQualityLabel = item.selectedQualityLabel;
  if (!defaultQualityLabel) {
    if (isHls) {
      defaultQualityLabel = item.quality ? `MP4 ${item.quality}` : 'MP4 802p';
    } else {
      defaultQualityLabel = item.quality ? `${(item.ext || 'MP4').toUpperCase()} ${item.quality}` : (item.ext || 'MP4').toUpperCase();
    }
  }

  const isSelected = selectedMediaIds.has(item.id);
  if (isSelected) {
    card.classList.add('selected');
  }

  card.innerHTML = `
    <div class="card-select-col">
      <input type="checkbox" class="media-card-checkbox" data-id="${item.id}" ${isSelected ? 'checked' : ''} aria-label="Select ${escapeHtml(displayFilename)}" />
    </div>
    <div class="thumb-slot"></div>
    <div class="card-content-box">
      <!-- Top Row: Protocol pill + Title + Dismiss (✕) -->
      <div class="card-top-row">
        <span class="protocol-badge ${protocolClass}">${protocol}</span>
        <span class="card-title-text" title="${escapeHtml(displayFilename)}">${escapeHtml(displayFilename)}</span>
        <button class="btn-card-dismiss" title="Remove from list">✕</button>
      </div>

      <!-- Bottom Row: Rename [✏️] + Quality Dropdown [MP4 802p ▾] + Split Download [⬇ Download | ▾] -->
      <div class="card-bottom-row">
        <div class="card-controls-left">
          <button class="btn-rename-pill" title="Rename file">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
          <div class="quality-dropdown-wrapper">
            <button class="btn-quality-pill" title="Select format or quality">
              <span class="quality-label-text">${escapeHtml(defaultQualityLabel)}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="custom-dropdown-menu" style="display: none;">
              <!-- Options populated dynamically -->
            </div>
          </div>
        </div>

        <div class="split-dl-container">
          <button class="split-dl-main" title="Instant Download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="8 12 12 16 16 12"></polyline><line x1="12" y1="8" x2="12" y2="16"></line></svg>
            <span>Download</span>
          </button>
          <button class="split-dl-arrow" title="More download options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <div class="split-actions-menu" style="display: none;">
            <button class="split-menu-item action-quick-dl">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              <span>Instant Download</span>
            </button>
            <button class="split-menu-item action-save-as">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
              <span>Save As...</span>
            </button>
            <button class="split-menu-item action-mp3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
              <span>Extract MP3 Audio</span>
            </button>
            <button class="split-menu-item action-copy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span>Copy Direct Link</span>
            </button>
            <button class="split-menu-item action-preview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              <span>Preview Player</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Insert thumbnail
  const thumbSlot = card.querySelector('.thumb-slot');
  if (thumbSlot) {
    thumbSlot.replaceWith(thumbElem);
  }

  // Media Card Selection Checkbox
  const checkbox = card.querySelector('.media-card-checkbox');
  if (checkbox) {
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        selectedMediaIds.add(item.id);
        card.classList.add('selected');
      } else {
        selectedMediaIds.delete(item.id);
        card.classList.remove('selected');
      }
      updateBatchSelectionUI();
    });
  }

  // Dismiss Card (✕)
  const btnDismiss = card.querySelector('.btn-card-dismiss');
  btnDismiss.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({
      action: 'DELETE_MEDIA_ITEM',
      id: item.id,
      tabId: activeTabId
    }, () => {
      selectedMediaIds.delete(item.id);
      currentTabMedia = currentTabMedia.filter(m => m.id !== item.id);
      card.remove();
      updateCounts();
      const filtered = getFilteredMedia();
      if (filtered.length === 0) {
        emptyState.style.display = 'flex';
        mediaContainer.style.display = 'none';
        batchBar.style.display = 'none';
      } else {
        updateBatchSelectionUI();
      }
      showToast('Item removed from list.');
    });
  });

  // Inline Title Editing
  const titleText = card.querySelector('.card-title-text');
  const btnRename = card.querySelector('.btn-rename-pill');

  function startTitleEdit() {
    const currentName = item.filename;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-title-edit-input';
    input.value = currentName;
    titleText.replaceWith(input);
    input.focus();
    input.select();

    function commitTitle() {
      const newTitle = input.value.trim() || currentName;
      item.filename = newTitle;
      titleText.textContent = newTitle;
      titleText.title = newTitle;
      input.replaceWith(titleText);
    }

    input.addEventListener('blur', commitTitle);
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') {
        input.removeEventListener('blur', commitTitle);
        commitTitle();
      } else if (ke.key === 'Escape') {
        input.removeEventListener('blur', commitTitle);
        input.replaceWith(titleText);
      }
    });
  }

  titleText.addEventListener('click', startTitleEdit);
  btnRename.addEventListener('click', startTitleEdit);

  // Format / Quality Selector Dropdown
  const btnQuality = card.querySelector('.btn-quality-pill');
  const qualityLabelText = card.querySelector('.quality-label-text');
  const qualityMenu = card.querySelector('.custom-dropdown-menu');

  btnQuality.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isVisible = qualityMenu.style.display === 'flex';
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.style.display = 'none');
    document.querySelectorAll('.split-actions-menu').forEach(m => m.style.display = 'none');

    if (!isVisible) {
      // Build options list
      qualityMenu.innerHTML = '';

      if (isHls) {
        // Fetch or provide HLS variants
        const standardQualities = [
          { label: 'MP4 1080p FHD', ext: 'mp4' },
          { label: 'MP4 720p HD', ext: 'mp4' },
          { label: 'MP4 480p SD', ext: 'mp4' },
          { label: 'MP4 (Best Stream)', ext: 'mp4' },
          { label: 'M4A Audio (Lossless Stream)', ext: 'm4a' },
          { label: 'MP3 Audio Track', ext: 'mp3' }
        ];

        standardQualities.forEach((q) => {
          const opt = document.createElement('button');
          opt.className = 'dropdown-item';
          opt.textContent = q.label;
          opt.addEventListener('click', () => {
            qualityLabelText.textContent = q.label.replace(' Only', '');
            item.selectedQualityLabel = q.label.replace(' Only', '');
            item.targetContainer = q.ext;
            qualityMenu.style.display = 'none';
          });
          qualityMenu.appendChild(opt);
        });
      } else {
        const directOptions = [
          { label: `${(item.ext || 'MP4').toUpperCase()} (Original)`, ext: item.ext || 'mp4' },
          { label: 'M4A Audio Track', ext: 'm4a' },
          { label: 'MP3 Audio Track', ext: 'mp3' }
        ];

        directOptions.forEach((q) => {
          const opt = document.createElement('button');
          opt.className = 'dropdown-item';
          opt.textContent = q.label;
          opt.addEventListener('click', () => {
            qualityLabelText.textContent = q.label;
            item.selectedQualityLabel = q.label;
            item.targetContainer = q.ext;
            qualityMenu.style.display = 'none';
          });
          qualityMenu.appendChild(opt);
        });
      }

      qualityMenu.style.display = 'flex';
    }
  });

  // Split Download Actions
  const splitDlMain = card.querySelector('.split-dl-main');
  const splitDlArrow = card.querySelector('.split-dl-arrow');
  const splitMenu = card.querySelector('.split-actions-menu');

  // Main download trigger (delegates to background offscreen worker)
  splitDlMain.addEventListener('click', () => {
    const format = item.targetContainer || (isHls ? 'mp4' : (item.ext || 'mp4'));
    startDownloadJob(item, format, false);
  });

  splitDlArrow.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = splitMenu.style.display === 'flex';
    document.querySelectorAll('.split-actions-menu').forEach(m => m.style.display = 'none');
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.style.display = 'none');
    splitMenu.style.display = isVisible ? 'none' : 'flex';
  });

  // Split Menu Options
  card.querySelector('.action-quick-dl').addEventListener('click', () => {
    splitMenu.style.display = 'none';
    const format = item.targetContainer || (isHls ? 'mp4' : (item.ext || 'mp4'));
    startDownloadJob(item, format, false);
  });

  card.querySelector('.action-save-as').addEventListener('click', () => {
    splitMenu.style.display = 'none';
    const format = item.targetContainer || (isHls ? 'mp4' : (item.ext || 'mp4'));
    startDownloadJob(item, format, true);
  });

  card.querySelector('.action-mp3').addEventListener('click', () => {
    splitMenu.style.display = 'none';
    startDownloadJob(item, 'm4a', false);
  });

  card.querySelector('.action-copy').addEventListener('click', () => {
    splitMenu.style.display = 'none';
    navigator.clipboard.writeText(item.url).then(() => {
      showToast('Direct stream link copied! 📋');
    });
  });

  card.querySelector('.action-preview').addEventListener('click', () => {
    splitMenu.style.display = 'none';
    openPreviewModal(item);
  });

  return card;
}

/**
 * Direct file download via background service worker
 */
function triggerDownload(item, saveAs = false) {
  showToast(`Downloading: ${item.filename}`);
  chrome.runtime.sendMessage({
    action: 'DOWNLOAD_MEDIA',
    url: item.url,
    filename: item.filename,
    saveAs
  }, (res) => {
    if (chrome.runtime.lastError) {
      showToast('Download error: ' + chrome.runtime.lastError.message);
      return;
    }
    if (res && res.success) {
      showToast('Download started in browser! ⬇️');
    } else {
      showToast('Download failed: ' + (res?.error || 'Network error'));
    }
  });
}

/**
 * Handle HLS Stream Download & Automatic Transmuxing to MP4
 */
async function startHlsMp4Conversion(item, saveAs = false) {
  hlsModalTitle.textContent = 'Converting Stream to MP4 🎥';
  hlsProgressModal.style.display = 'flex';
  hlsProgressFill.style.width = '0%';
  hlsStatusText.textContent = 'Initializing stream download...';
  hlsPercentText.textContent = '0%';

  activeHlsDownloader = new HLSDownloader({
    concurrency: 4,
    tabId: activeTabId,
    pageUrl: activeTabUrl
  });

  try {
    const result = await activeHlsDownloader.downloadAndConvertToMp4(item.url, (progress) => {
      hlsProgressFill.style.width = `${progress.percent}%`;
      hlsPercentText.textContent = `${progress.percent}%`;
      hlsStatusText.textContent = progress.text;
    });

    const blobUrl = URL.createObjectURL(result.blob);
    let downloadFilename = item.filename;
    if (!downloadFilename.toLowerCase().endsWith('.' + result.format)) {
      downloadFilename = downloadFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.' + result.format;
    }

    chrome.downloads.download({
      url: blobUrl,
      filename: downloadFilename,
      saveAs
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        showToast(`Save error: ${chrome.runtime.lastError.message}`);
      } else {
        showToast(`Stream converted & saved as ${result.format.toUpperCase()}! 🎉`);
        // Log to history
        chrome.runtime.sendMessage({
          action: 'RECORD_DOWNLOAD_HISTORY',
          item: {
            filename: downloadFilename,
            url: item.url,
            downloadId
          }
        });
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      hlsProgressModal.style.display = 'none';
    });
  } catch (err) {
    if (!err.message || !err.message.includes('cancelled')) {
      showToast(`Conversion error: ${err.message || 'Stream processing failed'}`);
    }
    hlsProgressModal.style.display = 'none';
  }
}

/**
 * Handle HLS Stream Download & Audio Extraction to MP3
 */
async function startHlsMp3Extraction(item) {
  hlsModalTitle.textContent = 'Extracting Audio to MP3 🎵';
  hlsProgressModal.style.display = 'flex';
  hlsProgressFill.style.width = '0%';
  hlsStatusText.textContent = 'Downloading stream audio chunks...';
  hlsPercentText.textContent = '0%';

  activeHlsDownloader = new HLSDownloader({
    concurrency: 4,
    tabId: activeTabId,
    pageUrl: activeTabUrl
  });

  try {
    const result = await activeHlsDownloader.downloadAndExtractAudio(item.url, (progress) => {
      hlsProgressFill.style.width = `${progress.percent}%`;
      hlsPercentText.textContent = `${progress.percent}%`;
      hlsStatusText.textContent = progress.text;
    });

    const blobUrl = URL.createObjectURL(result.blob);
    let downloadFilename = item.filename.replace(/\.[a-zA-Z0-9]+$/, '') + '.mp3';

    chrome.downloads.download({
      url: blobUrl,
      filename: downloadFilename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        showToast(`Save error: ${chrome.runtime.lastError.message}`);
      } else {
        showToast('Audio extracted & saved as MP3! 🎵');
        chrome.runtime.sendMessage({
          action: 'RECORD_DOWNLOAD_HISTORY',
          item: {
            filename: downloadFilename,
            url: item.url,
            downloadId
          }
        });
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      hlsProgressModal.style.display = 'none';
    });
  } catch (err) {
    if (!err.message || !err.message.includes('cancelled')) {
      showToast(`Audio extraction error: ${err.message || 'Extraction failed'}`);
    }
    hlsProgressModal.style.display = 'none';
  }
}

/**
 * Update the batch bar selection summary and buttons
 */
function updateBatchSelectionUI() {
  if (!batchBar) return;
  const filtered = getFilteredMedia();
  if (filtered.length === 0) {
    batchBar.style.display = 'none';
    return;
  }

  batchBar.style.display = 'flex';
  const filteredSelected = filtered.filter(m => selectedMediaIds.has(m.id));
  const countSelected = filteredSelected.length;

  if (selectAllCheckbox) {
    if (countSelected === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (countSelected === filtered.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  }

  if (countSelected > 0) {
    batchInfo.textContent = `${countSelected} of ${filtered.length} selected`;
    if (btnDownloadText) btnDownloadText.textContent = `Download (${countSelected})`;
    if (btnCopyText) btnCopyText.textContent = `Copy (${countSelected})`;
    if (btnDeleteSelected) {
      btnDeleteSelected.style.display = 'inline-flex';
      if (btnDeleteText) btnDeleteText.textContent = `Delete (${countSelected})`;
    }
  } else {
    batchInfo.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'} ready`;
    if (btnDownloadText) btnDownloadText.textContent = 'Download All';
    if (btnCopyText) btnCopyText.textContent = 'Copy Links';
    if (btnDeleteSelected) btnDeleteSelected.style.display = 'none';
  }
}

/**
 * Delete all currently selected media items
 */
function deleteSelectedMedia() {
  const filtered = getFilteredMedia();
  const toDelete = filtered.filter(m => selectedMediaIds.has(m.id));
  if (!toDelete.length) return;

  const count = toDelete.length;
  toDelete.forEach((item) => {
    selectedMediaIds.delete(item.id);
    currentTabMedia = currentTabMedia.filter(m => m.id !== item.id);
    if (activeTabId) {
      chrome.runtime.sendMessage({
        action: 'DELETE_MEDIA_ITEM',
        id: item.id,
        tabId: activeTabId
      });
    }
  });

  renderUI();
  showToast(`Deleted ${count} selected item${count === 1 ? '' : 's'}.`);
}

/**
 * Batch Download Items (selected or all filtered)
 */
function downloadAllFiltered() {
  const filtered = getFilteredMedia();
  const targets = (selectedMediaIds.size > 0)
    ? filtered.filter(m => selectedMediaIds.has(m.id))
    : filtered;

  if (!targets.length) {
    showToast('No items to download.');
    return;
  }

  showToast(`Queueing ${targets.length} download${targets.length === 1 ? '' : 's'} in background...`);
  targets.forEach((item, index) => {
    setTimeout(() => {
      const format = (item.targetContainer === 'm4a' || item.targetContainer === 'mp3') ? 'm4a' : 'mp4';
      startDownloadJob(item, format, false);
    }, index * 800);
  });
}

/**
 * Batch Copy Links (selected or all filtered)
 */
function copyAllFiltered() {
  const filtered = getFilteredMedia();
  const targets = (selectedMediaIds.size > 0)
    ? filtered.filter(m => selectedMediaIds.has(m.id))
    : filtered;

  if (!targets.length) {
    showToast('No links to copy.');
    return;
  }

  const links = targets.map((m) => m.url).join('\n');
  navigator.clipboard.writeText(links).then(() => {
    showToast(`Copied ${targets.length} direct stream link${targets.length === 1 ? '' : 's'}! 📋`);
  });
}

/**
 * Open Download History Modal
 */
function openHistoryModal() {
  const container = document.getElementById('historyListContainer');
  container.innerHTML = '<div class="history-empty">Loading history...</div>';
  historyModal.style.display = 'flex';

  chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_HISTORY' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.history || res.history.length === 0) {
      container.innerHTML = '<div class="history-empty">No downloads recorded yet.</div>';
      return;
    }

    container.innerHTML = '';
    res.history.forEach((h) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'history-item';
      const timeStr = new Date(h.downloadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      itemEl.innerHTML = `
        <div class="history-item-details">
          <div class="history-item-title" title="${escapeHtml(h.filename)}">${escapeHtml(h.filename)}</div>
          <div class="history-item-time">${timeStr}</div>
        </div>
        <button class="secondary-btn btn-history-copy" title="Copy URL">📋</button>
      `;
      itemEl.querySelector('.btn-history-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(h.url);
        showToast('Copied download URL! 📋');
      });
      container.appendChild(itemEl);
    });
  });
}

/**
 * Open Subtitles / Captions Modal
 */
function openSubtitlesModal() {
  const container = document.getElementById('subtitlesContainer');
  subtitlesModal.style.display = 'flex';
  container.innerHTML = '<p class="guide-lead">Scanning active tab for WebVTT and SubRip tracks...</p>';

  if (activeTabId) {
    chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      func: () => {
        const subs = [];
        document.querySelectorAll('track[src]').forEach(t => {
          subs.push({ src: t.src, label: t.label || t.srclang || 'Subtitle Track' });
        });
        document.querySelectorAll('a[href*=".vtt"], a[href*=".srt"]').forEach(a => {
          subs.push({ src: a.href, label: a.innerText || 'Caption File' });
        });
        return subs;
      }
    }, (results) => {
      if (chrome.runtime.lastError || !results || !results[0] || !results[0].result || results[0].result.length === 0) {
        container.innerHTML = '<div class="history-empty">No separate subtitle tracks detected on this page. Most online players burn subtitles directly into the video stream.</div>';
        return;
      }

      const tracks = results[0].result;
      container.innerHTML = '';
      tracks.forEach((tr) => {
        const el = document.createElement('div');
        el.className = 'history-item';
        el.innerHTML = `
          <div class="history-item-details">
            <div class="history-item-title">${escapeHtml(tr.label)}</div>
            <div class="history-item-time">${escapeHtml(tr.src.slice(0, 45))}...</div>
          </div>
          <button class="primary-btn btn-dl-sub">Download</button>
        `;
        el.querySelector('.btn-dl-sub').addEventListener('click', () => {
          chrome.downloads.download({ url: tr.src, filename: `${tr.label || 'subtitles'}.vtt` });
          showToast('Downloading subtitles track...');
        });
        container.appendChild(el);
      });
    });
  }
}

/**
 * Initialize theme from local storage or system preference
 */
async function initTheme() {
  try {
    const stored = await chrome.storage.local.get({ theme: 'auto' });
    currentTheme = stored.theme || 'auto';
    applyTheme(currentTheme);

    // Watch for OS theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentTheme === 'auto') {
        applyTheme('auto');
      }
    });
  } catch (e) {
    applyTheme('auto');
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  let effectiveTheme = theme;
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    effectiveTheme = prefersDark ? 'dark' : 'light';
  }

  document.documentElement.dataset.theme = effectiveTheme;

  if (btnThemeToggle && themeIconDark && themeIconLight && themeIconAuto) {
    themeIconDark.style.display = 'none';
    themeIconLight.style.display = 'none';
    themeIconAuto.style.display = 'none';

    if (theme === 'auto') {
      themeIconAuto.style.display = 'block';
      btnThemeToggle.title = 'Theme: System Auto (Click to switch to Dark)';
    } else if (theme === 'dark') {
      themeIconDark.style.display = 'block';
      btnThemeToggle.title = 'Theme: Dark (Click to switch to Light)';
    } else {
      themeIconLight.style.display = 'block';
      btnThemeToggle.title = 'Theme: Light (Click to switch to Auto)';
    }
  }
}

function toggleTheme() {
  let nextTheme = 'auto';
  if (currentTheme === 'auto') nextTheme = 'dark';
  else if (currentTheme === 'dark') nextTheme = 'light';
  else nextTheme = 'auto';

  applyTheme(nextTheme);
  chrome.storage.local.set({ theme: nextTheme });
  showToast(`Theme set to ${nextTheme.toUpperCase()}`);
}

/**
 * Format seconds to MM:SS string
 */
function formatPlayerTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Update player volume UI state
 */
function updatePlayerVolumeUI() {
  if (!playerVolume || !iconVolHigh || !iconVolMuted) return;
  playerVolume.value = isPlayerMuted ? 0 : playerVolumeLevel;
  if (isPlayerMuted || playerVolumeLevel === 0) {
    iconVolHigh.style.display = 'none';
    iconVolMuted.style.display = 'block';
  } else {
    iconVolHigh.style.display = 'block';
    iconVolMuted.style.display = 'none';
  }
}

function setPlayerVolume(val) {
  playerVolumeLevel = Math.max(0, Math.min(1, val));
  isPlayerMuted = (playerVolumeLevel === 0);
  if (currentPlayingMediaEl) {
    currentPlayingMediaEl.volume = playerVolumeLevel;
    currentPlayingMediaEl.muted = isPlayerMuted;
  }
  updatePlayerVolumeUI();
}

function togglePlayerMute() {
  isPlayerMuted = !isPlayerMuted;
  if (currentPlayingMediaEl) {
    currentPlayingMediaEl.muted = isPlayerMuted;
  }
  updatePlayerVolumeUI();
}

function cyclePlayerSpeed() {
  currentSpeedIdx = (currentSpeedIdx + 1) % playerSpeedOptions.length;
  const speed = playerSpeedOptions[currentSpeedIdx];
  if (btnPlayerSpeed) btnPlayerSpeed.textContent = `${speed.toFixed(speed % 1 === 0 ? 1 : 2)}x`;
  if (currentPlayingMediaEl) {
    currentPlayingMediaEl.playbackRate = speed;
  }
}

function togglePlayerPlayPause() {
  if (!currentPlayingMediaEl) return;
  if (currentPlayingMediaEl.paused) {
    currentPlayingMediaEl.play().catch(() => {});
  } else {
    currentPlayingMediaEl.pause();
  }
}

function setPlayerPlayState(isPlaying) {
  if (!iconPlay || !iconPause) return;
  if (isPlaying) {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
  } else {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
  }

  const waves = document.querySelectorAll('.wave-bar');
  waves.forEach(w => {
    if (isPlaying) w.classList.add('playing');
    else w.classList.remove('playing');
  });
}

/**
 * Open Custom Mini Media Player Modal
 */
function openPreviewModal(item) {
  currentPreviewMedia = item;
  previewTitle.textContent = item.filename;
  if (modalDownloadBtnText) {
    const isAudio = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';
    modalDownloadBtnText.textContent = isAudio ? 'Download Audio (.M4A / .MP3)' : 'Download Video (.MP4)';
  }

  if (playerViewport) playerViewport.innerHTML = '';

  const isAudio = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';
  const mediaEl = document.createElement(isAudio ? 'audio' : 'video');
  currentPlayingMediaEl = mediaEl;

  mediaEl.src = item.url;
  mediaEl.preload = 'metadata';
  mediaEl.volume = isPlayerMuted ? 0 : playerVolumeLevel;
  mediaEl.muted = isPlayerMuted;
  mediaEl.playbackRate = playerSpeedOptions[currentSpeedIdx] || 1.0;

  if (isAudio) {
    const audioStage = document.createElement('div');
    audioStage.className = 'player-audio-stage';
    audioStage.innerHTML = `
      <div class="player-audio-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      </div>
      <div class="player-audio-wave">
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
      </div>
    `;
    if (playerViewport) {
      playerViewport.appendChild(audioStage);
      playerViewport.appendChild(mediaEl);
    }
  } else {
    mediaEl.playsInline = true;
    if (playerViewport) {
      playerViewport.appendChild(mediaEl);
    }
  }

  // Reset controls UI
  if (playerCurrentTime) playerCurrentTime.textContent = '0:00';
  if (playerDuration) playerDuration.textContent = item.durationFormatted || '0:00';
  if (playerTimeline) {
    playerTimeline.value = '0';
    playerTimeline.max = '100';
  }
  if (playerBuffered) playerBuffered.style.width = '0%';
  setPlayerPlayState(false);
  updatePlayerVolumeUI();
  if (btnPlayerSpeed) btnPlayerSpeed.textContent = `${playerSpeedOptions[currentSpeedIdx].toFixed(1)}x`;

  // Media Event Listeners
  mediaEl.addEventListener('loadedmetadata', () => {
    if (mediaEl.duration && !isNaN(mediaEl.duration)) {
      if (playerDuration) playerDuration.textContent = formatPlayerTime(mediaEl.duration);
      if (playerTimeline) playerTimeline.max = mediaEl.duration.toString();
    }
  });

  mediaEl.addEventListener('timeupdate', () => {
    if (!isTimelineScrubbing) {
      if (playerCurrentTime) playerCurrentTime.textContent = formatPlayerTime(mediaEl.currentTime);
      if (playerTimeline) playerTimeline.value = mediaEl.currentTime.toString();
    }
  });

  mediaEl.addEventListener('progress', () => {
    if (playerBuffered && mediaEl.duration > 0 && mediaEl.buffered.length > 0) {
      try {
        const bufferedEnd = mediaEl.buffered.end(mediaEl.buffered.length - 1);
        const pct = (bufferedEnd / mediaEl.duration) * 100;
        playerBuffered.style.width = `${Math.min(100, pct)}%`;
      } catch (e) {}
    }
  });

  mediaEl.addEventListener('play', () => setPlayerPlayState(true));
  mediaEl.addEventListener('pause', () => setPlayerPlayState(false));
  mediaEl.addEventListener('ended', () => {
    setPlayerPlayState(false);
    if (playerTimeline) playerTimeline.value = '0';
    if (playerCurrentTime) playerCurrentTime.textContent = '0:00';
  });

  previewModal.style.display = 'flex';
  mediaEl.play().catch(() => {
    // Autoplay policy fallback: stays paused gracefully until user clicks Play
  });
}

/**
 * Close Preview Modal & clean up player resources
 */
function closePreviewModal() {
  if (currentPlayingMediaEl) {
    currentPlayingMediaEl.pause();
    currentPlayingMediaEl.src = '';
    currentPlayingMediaEl = null;
  }
  setPlayerPlayState(false);
  if (playerViewport) playerViewport.innerHTML = '';
  previewModal.style.display = 'none';
  currentPreviewMedia = null;
}

/**
 * Close any active open modal dialogs
 */
function closeAllModals() {
  if (previewModal && previewModal.style.display !== 'none') closePreviewModal();
  if (noVideoModal && noVideoModal.style.display !== 'none') noVideoModal.style.display = 'none';
  if (historyModal && historyModal.style.display !== 'none') historyModal.style.display = 'none';
  if (helpModal && helpModal.style.display !== 'none') helpModal.style.display = 'none';
  if (subtitlesModal && subtitlesModal.style.display !== 'none') subtitlesModal.style.display = 'none';
  if (hlsProgressModal && hlsProgressModal.style.display !== 'none') {
    const btnCancel = document.getElementById('btnCancelHls');
    if (btnCancel) btnCancel.click();
  }
}

/**
 * Toast Notification Utility
 */
function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2400);
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
