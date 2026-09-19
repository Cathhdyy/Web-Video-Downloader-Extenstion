/**
 * Background Service Worker - Media Sniffer & Extension Core
 * Captures stream headers (Referer, Origin, User-Agent) from web traffic in real-time,
 * maintains DeclarativeNetRequest dynamic rules, and provides CORS-exempt background fetching.
 */

importScripts('../lib/media_detector.js');

// In-memory tab media registry: tabId -> Map(mediaId, mediaObject)
const tabMediaStore = new Map();

// Map of stream hostname -> { referer, origin } captured from real player traffic
const streamHeadersMap = new Map();

// Active background download jobs: jobId -> jobObject
const activeJobs = new Map();
let keepAliveTimer = null;

function ensureKeepAlive() {
  if (activeJobs.size > 0 && !keepAliveTimer) {
    keepAliveTimer = setInterval(async () => {
      if (activeJobs.size === 0) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
        return;
      }
      try {
        await chrome.runtime.getPlatformInfo();
      } catch (e) {}
    }, 20000);
  } else if (activeJobs.size === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

let creatingOffscreenPromise = null;
let offscreenIdleTimer = null;
const OFFSCREEN_IDLE_TIMEOUT_MS = 60000; // 60s idle timeout to reclaim RAM

function resetOffscreenIdleTimer() {
  if (offscreenIdleTimer) {
    clearTimeout(offscreenIdleTimer);
    offscreenIdleTimer = null;
  }
  if (activeJobs.size === 0) {
    offscreenIdleTimer = setTimeout(async () => {
      if (activeJobs.size === 0 && (await hasOffscreenDocument())) {
        try {
          await chrome.offscreen.closeDocument();
          console.log('[Offscreen] Closed idle offscreen document to save RAM.');
        } catch (e) {}
      }
    }, OFFSCREEN_IDLE_TIMEOUT_MS);
  }
}

async function setupOffscreenDocument(path = 'offscreen/offscreen.html') {
  if (offscreenIdleTimer) {
    clearTimeout(offscreenIdleTimer);
    offscreenIdleTimer = null;
  }

  if (await hasOffscreenDocument(path)) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: path,
    reasons: ['BLOBS', 'WORKERS'],
    justification: 'Fetch and transmux HLS media streams to MP4/M4A in background'
  });

  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function hasOffscreenDocument(path = 'offscreen/offscreen.html') {
  if (!chrome.offscreen) return false;
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(path)]
    });
    return Boolean(contexts && contexts.length);
  }
  return false;
}

// Default settings
const DEFAULT_SETTINGS = {
  minSizeThreshold: 50 * 1024, // 50 KB minimum
  autoBadgeCount: true,
  defaultSaveAs: false,
  captureHLS: true,
  filterSubChunks: true,
  mediaNamingRule: 'title_quality'
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing || !existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  console.log('[Media Sniffer] Initialized with real-time Referer capture.');
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const allData = await chrome.storage.local.get(null);
    const tabMediaKeys = Object.keys(allData).filter(k => k.startsWith('tab_media_'));
    if (tabMediaKeys.length > 0) {
      const activeTabs = await chrome.tabs.query({});
      const activeTabIds = new Set(activeTabs.map(t => t.id));
      const staleKeys = tabMediaKeys.filter(k => {
        const id = parseInt(k.replace('tab_media_', ''), 10);
        return !activeTabIds.has(id);
      });
      if (staleKeys.length > 0) {
        await chrome.storage.local.remove(staleKeys);
      }
    }
  } catch (err) {}
});

/**
 * Update the extension icon badge for a tab
 */
