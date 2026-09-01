/**
 * Popup Controller - Media List, Filters, Preview Player, MP4 Transmuxer, and MP3 Extraction
 */

let activeTabId = null;
let activeTabUrl = '';
let activeTabOrigin = '';
let currentTabMedia = [];
let activeFilter = 'all';
let searchQuery = '';
let currentPreviewMedia = null;
let activeHlsDownloader = null;

// DOM Elements
const currentDomainEl = document.getElementById('currentDomain');
const mediaContainer = document.getElementById('mediaContainer');
const emptyState = document.getElementById('emptyState');
const batchBar = document.getElementById('batchBar');
const batchInfo = document.getElementById('batchInfo');
const searchInput = document.getElementById('searchInput');

// Counter Badges
const countAllEl = document.getElementById('countAll');
const countVideoEl = document.getElementById('countVideo');
const countAudioEl = document.getElementById('countAudio');
const countStreamEl = document.getElementById('countStream');

// Modals
const previewModal = document.getElementById('previewModal');
const previewPlayerContainer = document.getElementById('previewPlayerContainer');
const previewTitle = document.getElementById('previewTitle');
const hlsProgressModal = document.getElementById('hlsProgressModal');
const hlsModalTitle = document.getElementById('hlsModalTitle');
const hlsProgressFill = document.getElementById('hlsProgressFill');
const hlsStatusText = document.getElementById('hlsStatusText');
const hlsPercentText = document.getElementById('hlsPercentText');

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await initActiveTab();
  await loadTabMedia();
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

      // Ensure content script is injected on the tab
      if (activeTabId && activeTabUrl) {
        chrome.runtime.sendMessage({
          action: 'ENSURE_CONTENT_SCRIPT',
          tabId: activeTabId
        }, () => {
          if (chrome.runtime.lastError) {}
        });

        // Setup Referer header rules in background
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
  });
}

/**
 * Setup Click & Input Event Listeners
 */
