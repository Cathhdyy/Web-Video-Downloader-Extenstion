/**
 * Unit Tests for HLSDownloader
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const HLSDownloader = require('../lib/hls_downloader.js');

describe('HLSDownloader.parseM3U8', () => {
  const downloader = new HLSDownloader();

  test('parses master playlist with dynamic qualities and bitrates', () => {
    const masterPlaylist = `
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2"
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
480p/playlist.m3u8
    `;

    const parsed = downloader.parseM3U8(masterPlaylist, 'https://stream.example.com/hls/master.m3u8');
    assert.equal(parsed.isMaster, true);
    assert.equal(parsed.variants.length, 3);

    const v1080 = parsed.variants[0];
    assert.equal(v1080.resolution, '1920x1080');
    assert.equal(v1080.qualityTag, '1080p FHD');
    assert.equal(v1080.bitrate, '5.0 Mbps');
    assert.equal(v1080.url, 'https://stream.example.com/hls/1080p/playlist.m3u8');

    const v720 = parsed.variants[1];
    assert.equal(v720.resolution, '1280x720');
    assert.equal(v720.qualityTag, '720p HD');
    assert.equal(v720.bitrate, '2.5 Mbps');

    const v480 = parsed.variants[2];
    assert.equal(v480.resolution, '854x480');
    assert.equal(v480.qualityTag, '480p SD');
    assert.equal(v480.bitrate, '800 kbps');
  });

  test('parses media playlist with segments and duration calculation', () => {
    const mediaPlaylist = `
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:9.009,
segment100.ts
#EXTINF:9.009,
segment101.ts
#EXTINF:8.5,
segment102.ts
#EXT-X-ENDLIST
    `;

    const parsed = downloader.parseM3U8(mediaPlaylist, 'https://stream.example.com/hls/720p/playlist.m3u8');
    assert.equal(parsed.isMaster, false);
    assert.equal(parsed.segmentCount, 3);
    assert.equal(parsed.segments.length, 3);
    assert.ok(Math.abs(parsed.totalDuration - 26.518) < 0.01);
    assert.equal(parsed.segments[0].seq, 100);
    assert.equal(parsed.segments[1].seq, 101);
    assert.equal(parsed.segments[2].seq, 102);
  });

  test('parses AES-128 encryption keys and IV from playlist', () => {
    const encryptedPlaylist = `
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="https://auth.example.com/keys/video1.key",IV=0x0123456789abcdef0123456789abcdef
#EXTINF:10.0,
chunk_001.ts
#EXTINF:10.0,
chunk_002.ts
#EXT-X-ENDLIST
    `;

    const parsed = downloader.parseM3U8(encryptedPlaylist, 'https://cdn.example.com/enc/playlist.m3u8');
    assert.equal(parsed.isMaster, false);
    assert.equal(parsed.hasEncryption, true);
    assert.equal(parsed.segments.length, 2);

    const seg1 = parsed.segments[0];
    assert.ok(seg1.key);
    assert.equal(seg1.key.method, 'AES-128');
    assert.equal(seg1.key.uri, 'https://auth.example.com/keys/video1.key');
    assert.equal(seg1.key.ivHex, '0123456789abcdef0123456789abcdef');
  });

  test('resolves relative URLs and preserves security auth query tokens', () => {
    const baseUrl = 'https://cdn.stream.tv/live/channel1/playlist.m3u8?token=xyz123&exp=99999999';
    const relativeChunk = 'seg_45.ts';

    const resolved = downloader.resolveUrl(baseUrl, relativeChunk);
    assert.equal(resolved, 'https://cdn.stream.tv/live/channel1/seg_45.ts?token=xyz123&exp=99999999');
  });
});
