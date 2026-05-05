# X Helper

Chrome extension for X / Twitter. Adds two LLM helpers next to every compose / reply box:

- **✨ Polish** — Polish the English you typed, or translate Chinese (or mixed) to natural English. Preserves @mentions / #hashtags / URLs / emojis.
- **💡 Suggest** — Generate 3 distinct reply suggestions based on the tweet you're replying to. Click one to insert it. If you've already typed a hint (Chinese OK), it's used as the intent.

Works with **any Anthropic-compatible API** — set Base URL + API Key + model in the options page.

## Install (developer mode)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** → select this folder (`x-helper/`)
4. Click the X Helper toolbar icon → **Open Settings**
5. Fill in:
   - **API Base URL** — e.g. `https://api.anthropic.com`, or any compatible gateway
   - **API Key** — your `sk-ant-...` (or whatever the gateway uses)
   - **Model** — e.g. `claude-3-5-sonnet-latest`
6. Click **Test connection** to verify.

## Usage

Open <https://x.com>, focus a compose / reply box, and look for the toolbar that appears under the editor:

```
✨ Polish    💡 Suggest    <status>
```

Keyboard shortcuts (when the editor is focused):

- `Cmd/Ctrl + Shift + P` → Polish
- `Cmd/Ctrl + Shift + J` → Suggest

## Configuration notes

- Polish uses the original tweet (when replying) only as **tone reference** — it is not translated.
- Suggest expects a tweet context. On a tweet detail page or reply modal, the closest preceding `<article>` is treated as the target.
- Prompts are baked in (`src/prompts.js`); the only user-supplied parameters are endpoint, key, model, and max-tokens.

## File map

```
manifest.json
src/
  background.js     # service worker, calls /v1/messages
  content.js        # injects toolbar, handles editor I/O
  content.css
  prompts.js        # built-in polish + suggest prompts
  options.html      # settings page
  options.js
  popup.html        # toolbar popup → opens settings
```