function setupEventListeners() {
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      renderUI();
    });
  });

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
  document.getElementById('btnRefresh').addEventListener('click', async () => {
    showToast('Rescanning page for media...');
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'RESCAN_DOM' }, () => {
        if (chrome.runtime.lastError) {}
        setTimeout(loadTabMedia, 600);
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

  document.getElementById('btnOptions').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options/options.html'));
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
  document.getElementById('btnDownloadAll').addEventListener('click', downloadAllFiltered);
  document.getElementById('btnCopyAll').addEventListener('click', copyAllFiltered);

  // Preview Modal
  document.getElementById('btnClosePreview').addEventListener('click', closePreviewModal);
  document.getElementById('previewModal').addEventListener('click', (e) => {
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
  filtered.forEach((item) => {
    const card = createMediaCard(item);
    mediaContainer.appendChild(card);
  });
}

/**
 * Update filter count badges
 */
function updateCounts() {
  const hasFullStream = currentTabMedia.some(m => m.ext === 'm3u8');
  const validList = currentTabMedia.filter(m => !(hasFullStream && m.isSubChunk));

  const allCount = validList.length;
  const videoCount = validList.filter((m) => m.type === 'video' || m.ext === 'm3u8' || m.ext === 'mp4').length;
  const audioCount = validList.filter((m) => m.type === 'audio' || m.ext === 'mp3' || m.ext === 'm4a').length;
  const streamCount = validList.filter((m) => m.type === 'stream' || m.ext === 'm3u8').length;

  countAllEl.textContent = allCount;
  countVideoEl.textContent = videoCount;
  countAudioEl.textContent = audioCount;
  countStreamEl.textContent = streamCount;
}

/**
 * Creates a Rich Video / Audio Thumbnail Element
 */
function createThumbnailElement(item) {
  const isAudio = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';
  const isHls = item.ext === 'm3u8' || item.type === 'stream';

  const thumbBox = document.createElement('div');
  thumbBox.className = `media-thumbnail ${isAudio ? 'thumb-audio' : 'thumb-video'}`;
  thumbBox.title = 'Click to preview in player';

  const durationBadge = item.durationFormatted 
    ? `<span class="thumb-badge duration-badge">${item.durationFormatted}</span>` 
    : (item.quality 
        ? `<span class="thumb-badge quality-badge">${item.quality}</span>` 
        : `<span class="thumb-badge format-badge">${isHls ? 'HLS' : (item.ext || 'MP4').toUpperCase()}</span>`);

  if (item.poster) {
    thumbBox.innerHTML = `
      <img src="${escapeHtml(item.poster)}" alt="thumbnail" class="thumb-img" />
      <div class="thumb-overlay"></div>
      <div class="thumb-play-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
      </div>
      <div class="thumb-top-tag ${isAudio ? 'audio-tag' : ''}">${isHls ? 'HLS' : (item.ext || 'MP4').toUpperCase()}</div>
      ${durationBadge}
    `;
    const img = thumbBox.querySelector('.thumb-img');
    if (img) {
      img.onerror = () => {
        thumbBox.innerHTML = getFallbackThumbnailHTML(item, isAudio, isHls, durationBadge);
      };
    }
  } else {
    thumbBox.innerHTML = getFallbackThumbnailHTML(item, isAudio, isHls, durationBadge);
  }

  thumbBox.addEventListener('click', (e) => {
    e.stopPropagation();
    openPreviewModal(item);
  });

  return thumbBox;
}

function getFallbackThumbnailHTML(item, isAudio, isHls, durationBadge) {
  if (isAudio) {
    return `
      <div class="thumb-graphic audio-graphic">
        <div class="sound-wave-art">
          <span class="sw-bar b1"></span>
          <span class="sw-bar b2"></span>
          <span class="sw-bar b3"></span>
          <span class="sw-bar b4"></span>
          <span class="sw-bar b5"></span>
        </div>
      </div>
      <div class="thumb-overlay"></div>
      <div class="thumb-play-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
      </div>
      <div class="thumb-top-tag audio-tag">MP3</div>
      ${durationBadge}
    `;
  }

  return `
    <div class="thumb-graphic video-graphic">
      <div class="grid-mesh"></div>
      <svg class="film-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
        <line x1="7" y1="2" x2="7" y2="22"></line>
        <line x1="17" y1="2" x2="17" y2="22"></line>
        <line x1="2" y1="12" x2="22" y2="12"></line>
        <line x1="2" y1="7" x2="7" y2="7"></line>
        <line x1="2" y1="17" x2="7" y2="17"></line>
        <line x1="17" y1="17" x2="22" y2="17"></line>
        <line x1="17" y1="7" x2="22" y2="7"></line>
      </svg>
    </div>
    <div class="thumb-overlay"></div>
    <div class="thumb-play-btn">
      <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
    </div>
    <div class="thumb-top-tag">${isHls ? 'HLS' : (item.ext || 'MP4').toUpperCase()}</div>
    ${durationBadge}
  `;
}

/**
 * Create a single media card DOM element with rich thumbnail and actions
 */
function createMediaCard(item) {
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

  const thumbElem = createThumbnailElement(item);

  card.innerHTML = `
    <div class="card-body">
      <div class="thumb-slot"></div>
      <div class="card-details">
        <div class="card-title-row">
          <input type="text" class="card-title-input" value="${escapeHtml(displayFilename)}" title="Click to rename before download" />
          <button class="title-edit-hint" title="Rename file">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
        </div>
        <div class="card-meta-row">
          ${item.quality ? `<span class="meta-pill quality-pill"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>${item.quality}</span>` : ''}
          <span class="meta-pill stream-pill">${isHls ? '⚡ HLS → MP4' : (item.label || item.type.toUpperCase())}</span>
          <span class="meta-pill size-pill">${item.sizeFormatted || 'Full Video'}</span>
        </div>
      </div>
    </div>
    <div class="card-actions">
      <button class="secondary-btn btn-preview" title="Preview Media">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        Preview
      </button>
      ${
        isHls
          ? `<button class="primary-btn btn-hls-mp4" title="Download & Convert to MP4 Video">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Download MP4
            </button>
            <button class="audio-action-btn btn-hls-mp3" title="Extract Audio as MP3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
              MP3 Audio
            </button>`
          : `<button class="primary-btn btn-download" title="Download File">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Download
            </button>
            ${
              !isAudio
                ? `<button class="audio-action-btn btn-mp3-dl" title="Save as MP3 Audio">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    MP3 Audio
                  </button>`
                : ''
            }`
      }
      <button class="secondary-btn btn-copy" title="Copy Direct Stream URL">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      </button>
    </div>
  `;

  const thumbSlot = card.querySelector('.thumb-slot');
  if (thumbSlot) {
    thumbSlot.replaceWith(thumbElem);
  }

  const titleInput = card.querySelector('.card-title-input');
  titleInput.addEventListener('change', (e) => {
    item.filename = e.target.value.trim();
  });

  const editHint = card.querySelector('.title-edit-hint');
  if (editHint) {
    editHint.addEventListener('click', () => {
      titleInput.focus();
      titleInput.select();
    });
  }

  card.querySelector('.btn-preview').addEventListener('click', () => {
    openPreviewModal(item);
  });

  card.querySelector('.btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(item.url).then(() => {
      showToast('Link copied to clipboard! 📋');
    });
  });

  const hlsMp4Btn = card.querySelector('.btn-hls-mp4');
  if (hlsMp4Btn) {
    hlsMp4Btn.addEventListener('click', () => startHlsMp4Conversion(item));
  }

  const hlsMp3Btn = card.querySelector('.btn-hls-mp3');
  if (hlsMp3Btn) {
    hlsMp3Btn.addEventListener('click', () => startHlsMp3Extraction(item));
  }

  const dlBtn = card.querySelector('.btn-download');
  if (dlBtn) {
    dlBtn.addEventListener('click', () => triggerDownload(item));
  }

  const mp3Btn = card.querySelector('.btn-mp3-dl');
  if (mp3Btn) {
    mp3Btn.addEventListener('click', () => {
      const audioItem = {
        ...item,
        filename: item.filename.replace(/\.[a-zA-Z0-9]+$/, '') + '.mp3'
      };
      triggerDownload(audioItem);
      showToast('Saving audio as MP3...');
    });
  }

  return card;
}

