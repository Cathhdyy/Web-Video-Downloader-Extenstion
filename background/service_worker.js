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
async function setStreamRefererRule(streamUrl, defaultPageUrl) {
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

    const rules = [{
      id: 9991,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: refererVal }
        ]
      },
      condition: {
        urlFilter: `||${host}`,
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    }];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9991],
      addRules: rules
    });
  } catch (err) {
    console.warn('DeclarativeNetRequest rule update error:', err);
  }
}

/**
 * Register detected media item for a given tab
 */
async function registerMedia(tabId, mediaItem) {
  if (!tabId || tabId < 0 || !mediaItem || !mediaItem.url) return;

  const storageData = await chrome.storage.local.get('settings');
  const settings = storageData.settings || DEFAULT_SETTINGS;

  if (mediaItem.size > 0 && mediaItem.size < settings.minSizeThreshold) {
    return;
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
            if (!inspected.filename || inspected.filename.startsWith('Media_') || inspected.filename.includes('videoplayback') || inspected.filename.includes('index_') || inspected.filename.includes('Video_')) {
              const ext = inspected.ext === 'm3u8' ? 'mp4' : inspected.ext;
              const q = inspected.quality ? `_${inspected.quality.replace(/\s+/g, '')}` : '';
              inspected.filename = `${MediaDetector.sanitizeTitle(tab.title)}${q}.${ext}`;
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

    case 'SETUP_STREAM_RULES': {
      if (request.streamUrl) {
        setStreamRefererRule(request.streamUrl, request.pageUrl).then(() => {
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
      const { url, responseType, pageUrl } = request;

      (async () => {
        try {
          if (!url) {
            sendResponse({ success: false, error: 'Empty URL provided' });
            return;
          }

          // Direct fetch in service worker (exempt from CORS via <all_urls> host permissions)
          let res;
          try {
            res = await fetch(url, {
              headers: {
                'Accept': '*/*'
              }
            });
          } catch (fetchErr) {
            // Retry once with referer setup if pageUrl is available
            if (pageUrl && pageUrl.startsWith('http')) {
              await setStreamRefererRule(url, pageUrl);
              res = await fetch(url, { headers: { 'Accept': '*/*' } });
            } else {
              throw fetchErr;
            }
          }

          if (!res.ok) {
            // If 403 Forbidden, retry with referer rule
            if (res.status === 403 && pageUrl && pageUrl.startsWith('http')) {
              await setStreamRefererRule(url, pageUrl);
              res = await fetch(url, { headers: { 'Accept': '*/*' } });
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
            sendResponse({ success: true, downloadId });
          }
        });
        return true;
      }
      break;
    }

    default:
      sendResponse({ status: 'unknown_action' });
  }

  return true;
});
