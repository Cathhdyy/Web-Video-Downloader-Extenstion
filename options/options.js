/**
 * Options Controller - User Settings & Preferences
 */

const DEFAULT_SETTINGS = {
  minSizeThreshold: 50, // in KB
  captureHLS: true,
  autoBadgeCount: true,
  mediaNamingRule: 'title_quality',
  defaultSaveAs: false
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
});

async function loadSettings() {
  const data = await chrome.storage.local.get('settings');
  const settings = data.settings || DEFAULT_SETTINGS;

  document.getElementById('minSizeThreshold').value = Math.round((settings.minSizeThreshold || 50 * 1024) / 1024);
  document.getElementById('captureHLS').checked = settings.captureHLS !== false;
  document.getElementById('autoBadgeCount').checked = settings.autoBadgeCount !== false;
  document.getElementById('mediaNamingRule').value = settings.mediaNamingRule || 'title_quality';
  document.getElementById('defaultSaveAs').checked = Boolean(settings.defaultSaveAs);
}

function setupEventListeners() {
  // Save Settings
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const minSizeKB = parseInt(document.getElementById('minSizeThreshold').value, 10) || 50;
    const settings = {
      minSizeThreshold: minSizeKB * 1024,
      captureHLS: document.getElementById('captureHLS').checked,
      autoBadgeCount: document.getElementById('autoBadgeCount').checked,
      mediaNamingRule: document.getElementById('mediaNamingRule').value,
      defaultSaveAs: document.getElementById('defaultSaveAs').checked
    };

    await chrome.storage.local.set({ settings });
    showToast('Settings saved successfully! ✨');
  });

  // Reset to Defaults
  document.getElementById('btnResetDefaults').addEventListener('click', async () => {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    await loadSettings();
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
