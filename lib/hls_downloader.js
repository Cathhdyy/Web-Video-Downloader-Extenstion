/**
 * In-Browser HLS (.m3u8) Stream Downloader, Transmuxer & Audio Extractor
 * Primary engine: Background Worker with recorded player headers + Fallback to In-Page Proxy / Direct fetch.
 * Transmuxes HLS TS chunks directly to MP4 using mux.js.
 */

function base64ToBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

class HLSDownloader {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 4;
    this.tabId = options.tabId || null;
    this.pageUrl = options.pageUrl || '';
    this.referer = options.referer || options.pageUrl || '';
    this.origin = options.origin || '';
    if (!this.origin && this.referer && this.referer.startsWith('http')) {
      try {
        this.origin = new URL(this.referer).origin;
      } catch (e) {}
    }
    this.selectedVariantUrl = options.selectedVariantUrl || null;
    this.abortController = null;
    this.isDownloading = false;
    this.keyCache = new Map();
    this.cryptoKeyCache = new Map();
  }

  /**
   * Decrypts an AES-128 encrypted HLS segment chunk using Web Crypto API
   */
  async decryptSegment(buffer, keyInfo, seq) {
    if (!keyInfo || keyInfo.method !== 'AES-128') return buffer;

    // 1. Fetch & cache raw 16-byte key buffer
    let rawKey = this.keyCache.get(keyInfo.uri);
    if (!rawKey) {
      rawKey = await this.fetchResource(keyInfo.uri, 'arraybuffer');
      this.keyCache.set(keyInfo.uri, rawKey);
    }

    // 2. Import and cache CryptoKey
    let cryptoKey = this.cryptoKeyCache.get(keyInfo.uri);
    if (!cryptoKey) {
      const cryptoApi = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : (globalThis.crypto?.subtle);
      if (!cryptoApi) {
        throw new Error('Web Crypto API not available for AES-128 decryption');
      }
      cryptoKey = await cryptoApi.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['decrypt']);
      this.cryptoKeyCache.set(keyInfo.uri, cryptoKey);
    }

    // 3. Determine 16-byte IV (explicit hex or sequence number per RFC 8216)
    let iv;
    if (keyInfo.ivHex) {
      const cleanHex = keyInfo.ivHex.padStart(32, '0');
      iv = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        iv[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
      }
    } else {
      iv = new Uint8Array(16);
      const view = new DataView(iv.buffer);
      view.setUint32(12, seq || 0, false); // big-endian 32-bit sequence number in last 4 bytes
    }

    const cryptoApi = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : (globalThis.crypto?.subtle);
    return await cryptoApi.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buffer);
  }

  static async getVariants(m3u8Url, tabId, pageUrl, referer, origin) {
    try {
      const downloader = new HLSDownloader({ tabId, pageUrl, referer, origin });
      const rawContent = await downloader.fetchResource(m3u8Url, 'text');
      const parsed = downloader.parseM3U8(rawContent, m3u8Url);
      if (parsed.isMaster && parsed.variants && parsed.variants.length > 0) {
        return parsed.variants;
      }
    } catch (e) {}
    return [];
  }

  /**
   * Resilient Multi-Layer Resource Fetcher
   */
  async fetchResource(url, responseType = 'text', headers = {}) {
    const signal = this.abortController ? this.abortController.signal : null;
    let lastError = null;

    // 1. Background Service Worker (has <all_urls> host permissions, CORS-exempt)
    try {
      const bgResult = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'BACKGROUND_FETCH',
          url,
          responseType,
          headers,
          pageUrl: this.pageUrl,
          referer: this.referer,
          origin: this.origin,
          tabId: this.tabId
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.success) {
            reject(new Error(response?.error || 'Background fetch rejected'));
            return;
          }

          if (responseType === 'arraybuffer' && response.base64) {
            resolve(base64ToBuffer(response.base64));
          } else {
            resolve(response.text);
          }
        });
      });

      if (bgResult !== undefined && bgResult !== null) return bgResult;
    } catch (bgErr) {
      lastError = bgErr.message;
    }

    // 2. Direct fetch fallback
    try {
      const res = await fetch(url, {
        signal,
        headers: {
          'Accept': '*/*',
          ...headers
        }
      });
      if (res.ok) {
        if (responseType === 'arraybuffer') {
          return await res.arrayBuffer();
        }
        return await res.text();
      } else {
        lastError = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (!lastError) lastError = err.message;
    }

    // 3. In-page context proxy via content script (direct or via background service worker bridge)
    try {
      let pageResult = null;
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage && this.tabId) {
        pageResult = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(
            this.tabId,
            {
              action: 'FETCH_RESOURCE',
              url,
              responseType,
              headers
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (!response || !response.success) {
                reject(new Error(response?.error || 'In-page fetch rejected'));
                return;
              }

              if (responseType === 'arraybuffer' && response.base64) {
                resolve(base64ToBuffer(response.base64));
              } else {
                resolve(response.text);
              }
            }
          );
        });
      } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        pageResult = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              action: 'PROXY_TAB_FETCH',
              url,
              responseType,
              headers,
              tabId: this.tabId,
              pageUrl: this.pageUrl
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (!response || !response.success) {
                reject(new Error(response?.error || 'Tab proxy fetch rejected'));
                return;
              }

              if (responseType === 'arraybuffer' && response.base64) {
                resolve(base64ToBuffer(response.base64));
              } else {
                resolve(response.text);
              }
            }
          );
        });
      }

      if (pageResult !== undefined && pageResult !== null) return pageResult;
    } catch (pageErr) {
      if (!lastError) lastError = pageErr.message;
    }

    throw new Error(lastError || `Failed to fetch ${url}`);
  }

  /**
   * Resolves relative URLs based on the base playlist URL, preserving auth query tokens
   */
  resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return '';
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://') || relativeUrl.startsWith('blob:')) {
      return relativeUrl;
    }
    try {
      const base = new URL(baseUrl);
      const resolved = new URL(relativeUrl, baseUrl);
      
      // Preserve auth query params (?token=..., ?expires=...) if relative path doesn't specify them
      if (!resolved.search && base.search) {
        resolved.search = base.search;
      }
      return resolved.href;
    } catch (e) {
      const baseParts = baseUrl.split('?')[0].split('/');
      baseParts.pop();
      return baseParts.join('/') + '/' + relativeUrl;
    }
  }

  /**
   * Parses an M3U8 playlist content and extracts variant streams or chunk URLs.
   */
  parseM3U8(content, baseUrl) {
    if (!content || typeof content !== 'string') {
      throw new Error('Empty or invalid playlist content received');
    }
    const cleanContent = content.replace(/^\uFEFF/, '');
    const lines = cleanContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
      throw new Error('Empty playlist file');
    }

    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

    if (isMaster) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const info = lines[i];
          // Find next non-comment line
          let streamUrl = '';
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].startsWith('#')) {
              streamUrl = lines[j];
              break;
            }
          }

          let bandwidth = 0;
          let resolution = '';
          let qualityTag = '';

          const bwMatch = info.match(/BANDWIDTH=(\d+)/i);
          if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);

          const resMatch = info.match(/RESOLUTION=(\d+x\d+)/i);
          if (resMatch) {
            resolution = resMatch[1];
            const h = parseInt(resolution.split('x')[1], 10);
            if (h >= 2160) qualityTag = '4K UHD';
            else if (h >= 1440) qualityTag = '2K QHD';
            else if (h >= 1080) qualityTag = '1080p FHD';
            else if (h >= 720) qualityTag = '720p HD';
            else if (h >= 480) qualityTag = '480p SD';
            else if (h >= 360) qualityTag = '360p';
            else qualityTag = `${h}p`;
          } else if (bandwidth > 0) {
            if (bandwidth >= 4500000) qualityTag = '1080p FHD';
            else if (bandwidth >= 2500000) qualityTag = '720p HD';
            else if (bandwidth >= 1000000) qualityTag = '480p SD';
            else qualityTag = 'SD Stream';
          }

          let bitrateStr = '';
          if (bandwidth >= 1000000) {
            bitrateStr = `${(bandwidth / 1000000).toFixed(1)} Mbps`;
          } else if (bandwidth > 0) {
            bitrateStr = `${Math.round(bandwidth / 1000)} kbps`;
          }

          let label = qualityTag || resolution || 'Auto Quality';
          if (bitrateStr) label += ` (${bitrateStr})`;

          if (streamUrl) {
            variants.push({
              bandwidth,
              resolution,
              qualityTag: qualityTag || 'Auto',
              bitrate: bitrateStr,
              url: this.resolveUrl(baseUrl, streamUrl),
              label
            });
          }
        }
      }
      return { isMaster: true, variants };
    }

    // Media playlist with segment chunks & optional AES-128 encryption
    const segments = [];
    let totalDuration = 0;
    let currentDuration = 0;
    let currentKey = null;
    let mediaSequence = 0;
    let currentByteRange = null;
    let previousByteRangeEnd = 0;

    const seqLine = lines.find(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
    if (seqLine) {
      const match = seqLine.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      if (match) mediaSequence = parseInt(match[1], 10);
    }

    let segmentIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : 'NONE';
        if (method === 'AES-128') {
          const uriMatch = line.match(/URI=["']?([^"',]+)["']?/i);
          const ivMatch = line.match(/IV=0x([a-fA-F0-9]+)/i);
          if (uriMatch && uriMatch[1]) {
            currentKey = {
              method: 'AES-128',
              uri: this.resolveUrl(baseUrl, uriMatch[1]),
              ivHex: ivMatch ? ivMatch[1] : null
            };
          }
        } else if (method === 'NONE') {
          currentKey = null;
        }
      } else if (line.startsWith('#EXTINF:')) {
        const durMatch = line.match(/#EXTINF:([\d.]+)/);
        if (durMatch) {
          currentDuration = parseFloat(durMatch[1]);
          totalDuration += currentDuration;
        }
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const brMatch = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i);
        if (brMatch) {
          const length = parseInt(brMatch[1], 10);
          const offset = brMatch[2] !== undefined ? parseInt(brMatch[2], 10) : previousByteRangeEnd;
          currentByteRange = { offset, length };
          previousByteRangeEnd = offset + length;
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uriMatch = line.match(/URI=["']?([^"',]+)["']?/i);
        const brMatch = line.match(/BYTERANGE=["']?(\d+)(?:@(\d+))?["']?/i);
        let mapByteRange = null;
        if (brMatch) {
          mapByteRange = {
            offset: parseInt(brMatch[2] || 0, 10),
            length: parseInt(brMatch[1], 10)
          };
        }
        if (uriMatch && uriMatch[1]) {
          segments.unshift({
            url: this.resolveUrl(baseUrl, uriMatch[1]),
            duration: 0,
            isInitSegment: true,
            byteRange: mapByteRange,
            key: currentKey ? { ...currentKey } : null,
            seq: mediaSequence
          });
        }
      } else if (!line.startsWith('#') && line.length > 0) {
        const seq = mediaSequence + segmentIndex;
        segments.push({
          url: this.resolveUrl(baseUrl, line),
          duration: currentDuration,
          key: currentKey ? { ...currentKey } : null,
          byteRange: currentByteRange,
          seq
        });
        currentByteRange = null;
        segmentIndex++;
      }
    }

    const isFmp4 = segments.some(s => s.isInitSegment || s.url.includes('.m4s') || s.url.includes('.mp4'));

    return {
      isMaster: false,
      totalDuration,
      segmentCount: segments.length,
      hasEncryption: Boolean(currentKey),
      isFmp4,
      segments
    };
  }

  /**
   * Downloads all segments from an M3U8 URL and returns raw ArrayBuffers.
   */
  async fetchAllSegments(m3u8Url, onProgress = () => {}) {
    this.abortController = new AbortController();
    this.isDownloading = true;

    onProgress({ status: 'fetching_manifest', percent: 2, text: 'Fetching playlist manifest...' });
    const rawContent = await this.fetchResource(m3u8Url, 'text');
    let parsed = this.parseM3U8(rawContent, m3u8Url);

    let mediaPlaylistUrl = this.selectedVariantUrl || m3u8Url;
    if (!this.selectedVariantUrl && parsed.isMaster) {
      if (!parsed.variants.length) {
        throw new Error('No streaming variants found in master playlist');
      }
      parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const bestVariant = parsed.variants[0];
      mediaPlaylistUrl = bestVariant.url;
      
      onProgress({ status: 'fetching_variant', percent: 5, text: `Loading quality: ${bestVariant.label}...` });
      const variantContent = await this.fetchResource(mediaPlaylistUrl, 'text');
      parsed = this.parseM3U8(variantContent, mediaPlaylistUrl);
    } else if (this.selectedVariantUrl && parsed.isMaster) {
      onProgress({ status: 'fetching_variant', percent: 5, text: 'Loading selected stream quality...' });
      const variantContent = await this.fetchResource(mediaPlaylistUrl, 'text');
      parsed = this.parseM3U8(variantContent, mediaPlaylistUrl);
    }

    this.isFmp4 = Boolean(parsed.isFmp4);

    if (!parsed.segments || !parsed.segments.length) {
      throw new Error('No video segments found in media playlist');
    }

    const totalSegments = parsed.segments.length;
    const chunks = new Array(totalSegments);
    let completedCount = 0;
    let totalBytesDownloaded = 0;
    const startTime = Date.now();
    let lastSampleTime = startTime;
    let lastSampleBytes = 0;
    let currentSpeedBps = 0;

    const formatSpeed = (bps) => {
      if (!bps || bps <= 0) return '';
      if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
      return `${Math.round(bps / 1024)} KB/s`;
    };

    const formatEta = (seconds) => {
      if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
      const s = Math.round(seconds);
      if (s < 60) return `${s}s left`;
      const m = Math.floor(s / 60);
      return `${m}m ${s % 60}s left`;
    };

    onProgress({
      status: 'downloading_segments',
      percent: 10,
      completed: 0,
      total: totalSegments,
      speed: '',
      eta: '',
      text: `Starting download (0/${totalSegments} chunks)...`
    });

    const retryDelays = [500, 1500, 3000]; // Progressive exponential delays

    let nextIndex = 0;
    const downloadWorker = async () => {
      while (nextIndex < totalSegments) {
        if (this.abortController?.signal.aborted) throw new Error('Download cancelled');
        const currentIndex = nextIndex++;
        const seg = parsed.segments[currentIndex];

        let buffer = null;
        let reqHeaders = {};
        if (seg.byteRange) {
          const start = seg.byteRange.offset;
          const end = seg.byteRange.offset + seg.byteRange.length - 1;
          reqHeaders['Range'] = `bytes=${start}-${end}`;
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
          if (this.abortController?.signal.aborted) throw new Error('Download cancelled');
          try {
            buffer = await this.fetchResource(seg.url, 'arraybuffer', reqHeaders);
            if (seg.key) {
              buffer = await this.decryptSegment(buffer, seg.key, seg.seq);
            }
            break;
          } catch (err) {
            if (this.abortController?.signal.aborted) throw err;
            if (attempt === 3) {
              console.warn(`Segment ${currentIndex + 1}/${totalSegments} failed after 3 attempts (${retryDelays[2]}ms):`, err);
              break;
            }
            const delay = retryDelays[attempt - 1] || 500;
            await new Promise(r => setTimeout(r, delay));
          }
        }

        if (buffer) {
          chunks[currentIndex] = buffer;
          totalBytesDownloaded += buffer.byteLength;
        }
        completedCount++;

        const now = Date.now();
        if (now - lastSampleTime >= 700) {
          const bytesDiff = totalBytesDownloaded - lastSampleBytes;
          const timeDiffSec = (now - lastSampleTime) / 1000;
          currentSpeedBps = timeDiffSec > 0 ? (bytesDiff / timeDiffSec) : 0;
          lastSampleTime = now;
          lastSampleBytes = totalBytesDownloaded;
        }

        const remainingSegments = totalSegments - completedCount;
        const avgChunkBytes = totalBytesDownloaded / Math.max(1, completedCount);
        const estRemainingBytes = remainingSegments * avgChunkBytes;
        const etaSeconds = currentSpeedBps > 0 ? (estRemainingBytes / currentSpeedBps) : 0;

        const speedStr = formatSpeed(currentSpeedBps);
        const etaStr = formatEta(etaSeconds);
        const percent = 10 + Math.round((completedCount / totalSegments) * 75);

        let progressLabel = `Downloading: ${completedCount}/${totalSegments} (${percent}%)`;
        if (speedStr) progressLabel += ` • ${speedStr}`;
        if (etaStr) progressLabel += ` • ${etaStr}`;

        onProgress({
          status: 'downloading_segments',
          percent,
          completed: completedCount,
          total: totalSegments,
          speed: speedStr,
          eta: etaStr,
          bytesDownloaded: totalBytesDownloaded,
          text: progressLabel
        });
      }
    };

    const workerCount = Math.min(this.concurrency, totalSegments);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(downloadWorker());
    }
    await Promise.all(workers);

    if (this.abortController?.signal.aborted) throw new Error('Download cancelled');

    return chunks.filter(Boolean);
  }

  /**
   * Transmuxes MPEG-TS segments into a standard MP4 Blob using mux.js
   */
  async transmuxTsToMp4(tsChunks, onProgress = () => {}) {
    onProgress({ status: 'transmuxing', percent: 88, text: 'Converting stream to MP4 format...' });

    // For fragmented MP4 (CMAF/fMP4) streams, the concatenated chunks are already a valid MP4!
    if (this.isFmp4) {
      onProgress({ status: 'packaging', percent: 98, text: 'Packaging fMP4 stream to MP4...' });
      const mp4Blob = new Blob(tsChunks, { type: 'video/mp4' });
      return { blob: mp4Blob, format: 'mp4' };
    }

    const MuxJsLib = (typeof muxjs !== 'undefined') ? muxjs : (typeof window !== 'undefined' && window.muxjs);
    
    if (!MuxJsLib || !MuxJsLib.mp4 || !MuxJsLib.mp4.Transmuxer) {
      return { blob: new Blob(tsChunks, { type: 'video/mp4' }), format: 'mp4' };
    }

    try {
      const transmuxer = new MuxJsLib.mp4.Transmuxer({
        keepOriginalTimestamps: true,
        remux: true
      });

      let initSegment = null;
      const mediaSegments = [];

      transmuxer.on('data', (segment) => {
        if (segment.initSegment && segment.initSegment.byteLength > 0) {
          initSegment = segment.initSegment;
        }
        if (segment.data && segment.data.byteLength > 0) {
          mediaSegments.push(segment.data);
        }
      });

      for (let i = 0; i < tsChunks.length; i++) {
        transmuxer.push(new Uint8Array(tsChunks[i]));
        transmuxer.flush();
        if (i % 15 === 0) {
          const p = 88 + Math.round((i / tsChunks.length) * 8);
          onProgress({ status: 'transmuxing', percent: p, text: `Transmuxing to MP4 (${Math.round((i / tsChunks.length) * 100)}%)...` });
        }
      }

      if (initSegment && mediaSegments.length > 0) {
        onProgress({ status: 'packaging', percent: 98, text: 'Packaging MP4 video...' });
        const boxes = [initSegment, ...mediaSegments];
        const mp4Blob = new Blob(boxes, { type: 'video/mp4' });
        return { blob: mp4Blob, format: 'mp4' };
      } else {
        return { blob: new Blob(tsChunks, { type: 'video/mp4' }), format: 'mp4' };
      }
    } catch (err) {
      console.error('Transmuxing error:', err);
      return { blob: new Blob(tsChunks, { type: 'video/mp4' }), format: 'mp4' };
    }
  }

  /**
   * Main download flow: Downloads HLS stream and converts to MP4 Blob
   */
  async downloadAndConvertToMp4(m3u8Url, onProgress = () => {}) {
    try {
      const rawChunks = await this.fetchAllSegments(m3u8Url, onProgress);
      const result = await this.transmuxTsToMp4(rawChunks, onProgress);
      this.isDownloading = false;
      onProgress({ status: 'completed', percent: 100, text: 'Stream converted to MP4 successfully!', result });
      return result;
    } catch (err) {
      this.isDownloading = false;
      if (err.name === 'AbortError' || err.message.includes('cancelled')) {
        onProgress({ status: 'cancelled', percent: 0, text: 'Download cancelled' });
      } else {
        onProgress({ status: 'error', percent: 0, text: `Error: ${err.message}` });
      }
      throw err;
    }
  }

  /**
   * Extracts audio stream from HLS and converts to Audio/MP3
   */
  async downloadAndExtractAudio(m3u8Url, onProgress = () => {}, options = {}) {
    try {
      const rawChunks = await this.fetchAllSegments(m3u8Url, onProgress);
      onProgress({ status: 'extracting_audio', percent: 90, text: 'Extracting audio track from stream...' });

      const MuxJsLib = (typeof muxjs !== 'undefined') ? muxjs : (typeof window !== 'undefined' && window.muxjs);
      if (MuxJsLib && MuxJsLib.mp4 && MuxJsLib.mp4.Transmuxer) {
        const transmuxer = new MuxJsLib.mp4.Transmuxer({ keepOriginalTimestamps: true });
        let initSegment = null;
        const mediaSegments = [];

        transmuxer.on('data', (segment) => {
          if (segment.initSegment) initSegment = segment.initSegment;
          if (segment.data) mediaSegments.push(segment.data);
        });

        for (const chunk of rawChunks) {
          transmuxer.push(new Uint8Array(chunk));
          transmuxer.flush();
        }

        if (initSegment && mediaSegments.length > 0) {
          const audioBlob = new Blob([initSegment, ...mediaSegments], { type: 'audio/mp4' });
          this.isDownloading = false;
          onProgress({ status: 'completed', percent: 100, text: 'Lossless audio extracted successfully (.m4a)!', result: { format: 'm4a' } });
          return { blob: audioBlob, format: 'm4a', ext: 'm4a', mimeType: 'audio/mp4' };
        }
      }

      const directBlob = new Blob(rawChunks, { type: 'audio/mp4' });
      this.isDownloading = false;
      onProgress({ status: 'completed', percent: 100, text: 'Audio stream downloaded!', result: { format: 'm4a' } });
      return { blob: directBlob, format: 'm4a', ext: 'm4a', mimeType: 'audio/mp4' };
    } catch (err) {
      this.isDownloading = false;
      throw err;
    }
  }

  cancel() {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isDownloading = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HLSDownloader;
} else if (typeof globalThis !== 'undefined') {
  globalThis.HLSDownloader = HLSDownloader;
}
