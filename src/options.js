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

async function save() {
  const data = {
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    maxTokens: parseInt($('maxTokens').value, 10) || DEFAULTS.maxTokens,
  };
  await chrome.storage.sync.set(data);
  showStatus('Saved ✓', false);
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
    await save();
    test();
  });
  document.querySelectorAll('.presets button').forEach((b) => {
    b.addEventListener('click', () => {
      $('baseUrl').value = b.dataset.preset;
    });
  });
});
