/**
 * Media Detector & URL Analyzer Utility
 * Helper functions for detecting, classifying, and formatting media streams.
 */

const MediaDetector = {
  // Common video & audio MIME type patterns
  MIME_MAP: {
    'video/mp4': { ext: 'mp4', type: 'video', label: 'MP4 Video' },
    'video/webm': { ext: 'webm', type: 'video', label: 'WebM Video' },
    'video/ogg': { ext: 'ogv', type: 'video', label: 'OGV Video' },
    'video/x-matroska': { ext: 'mkv', type: 'video', label: 'MKV Video' },
    'video/x-flv': { ext: 'flv', type: 'video', label: 'FLV Video' },
    'video/quicktime': { ext: 'mov', type: 'video', label: 'QuickTime Video' },
    'video/3gpp': { ext: '3gp', type: 'video', label: '3GP Video' },
    'video/mp2t': { ext: 'ts', type: 'stream', label: 'TS Stream Segment' },

    'audio/mpeg': { ext: 'mp3', type: 'audio', label: 'MP3 Audio' },
    'audio/mp3': { ext: 'mp3', type: 'audio', label: 'MP3 Audio' },
    'audio/mp4': { ext: 'm4a', type: 'audio', label: 'M4A Audio' },
    'audio/m4a': { ext: 'm4a', type: 'audio', label: 'M4A Audio' },
    'audio/aac': { ext: 'aac', type: 'audio', label: 'AAC Audio' },
    'audio/ogg': { ext: 'ogg', type: 'audio', label: 'OGG Audio' },
    'audio/wav': { ext: 'wav', type: 'audio', label: 'WAV Audio' },
    'audio/webm': { ext: 'weba', type: 'audio', label: 'WebM Audio' },
    'audio/flac': { ext: 'flac', type: 'audio', label: 'FLAC Audio' },

    'application/vnd.apple.mpegurl': { ext: 'm3u8', type: 'stream', label: 'HLS Video Stream (Converts to MP4)' },
    'application/x-mpegurl': { ext: 'm3u8', type: 'stream', label: 'HLS Video Stream (Converts to MP4)' },
    'audio/x-mpegurl': { ext: 'm3u8', type: 'stream', label: 'HLS Audio Stream' },
    'application/dash+xml': { ext: 'mpd', type: 'stream', label: 'DASH Manifest' },
    'application/octet-stream': null
  },

  // Extension patterns to match in URLs
  EXT_PATTERNS: [
    { regex: /\.(mp4)(?:[?#]|$)/i, ext: 'mp4', type: 'video', label: 'MP4 Video' },
    { regex: /\.(webm)(?:[?#]|$)/i, ext: 'webm', type: 'video', label: 'WebM Video' },
    { regex: /\.(mkv)(?:[?#]|$)/i, ext: 'mkv', type: 'video', label: 'MKV Video' },
    { regex: /\.(flv)(?:[?#]|$)/i, ext: 'flv', type: 'video', label: 'FLV Video' },
    { regex: /\.(mov)(?:[?#]|$)/i, ext: 'mov', type: 'video', label: 'MOV Video' },
    { regex: /\.(m4v)(?:[?#]|$)/i, ext: 'm4v', type: 'video', label: 'M4V Video' },
    { regex: /\.(3gp)(?:[?#]|$)/i, ext: '3gp', type: 'video', label: '3GP Video' },

    { regex: /\.(mp3)(?:[?#]|$)/i, ext: 'mp3', type: 'audio', label: 'MP3 Audio' },
    { regex: /\.(m4a)(?:[?#]|$)/i, ext: 'm4a', type: 'audio', label: 'M4A Audio' },
    { regex: /\.(aac)(?:[?#]|$)/i, ext: 'aac', type: 'audio', label: 'AAC Audio' },
    { regex: /\.(wav)(?:[?#]|$)/i, ext: 'wav', type: 'audio', label: 'WAV Audio' },
    { regex: /\.(ogg|oga)(?:[?#]|$)/i, ext: 'ogg', type: 'audio', label: 'OGG Audio' },
    { regex: /\.(flac)(?:[?#]|$)/i, ext: 'flac', type: 'audio', label: 'FLAC Audio' },
    { regex: /\.(opus)(?:[?#]|$)/i, ext: 'opus', type: 'audio', label: 'Opus Audio' },

    { regex: /\.(m3u8)(?:[?#]|$)/i, ext: 'm3u8', type: 'stream', label: 'HLS Stream (Converts to MP4)' },
    { regex: /\.(mpd)(?:[?#]|$)/i, ext: 'mpd', type: 'stream', label: 'DASH Manifest' },
    { regex: /\.(ts)(?:[?#]|$)/i, ext: 'ts', type: 'stream', label: 'TS Stream Segment' }
  ],

  isMediaMime(mimeType) {
    if (!mimeType) return false;
    const clean = mimeType.toLowerCase().split(';')[0].trim();
    if (this.MIME_MAP[clean] !== undefined) {
      return this.MIME_MAP[clean] !== null;
    }
    return clean.startsWith('video/') || clean.startsWith('audio/');
  },

  // Detect if a URL is an individual sub-chunk of an HLS stream (e.g. seg_000.ts, chunk_12.ts)
  isSubChunk(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return /\.(ts)(?:[?#]|$)/i.test(lower) && 
      (/(?:seg|chunk|segment|fragment|part|slice)[-_]?\d+/i.test(lower) || /[-_]\d{3,}\.ts/i.test(lower));
  },

  isGenericFilename(name) {
    if (!name || typeof name !== 'string') return true;
    const lower = name.toLowerCase().trim();
    const base = lower.replace(/\.[a-z0-9]{2,5}$/i, '');
    if (base.length < 3) return true;

    const genericTokens = [
      'index', 'master', 'playlist', 'play', 'video', 'videoplayback', 'stream',
      'chunk', 'segment', 'screenshare', 'screen-recording', 'recording',
      'output', 'source', 'default', 'main', 'media', 'manifest', 'temp',
      'download', 'file', 'track', 'track_audio', 'track_video', 'sample', 'test',
      'preview', 'raw', 'hls', 'dash', 'blob'
    ];

    if (genericTokens.includes(base)) return true;
    if (/^(index|master|segment|chunk|part|slice|fragment|video|media)[-_]?\d*$/i.test(base)) return true;
    if (/^[a-f0-9]{8,64}$/i.test(base)) return true;  // Hex hash
    if (/^[a-f0-9-]{36}$/i.test(base)) return true;   // UUID
    if (/^\d{8,16}$/.test(base)) return true;          // Numeric timestamp

    return false;
  },

  isNoiseMedia(url, filename, contentLength, extra = {}) {
    const lowerUrl = (url || '').toLowerCase();
    const lowerName = (filename || '').toLowerCase();
    // Filter out dummy screenshare / canvas recordings under 300 KB
    if ((lowerName.includes('screenshare') || lowerUrl.includes('screenshare') || lowerName.includes('screen-recording')) && contentLength < 350 * 1024) {
      return true;
    }
    // Filter tiny ad tracking beacons or dummy audio/video under 100 KB unless verified audio track
    if (contentLength > 0 && contentLength < 95 * 1024 && (!extra.duration || extra.duration < 3)) {
      if (!lowerName.endsWith('.mp3') && !lowerName.endsWith('.m4a') && !lowerName.endsWith('.aac')) {
        return true;
      }
    }
    return false;
  },

  cleanPageTitle(rawTitle) {
    if (!rawTitle) return '';
    let title = rawTitle.trim();
    title = title.replace(/\s*[-–|]\s*(Watch Free Online|Watch Online|Full Movie Online|Free Streaming|Watch HD|Online Free).*$/i, '');
    return this.sanitizeTitle(title);
  },

  // Parse media information from URL and HTTP response headers
  inspectMedia(url, headers = {}, defaultTitle = '', extra = {}) {
    if (!url || typeof url !== 'string') return null;

    if (url.startsWith('chrome-extension://') || url.startsWith('blob:chrome-extension')) {
      return null;
    }

    let detectedExt = '';
    let mediaType = 'unknown';
    let label = 'Media File';
    let contentLength = 0;

    // 1. Inspect Content-Type header
    const contentTypeHeader = headers['content-type'] || headers['Content-Type'] || '';
    const cleanMime = contentTypeHeader.toLowerCase().split(';')[0].trim();
    if (this.MIME_MAP[cleanMime]) {
      const info = this.MIME_MAP[cleanMime];
      detectedExt = info.ext;
      mediaType = info.type;
      label = info.label;
    } else if (cleanMime.startsWith('video/')) {
      detectedExt = cleanMime.replace('video/', '').replace('x-', '');
      mediaType = 'video';
      label = detectedExt.toUpperCase() + ' Video';
    } else if (cleanMime.startsWith('audio/')) {
      detectedExt = cleanMime.replace('audio/', '').replace('x-', '');
      mediaType = 'audio';
      label = detectedExt.toUpperCase() + ' Audio';
    }

    // 2. Inspect URL if MIME was generic
    if (!detectedExt) {
      for (const item of this.EXT_PATTERNS) {
        if (item.regex.test(url)) {
          detectedExt = item.ext;
          mediaType = item.type;
          label = item.label;
          break;
        }
      }
    }

    if (!detectedExt && !cleanMime.startsWith('video/') && !cleanMime.startsWith('audio/')) {
      return null;
    }

    // Extract Content-Length
    const clHeader = headers['content-length'] || headers['Content-Length'];
    if (clHeader) {
      contentLength = parseInt(clHeader, 10) || 0;
    }

    // Extract filename from Content-Disposition if present
    let filename = '';
    const cdHeader = headers['content-disposition'] || headers['Content-Disposition'] || '';
    const matchCd = cdHeader.match(/filename\*?=(?:UTF-8'')?"?([^";\n]+)"?/i);
    if (matchCd && matchCd[1]) {
      try {
        filename = decodeURIComponent(matchCd[1].trim());
      } catch (e) {
        filename = matchCd[1].trim();
      }
    }

    // Derive filename from URL
    if (!filename) {
      try {
        const parsedUrl = new URL(url);
        const segments = parsedUrl.pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
          const last = decodeURIComponent(segments[segments.length - 1]);
          if (last && last.length < 100 && !last.includes('manifest')) {
            filename = last;
          }
        }
      } catch (e) {}
    }

    // Check if filename is dummy/noise
    if (this.isNoiseMedia(url, filename, contentLength, extra)) {
      return null;
    }

    const quality = this.extractQualityBadge(url, headers);
    const targetExt = detectedExt === 'm3u8' ? 'mp4' : (detectedExt || 'mp4');

    // Smart naming: if filename is generic or missing, use page/movie title
    if (!filename || this.isGenericFilename(filename)) {
      const cleanTitle = this.cleanPageTitle(defaultTitle);
      const baseName = cleanTitle || `Video_${Date.now().toString().slice(-6)}`;
      const qTag = quality ? `_${quality.replace(/\s+/g, '')}` : '';
      filename = `${baseName}${qTag}.${targetExt}`;
    }

    // If M3U8, convert default filename suffix to .mp4
    if (detectedExt === 'm3u8' && filename.toLowerCase().endsWith('.m3u8')) {
      filename = filename.replace(/\.m3u8$/i, '.mp4');
    }

    const isChunk = this.isSubChunk(url);
    const duration = extra.duration || null;
    const poster = extra.poster || null;
    const protocol = (detectedExt === 'm3u8' || mediaType === 'stream') ? 'HLS' : 'HTTP';

    return {
      id: this.generateMediaId(url),
      url,
      filename: this.sanitizeTitle(filename),
      ext: detectedExt || 'mp4',
      type: mediaType,
      protocol,
      label,
      size: contentLength,
      sizeFormatted: detectedExt === 'm3u8' ? 'Full Video Stream' : this.formatBytes(contentLength),
      quality,
      duration,
      durationFormatted: this.formatDuration(duration),
      poster,
      isSubChunk: isChunk,
      timestamp: Date.now()
    };
  },

  formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds <= 0) return '';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) {
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
  },

  extractQualityBadge(url, headers = {}) {
    const lower = url.toLowerCase();
    if (lower.includes('2160p') || lower.includes('4k') || lower.includes('3840x2160')) return '4K UHD';
    if (lower.includes('1440p') || lower.includes('2k') || lower.includes('2560x1440')) return '2K QHD';
    if (lower.includes('1080p') || lower.includes('1920x1080') || lower.includes('height=1080')) return '1080p';
    if (lower.includes('802p')) return '802p';
    if (lower.includes('720p') || lower.includes('1280x720') || lower.includes('height=720')) return '720p';
    if (lower.includes('480p') || lower.includes('854x480') || lower.includes('height=480')) return '480p';
    if (lower.includes('360p') || lower.includes('640x360') || lower.includes('height=360')) return '360p';
    if (lower.includes('320k') || lower.includes('320kbps')) return '320 kbps';
    if (lower.includes('256k') || lower.includes('256kbps')) return '256 kbps';
    if (lower.includes('192k') || lower.includes('192kbps')) return '192 kbps';
    if (lower.includes('128k') || lower.includes('128kbps')) return '128 kbps';
    return null;
  },

  sanitizeTitle(title) {
    if (!title) return 'Downloaded_Media';
    return title
      .replace(/[:]/g, ' - ')
      .replace(/[\\/*?"<>|]/g, '_')
      .replace(/\s*-\s*-\s*/g, ' - ')
      .replace(/\s*-\s*–\s*/g, ' - ')
      .replace(/_+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  },

  /**
   * Smart Filename Formatting Engine
   * Supported dynamic tokens: {title}, {quality}, {resolution}, {ext}, {date}, {time}, {site}
   */
  formatFilename(template, data = {}) {
    if (!template || typeof template !== 'string' || !template.trim()) {
      template = '{title}_{quality}.{ext}';
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');

    const cleanTitle = this.sanitizeTitle(data.title || data.filename || 'Downloaded_Media');
    const quality = (data.quality || 'HD').replace(/\s+/g, '');
    const resolution = (data.resolution || '1080p').replace(/\s+/g, '');
    let ext = (data.ext || 'mp4').toLowerCase().replace(/^\./, '');
    if (ext === 'm3u8') ext = 'mp4';
    const site = this.sanitizeTitle(data.site || data.domain || 'web').replace(/\s+/g, '_');

    let result = template
      .replace(/\{title\}/gi, cleanTitle)
      .replace(/\{quality\}/gi, quality)
      .replace(/\{resolution\}/gi, resolution)
      .replace(/\{ext\}/gi, ext)
      .replace(/\{date\}/gi, dateStr)
      .replace(/\{time\}/gi, timeStr)
      .replace(/\{site\}/gi, site);

    // If template didn't include extension, append it
    if (!result.toLowerCase().endsWith('.' + ext)) {
      result = `${result}.${ext}`;
    }

    // Clean any accidental duplicate underscores or illegal characters
    result = result
      .replace(/[\\/*?"<>|:]/g, '_')
      .replace(/__+/g, '_')
      .replace(/_+([.])/g, '$1')
      .trim();

    return result;
  },

  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return 'Stream / Unknown Size';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  },

  generateMediaId(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = (hash << 5) - hash + url.charCodeAt(i);
      hash |= 0;
    }
    return 'media_' + Math.abs(hash).toString(36);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaDetector;
} else if (typeof globalThis !== 'undefined') {
  globalThis.MediaDetector = MediaDetector;
}
