/**
 * Options Controller - User Settings & Preferences
 */

const DEFAULT_SETTINGS = {
  minSizeThreshold: 50, // in KB
  captureHLS: true,
  autoBadgeCount: true,
  mediaNamingRule: 'title_quality',
  filenameTemplate: '{title}_{quality}.{ext}',
  downloadConcurrency: 4,
  defaultSaveAs: false
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  updateFilenamePreview();
});

async function loadSettings() {
  const data = await chrome.storage.local.get('settings');
  const settings = data.settings || DEFAULT_SETTINGS;

  document.getElementById('minSizeThreshold').value = Math.round((settings.minSizeThreshold || 50 * 1024) / 1024);
  document.getElementById('captureHLS').checked = settings.captureHLS !== false;
  document.getElementById('autoBadgeCount').checked = settings.autoBadgeCount !== false;
  document.getElementById('mediaNamingRule').value = settings.mediaNamingRule || 'title_quality';
  document.getElementById('filenameTemplate').value = settings.filenameTemplate || '{title}_{quality}.{ext}';
  document.getElementById('downloadConcurrency').value = String(settings.downloadConcurrency || 4);
  document.getElementById('defaultSaveAs').checked = Boolean(settings.defaultSaveAs);
}

function updateFilenamePreview() {
  const tpl = document.getElementById('filenameTemplate').value || '{title}_{quality}.{ext}';
  const previewEl = document.getElementById('templateLivePreview');
  if (!previewEl) return;

  const now = new Date();
  const sampleData = {
    title: 'Inception_2010',
    quality: '1080p_FHD',
    resolution: '1920x1080',
    ext: 'mp4',
    site: 'streamweb'
  };

  let result = tpl
    .replace(/\{title\}/gi, sampleData.title)
    .replace(/\{quality\}/gi, sampleData.quality)
    .replace(/\{resolution\}/gi, sampleData.resolution)
    .replace(/\{ext\}/gi, sampleData.ext)
    .replace(/\{date\}/gi, now.toISOString().slice(0, 10))
    .replace(/\{time\}/gi, now.toTimeString().slice(0, 8).replace(/:/g, '-'))
    .replace(/\{site\}/gi, sampleData.site);

  if (!result.toLowerCase().endsWith('.mp4')) result += '.mp4';
  previewEl.textContent = result;
}

function setupEventListeners() {
  // Live input event for filename template preview
  document.getElementById('filenameTemplate').addEventListener('input', updateFilenamePreview);

  // Save Settings
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const minSizeKB = parseInt(document.getElementById('minSizeThreshold').value, 10) || 50;
    const settings = {
      minSizeThreshold: minSizeKB * 1024,
      captureHLS: document.getElementById('captureHLS').checked,
      autoBadgeCount: document.getElementById('autoBadgeCount').checked,
      mediaNamingRule: document.getElementById('mediaNamingRule').value,
      filenameTemplate: document.getElementById('filenameTemplate').value || '{title}_{quality}.{ext}',
      downloadConcurrency: parseInt(document.getElementById('downloadConcurrency').value, 10) || 4,
      defaultSaveAs: document.getElementById('defaultSaveAs').checked
    };

    await chrome.storage.local.set({ settings });
    showToast('Settings saved successfully! ✨');
  });

  // Reset to Defaults
  document.getElementById('btnResetDefaults').addEventListener('click', async () => {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    await loadSettings();
    updateFilenamePreview();
    showToast('Settings reset to defaults.');
  });

  // Link to Test Lab
  document.getElementById('linkTestLab').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('test_lab/test_lab.html') });
  });
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}