async function updateTabBadge(tabId) {
  const mediaMap = tabMediaStore.get(tabId);
  let count = 0;
  if (mediaMap) {
    for (const item of mediaMap.values()) {
      if (!item.isSubChunk) count++;
    }
  }

  const badgeText = count > 0 ? (count > 99 ? '99+' : String(count)) : '';

  try {
    await chrome.action.setBadgeText({ tabId, text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7C4DFF' });
    await chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' });
  } catch (err) {}
}

/**
 * Real-time Request Header Sniffer:
 * Automatically records the exact Referer and Origin sent by video players/iframes
 */
if (chrome.webRequest && chrome.webRequest.onBeforeSendHeaders) {
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        if (details.requestHeaders && details.url) {
          let referer = '';
          let origin = '';
          for (const h of details.requestHeaders) {
            const name = h.name.toLowerCase();
            if (name === 'referer') referer = h.value;
            if (name === 'origin') origin = h.value;
          }

          if (referer || origin) {
            try {
              const urlObj = new URL(details.url);
              streamHeadersMap.set(urlObj.hostname, {
                referer: referer || details.url,
                origin: origin || (referer ? new URL(referer).origin : urlObj.origin)
              });
            } catch (e) {}
          }
        }
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders', 'extraHeaders']
    );
  } catch (e) {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        if (details.requestHeaders && details.url) {
          let referer = '';
          for (const h of details.requestHeaders) {
            if (h.name.toLowerCase() === 'referer') referer = h.value;
          }
          if (referer) {
            try {
              const urlObj = new URL(details.url);
              streamHeadersMap.set(urlObj.hostname, { referer, origin: new URL(referer).origin });
            } catch (err) {}
          }
        }
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders']
    );
  }
}

/**
 * Configure DeclarativeNetRequest rules with valid syntax for anti-hotlinking
 */
const hostRuleMap = new Map();
let nextRuleId = 9901;
const MAX_RULE_ID = 9980;

async function setStreamRefererRule(streamUrl, defaultPageUrl, defaultOrigin) {
  if (!chrome.declarativeNetRequest || !streamUrl) return;
  try {
    const urlObj = new URL(streamUrl);
    const host = urlObj.hostname;
    if (!host) return;

    const captured = streamHeadersMap.get(host);
    let refererVal = captured?.referer || defaultPageUrl || '';
    if (!refererVal || !refererVal.startsWith('http')) {
      return;
    }

    let originVal = captured?.origin || defaultOrigin || '';
    if (!originVal && refererVal) {
      try {
        originVal = new URL(refererVal).origin;
      } catch (e) {}
    }

    let ruleId = hostRuleMap.get(host);
    if (!ruleId) {
      ruleId = nextRuleId++;
      if (nextRuleId > MAX_RULE_ID) nextRuleId = 9901;
      hostRuleMap.set(host, ruleId);
    }

    const requestHeaders = [
      { header: 'Referer', operation: 'set', value: refererVal }
    ];
    if (originVal) {
      requestHeaders.push({ header: 'Origin', operation: 'set', value: originVal });
    }

    const rules = [{
      id: ruleId,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders
      },
      condition: {
        urlFilter: `||${host}`,
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    }];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: rules
    });
  } catch (err) {
    console.warn('DeclarativeNetRequest rule update error:', err);
  }
}

/**
 * Register detected media item for a given tab
 */
const tabMaxDurations = new Map();
const tabPosters = new Map();

