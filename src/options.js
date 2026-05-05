// Mirror the split in background.js: sync for non-sensitive settings,
// local for the API key (so it's never uploaded to Google sync).
const SYNC_DEFAULTS = {
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-3-5-sonnet-latest',
  maxTokens: 1024,
};
const LOCAL_DEFAULTS = {
  apiKey: '',
};

const $ = (id) => document.getElementById(id);

async function load() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  // Tolerate older installs where apiKey may still live in sync.
  $('baseUrl').value = sync.baseUrl || SYNC_DEFAULTS.baseUrl;
  $('apiKey').value = local.apiKey || sync.apiKey || '';
  $('model').value = sync.model || SYNC_DEFAULTS.model;
  $('maxTokens').value = sync.maxTokens || SYNC_DEFAULTS.maxTokens;
}

// Convert a base URL to a host-permission origin pattern.
// e.g. "https://api.deepseek.com/anthropic" -> "https://api.deepseek.com/*"
function originPatternFor(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

// Ensure we hold host permission for the configured base URL.
// Returns true on success, false if user declined.
async function ensureHostPermission(baseUrl) {
  const origin = originPatternFor(baseUrl);
  if (!origin) return false;
  // api.anthropic.com is already in manifest.host_permissions; skip prompt.
  if (origin === 'https://api.anthropic.com/*') return true;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return await chrome.permissions.request({ origins: [origin] });
}

async function save() {
  const baseUrl = $('baseUrl').value.trim() || SYNC_DEFAULTS.baseUrl;
  const granted = await ensureHostPermission(baseUrl);
  if (!granted) {
    showStatus('Permission for that host was denied. Cannot call the API.', true);
    return false;
  }
  const syncData = {
    baseUrl,
    model: $('model').value.trim() || SYNC_DEFAULTS.model,
    maxTokens: parseInt($('maxTokens').value, 10) || SYNC_DEFAULTS.maxTokens,
  };
  const localData = {
    apiKey: $('apiKey').value.trim(),
  };
  await Promise.all([
    chrome.storage.sync.set(syncData),
    chrome.storage.local.set(localData),
    // Scrub any legacy apiKey from sync (older installs wrote it there).
    chrome.storage.sync.remove('apiKey').catch(() => {}),
  ]);
  showStatus('Saved ✓', false);
  return true;
}

function showStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

async function test() {
  showStatus('Testing…', false);
  // Use the polish handler with a tiny input as smoke test.
  chrome.runtime.sendMessage(
    { type: 'polish', payload: { text: 'hello world', context: '' } },
    (res) => {
      if (chrome.runtime.lastError) {
        showStatus('Error: ' + chrome.runtime.lastError.message, true);
        return;
      }
      if (!res?.ok) {
        showStatus('Error: ' + (res?.error || 'unknown'), true);
        return;
      }
      showStatus('OK ✓ Sample reply: ' + res.text, false);
    },
  );
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', async () => {
    const ok = await save();
    if (ok) test();
  });
  document.querySelectorAll('.presets button').forEach((b) => {
    b.addEventListener('click', () => {
      $('baseUrl').value = b.dataset.preset;
    });
  });
});
