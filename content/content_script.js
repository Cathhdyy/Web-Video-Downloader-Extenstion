/**
 * Content Script - Page DOM Media Inspector & In-Page Context Fetcher
 * Scans page DOM for <video>, <audio>, embeds, and provides page-context fetching to bypass 403 anti-hotlink protections.
 */

(function () {
  const seenUrls = new Set();

  function scanMediaElements() {
    const discovered = [];
    const pageTitle = document.title || '';
    
    // Extract default page poster from OpenGraph or Twitter meta
    const pagePoster = document.querySelector('meta[property="og:image"]')?.content || 
                       document.querySelector('meta[property="og:image:secure_url"]')?.content ||
                       document.querySelector('meta[name="twitter:image"]')?.content || 
                       document.querySelector('meta[name="twitter:image:src"]')?.content || '';

    // 1. Scan <video> elements
    const videos = document.querySelectorAll('video');
    videos.forEach((vid) => {
      const vidPoster = vid.poster || vid.getAttribute('data-poster') || vid.getAttribute('poster') || pagePoster || null;
      const src = vid.currentSrc || vid.src || vid.getAttribute('data-src');
      if (src && !seenUrls.has(src)) {
        seenUrls.add(src);
        discovered.push({
          url: src,
          type: 'video',
          pageTitle,
          duration: vid.duration || null,
          poster: vidPoster
        });
      }

      // Check inner <source> tags
      vid.querySelectorAll('source').forEach((source) => {
        const sSrc = source.src || source.getAttribute('data-src');
        if (sSrc && !seenUrls.has(sSrc)) {
          seenUrls.add(sSrc);
          discovered.push({
            url: sSrc,
            type: source.type && source.type.includes('audio') ? 'audio' : 'video',
            pageTitle,
            duration: vid.duration || null,
            poster: vidPoster
          });
        }
      });
    });

    // 2. Scan <audio> elements
    const audios = document.querySelectorAll('audio');
    audios.forEach((aud) => {
      const src = aud.currentSrc || aud.src || aud.getAttribute('data-src');
      if (src && !seenUrls.has(src)) {
        seenUrls.add(src);
        discovered.push({
          url: src,
          type: 'audio',
          pageTitle,
          duration: aud.duration || null,
          poster: pagePoster || null
        });
      }

      aud.querySelectorAll('source').forEach((source) => {
        const sSrc = source.src || source.getAttribute('data-src');
        if (sSrc && !seenUrls.has(sSrc)) {
          seenUrls.add(sSrc);
          discovered.push({
            url: sSrc,
            type: 'audio',
            pageTitle,
            duration: aud.duration || null,
            poster: pagePoster || null
          });
        }
      });
    });

    // 3. Scan OpenGraph & Twitter Meta Tags
    const metaSelectors = [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[property="og:audio"]',
      'meta[property="og:audio:secure_url"]',
      'meta[name="twitter:player:stream"]'
    ];
    metaSelectors.forEach((sel) => {
      const meta = document.querySelector(sel);
      if (meta && meta.content && !seenUrls.has(meta.content)) {
        seenUrls.add(meta.content);
        const isAudio = sel.includes('audio');
        discovered.push({
          url: meta.content,
          type: isAudio ? 'audio' : 'video',
          pageTitle,
          poster: pagePoster || null
        });
      }
    });

    // 4. Scan Performance Resource Timing entries for media extensions
    try {
      const entries = performance.getEntriesByType('resource');
      const mediaExtRegex = /\.(mp4|webm|mkv|flv|mov|mp3|m4a|aac|wav|ogg|flac|m3u8|mpd)(?:[?#]|$)/i;
      entries.forEach((entry) => {
        if (entry.name && mediaExtRegex.test(entry.name) && !seenUrls.has(entry.name)) {
          seenUrls.add(entry.name);
          const isAudio = /\.(mp3|m4a|aac|wav|ogg|flac)(?:[?#]|$)/i.test(entry.name);
          discovered.push({
            url: entry.name,
            type: isAudio ? 'audio' : 'video',
            pageTitle,
            size: entry.transferSize || entry.encodedBodySize || 0,
            poster: pagePoster || null
          });
        }
      });
    } catch (e) {
      // Ignore performance timing errors
    }

    if (discovered.length > 0) {
      chrome.runtime.sendMessage({
        action: 'DOM_MEDIA_DETECTED',
        mediaList: discovered
      }).catch(() => {});
    }
  }

  // Initial scans
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    scanMediaElements();
  } else {
    window.addEventListener('DOMContentLoaded', scanMediaElements);
  }

  setTimeout(scanMediaElements, 1200);
  setTimeout(scanMediaElements, 3500);

  // MutationObserver for dynamic players
  let mutationTimeout = null;
  const observer = new MutationObserver(() => {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(scanMediaElements, 600);
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'currentSrc', 'data-src']
  });

  // ArrayBuffer to base64 helper (chunked for high performance)
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

  // Message listener for popup & background actions
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'RESCAN_DOM') {
      scanMediaElements();
      sendResponse({ status: 'scanned' });
      return false;
    }

    // In-page context fetcher (bypasses page-specific anti-hotlink protections)
    if (request.action === 'FETCH_RESOURCE') {
      const fetchUrl = request.url;
      const responseType = request.responseType || 'text'; // 'text' | 'arraybuffer'

      (async () => {
        try {
          let res;
          try {
            // First attempt with same-origin / omni credentials
            res = await fetch(fetchUrl, {
              method: 'GET',
              headers: { 'Accept': '*/*' }
            });
          } catch (err1) {
            // Fallback attempt with credentials included
            res = await fetch(fetchUrl, {
              method: 'GET',
              credentials: 'include',
              headers: { 'Accept': '*/*' }
            });
          }

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText || 'In-page fetch failed'}`);
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
          sendResponse({ success: false, error: err.message || 'In-page fetch error' });
        }
      })();

      return true; // Async sendResponse
    }
  });
})();
