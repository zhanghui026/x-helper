const DEFAULTS = {
  baseUrl: 'https://api.anthropic.com',
  apiKey: '',
  model: 'claude-3-5-sonnet-latest',
  maxTokens: 1024,
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('baseUrl').value = s.baseUrl || DEFAULTS.baseUrl;
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || DEFAULTS.model;
  $('maxTokens').value = s.maxTokens || DEFAULTS.maxTokens;
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
  const baseUrl = $('baseUrl').value.trim() || DEFAULTS.baseUrl;
  const granted = await ensureHostPermission(baseUrl);
  if (!granted) {
    showStatus('Permission for that host was denied. Cannot call the API.', true);
    return false;
  }
  const data = {
    baseUrl,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    maxTokens: parseInt($('maxTokens').value, 10) || DEFAULTS.maxTokens,
  };
  await chrome.storage.sync.set(data);
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
    }
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
