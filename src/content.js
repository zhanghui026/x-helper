// X Helper content script.
// Injects a small toolbar next to X compose / reply boxes with Polish & Suggest buttons.

(() => {
  const TOOLBAR_CLASS = 'xh-toolbar';
  const ATTACHED_FLAG = 'data-xh-attached';

  // ---------- helpers ----------
  function $(sel, root = document) {
    return root.querySelector(sel);
  }
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

  // Deliver text to the editor. We DO NOT mutate the editor DOM directly:
  // X's compose box is Draft.js, which keeps its own React EditorState. Any
  // DOM mutation we make is invisible to Draft, leaves the placeholder
  // overlay visible, and — worst of all — Draft submits its (empty) state on
  // post, throwing away our text.
  //
  // The only reliable cross-version path is: copy to clipboard and let the
  // user paste with ⌘V. Their paste is a real, isTrusted event that Draft
  // handles natively.
  async function setEditorText(_editor, text) {
    return await copyToClipboard(text);
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
  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res);
        }
      });
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
      const copied = await setEditorText(editor, res.text);
      status.textContent = copied
        ? '✓ Copied — press ⌘V (or Ctrl+V) to paste'
        : '✓ Done — but clipboard write failed';
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
          const copied = await setEditorText(editor, s);
          status.textContent = copied
            ? '✓ Copied — press ⌘V (or Ctrl+V) to paste'
            : '✓ Done — but clipboard write failed';
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

    // Animation loop fallback for SPA layout shifts (cheap: one rect read).
    let lastKey = '';
    const tick = () => {
      if (!editor.isConnected) {
        bar.remove();
        ro.disconnect();
        window.removeEventListener('scroll', update, true);
        window.removeEventListener('resize', update);
        return;
      }
      const r = editor.getBoundingClientRect();
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (key !== lastKey) {
        lastKey = key;
        update();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function scan() {
    // X compose textarea has data-testid like tweetTextarea_0, tweetTextarea_0_label, etc.
    const editors = $$('div[data-testid^="tweetTextarea_"][contenteditable="true"]');
    for (const ed of editors) attach(ed);
  }

  // Initial scan + observe SPA navigation.
  scan();
  const mo = new MutationObserver(() => scan());
  mo.observe(document.body, { childList: true, subtree: true });
})();
