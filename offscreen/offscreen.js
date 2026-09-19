/**
 * MediaGrabber PRO - Offscreen Transmuxer & Background Downloader Worker
 * Runs inside chrome.offscreen context to ensure stream downloads and mux.js
 * transmuxing continue running seamlessly even when popup is closed by the user.
 */

const activeDownloaders = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'OFFSCREEN_PING': {
      sendResponse({
        status: 'alive',
        activeCount: activeDownloaders.size,
        jobs: Array.from(activeDownloaders.keys())
      });
      break;
    }

    case 'START_OFFSCREEN_JOB': {
      const { jobId, media, format, tabId, pageUrl, referer, origin, saveAs, filename, concurrency } = request;
      if (!jobId || !media || !media.url) {
        sendResponse({ success: false, error: 'Invalid job parameters' });
        return false;
      }

      handleStartJob({ jobId, media, format, tabId, pageUrl, referer, origin, saveAs, filename, concurrency });
      sendResponse({ success: true, jobId });
      break;
    }

    case 'CANCEL_OFFSCREEN_JOB': {
      const { jobId } = request;
      if (jobId && activeDownloaders.has(jobId)) {
        const downloader = activeDownloaders.get(jobId);
        downloader.cancel();
        activeDownloaders.delete(jobId);
        chrome.runtime.sendMessage({
          action: 'JOB_CANCELLED',
          jobId
        }).catch(() => {});
        sendResponse({ success: true, jobId });
      } else {
        sendResponse({ success: false, error: 'Job not found' });
      }
      break;
    }

    default:
      break;
  }

  return true;
});

async function handleStartJob({ jobId, media, format, tabId, pageUrl, referer, origin, saveAs, filename, concurrency }) {
  const isAudio = format === 'm4a' || format === 'mp3' || media.targetContainer === 'm4a' || media.targetContainer === 'mp3';
  const targetExt = isAudio ? 'm4a' : 'mp4';

  let cleanFilename = filename || media.filename || 'download.mp4';
  if (!cleanFilename.toLowerCase().endsWith('.' + targetExt)) {
    cleanFilename = cleanFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.' + targetExt;
  }

  let effectiveOrigin = origin || media.origin || '';
  const effectiveReferer = referer || media.referer || pageUrl || '';
  if (!effectiveOrigin && effectiveReferer && effectiveReferer.startsWith('http')) {
    try {
      effectiveOrigin = new URL(effectiveReferer).origin;
    } catch (e) {}
  }

  const downloader = new HLSDownloader({
    concurrency: concurrency || 4,
    tabId: tabId || null,
    pageUrl: pageUrl || media.pageUrl || '',
    referer: effectiveReferer,
    origin: effectiveOrigin,
    selectedVariantUrl: media.selectedVariantUrl || null
  });

  activeDownloaders.set(jobId, downloader);

  const onProgress = (progress) => {
    chrome.runtime.sendMessage({
      action: 'JOB_PROGRESS_UPDATE',
      jobId,
      progress: {
        percent: progress.percent || 0,
        text: progress.text || '',
        status: progress.status || 'downloading',
        speed: progress.speed || '',
        eta: progress.eta || '',
        completed: progress.completed || 0,
        total: progress.total || 0,
        bytesDownloaded: progress.bytesDownloaded || 0
      }
    }).catch(() => {});
  };

  try {
    let result;
    if (isAudio) {
      result = await downloader.downloadAndExtractAudio(media.url, onProgress);
    } else {
      result = await downloader.downloadAndConvertToMp4(media.url, onProgress);
    }

    const finalExt = result.ext || targetExt;
    if (!cleanFilename.toLowerCase().endsWith('.' + finalExt)) {
      cleanFilename = cleanFilename.replace(/\.[a-zA-Z0-9]+$/, '') + '.' + finalExt;
    }

    const blobUrl = URL.createObjectURL(result.blob);

    activeDownloaders.delete(jobId);

    // Delegate download to background service worker (chrome.downloads is not available in offscreen documents)
    chrome.runtime.sendMessage({
      action: 'OFFSCREEN_JOB_FINISHED',
      jobId,
      blobUrl,
      filename: cleanFilename,
      saveAs: Boolean(saveAs)
    }).catch((sendErr) => {
      console.error('[Offscreen] Failed to notify background of job completion:', sendErr);
    });

    // Revoke object URL after 2 minutes to allow download manager to finish saving to disk
    setTimeout(() => {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (e) {}
    }, 120000);

  } catch (err) {
    activeDownloaders.delete(jobId);
    const isCancelled = err.name === 'AbortError' || (err.message && err.message.includes('cancelled'));

    if (isCancelled) {
      chrome.runtime.sendMessage({
        action: 'JOB_CANCELLED',
        jobId
      }).catch(() => {});
    } else {
      console.error('[Offscreen] Job execution error:', err);
      chrome.runtime.sendMessage({
        action: 'JOB_ERROR',
        jobId,
        error: err.message || 'Stream processing failed'
      }).catch(() => {});
    }
  }
}
