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

  test('parses EXT-X-BYTERANGE with explicit and implicit offsets', () => {
    const byteRangePlaylist = `
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
#EXT-X-BYTERANGE:500000@0
video.mp4
#EXTINF:10.0,
#EXT-X-BYTERANGE:450000
video.mp4
#EXTINF:10.0,
#EXT-X-BYTERANGE:600000@1200000
video.mp4
#EXT-X-ENDLIST
    `;

    const parsed = downloader.parseM3U8(byteRangePlaylist, 'https://cdn.example.com/hls/playlist.m3u8');
    assert.equal(parsed.isMaster, false);
    assert.equal(parsed.segments.length, 3);

    // Segment 1: explicit offset 0, length 500000
    assert.deepEqual(parsed.segments[0].byteRange, { offset: 0, length: 500000 });

    // Segment 2: implicit offset (0 + 500000 = 500000), length 450000
    assert.deepEqual(parsed.segments[1].byteRange, { offset: 500000, length: 450000 });

    // Segment 3: explicit offset 1200000, length 600000
    assert.deepEqual(parsed.segments[2].byteRange, { offset: 1200000, length: 600000 });
  });

  test('parses EXT-X-MAP with BYTERANGE and detects fMP4 stream', () => {
    const fmp4Playlist = `
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4",BYTERANGE="1234@0"
#EXTINF:6.0,
segment1.m4s
#EXTINF:6.0,
segment2.m4s
#EXT-X-ENDLIST
    `;

    const parsed = downloader.parseM3U8(fmp4Playlist, 'https://cdn.example.com/cmaf/playlist.m3u8');
    assert.equal(parsed.isMaster, false);
    assert.equal(parsed.isFmp4, true);
    assert.equal(parsed.segments.length, 3);

    const initSeg = parsed.segments[0];
    assert.equal(initSeg.isInitSegment, true);
    assert.equal(initSeg.url, 'https://cdn.example.com/cmaf/init.mp4');
    assert.deepEqual(initSeg.byteRange, { offset: 0, length: 1234 });
  });

  test('parses EXT-X-MEDIA:TYPE=AUDIO and links to variant stream', () => {
    const masterWithAudio = `
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="Spanish",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="es",URI="audio/es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="audio-aac"
video/1080p.m3u8
    `;

    const parsed = downloader.parseM3U8(masterWithAudio, 'https://cdn.example.com/stream/master.m3u8');
    assert.equal(parsed.isMaster, true);
    assert.equal(parsed.audioTracks.length, 2);
    assert.equal(parsed.audioTracks[0].name, 'English');
    assert.equal(parsed.audioTracks[0].isDefault, true);
    assert.equal(parsed.audioTracks[0].url, 'https://cdn.example.com/stream/audio/en.m3u8');
    assert.equal(parsed.audioTracks[1].name, 'Spanish');
    assert.equal(parsed.audioTracks[1].url, 'https://cdn.example.com/stream/audio/es.m3u8');

    assert.equal(parsed.variants.length, 1);
    assert.equal(parsed.variants[0].audioUrl, 'https://cdn.example.com/stream/audio/en.m3u8');
  });
});

