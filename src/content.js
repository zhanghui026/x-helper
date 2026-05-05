// X Helper content script.
// Injects a small toolbar next to X compose / reply boxes with Polish & Suggest buttons.

(() => {
  const TOOLBAR_CLASS = 'xh-toolbar';
  const ATTACHED_FLAG = 'data-xh-attached';

  // ---------- helpers ----------
  function $$(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function getEditorText(editor) {
    // X uses Draft.js; plain text content is sufficient for our prompts.
    return (editor.innerText || '').trim();
  }

  // Copy text to the system clipboard. Used as a reliable fallback because
  // X's Draft.js editor is hostile to programmatic content replacement.
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback: temporary textarea + execCommand('copy')
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  // Replace the editor contents via a synthetic paste event. Draft.js (X's
  // editor) ignores raw DOM mutation but accepts paste because its onPaste
  // calls Modifier.replaceText, which atomically updates both ContentState
  // and SelectionState in one EditorState push.
  function tryInsertText(editor, text) {
    return new Promise((resolve) => {
      try {
        editor.focus();
        const before = editor.innerText || '';
        // selectAll updates the DOM selection synchronously, but Draft's
        // own SelectionState is updated asynchronously via React's setState
        // in response to the selectionchange event. If we dispatch paste
        // immediately, Draft's onPaste reads its PRE-selectAll
        // SelectionState — a collapsed cursor at the end of existing
        // content — and the paste appends instead of replaces.
        //
        // Wait two rAFs (one for React to schedule, one to commit) so the
        // SelectionState catches up to "all selected" before paste runs.
        document.execCommand('selectAll');
        const afterReactCommit = (cb) => requestAnimationFrame(() => requestAnimationFrame(cb));
        afterReactCommit(() => {
          try {
            // Synthetic paste — Draft's onPaste calls Modifier.replaceText,
            // which atomically sets ContentState (new text) AND
            // SelectionState (collapsed at end of inserted content) in one
            // EditorState push. No post-insert lag, so immediate Backspace
            // / arrow keys work right away.
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            editor.dispatchEvent(
              new ClipboardEvent('paste', {
                clipboardData: dt,
                bubbles: true,
                cancelable: true,
              }),
            );
            requestAnimationFrame(() => {
              const after = editor.innerText || '';
              resolve(after !== before && after.includes(text.slice(0, Math.min(20, text.length))));
            });
          } catch {
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
  }

  // Deliver text to the editor. Returns:
  //   'inserted' — text is in the editor, user can post directly
  //   'copied'   — clipboard set, user must press ⌘V
  //   'failed'   — neither worked
  async function setEditorText(editor, text) {
    const inserted = await tryInsertText(editor, text);
    if (inserted) return 'inserted';
    const copied = await copyToClipboard(text);
    return copied ? 'copied' : 'failed';
  }

  // Find the tweet being replied to. Heuristic: in reply modal/page, the tweet
  // immediately preceding the editor in DOM order is the target. We grab the
  // closest <article> that comes before the editor.
  function findReplyContextTweet(editor) {
    const articles = $$('article[data-testid="tweet"]');
    if (!articles.length) return '';
    // Pick last article that appears BEFORE the editor in document order.
    let candidate = null;
    for (const a of articles) {
      if (a.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING) {
        candidate = a;
      }
    }
    if (!candidate) candidate = articles[0];
    const tweetTextEl = candidate.querySelector('[data-testid="tweetText"]');
    return (tweetTextEl?.innerText || candidate.innerText || '').trim().slice(0, 1000);
  }

  // ---------- LLM bridge ----------
  // The content script can outlive its background worker: when the extension
  // is reloaded / updated, all open tabs keep the old content.js running but
  // chrome.runtime is now disconnected. sendMessage then THROWS synchronously
  // ("Extension context invalidated"), and a throw inside a `new Promise(...)`
  // executor becomes an unhandled rejection.
  function send(type, payload) {
    return new Promise((resolve) => {
      // chrome.runtime.id is undefined once the context is invalidated — fast
      // bail-out before attempting the call.
      if (!chrome.runtime?.id) {
        resolve({ ok: false, error: 'Extension was reloaded — refresh this tab to continue.' });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        const msg = /context invalidated/i.test(e?.message || '')
          ? 'Extension was reloaded — refresh this tab to continue.'
          : e?.message || String(e);
        resolve({ ok: false, error: msg });
      }
    });
  }

  // ---------- toolbar UI ----------
  function makeButton(label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xh-btn';
    b.textContent = label;
    b.title = title || label;
    return b;
  }

  function makeToolbar(editor) {
    const bar = document.createElement('div');
    bar.className = TOOLBAR_CLASS + ' xh-collapsed';

    // Collapsed state: a small chip with just the ✨ icon.
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'xh-chip';
    chip.title = 'X Helper — click to expand';
    chip.textContent = '✨';

    // Expanded panel: action buttons + status + suggestions list.
    const panel = document.createElement('div');
    panel.className = 'xh-panel';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'xh-close';
    closeBtn.title = 'Collapse';
    closeBtn.textContent = '×';

    const polishBtn = makeButton('✨ Polish', 'Polish English / 中翻英 (Cmd+Shift+P)');
    const suggestBtn = makeButton('💡 Suggest', 'Generate 3 reply suggestions (Cmd+Shift+J)');
    const status = document.createElement('span');
    status.className = 'xh-status';

    const suggestList = document.createElement('div');
    suggestList.className = 'xh-suggest-list';

    panel.append(polishBtn, suggestBtn, status, closeBtn, suggestList);
    bar.append(chip, panel);

    function setCollapsed(collapsed) {
      bar.classList.toggle('xh-collapsed', collapsed);
      bar.classList.toggle('xh-expanded', !collapsed);
    }
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      setCollapsed(false);
    });
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      setCollapsed(true);
      status.textContent = '';
      suggestList.innerHTML = '';
    });

    function setBusy(b, busy) {
      b.disabled = busy;
      b.classList.toggle('xh-busy', busy);
    }

    async function doPolish() {
      const text = getEditorText(editor);
      if (!text) {
        status.textContent = 'Type something first.';
        return;
      }
      setBusy(polishBtn, true);
      status.textContent = 'Polishing…';
      const ctx = findReplyContextTweet(editor);
      const res = await send('polish', { text, context: ctx });
      setBusy(polishBtn, false);
      if (!res?.ok) {
        status.textContent = `Error: ${res?.error || 'unknown'}`;
        return;
      }
      const result = await setEditorText(editor, res.text);
      status.textContent = {
        inserted: '✓ Inserted',
        copied: '✓ Copied — press ⌘V (or Ctrl+V) to paste',
        failed: '✓ Done — but clipboard write failed',
      }[result];
    }

    async function doSuggest() {
      const tweet = findReplyContextTweet(editor);
      if (!tweet) {
        status.textContent = 'No tweet context found.';
        return;
      }
      setBusy(suggestBtn, true);
      status.textContent = 'Generating…';
      const hint = getEditorText(editor);
      const res = await send('suggest', { tweet, hint });
      setBusy(suggestBtn, false);
      if (!res?.ok) {
        status.textContent = `Error: ${res?.error || 'unknown'}`;
        return;
      }
      status.textContent = 'Pick one:';
      suggestList.innerHTML = '';
      (res.suggestions || []).forEach((s) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'xh-suggest-item';
        item.textContent = s;
        item.title = 'Click to use';
        item.addEventListener('click', async () => {
          const result = await setEditorText(editor, s);
          status.textContent = {
            inserted: '✓ Inserted',
            copied: '✓ Copied — press ⌘V (or Ctrl+V) to paste',
            failed: '✓ Done — but clipboard write failed',
          }[result];
          suggestList.innerHTML = '';
        });
        suggestList.appendChild(item);
      });
    }

    polishBtn.addEventListener('click', doPolish);
    suggestBtn.addEventListener('click', doSuggest);

    // Keyboard shortcuts when editor is focused.
    editor.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        setCollapsed(false);
        doPolish();
      } else if (mod && e.shiftKey && (e.key === 'J' || e.key === 'j')) {
        e.preventDefault();
        setCollapsed(false);
        doSuggest();
      }
    });

    return bar;
  }

  // Position the floating toolbar just below the editor, using its bounding box.
  function positionBar(bar, editor) {
    if (!editor.isConnected) {
      bar.style.display = 'none';
      return;
    }
    const r = editor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    bar.style.left = `${Math.round(r.left + window.scrollX)}px`;
    bar.style.top = `${Math.round(r.bottom + window.scrollY + 6)}px`;
    // Pass editor width as a CSS var so the expanded panel can clamp to it
    // (and stay narrower so the reply button is never covered).
    bar.style.setProperty('--xh-editor-width', `${Math.round(r.width)}px`);
  }

  function attach(editor) {
    if (editor.getAttribute(ATTACHED_FLAG)) return;
    editor.setAttribute(ATTACHED_FLAG, '1');

    const bar = makeToolbar(editor);
    bar.classList.add('xh-floating');
    document.body.appendChild(bar);

    const update = () => positionBar(bar, editor);
    update();

    // Reposition on layout changes.
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);
    if (editor.isConnected) ro.observe(editor);

    // Periodic fallback for SPA layout shifts that don't fire scroll/resize/RO.
    // 250ms is well below human-perceptible jitter and ~240× cheaper than rAF.
    let lastKey = '';
    const fallback = setInterval(() => {
      if (!editor.isConnected) {
        bar.remove();
        ro.disconnect();
        window.removeEventListener('scroll', update, true);
        window.removeEventListener('resize', update);
        clearInterval(fallback);
        return;
      }
      const r = editor.getBoundingClientRect();
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (key !== lastKey) {
        lastKey = key;
        update();
      }
    }, 250);
  }

  function scan() {
    // X compose textarea has data-testid like tweetTextarea_0, tweetTextarea_0_label, etc.
    const editors = $$('div[data-testid^="tweetTextarea_"][contenteditable="true"]');
    for (const ed of editors) attach(ed);
  }

  // Debounce scan() — X mutates the DOM hundreds of times per second, but new
  // editors only appear on navigation / modal-open, so idle-time is fine.
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    const run = () => {
      scanScheduled = false;
      scan();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 200);
    }
  }

  // Initial scan + observe SPA navigation.
  scan();
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
})();
