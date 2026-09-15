/**
 * Unit Tests for MediaDetector
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const MediaDetector = require('../lib/media_detector.js');

describe('MediaDetector.isMediaMime', () => {
  test('correctly identifies video and audio MIME types', () => {
    assert.equal(MediaDetector.isMediaMime('video/mp4'), true);
    assert.equal(MediaDetector.isMediaMime('video/webm; codecs="vp9"'), true);
    assert.equal(MediaDetector.isMediaMime('audio/mpeg'), true);
    assert.equal(MediaDetector.isMediaMime('audio/mp4'), true);
    assert.equal(MediaDetector.isMediaMime('application/vnd.apple.mpegurl'), true);
    assert.equal(MediaDetector.isMediaMime('application/x-mpegurl'), true);
    assert.equal(MediaDetector.isMediaMime('application/dash+xml'), true);
  });

  test('rejects non-media MIME types', () => {
    assert.equal(MediaDetector.isMediaMime('text/html'), false);
    assert.equal(MediaDetector.isMediaMime('application/json'), false);
    assert.equal(MediaDetector.isMediaMime('image/png'), false);
    assert.equal(MediaDetector.isMediaMime('application/octet-stream'), false);
    assert.equal(MediaDetector.isMediaMime(''), false);
    assert.equal(MediaDetector.isMediaMime(null), false);
  });
});

describe('MediaDetector.inspectMedia', () => {
  test('detects direct MP4 video from URL and headers', () => {
    const media = MediaDetector.inspectMedia('https://example.com/assets/trailer.mp4', {
      'content-type': 'video/mp4',
      'content-length': '15728640'
    }, 'Big Buck Bunny Trailer');

    assert.ok(media);
    assert.equal(media.ext, 'mp4');
    assert.equal(media.type, 'video');
    assert.equal(media.protocol, 'HTTP');
    assert.equal(media.size, 15728640);
    assert.equal(media.filename, 'trailer.mp4');
  });

  test('detects HLS stream and sets protocol to HLS', () => {
    const media = MediaDetector.inspectMedia('https://cdn.example.com/video/master.m3u8', {
      'content-type': 'application/vnd.apple.mpegurl'
    }, 'Nature Documentary 2026');

    assert.ok(media);
    assert.equal(media.ext, 'm3u8');
    assert.equal(media.type, 'stream');
    assert.equal(media.protocol, 'HLS');
    // Generic name master.m3u8 should be replaced with clean page title
    assert.equal(media.filename, 'Nature Documentary 2026.mp4');
  });

  test('filters out noise and dummy canvas recordings', () => {
    const media = MediaDetector.inspectMedia('blob:https://example.com/screenshare-rec-1234.webm', {}, 'Meeting', {
      duration: 1
    });
    assert.equal(media, null);
  });
});

describe('MediaDetector.sanitizeTitle', () => {
  test('strips illegal filename characters for cross-platform safety', () => {
    const raw = 'Movie: Episode 1 / The Beginning? *Special Edition* <Director\'s Cut> | 2026';
    const clean = MediaDetector.sanitizeTitle(raw);
    assert.equal(clean.includes(':'), false);
    assert.equal(clean.includes('/'), false);
    assert.equal(clean.includes('?'), false);
    assert.equal(clean.includes('*'), false);
    assert.equal(clean.includes('<'), false);
    assert.equal(clean.includes('>'), false);
    assert.equal(clean.includes('|'), false);
  });
});

describe('MediaDetector.formatFilename (Smart Template Engine)', () => {
  test('substitutes dynamic tokens correctly', () => {
    const template = '{title}_{quality}_{date}.{ext}';
    const data = {
      title: 'Interstellar',
      quality: '1080p',
      resolution: '1920x1080',
      ext: 'mp4'
    };

    const formatted = MediaDetector.formatFilename(template, data);
    const dateStr = new Date().toISOString().slice(0, 10);
    assert.equal(formatted, `Interstellar_1080p_${dateStr}.mp4`);
  });

  test('appends extension if omitted from template', () => {
    const template = 'Video_{title}_{resolution}';
    const data = {
      title: 'Concert',
      resolution: '720p',
      ext: 'm4a'
    };

    const formatted = MediaDetector.formatFilename(template, data);
    assert.equal(formatted, 'Video_Concert_720p.m4a');
  });
});
