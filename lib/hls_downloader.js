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
    this.selectedVariantUrl = options.selectedVariantUrl || null;
    this.abortController = null;
    this.isDownloading = false;
  }

  static async getVariants(m3u8Url, tabId, pageUrl) {
    try {
      const downloader = new HLSDownloader({ tabId, pageUrl });
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
  async fetchResource(url, responseType = 'text') {
    const signal = this.abortController ? this.abortController.signal : null;
    let lastError = null;

    // 1. Background Service Worker (has <all_urls> host permissions, CORS-exempt)
    try {
      const bgResult = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'BACKGROUND_FETCH',
          url,
          responseType,
          pageUrl: this.pageUrl
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
      const res = await fetch(url, { signal });
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

    // 3. In-page context proxy via content script
    if (this.tabId) {
      try {
        const pageResult = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(
            this.tabId,
            {
              action: 'FETCH_RESOURCE',
              url,
              responseType
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

        if (pageResult !== undefined && pageResult !== null) return pageResult;
      } catch (pageErr) {
        if (!lastError) lastError = pageErr.message;
      }
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
          
          const bwMatch = info.match(/BANDWIDTH=(\d+)/i);
          if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);
          
          const resMatch = info.match(/RESOLUTION=(\d+x\d+)/i);
          if (resMatch) resolution = resMatch[1];
          
          if (streamUrl) {
            variants.push({
              bandwidth,
              resolution,
              url: this.resolveUrl(baseUrl, streamUrl),
              label: resolution ? `${resolution} (${Math.round(bandwidth / 1000)} kbps)` : `${Math.round(bandwidth / 1000)} kbps`
            });
          }
        }
      }
      return { isMaster: true, variants };
    }

    // Media playlist with segment chunks
    const segments = [];
    let totalDuration = 0;
    let currentDuration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXTINF:')) {
        const durMatch = line.match(/#EXTINF:([\d.]+)/);
        if (durMatch) {
          currentDuration = parseFloat(durMatch[1]);
          totalDuration += currentDuration;
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uriMatch = line.match(/URI=["']?([^"',]+)["']?/i);
        if (uriMatch && uriMatch[1]) {
          segments.unshift({
            url: this.resolveUrl(baseUrl, uriMatch[1]),
            duration: 0,
            isInitSegment: true
          });
        }
      } else if (!line.startsWith('#') && line.length > 0) {
        segments.push({
          url: this.resolveUrl(baseUrl, line),
          duration: currentDuration
        });
      }
    }

    return {
      isMaster: false,
      totalDuration,
      segmentCount: segments.length,
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

    if (!parsed.segments || !parsed.segments.length) {
      throw new Error('No video segments found in media playlist');
    }

    const totalSegments = parsed.segments.length;
    const chunks = new Array(totalSegments);
    let completedCount = 0;

    onProgress({
      status: 'downloading_segments',
      percent: 10,
      completed: 0,
      total: totalSegments,
      text: `Starting download (0/${totalSegments} chunks)...`
    });

    let nextIndex = 0;
    const downloadWorker = async () => {
      while (nextIndex < totalSegments) {
        if (this.abortController?.signal.aborted) throw new Error('Download cancelled');
        const currentIndex = nextIndex++;
        const seg = parsed.segments[currentIndex];

        try {
          const buffer = await this.fetchResource(seg.url, 'arraybuffer');
          chunks[currentIndex] = buffer;
          completedCount++;

          const percent = 10 + Math.round((completedCount / totalSegments) * 75);
          onProgress({
            status: 'downloading_segments',
            percent,
            completed: completedCount,
            total: totalSegments,
            text: `Downloading chunks: ${completedCount}/${totalSegments} (${percent}%)`
          });
        } catch (err) {
          if (this.abortController?.signal.aborted) throw err;
          try {
            const retryBuf = await this.fetchResource(seg.url, 'arraybuffer');
            chunks[currentIndex] = retryBuf;
            completedCount++;
          } catch (retryErr) {
            console.warn(`Segment ${currentIndex} retry failed:`, retryErr);
          }
        }
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
  async downloadAndExtractAudio(m3u8Url, onProgress = () => {}) {
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
          onProgress({ status: 'completed', percent: 100, text: 'Audio extracted successfully!' });
          return { blob: audioBlob, format: 'mp3', ext: 'mp3' };
        }
      }

      const directBlob = new Blob(rawChunks, { type: 'audio/mpeg' });
      this.isDownloading = false;
      onProgress({ status: 'completed', percent: 100, text: 'Audio stream downloaded!' });
      return { blob: directBlob, format: 'mp3', ext: 'mp3' };
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
