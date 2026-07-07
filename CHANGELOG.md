## Changelog

All notable changes to this project will be documented in this file.

Format: Keep a high-level, user-facing summary (what changed and why).  
Scope: Primarily the Chrome extension (`wiki2md/`), which is the recommended workflow.

---

## [Unreleased]

### Added

- Options page (stored in `chrome.storage.sync`) for tuning behaviors:
  - Optional allowlist (empty = allow all)
  - Platform toggles (Confluence enabled by default)
  - Force Markdown tables toggle
  - Rewrite relative links toggle
  - Image download concurrency
- Exported Markdown now starts with a short quote block containing the source URL and export timestamp (Beijing time, `YYYY-MM-DD HH:mm:ss`) for traceability.

### Fixed

- TOC robustness across Confluence variants:
  - Supports TOC rendered as a plain `ul/li` list (outside the TOC macro wrapper).
  - Supports malformed Confluence HTML where the TOC macro is nested inside the first `h1`.
  - TOC is now extracted and rendered separately, preventing stray headings and ensuring the first TOC item anchors correctly.
  - TOC links are always exported as in-page `#toc-...` links (never absolute wiki URLs).

## [1.0.0] - 2026-02-03

### Added

- Chrome extension renamed and standardized as **wiki2md** (manifest + npm package name).
- Export manifest `meta.json` inside the downloaded zip for traceability (URL/title/time, image stats, failures, etc.).
- Code block formatting support for Confluence code macro / SyntaxHighlighter, including improved language inference.
- TOC handling:
  - Rewrites Confluence in-page anchor links to simplified local anchors.
  - Injects matching anchors into the exported document so the TOC works offline.
- Absolute link rewriting:
  - Converts relative `a[href]` links into absolute URLs based on the current page URL.
- Image coverage and stability:
  - More image sources supported (common `<img>` attributes, `srcset`, SVG `<image>`, and inline `background-image` URLs).
  - Stable asset filenames based on URL hash + best-effort extension.
  - Concurrency-limited downloads and retry handling.
- Type checking for the extension (`npm run typecheck`) to keep refactors safe.
- Minimal CI workflow (GitHub Actions) to run install/typecheck/build/package for the extension.
- Build/packaging workflow:
  - `npm run build`, `npm run build:watch`, `npm run package` for the extension.
  - `build-info.json` emitted into `dist/` with build metadata.
  - Versioned extension zip output (`wiki2md-extension_<version>.zip`).
  - Node version guidance via `.nvmrc` and extension `.nvmrc`.
- Documentation:
  - Improved `README.md` and added `README.zh-CN.md` with cross-links and anchors.
  - Architecture notes for future platform adapters (Feishu/WeChat, etc.).
  - Added `CONTRIBUTING.md`.
- Project hygiene:
  - Added `.editorconfig` and `LICENSE`.

### Changed

- Refactored the extension’s content script:
  - Split monolithic `content.ts` into a maintainable structure:
    - Platform adapters (`src/platforms/*`)
    - Export pipeline (`src/core/*`)
    - Reusable processors (`src/processors/*`)
    - Utilities (`src/utils/*`)
- Table handling best practices:
  - Minimizes HTML table noise by stripping style/class/data/aria attributes.
  - Adds a “force Markdown tables” mode: for simple, rectangular, non-nested tables without block content, export as Markdown tables; otherwise keep minimized HTML.

### Fixed

- Confluence sticky header duplication causing repeated header rows in exported tables.
- Table cell code blocks that previously broke Markdown table parsing.
- TOC numbering duplication and first-anchor placement issues (anchors now avoid being injected before the TOC; empty headings removed to prevent stray `#`).
- Popup UX improvements:
  - Validates the current tab looks like a Confluence page before injecting the content script.
  - UI text updated to `wiki2md`.
