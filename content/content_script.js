/**
 * Content Script - Page DOM Media Inspector & In-Page Context Fetcher
 * Scans page DOM for <video>, <audio>, embeds, captures real video frames via Canvas,
 * extracts player posters & schema metadata, and bypasses 403 anti-hotlink protections.
 */

(function () {
  const seenUrls = new Set();

  /**
   * Captures a real-time thumbnail frame from an HTML5 video element using an off-screen Canvas
   */
  function captureVideoFrame(video) {
    if (!video) return null;
    try {
      if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) {
        const canvas = document.createElement('canvas');
        const maxW = 320;
        const scale = Math.min(1, maxW / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.8);
      }
    } catch (e) {
      // CORS tainted canvas or security restriction: graceful fallback
    }
    return null;
  }

  /**
   * Extracts player poster from wrappers or CSS background-image
   */
  function getPlayerPoster(video) {
    if (!video) return null;

    // 1. Direct video poster attribute
    const direct = video.poster || video.getAttribute('data-poster') || video.getAttribute('poster');
    if (direct && !direct.startsWith('data:image/gif')) return direct;

    // 2. Player wrapper posters (JWPlayer, VideoJS, Plyr, etc.)
    try {
      const container = video.closest('.jwplayer, .video-js, .vjs-player, .plyr, .player-container, .player, [class*="player"]');
      if (container) {
        const posterEl = container.querySelector('.jw-preview, .jw-poster, .vjs-poster, .plyr__poster, [class*="poster"], [class*="preview"], [class*="thumb"]');
        if (posterEl) {
          const bgImg = window.getComputedStyle(posterEl).backgroundImage;
          if (bgImg && bgImg.startsWith('url(')) {
            const cleanUrl = bgImg.slice(4, -1).replace(/["']/g, '');
            if (cleanUrl.startsWith('http')) return cleanUrl;
          }
          if (posterEl.src) return posterEl.src;
        }
      }
    } catch (e) {}

    return null;
  }

  /**
   * Scans page OpenGraph, Twitter, and Schema.org JSON-LD for cover artwork
   */
  function getPageCoverImage() {
    // OpenGraph & Twitter
    const ogImg = document.querySelector('meta[property="og:image"]')?.content ||
                  document.querySelector('meta[property="og:image:secure_url"]')?.content ||
                  document.querySelector('meta[name="twitter:image"]')?.content ||
                  document.querySelector('meta[name="twitter:image:src"]')?.content;
    if (ogImg && ogImg.startsWith('http')) return ogImg;

    // Schema.org JSON-LD
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        if (!script.textContent) continue;
        const data = JSON.parse(script.textContent);
        const obj = Array.isArray(data) ? data[0] : (data['@graph'] ? data['@graph'][0] : data);
        if (obj) {
          const thumb = obj.thumbnailUrl || obj.image || (Array.isArray(obj.image) ? obj.image[0] : null);
          if (typeof thumb === 'string' && thumb.startsWith('http')) return thumb;
          if (thumb && typeof thumb === 'object' && thumb.url) return thumb.url;
        }
      }
    } catch (e) {}

    return null;
  }

  /**
   * Extracts clean page/video title from Schema, OpenGraph, or Document
   */
  function getBestTitle(video) {
    if (video) {
      const vTitle = video.getAttribute('title') || video.getAttribute('aria-label') || video.getAttribute('data-title');
      if (vTitle && vTitle.trim().length > 3) return vTitle.trim();
    }

    // Schema JSON-LD
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        if (!script.textContent) continue;
        const data = JSON.parse(script.textContent);
        const obj = Array.isArray(data) ? data[0] : (data['@graph'] ? data['@graph'][0] : data);
        if (obj && obj.name && typeof obj.name === 'string') {
          return obj.name.trim();
        }
      }
    } catch (e) {}

    // OG Title
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content ||
                    document.querySelector('meta[name="twitter:title"]')?.content;
    if (ogTitle && ogTitle.trim().length > 2) {
      return ogTitle.trim();
    }

    // Document title
    if (document.title && document.title.trim().length > 2) {
      return document.title.trim();
    }

    // H1 header
    const h1 = document.querySelector('h1');
    if (h1 && h1.innerText && h1.innerText.trim().length > 3) {
      return h1.innerText.trim();
    }

    return '';
  }

  function isDummyNoise(src) {
    if (!src) return true;
    const lower = src.toLowerCase();
    // Filter dummy screenshare or canvas blobs unless genuine video
    if (lower.includes('screenshare') || lower.includes('screen-recording')) {
      return true;
    }
    return false;
  }

  function scanMediaElements() {
    const discovered = [];
    const pageCover = getPageCoverImage();

    // 1. Scan <video> elements
    const videos = document.querySelectorAll('video');
    videos.forEach((vid) => {
      const vidTitle = getBestTitle(vid);
      let vidPoster = captureVideoFrame(vid) || getPlayerPoster(vid) || pageCover || null;

      const src = vid.currentSrc || vid.src || vid.getAttribute('data-src');
      if (src && !seenUrls.has(src) && !isDummyNoise(src)) {
        seenUrls.add(src);
        discovered.push({
          url: src,
          type: 'video',
          pageTitle: vidTitle,
          duration: vid.duration && !isNaN(vid.duration) && isFinite(vid.duration) ? vid.duration : null,
          poster: vidPoster
        });
      }

      // Check inner <source> tags
      vid.querySelectorAll('source').forEach((source) => {
        const sSrc = source.src || source.getAttribute('data-src');
        if (sSrc && !seenUrls.has(sSrc) && !isDummyNoise(sSrc)) {
          seenUrls.add(sSrc);
          discovered.push({
            url: sSrc,
            type: source.type && source.type.includes('audio') ? 'audio' : 'video',
            pageTitle: vidTitle,
            duration: vid.duration && !isNaN(vid.duration) && isFinite(vid.duration) ? vid.duration : null,
            poster: vidPoster
          });
        }
      });
    });

    // 2. Scan <audio> elements
    const audios = document.querySelectorAll('audio');
    audios.forEach((aud) => {
      const src = aud.currentSrc || aud.src || aud.getAttribute('data-src');
      const audTitle = getBestTitle(null);
      if (src && !seenUrls.has(src) && !isDummyNoise(src)) {
        seenUrls.add(src);
        discovered.push({
          url: src,
          type: 'audio',
          pageTitle: audTitle,
          duration: aud.duration && !isNaN(aud.duration) && isFinite(aud.duration) ? aud.duration : null,
          poster: pageCover || null
        });
      }

      aud.querySelectorAll('source').forEach((source) => {
        const sSrc = source.src || source.getAttribute('data-src');
        if (sSrc && !seenUrls.has(sSrc) && !isDummyNoise(sSrc)) {
          seenUrls.add(sSrc);
          discovered.push({
            url: sSrc,
            type: 'audio',
            pageTitle: audTitle,
            duration: aud.duration && !isNaN(aud.duration) && isFinite(aud.duration) ? aud.duration : null,
            poster: pageCover || null
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
      if (meta && meta.content && !seenUrls.has(meta.content) && !isDummyNoise(meta.content)) {
        seenUrls.add(meta.content);
        const isAudio = sel.includes('audio');
        discovered.push({
          url: meta.content,
          type: isAudio ? 'audio' : 'video',
          pageTitle: getBestTitle(null),
          poster: pageCover || null
        });
      }
    });

    // 4. Scan Performance Resource Timing entries for media extensions
    try {
      const entries = performance.getEntriesByType('resource');
      const mediaExtRegex = /\.(mp4|webm|mkv|flv|mov|mp3|m4a|aac|wav|ogg|flac|m3u8|mpd)(?:[?#]|$)/i;
      entries.forEach((entry) => {
        if (entry.name && mediaExtRegex.test(entry.name) && !seenUrls.has(entry.name) && !isDummyNoise(entry.name)) {
          seenUrls.add(entry.name);
          const isAudio = /\.(mp3|m4a|aac|wav|ogg|flac)(?:[?#]|$)/i.test(entry.name);
          discovered.push({
            url: entry.name,
            type: isAudio ? 'audio' : 'video',
            pageTitle: getBestTitle(null),
            size: entry.transferSize || entry.encodedBodySize || 0,
            poster: pageCover || null
          });
        }
      });
    } catch (e) {}

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

  setTimeout(scanMediaElements, 800);
  setTimeout(scanMediaElements, 2200);
  setTimeout(scanMediaElements, 4500);

  // MutationObserver for dynamic players
  let mutationTimeout = null;
  const observer = new MutationObserver(() => {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(scanMediaElements, 500);
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'currentSrc', 'data-src', 'poster']
  });

  // ArrayBuffer to base64 helper
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

  function getPageVideoInfo() {
    const videos = document.querySelectorAll('video');
    let maxDur = 0;
    let bestPoster = null;
    videos.forEach((v) => {
      if (v.duration && !isNaN(v.duration) && isFinite(v.duration) && v.duration > maxDur) {
        maxDur = v.duration;
        const frame = captureVideoFrame(v) || getPlayerPoster(v);
        if (frame) bestPoster = frame;
      }
    });
    return {
      duration: maxDur > 0 ? maxDur : null,
      poster: bestPoster || getPageCoverImage()
    };
  }

  function onVideoActive(e) {
    const video = e.target;
    if (video && video.tagName === 'VIDEO' && video.duration && !isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
      chrome.runtime.sendMessage({
        action: 'PAGE_VIDEO_DURATION_UPDATED',
        duration: video.duration,
        poster: captureVideoFrame(video) || getPlayerPoster(video)
      }).catch(() => {});
    }
  }

  document.addEventListener('loadedmetadata', onVideoActive, true);
  document.addEventListener('durationchange', onVideoActive, true);
  document.addEventListener('canplay', onVideoActive, true);
  document.addEventListener('play', onVideoActive, true);

  // Message listener for popup & background actions
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_PAGE_VIDEO_INFO') {
      sendResponse(getPageVideoInfo());
      return false;
    }

    if (request.action === 'RESCAN_DOM') {
      scanMediaElements();
      sendResponse({ status: 'scanned', ...getPageVideoInfo() });
      return false;
    }

    // "No video?" Deep Diagnostic Scan
    if (request.action === 'DEEP_SCAN') {
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        captureVideoFrame(v);
      });
      scanMediaElements();
      sendResponse({
        status: 'deep_scanned',
        videoCount: videos.length,
        hasIframes: document.querySelectorAll('iframe').length > 0,
        ...getPageVideoInfo()
      });
      return false;
    }

    // In-page context fetcher (bypasses page-specific anti-hotlink protections)
    if (request.action === 'FETCH_RESOURCE') {
      const fetchUrl = request.url;
      const responseType = request.responseType || 'text';

      (async () => {
        try {
          let res;
          try {
            res = await fetch(fetchUrl, {
              method: 'GET',
              headers: { 'Accept': '*/*' }
            });
          } catch (err1) {
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
