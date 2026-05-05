// MV3 service worker. Handles LLM calls so content script bypasses CORS / API key exposure.
import { PROMPTS } from './prompts.js';

// Non-sensitive settings sync across devices; the API key lives in local
// storage so it is not uploaded to Google's sync servers.
const SYNC_DEFAULTS = {
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-3-5-sonnet-latest',
  maxTokens: 1024,
};
const LOCAL_DEFAULTS = {
  apiKey: '',
};

const REQUEST_TIMEOUT_MS = 30_000;

// One-time migration: older builds wrote apiKey into chrome.storage.sync.
// Move any such key to local and scrub it from sync.
async function migrateApiKeyFromSync() {
  const sync = await chrome.storage.sync.get(['apiKey']);
  if (!sync.apiKey) return;
  const local = await chrome.storage.local.get(['apiKey']);
  if (!local.apiKey) {
    await chrome.storage.local.set({ apiKey: sync.apiKey });
  }
  await chrome.storage.sync.remove('apiKey');
}
migrateApiKeyFromSync().catch(() => {
  /* best-effort */
});

async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  return { ...SYNC_DEFAULTS, ...sync, ...LOCAL_DEFAULTS, ...local };
}

async function callAnthropic({ system, user }) {
  const s = await getSettings();
  if (!s.apiKey) {
    throw new Error('API key not set. Open extension options to configure.');
  }
  const url = `${s.baseUrl.replace(/\/+$/, '')}/v1/messages`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01',
        // Required for browser-origin requests on api.anthropic.com:
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: s.model,
        max_tokens: s.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Network error: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // Log full body to console for debugging; surface only a generic message
    // so we don't echo back any key/account info that gateways sometimes embed.
    console.warn('[x-helper] LLM error', resp.status, text);
    throw new Error(`LLM error ${resp.status} ${resp.statusText || ''}`.trim());
  }
  const data = await resp.json();
  // Anthropic response: { content: [{type:'text', text:'...'}], ... }
  const parts = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text);
  return parts.join('').trim();
}

function stripWrappingQuotes(s) {
  return s.replace(/^["“”'`\s]+|["“”'`\s]+$/g, '');
}

async function handlePolish({ text, context }) {
  const out = await callAnthropic({
    system: PROMPTS.polish.system,
    user: PROMPTS.polish.user(text, context),
  });
  return stripWrappingQuotes(out);
}

function parseSuggestions(out) {
  // Primary format: 3 replies separated by lines of "===".
  const byDelim = out
    .split(/^\s*={3,}\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byDelim.length >= 2) return byDelim.slice(0, 3);

  // Fallback 1: a clean JSON array.
  try {
    const arr = JSON.parse(out);
    if (Array.isArray(arr) && arr.length) return arr.map(String).slice(0, 3);
  } catch {
    /* ignore */
  }

  // Fallback 2: extract quoted strings (handles JSON-ish output even with bad escaping).
  const quoted = [...out.matchAll(/"((?:[^"\\]|\\.){10,})"/g)].map((m) => m[1]);
  if (quoted.length >= 2) return quoted.slice(0, 3);

  // Fallback 3: numbered or bulleted lines.
  const lines = out
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 0 && !/^={3,}$/.test(l));
  return lines.slice(0, 3);
}

async function handleSuggest({ tweet, hint }) {
  const out = await callAnthropic({
    system: PROMPTS.suggest.system,
    user: PROMPTS.suggest.user(tweet, hint),
  });
  const arr = parseSuggestions(out);
  return arr.map(stripWrappingQuotes).filter(Boolean).slice(0, 3);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'polish') {
        sendResponse({ ok: true, text: await handlePolish(msg.payload) });
      } else if (msg?.type === 'suggest') {
        sendResponse({ ok: true, suggestions: await handleSuggest(msg.payload) });
      } else if (msg?.type === 'ping') {
        sendResponse({ ok: true, settings: await getSettings() });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // keep channel open for async response
});