async function registerMedia(tabId, mediaItem) {
  if (!tabId || tabId < 0 || !mediaItem || !mediaItem.url) return;

  // Enrich with captured referer and origin
  try {
    const urlObj = new URL(mediaItem.url);
    const captured = streamHeadersMap.get(urlObj.hostname);
    if (captured) {
      if (!mediaItem.referer) mediaItem.referer = captured.referer;
      if (!mediaItem.origin) mediaItem.origin = captured.origin;
    }
  } catch (e) {}

  // If pageUrl is missing, try to get from active tab
  if (!mediaItem.pageUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url && tab.url.startsWith('http')) {
        mediaItem.pageUrl = tab.url;
        if (!mediaItem.referer) mediaItem.referer = tab.url;
        if (!mediaItem.origin) mediaItem.origin = new URL(tab.url).origin;
      }
    } catch (e) {}
  }

  const storageData = await chrome.storage.local.get('settings');
  const settings = storageData.settings || DEFAULT_SETTINGS;

  if (mediaItem.size > 0 && mediaItem.size < settings.minSizeThreshold) {
    return;
  }

  // Inherit page video duration & poster if not present on stream
  if (!mediaItem.duration && tabMaxDurations.has(tabId)) {
    mediaItem.duration = tabMaxDurations.get(tabId);
    mediaItem.durationFormatted = MediaDetector.formatDuration(mediaItem.duration);
  }
  if (!mediaItem.poster && tabPosters.has(tabId)) {
    mediaItem.poster = tabPosters.get(tabId);
  }

  if (!tabMediaStore.has(tabId)) {
    tabMediaStore.set(tabId, new Map());
  }

  const mediaMap = tabMediaStore.get(tabId);

  if (settings.filterSubChunks && mediaItem.isSubChunk) {
    const hasStream = Array.from(mediaMap.values()).some(m => m.ext === 'm3u8' || m.type === 'stream');
    if (hasStream) return;
  }
  
  if (mediaMap.has(mediaItem.id)) {
    const existing = mediaMap.get(mediaItem.id);
    if (!existing.size && mediaItem.size) {
      existing.size = mediaItem.size;
      existing.sizeFormatted = mediaItem.sizeFormatted;
    }
    if (!existing.quality && mediaItem.quality) {
      existing.quality = mediaItem.quality;
    }
    if (!existing.poster && mediaItem.poster) {
      existing.poster = mediaItem.poster;
    }
    if (!existing.duration && mediaItem.duration) {
      existing.duration = mediaItem.duration;
      existing.durationFormatted = mediaItem.durationFormatted;
    }
    if (!existing.referer && mediaItem.referer) {
      existing.referer = mediaItem.referer;
    }
    if (!existing.origin && mediaItem.origin) {
      existing.origin = mediaItem.origin;
    }
    if (!existing.pageUrl && mediaItem.pageUrl) {
      existing.pageUrl = mediaItem.pageUrl;
    }
  } else {
    mediaMap.set(mediaItem.id, mediaItem);
  }

  if (mediaItem.ext === 'm3u8' && settings.filterSubChunks) {
    for (const [id, item] of mediaMap.entries()) {
      if (item.isSubChunk) {
        mediaMap.delete(id);
      }
    }
  }

  const serialized = Array.from(mediaMap.values());
  await chrome.storage.local.set({ [`tab_media_${tabId}`]: serialized });

  if (settings.autoBadgeCount) {
    updateTabBadge(tabId);
  }
}

/**
 * Network Response Sniffer
 */
