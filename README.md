<a id="readme-en"></a>

# wiki2md (Chrome Extension)

[中文](README.zh-CN.md#readme-zh)

`wiki2md` exports the current Confluence page into an offline-ready `.zip`:

- `wiki_<Title>.md` (Markdown)
- `assets/` (downloaded images)
- `meta.json` (export metadata)

The exported Markdown starts with a short quote block containing the source URL and the export time (Beijing time, `YYYY-MM-DD HH:mm:ss`).

## Features

- One-click export using your existing browser login session (SSO-friendly)
- Images downloaded and rewritten to local `assets/`
- Code blocks preserved (Confluence code macro / SyntaxHighlighter → fenced code blocks, best-effort language detection)
- Tables (best effort):
  - “Simple” tables can be forced into GitHub-flavored Markdown tables
  - Complex tables are kept as minimized HTML (noisy attributes stripped) to reduce tokens
- Links normalized (relative → absolute, configurable)
- TOC anchors fixed (TOC extracted separately + stable `#toc-...` anchors injected so offline TOC works)

## Install (Load Unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Build the extension:
   ```bash
   cd wiki2md
   npm ci
   npm run build
   ```
5. Select `wiki2md/dist`

## Use

1. Open a Confluence page
2. Click the **wiki2md** extension icon
3. Click **Download .zip**

## Options / Configuration

Open: `chrome://extensions` → **wiki2md** → **Details** → **Extension options**

- Allowlist (empty = allow all sites)
- Platform toggles (Confluence enabled by default; others can be added later)
- Force Markdown tables (only for safe/simple tables)
- Rewrite relative links to absolute URLs
- Image download concurrency

## Output

The downloaded `.zip` contains:

- `wiki_<Title>.md`
- `assets/`
- `meta.json` (source URL/title/time, image stats, failures, etc.)

## Privacy & Security

- `wiki2md` runs locally in your browser and does not upload your content to any third-party service.
- It fetches page assets (e.g. images) using your current browser session (`credentials: include`).
- The exported Markdown and `meta.json` include the source page URL and may contain internal links/content—review and redact before sharing publicly.

## Development

```bash
cd wiki2md
nvm use
npm run check
```

`npm run check` runs `typecheck + build`.

### Package

```bash
cd wiki2md
npm run package
```

This generates a versioned zip like `wiki2md-extension_1.0.zip` in `wiki2md/`.

## Troubleshooting

- Changes not taking effect: reload the extension in `chrome://extensions`
- Build issues:
  - Use Node 18+ (recommended via the project’s `.nvmrc`)
  - Avoid mixing Rosetta x64 Node with ARM64 `node_modules` on Apple Silicon
  - If you see a Node version error, run `nvm use` and retry (or set `WIKI2MD_SKIP_NODE_CHECK=1` to bypass).
