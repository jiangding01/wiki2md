# wiki2md Optimization And Upgrade Plan

## Goals
- Reduce regression risk for upcoming feature iterations.
- Improve maintainability of the export pipeline.
- Establish a minimum engineering quality baseline.

## Priority Backlog

### P0 (High): Runtime Maintainability And Consistency
- [x] Refactor export orchestration to a stage-based pipeline in `src/core/runWiki2mdExport.ts`.
- [x] Add step-level timing and failed-step context to exported `meta.json` (`pipeline` field).
- [x] Remove duplicated allowlist logic from popup and reuse `core/options`.
- [x] Centralize option sanitization in `core/options` for both read/write paths.

### P1 (Medium): Engineering Guard Rails
- [x] Add `npm run check` command (`typecheck + build`).
- [x] Add GitHub Actions CI workflow to run `npm ci` + `npm run check`.

### P2 (Low): Documentation And Iteration Handoff
- [x] Document prioritized upgrade roadmap and completion status in this file.
- [ ] Add regression test fixtures for representative Confluence pages (code, TOC, complex tables, large images).
- [ ] Split processor tests by capability (images, tables, anchors) with deterministic sample inputs.
- [ ] Introduce adapter contract tests before adding Feishu/WeChat adapters.

## Remaining Recommended Next Steps
1. Add fixture-based regression testing for markdown output stability.
2. Isolate per-stage pipeline data types into dedicated files to reduce core-module size.
3. Add structured warnings in `meta.json` for skipped complex tables and failed anchor injections.