/**
 * Direct file download via background service worker
 */
function triggerDownload(item) {
  showToast(`Starting download: ${item.filename}`);
  chrome.runtime.sendMessage({
    action: 'DOWNLOAD_MEDIA',
    url: item.url,
    filename: item.filename
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
async function startHlsMp4Conversion(item) {
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
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        showToast(`Save error: ${chrome.runtime.lastError.message}`);
      } else {
        showToast(`Stream converted & saved as ${result.format.toUpperCase()}! 🎉`);
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
 * Batch Download Filtered Items
 */
function downloadAllFiltered() {
  const filtered = getFilteredMedia();
  if (!filtered.length) return;

  showToast(`Starting batch download (${filtered.length} files)...`);
  filtered.forEach((item, index) => {
    setTimeout(() => {
      if (item.ext === 'm3u8') {
        startHlsMp4Conversion(item);
      } else {
        triggerDownload(item);
      }
    }, index * 1000);
  });
}

/**
 * Batch Copy All Links
 */
function copyAllFiltered() {
  const filtered = getFilteredMedia();
  if (!filtered.length) return;

  const links = filtered.map((m) => m.url).join('\n');
  navigator.clipboard.writeText(links).then(() => {
    showToast(`Copied ${filtered.length} stream links! 📋`);
  });
}

/**
 * Open Embedded Preview Player Modal
 */
function openPreviewModal(item) {
  currentPreviewMedia = item;
  previewTitle.textContent = item.filename;
  previewPlayerContainer.innerHTML = '';

  const isAudio = item.type === 'audio' || item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav';

  if (isAudio) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.autoplay = true;
    audio.src = item.url;
    previewPlayerContainer.appendChild(audio);
  } else {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.src = item.url;
    previewPlayerContainer.appendChild(video);
  }

  previewModal.style.display = 'flex';
}

/**
 * Close Preview Modal
 */
function closePreviewModal() {
  previewModal.style.display = 'none';
  previewPlayerContainer.innerHTML = '';
  currentPreviewMedia = null;
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