if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const headers = {};
      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          headers[h.name.toLowerCase()] = h.value;
        }
      }

      const inspected = MediaDetector.inspectMedia(details.url, headers);
      if (inspected) {
        chrome.tabs.get(details.tabId, (tab) => {
          if (!chrome.runtime.lastError && tab && tab.title) {
            if (!inspected.filename || MediaDetector.isGenericFilename(inspected.filename)) {
              const ext = inspected.ext === 'm3u8' ? 'mp4' : (inspected.ext || 'mp4');
              const q = inspected.quality ? `_${inspected.quality.replace(/\s+/g, '')}` : '';
              inspected.filename = `${MediaDetector.cleanPageTitle(tab.title)}${q}.${ext}`;
            }
          }
          registerMedia(details.tabId, inspected);
        });
      }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabMediaStore.delete(tabId);
    chrome.storage.local.remove(`tab_media_${tabId}`);
    updateTabBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaStore.delete(tabId);
  chrome.storage.local.remove(`tab_media_${tabId}`);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateTabBadge(activeInfo.tabId);
});

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Message handler for content scripts and popup UI
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = request.tabId || (sender.tab && sender.tab.id);

  switch (request.action) {
    case 'DOM_MEDIA_DETECTED': {
      if (tabId && request.mediaList && Array.isArray(request.mediaList)) {
        for (const raw of request.mediaList) {
          const inspected = MediaDetector.inspectMedia(raw.url, {}, raw.pageTitle || '', {
            duration: raw.duration,
            poster: raw.poster
          });
          if (inspected) {
            if (raw.type && raw.type !== 'unknown') inspected.type = raw.type;
            if (raw.duration) {
              inspected.duration = raw.duration;
              inspected.durationFormatted = MediaDetector.formatDuration(raw.duration);
            }
            if (raw.poster) inspected.poster = raw.poster;
            registerMedia(tabId, inspected);
          }
        }
        sendResponse({ success: true });
      }
      break;
    }

    case 'PAGE_VIDEO_DURATION_UPDATED': {
      if (tabId && request.duration > 0) {
        tabMaxDurations.set(tabId, request.duration);
        if (request.poster) tabPosters.set(tabId, request.poster);

        if (tabMediaStore.has(tabId)) {
          const mediaMap = tabMediaStore.get(tabId);
          let changed = false;
          for (const item of mediaMap.values()) {
            if (!item.duration) {
              item.duration = request.duration;
              item.durationFormatted = MediaDetector.formatDuration(request.duration);
              changed = true;
            }
            if (request.poster && !item.poster) {
              item.poster = request.poster;
              changed = true;
            }
          }
          if (changed) {
            chrome.storage.local.set({ [`tab_media_${tabId}`]: Array.from(mediaMap.values()) });
          }
        }
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false });
      }
      break;
    }

    case 'SETUP_STREAM_RULES': {
      if (request.streamUrl) {
        setStreamRefererRule(request.streamUrl, request.pageUrl, request.origin).then(() => {
          sendResponse({ success: true });
        }).catch(() => {
          sendResponse({ success: true });
        });
        return true;
      }
      sendResponse({ success: true });
      break;
    }

    case 'BACKGROUND_FETCH': {
      const { url, responseType, pageUrl, referer, origin, headers } = request;

      (async () => {
        try {
          if (!url) {
            sendResponse({ success: false, error: 'Empty URL provided' });
            return;
          }

          const effectiveReferer = referer || pageUrl || '';
          let effectiveOrigin = origin || '';
          if (!effectiveOrigin && effectiveReferer && effectiveReferer.startsWith('http')) {
            try {
              effectiveOrigin = new URL(effectiveReferer).origin;
            } catch (e) {}
          }

          // Pre-emptively apply referer/origin DNR rule before fetching if referer is known
          if (effectiveReferer && effectiveReferer.startsWith('http')) {
            await setStreamRefererRule(url, effectiveReferer, effectiveOrigin);
          }

          const fetchHeaders = {
            'Accept': '*/*',
            ...(headers || {})
          };

          // Direct fetch in service worker (exempt from CORS via <all_urls> host permissions)
          let res;
          try {
            res = await fetch(url, {
              headers: fetchHeaders
            });
          } catch (fetchErr) {
            // Retry once with referer setup if effectiveReferer is available
            if (effectiveReferer && effectiveReferer.startsWith('http')) {
              await setStreamRefererRule(url, effectiveReferer, effectiveOrigin);
              res = await fetch(url, { headers: fetchHeaders });
            } else {
              throw fetchErr;
            }
          }

          if (!res.ok) {
            // If 403 Forbidden, retry with referer rule
            if (res.status === 403 && effectiveReferer && effectiveReferer.startsWith('http')) {
              await setStreamRefererRule(url, effectiveReferer, effectiveOrigin);
              res = await fetch(url, { headers: fetchHeaders });
            }
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText || 'Fetch failed'}`);
            }
          }

          if (responseType === 'arraybuffer') {
            const buffer = await res.arrayBuffer();
            const base64 = bufferToBase64(buffer);
            sendResponse({ success: true, base64, size: buffer.byteLength });
          } else {
            const text = await res.text();
            sendResponse({ success: true, text });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message || 'Background network error' });
        }
      })();

      return true; // Keep message channel open for async response
    }

    case 'PROXY_TAB_FETCH': {
      const { url, responseType, tabId: requestedTabId, pageUrl, headers } = request;

      (async () => {
        try {
          let targetTabId = requestedTabId;

          // If no tabId provided or tab is closed, try to find an active tab matching the pageUrl or domain
          if (!targetTabId) {
            try {
              if (pageUrl) {
                const targetOrigin = new URL(pageUrl).origin;
                const tabs = await chrome.tabs.query({});
                const matched = tabs.find(t => t.url && t.url.startsWith(targetOrigin));
                if (matched) targetTabId = matched.id;
              }
              if (!targetTabId) {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab) targetTabId = activeTab.id;
              }
            } catch (e) {}
          }

          if (!targetTabId) {
            sendResponse({ success: false, error: 'No suitable browser tab found to proxy request' });
            return;
          }

          chrome.tabs.sendMessage(
            targetTabId,
            {
              action: 'FETCH_RESOURCE',
              url,
              responseType: responseType || 'text',
              headers: headers || {}
            },
            (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
                return;
              }
              sendResponse(response || { success: false, error: 'Empty tab proxy response' });
            }
          );
        } catch (err) {
          sendResponse({ success: false, error: err.message || 'Tab proxy error' });
        }
      })();

      return true;
    }

    case 'ENSURE_CONTENT_SCRIPT': {
      if (tabId) {
        chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/content_script.js']
        }, () => {
          if (chrome.runtime.lastError) {}
          sendResponse({ success: true });
        });
        return true;
      }
      sendResponse({ success: false });
      break;
    }

    case 'GET_TAB_MEDIA': {
      if (tabId) {
        const memoryList = tabMediaStore.has(tabId) ? Array.from(tabMediaStore.get(tabId).values()) : [];
        if (memoryList.length > 0) {
          sendResponse({ media: memoryList });
        } else {
          chrome.storage.local.get(`tab_media_${tabId}`).then((data) => {
            const list = data[`tab_media_${tabId}`] || [];
            sendResponse({ media: list });
          });
          return true;
        }
      } else {
        sendResponse({ media: [] });
      }
      break;
    }

    case 'CLEAR_TAB_MEDIA': {
      if (tabId) {
        tabMediaStore.delete(tabId);
        chrome.storage.local.remove(`tab_media_${tabId}`);
        updateTabBadge(tabId);
        sendResponse({ success: true });
      }
      break;
    }

    case 'DELETE_MEDIA_ITEM': {
      const targetTabId = request.tabId || tabId;
      const mediaId = request.id;
      if (targetTabId && mediaId && tabMediaStore.has(targetTabId)) {
        const mediaMap = tabMediaStore.get(targetTabId);
        mediaMap.delete(mediaId);
        const serialized = Array.from(mediaMap.values());
        chrome.storage.local.set({ [`tab_media_${targetTabId}`]: serialized }).then(() => {
          updateTabBadge(targetTabId);
          sendResponse({ success: true, count: serialized.length });
        });
        return true;
      } else if (targetTabId && mediaId) {
        chrome.storage.local.get(`tab_media_${targetTabId}`).then((data) => {
          const list = (data[`tab_media_${targetTabId}`] || []).filter(m => m.id !== mediaId);
          chrome.storage.local.set({ [`tab_media_${targetTabId}`]: list }).then(() => {
            updateTabBadge(targetTabId);
            sendResponse({ success: true, count: list.length });
          });
        });
        return true;
      }
      sendResponse({ success: false });
      break;
    }

    case 'OPEN_DOWNLOADS_FOLDER': {
      if (chrome.downloads && chrome.downloads.showDefaultFolder) {
        chrome.downloads.showDefaultFolder();
        sendResponse({ success: true });
      } else {
        chrome.tabs.create({ url: 'chrome://downloads' });
        sendResponse({ success: true });
      }
      break;
    }

    case 'RECORD_DOWNLOAD_HISTORY': {
      if (request.item) {
        chrome.storage.local.get('download_history').then((data) => {
          const history = data.download_history || [];
          const record = {
            ...request.item,
            downloadedAt: Date.now()
          };
          history.unshift(record);
          if (history.length > 50) history.pop();
          chrome.storage.local.set({ download_history: history });
          sendResponse({ success: true });
        });
        return true;
      }
      sendResponse({ success: false });
      break;
    }

    case 'GET_DOWNLOAD_HISTORY': {
      chrome.storage.local.get('download_history').then((data) => {
        sendResponse({ history: data.download_history || [] });
      });
      return true;
    }

    case 'CLEAR_DOWNLOAD_HISTORY': {
      chrome.storage.local.remove('download_history').then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    case 'TRIGGER_DEEP_SCAN': {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: 'DEEP_SCAN' }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, data: res });
          }
        });
        return true;
      }
      sendResponse({ success: false });
      break;
    }

    case 'DOWNLOAD_MEDIA': {
      if (request.url) {
        const downloadOptions = {
          url: request.url,
          filename: request.filename || 'download.mp4',
          saveAs: typeof request.saveAs === 'boolean' ? request.saveAs : false
        };

        chrome.downloads.download(downloadOptions, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('[Download Error]:', chrome.runtime.lastError.message);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            // Also log to download history
            chrome.storage.local.get('download_history').then((data) => {
              const history = data.download_history || [];
              history.unshift({
                filename: downloadOptions.filename,
                url: downloadOptions.url,
                downloadedAt: Date.now(),
                downloadId
              });
              if (history.length > 50) history.pop();
              chrome.storage.local.set({ download_history: history });
            });
            sendResponse({ success: true, downloadId });
          }
        });
        return true;
      }
      break;
    }

    case 'START_DOWNLOAD_JOB': {
      const { media, format, saveAs, filename, pageUrl } = request;
      const targetTabId = request.tabId || tabId;

      if (!media || !media.url) {
        sendResponse({ success: false, error: 'No media specified' });
        break;
      }

      const jobId = 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      const isAudio = format === 'm4a' || format === 'mp3' || media.targetContainer === 'm4a' || media.targetContainer === 'mp3';
      const targetExt = isAudio ? 'm4a' : 'mp4';

      let jobFilename = filename || media.filename || 'download.mp4';
      if (!jobFilename.toLowerCase().endsWith('.' + targetExt)) {
        jobFilename = jobFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.' + targetExt;
      }

      const job = {
        id: jobId,
        tabId: targetTabId,
        media,
        format: targetExt,
        filename: jobFilename,
        status: 'starting',
        percent: 0,
        speed: '',
        eta: '',
        text: 'Starting background download...',
        startTime: Date.now()
      };

      activeJobs.set(jobId, job);
      ensureKeepAlive();

      // Check if direct download or HLS stream
      if (media.protocol !== 'HLS' && media.ext !== 'm3u8') {
        const effectiveReferer = media.referer || pageUrl || '';
        let effectiveOrigin = media.origin || '';
        if (!effectiveOrigin && effectiveReferer && effectiveReferer.startsWith('http')) {
          try {
            effectiveOrigin = new URL(effectiveReferer).origin;
          } catch (e) {}
        }
        if (media.url && effectiveReferer) {
          setStreamRefererRule(media.url, effectiveReferer, effectiveOrigin).catch(() => {});
        }

        job.status = 'downloading';
        job.percent = 50;
        job.text = 'Downloading direct media file...';

        chrome.downloads.download({
          url: media.url,
          filename: jobFilename,
          saveAs: Boolean(saveAs)
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            job.status = 'error';
            job.error = chrome.runtime.lastError.message;
            job.text = 'Download failed: ' + chrome.runtime.lastError.message;
          } else {
            job.status = 'completed';
            job.percent = 100;
            job.downloadId = downloadId;
            job.text = 'Download completed!';

            chrome.storage.local.get('download_history').then((data) => {
              const history = data.download_history || [];
              history.unshift({
                filename: jobFilename,
                url: media.url,
                downloadedAt: Date.now(),
                downloadId
              });
              if (history.length > 50) history.pop();
              chrome.storage.local.set({ download_history: history });
            });
          }

          setTimeout(() => {
            activeJobs.delete(jobId);
            ensureKeepAlive();
          }, 6000);
        });

        sendResponse({ success: true, jobId, job });
        return true;
      }

      // HLS stream: setup offscreen and dispatch
      (async () => {
        try {
          const settingsData = await chrome.storage.local.get('settings');
          const concurrency = settingsData?.settings?.downloadConcurrency || 4;

          const effectivePageUrl = pageUrl || media.pageUrl || media.referer || '';
          const effectiveReferer = media.referer || effectivePageUrl || '';
          let effectiveOrigin = media.origin || '';
          if (!effectiveOrigin && effectiveReferer && effectiveReferer.startsWith('http')) {
            try {
              effectiveOrigin = new URL(effectiveReferer).origin;
            } catch (e) {}
          }

          // Pre-emptively register DNR anti-hotlink rule for the stream
          if (media.url && effectiveReferer) {
            await setStreamRefererRule(media.url, effectiveReferer, effectiveOrigin);
          }

          await setupOffscreenDocument();
          chrome.runtime.sendMessage({
            action: 'START_OFFSCREEN_JOB',
            jobId,
            media,
            format: targetExt,
            tabId: targetTabId,
            pageUrl: effectivePageUrl,
            referer: effectiveReferer,
            origin: effectiveOrigin,
            saveAs: Boolean(saveAs),
            filename: jobFilename,
            concurrency
          });
        } catch (err) {
          console.error('Failed to dispatch offscreen job:', err);
          job.status = 'error';
          job.error = err.message;
          job.text = 'Offscreen worker initialization failed';
        }
      })();

      sendResponse({ success: true, jobId, job });
      break;
    }

    case 'GET_ACTIVE_JOBS': {
      sendResponse({ jobs: Array.from(activeJobs.values()) });
      break;
    }

    case 'CANCEL_DOWNLOAD_JOB': {
      const { jobId } = request;
      if (jobId && activeJobs.has(jobId)) {
        chrome.runtime.sendMessage({
          action: 'CANCEL_OFFSCREEN_JOB',
          jobId
        }).catch(() => {});
        activeJobs.delete(jobId);
        ensureKeepAlive();
        resetOffscreenIdleTimer();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Job not found' });
      }
      break;
    }

    case 'JOB_PROGRESS_UPDATE': {
      const { jobId, progress } = request;
      if (jobId && activeJobs.has(jobId)) {
        const job = activeJobs.get(jobId);
        Object.assign(job, progress);
      }
      sendResponse({ success: true });
      break;
    }

    case 'JOB_COMPLETED': {
      const { jobId, downloadId, filename } = request;
      if (jobId && activeJobs.has(jobId)) {
        const job = activeJobs.get(jobId);
        job.status = 'completed';
        job.percent = 100;
        job.text = 'Download complete! Saved as ' + (filename || job.filename);
        job.downloadId = downloadId;

        // Log to history
        chrome.storage.local.get('download_history').then((data) => {
          const history = data.download_history || [];
          history.unshift({
            filename: filename || job.filename,
            url: job.media?.url || '',
            downloadedAt: Date.now(),
            downloadId
          });
          if (history.length > 50) history.pop();
          chrome.storage.local.set({ download_history: history });
        });

        setTimeout(() => {
          activeJobs.delete(jobId);
          ensureKeepAlive();
          resetOffscreenIdleTimer();
        }, 5000);
      }
      sendResponse({ success: true });
      break;
    }

    case 'JOB_ERROR': {
      const { jobId, error } = request;
      if (jobId && activeJobs.has(jobId)) {
        const job = activeJobs.get(jobId);
        job.status = 'error';
        job.error = error;
        job.text = 'Error: ' + error;
        setTimeout(() => {
          activeJobs.delete(jobId);
          ensureKeepAlive();
          resetOffscreenIdleTimer();
        }, 8000);
      }
      sendResponse({ success: true });
      break;
    }

    case 'JOB_CANCELLED': {
      const { jobId } = request;
      if (jobId && activeJobs.has(jobId)) {
        activeJobs.delete(jobId);
        ensureKeepAlive();
        resetOffscreenIdleTimer();
      }
      sendResponse({ success: true });
      break;
    }

    case 'OPEN_SIDE_PANEL': {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.sidePanel.open({ windowId: sender.tab?.windowId || request.windowId })
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      } else {
        sendResponse({ success: false, error: 'Side panel API not supported on this browser version' });
      }
      break;
    }

    default:
      sendResponse({ status: 'unknown_action' });
  }

  return true;
});
