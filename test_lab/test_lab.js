/**
 * Test Lab Controller - Dynamic Media Fetching & Stream Testing
 */

document.addEventListener('DOMContentLoaded', () => {
  const dynamicStatus = document.getElementById('dynamicStatus');

  // Fetch MP4 via AJAX / Fetch
  document.getElementById('btnFetchMp4').addEventListener('click', async () => {
    dynamicStatus.textContent = 'Fetching dynamic MP4 headers...';
    try {
      const url = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4';
      const res = await fetch(url, { method: 'HEAD' });
      dynamicStatus.innerHTML = `✅ Successfully fetched MP4 headers (HTTP ${res.status}). Extension background sniffer should detect <code>TearsOfSteel.mp4</code>.`;
    } catch (err) {
      dynamicStatus.textContent = 'Error: ' + err.message;
    }
  });

  // Fetch MP3 via AJAX / Fetch
  document.getElementById('btnFetchMp3').addEventListener('click', async () => {
    dynamicStatus.textContent = 'Fetching dynamic MP3 stream...';
    try {
      const url = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3';
      const res = await fetch(url, { method: 'HEAD' });
      dynamicStatus.innerHTML = `✅ Successfully fetched MP3 headers (HTTP ${res.status}). Extension should detect <code>SoundHelix-Song-3.mp3</code>.`;
    } catch (err) {
      dynamicStatus.textContent = 'Error: ' + err.message;
    }
  });

  // Trigger HLS Stream Ping
  document.getElementById('btnTriggerHlsTest').addEventListener('click', async () => {
    dynamicStatus.textContent = 'Requesting HLS Master Playlist...';
    try {
      const url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
      const res = await fetch(url);
      if (res.ok) {
        dynamicStatus.innerHTML = `✅ Fetched HLS Master Playlist. Check MediaGrabber PRO for <code>x36xhzz.m3u8</code>!`;
      } else {
        dynamicStatus.textContent = `HTTP ${res.status}`;
      }
    } catch (err) {
      dynamicStatus.textContent = 'HLS fetch error: ' + err.message;
    }
  });

  // Trigger Generic index.m3u8 Ping (tests automatic page title resolution)
  const btnGenericHls = document.getElementById('btnTriggerGenericHls');
  if (btnGenericHls) {
    btnGenericHls.addEventListener('click', async () => {
      dynamicStatus.textContent = 'Requesting generic index.m3u8 playlist...';
      try {
        const url = 'https://multiplatform-f.akamaihd.net/i/multi/will/bunny/big_buck_bunny_,640x360_400,640x360_700,960x540_1000,1280x720_1500,1920x1080_2500,.f4m.csmil/index.m3u8';
        await fetch(url, { method: 'HEAD' });
        dynamicStatus.innerHTML = '✅ Fetched generic <code>index.m3u8</code>. Open MediaGrabber PRO: it should automatically name it <strong>MediaGrabber PRO - Test Laboratory.mp4</strong> instead of <code>index.mp4</code>!';
      } catch (e) {
        dynamicStatus.textContent = 'Error: ' + e.message;
      }
    });
  }
});
