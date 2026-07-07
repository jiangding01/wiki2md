# Contributing

This repo primarily ships the **wiki2md** Chrome extension (recommended workflow). The CLI is kept as a legacy/reference path.

## Prerequisites

- Node.js 18+ (recommended via `nvm use`)
- npm (any recent version)

If you run commands with an older Node version, `wiki2md` will fail fast with a clear message (instead of a cryptic syntax error).

## Setup

```bash
cd wiki2md
npm ci
```

## Development

- Build once:
  ```bash
  npm run build
  ```
- Watch mode:
  ```bash
  npm run build:watch
  ```
- Load in Chrome:
  1. Open `chrome://extensions`
  2. Enable “Developer mode”
  3. Click “Load unpacked”
  4. Select `wiki2md/dist`

## Type checking

```bash
cd wiki2md
npm run typecheck
```

## Project check (recommended before commit)

```bash
cd wiki2md
npm run check
```

This runs `typecheck + build` in one command.

## Packaging

```bash
cd wiki2md
npm run package
```

This produces `wiki2md-extension_<version>.zip` under `wiki2md/`.

## CI

- GitHub Actions workflow: `.github/workflows/ci.yml`
- Runs on push/PR with Node from `.nvmrc`
- Executes `npm ci` and `npm run check`

## Project structure (extension)

- Entry: `wiki2md/src/content.ts`
- Export pipeline: `wiki2md/src/core/runWiki2mdExport.ts`
- Platform adapters: `wiki2md/src/platforms/*`
- Processors: `wiki2md/src/processors/*`
- Utilities: `wiki2md/src/utils/*`

## Adding a new platform (Feishu / WeChat, etc.)

1. Add an adapter in `wiki2md/src/platforms/<platform>.ts` (see `confluence.ts`).
2. Register it in `wiki2md/src/platforms/detect.ts`.
3. Reuse existing processors where possible; add platform-specific processors only when necessary.