describe('HLSDownloader.transmuxTsToMp4', () => {
  const downloader = new HLSDownloader();

  test('falls back gracefully to TS container with correct mime type when mux.js is unavailable or empty', async () => {
    const dummyChunk = new Uint8Array([0x47, 0x00, 0x10, 0x00]);
    const result = await downloader.transmuxTsToMp4([dummyChunk.buffer]);
    assert.ok(result);
    assert.equal(result.format, 'ts');
    assert.equal(result.ext, 'ts');
    assert.equal(result.mimeType, 'video/mp2t');
    assert.ok(result.blob);
  });

  test('preserves fMP4 stream without modifying boxes', async () => {
    const fmp4Downloader = new HLSDownloader();
    fmp4Downloader.isFmp4 = true;
    const dummyChunk = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // ftyp header
    const result = await fmp4Downloader.transmuxTsToMp4([dummyChunk.buffer]);
    assert.equal(result.format, 'mp4');
    assert.equal(result.ext, 'mp4');
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.blob.size, dummyChunk.buffer.byteLength);
  });

  test('patchMp4Duration fixes 13:15:21 duration bug to exact seconds in mvhd/tkhd/mdhd', () => {
    // Build a mock moov container with mvhd, tkhd, mdhd having 4294967295 duration
    const mvhd = [
      0x00, 0x00, 0x00, 28,   // size 28
      0x6D, 0x76, 0x68, 0x64, // 'mvhd'
      0x00, 0x00, 0x00, 0x00, // v0 + flags
      0x00, 0x00, 0x00, 0x01, // ctime
      0x00, 0x00, 0x00, 0x02, // mtime
      0x00, 0x01, 0x5F, 0x90, // timescale 90000
      0xFF, 0xFF, 0xFF, 0xFF  // duration 4294967295 (13:15:21 bug)
    ];

    const tkhd = [
      0x00, 0x00, 0x00, 32,   // size 32
      0x74, 0x6B, 0x68, 0x64, // 'tkhd'
      0x00, 0x00, 0x00, 0x07, // v0 + flags
      0x00, 0x00, 0x00, 0x00, // ctime
      0x00, 0x00, 0x00, 0x00, // mtime
      0x00, 0x00, 0x00, 0x01, // trackId 1
      0x00, 0x00, 0x00, 0x00, // reserved
      0xFF, 0xFF, 0xFF, 0xFF  // duration 4294967295
    ];

    const mdhd = [
      0x00, 0x00, 0x00, 28,   // size 28
      0x6D, 0x64, 0x68, 0x64, // 'mdhd'
      0x00, 0x00, 0x00, 0x00, // v0 + flags
      0x00, 0x00, 0x00, 0x01, // ctime
      0x00, 0x00, 0x00, 0x02, // mtime
      0x00, 0x01, 0x5F, 0x90, // timescale 90000
      0xFF, 0xFF, 0xFF, 0xFF  // duration 4294967295
    ];

    const mdia = [
      0x00, 0x00, 0x00, 8 + mdhd.length,
      0x6D, 0x64, 0x69, 0x61, // 'mdia'
      ...mdhd
    ];

    const trak = [
      0x00, 0x00, 0x00, 8 + tkhd.length + mdia.length,
      0x74, 0x72, 0x61, 0x6B, // 'trak'
      ...tkhd,
      ...mdia
    ];

    const moov = [
      0x00, 0x00, 0x00, 8 + mvhd.length + trak.length,
      0x6D, 0x6F, 0x6F, 0x76, // 'moov'
      ...mvhd,
      ...trak
    ];

    const buf = new Uint8Array(moov);
    const targetDurationSec = 192; // 00:03:12 (matches Video DownloadHelper exactly)
    downloader.patchMp4Duration(buf, targetDurationSec);

    const view = new DataView(buf.buffer);
    const mvhdDuration = view.getUint32(8 + 8 + 16);
    assert.equal(mvhdDuration, 192 * 90000); // 17,280,000

    const tkhdDuration = view.getUint32(8 + mvhd.length + 8 + 8 + 20);
    assert.equal(tkhdDuration, 192 * 90000);

    const mdhdDuration = view.getUint32(8 + mvhd.length + 8 + tkhd.length + 8 + 8 + 16);
    assert.equal(mdhdDuration, 192 * 90000);
  });

  test('mux.js correctly delimits frames and creates multiple samples when stream omits AUDs', () => {
    const muxjs = require('../lib/mux.min.js');
    const track = {
      timelineStartInfo: { pts: 0, dts: 0, baseMediaDecodeTime: 0 },
      sps: [new Uint8Array([0x67, 0x42, 0x00, 0x1E])],
      pps: [new Uint8Array([0x68, 0xCE, 0x38, 0x80])]
    };
    const vStream = new muxjs.mp4.VideoSegmentStream(track);

    let output = null;
    vStream.on('data', d => { output = d; });

    // Stream with SPS, PPS, IDR slice, and 2 P-frame slices WITHOUT any AUD (type 9)
    const nalsWithoutAud = [
      { nalUnitTypeCode: 7, nalUnitType: 'seq_parameter_set_rbsp', data: new Uint8Array([0x67, 0x42, 0x00, 0x1E]), config: { width: 404, height: 720 }, pts: 0, dts: 0 },
      { nalUnitTypeCode: 8, nalUnitType: 'pic_parameter_set_rbsp', data: new Uint8Array([0x68, 0xCE, 0x38, 0x80]), pts: 0, dts: 0 },
      { nalUnitTypeCode: 5, nalUnitType: 'slice_layer_without_partitioning_rbsp_idr', data: new Uint8Array([0x65, 0x88, 0x80]), pts: 0, dts: 0 }, // IDR, first_mb=0
      { nalUnitTypeCode: 1, data: new Uint8Array([0x41, 0x9A, 0x00]), pts: 3000, dts: 3000 }, // non-IDR, first_mb=0
      { nalUnitTypeCode: 1, data: new Uint8Array([0x41, 0x9A, 0x00]), pts: 6000, dts: 6000 }  // non-IDR, first_mb=0
    ];

    nalsWithoutAud.forEach(nal => vStream.push(nal));
    vStream.flush();

    assert.ok(output);
    assert.ok(output.track.samples);
    // Previously, without AUD, all NALs were discarded or merged into 1 corrupt frame
    // Now, samples.length MUST be 3!
    assert.equal(output.track.samples.length, 3);
    assert.equal(output.track.samples[0].duration, 3000);
    assert.equal(output.track.samples[1].duration, 3000);
    assert.equal(output.track.samples[2].duration, 3000);
  });
});



