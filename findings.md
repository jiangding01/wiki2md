# Findings & Decisions
<!-- 
  WHAT: Your knowledge base for the task. Stores everything you discover and decide.
  WHY: Context windows are limited. This file is your "external memory" - persistent and unlimited.
  WHEN: Update after ANY discovery, especially after 2 view/browser/search operations (2-Action Rule).
-->

## Requirements
<!-- 
  WHAT: What the user asked for, broken down into specific requirements.
  WHY: Keeps requirements visible so you don't forget what you're building.
  WHEN: Fill this in during Phase 1 (Requirements & Discovery).
  EXAMPLE:
    - Command-line interface
    - Add tasks
    - List all tasks
    - Delete tasks
    - Python implementation
-->
<!-- Captured from user request -->
- Provide an in-depth analysis of the repository's main functions.
- Base conclusions on real code structure and execution flow, not only README descriptions.
- Produce analysis that can directly support later feature iteration and development planning.
- Based on that assessment, produce a best-practice optimization/upgrade plan.
- Implement optimizations from high priority to low priority within this iteration.
- Keep outputs directly actionable for continued feature development.

## Research Findings
<!-- 
  WHAT: Key discoveries from web searches, documentation reading, or exploration.
  WHY: Multimodal content (images, browser results) doesn't persist. Write it down immediately.
  WHEN: After EVERY 2 view/browser/search operations, update this section (2-Action Rule).
  EXAMPLE:
    - Python's argparse module supports subcommands for clean CLI design
    - JSON module handles file persistence easily
    - Standard pattern: python script.py <command> [args]
-->
<!-- Key discoveries during exploration -->
- Repository appears to be a browser extension project (`public/manifest.json`, `src/content.ts`, `src/popup.ts`, `src/options.ts`).
- Codebase is TypeScript-based and ships built assets to `dist/`.
- Main domain appears to be converting wiki-like pages to markdown (project name and module names under `src/core` and `src/processors`).
- Runtime flow is: popup click -> inject `content.js` -> `runWiki2mdExport()` orchestration in page context -> preprocess DOM -> convert to markdown -> package markdown/assets/meta in JSZip -> trigger browser download.
- Platform layer is adapter-based (`src/platforms/types.ts`), but only Confluence adapter is currently implemented and registered.
- Data fidelity strategy is placeholder-first:
  - code blocks, TOC anchors, and force-converted markdown tables are replaced with unique placeholders before Turndown
  - placeholders are restored in collision-safe order after markdown conversion.
- TOC handling is custom and strong:
  - TOC is extracted to standalone markdown list
  - local stable `#toc-*` anchors are injected
  - same-page links are rewritten to new local ids.
- Image processing is robust for practical wiki pages:
  - supports `src`, lazy attributes, `srcset` best candidate, `svg image`, and CSS `background-image`
  - resolves absolute URLs, retries transient fetch errors, deduplicates by canonical URL, hashes URL for stable filenames
  - writes both success and failure stats into `meta.json`.
- Table strategy is layered:
  - normalize rowspan/colspan to rectangular grid
  - nested tables are extracted as minimized HTML placeholders
  - simple tables can be force-converted to GFM markdown; complex tables remain (minimized) HTML.
- Options are persisted via `chrome.storage.sync` and include allowlist, platform toggles, link rewrite, force-table switch, image concurrency (clamped 1-12).
- Build system uses custom `build.js` + esbuild with an architecture-mismatch workaround (`ESBUILD_BINARY_PATH`) and emits `dist/build-info.json`.
- Project has TypeScript strict checking (`tsc --noEmit`) but currently no automated unit/integration test suite.
- `src/core/runWiki2mdExport.ts` remains the biggest maintainability hotspot (long orchestration function with many coupled steps).
- Allowlist validation logic is duplicated between popup and core export path, raising consistency risk.
- Project currently lacks a consolidated "check" command and CI guard for routine regression prevention.
- Implemented P0 refactor:
  - `runWiki2mdExport` now uses stage-based execution (`runPipelineStep`) with per-step timing.
  - Export failures include failed-step context for easier diagnosis.
  - `meta.json` now includes a `pipeline` summary (steps/durations/failedStep/totalDurationMs).
- Implemented P0 consistency cleanup:
  - popup now reuses `getOptions` + `isHostAllowed` from `core/options` (removed duplicated allowlist matching logic).
  - options sanitization is centralized for both read (`getOptions`) and write (`setOptions`) paths.
- Implemented P1 baseline:
  - Added `npm run check` (`typecheck + build`).
  - Added CI workflow `.github/workflows/ci.yml` to run `npm ci` + `npm run check` on push/PR.
- Implemented P2 handoff:
  - Added `UPGRADE_PLAN.md` with completed items and deferred next steps.
  - Updated contributor/development docs to use `npm run check`.
- Implemented popup UI/UX optimization:
  - Added stronger visual hierarchy (card layout, context badge, page meta area, prominent primary action).
  - Added busy state spinner and clearer status semantics (`info/success/error`).
  - Added quick actions: open options and refresh active-tab eligibility checks.
  - Added pre-flight exportability checks on popup load to reduce failed clicks.
- Implemented options UI/UX optimization:
  - Reworked settings into structured cards with improved readability and grouped controls.
  - Added explicit dirty-state handling and save-button enable/disable behavior.
  - Added allowlist normalization action and rule count feedback.
  - Added synchronized concurrency controls (range + number) with guidance text.
  - Added keyboard save shortcut (`Cmd/Ctrl + S`) and unsaved-change navigation guard.

## Technical Decisions
<!-- 
  WHAT: Architecture and implementation choices you've made, with reasoning.
  WHY: You'll forget why you chose a technology or approach. This table preserves that knowledge.
  WHEN: Update whenever you make a significant technical choice.
  EXAMPLE:
    | Use JSON for storage | Simple, human-readable, built-in Python support |
    | argparse with subcommands | Clean CLI: python todo.py add "task" |
-->
<!-- Decisions made with rationale -->
| Decision | Rationale |
|----------|-----------|
| Analyze from runtime flow first, then fill in support modules | Gives user an iteration-ready mental model grounded in actual behavior |
| Treat `src/core/runWiki2mdExport.ts` as the primary evolution hotspot | It owns sequencing and cross-processor interactions that most new features will touch |
| Set P0 to maintainability + consistency changes in runtime path | Highest leverage and largest risk reducer for future feature work |
| Set P1 to engineering baseline automation (typecheck+build in CI) | Prevents accidental breakage during fast iteration |
| Set P2 to documentation/handoff improvements | Useful but lower immediate risk impact |

## Issues Encountered
<!-- 
  WHAT: Problems you ran into and how you solved them.
  WHY: Similar to errors in task_plan.md, but focused on broader issues (not just code errors).
  WHEN: Document when you encounter blockers or unexpected challenges.
  EXAMPLE:
    | Empty file causes JSONDecodeError | Added explicit empty file check before json.load() |
-->
<!-- Errors and how they were resolved -->
| Issue | Resolution |
|-------|------------|
| `rg` command unavailable in environment | Switched to `find` + `sed` for file discovery |
| None in repository code reading phase | N/A |
| `npm run check` type errors after refactor (`TS7016`, `TS2322`) | Added local module declaration and stricter allowlist typing |

## Resources
<!-- 
  WHAT: URLs, file paths, API references, documentation links you've found useful.
  WHY: Easy reference for later. Don't lose important links in context.
  WHEN: Add as you discover useful resources.
  EXAMPLE:
    - Python argparse docs: https://docs.python.org/3/library/argparse.html
    - Project structure: src/main.py, src/utils.py
-->
<!-- URLs, file paths, API references -->
- `/Users/jiangding/wiki2md/README.md`
- `/Users/jiangding/wiki2md/README.zh-CN.md`
- `/Users/jiangding/wiki2md/package.json`
- `/Users/jiangding/wiki2md/src/`
- `/Users/jiangding/wiki2md/public/manifest.json`
- `/Users/jiangding/wiki2md/src/core/runWiki2mdExport.ts`
- `/Users/jiangding/wiki2md/src/core/markdown.ts`
- `/Users/jiangding/wiki2md/src/processors/`
- `/Users/jiangding/wiki2md/src/platforms/`
- `/Users/jiangding/wiki2md/build.js`
- `/Users/jiangding/wiki2md/scripts/package-zip.js`
- `/Users/jiangding/wiki2md/src/core/runWiki2mdExport.ts`
- `/Users/jiangding/wiki2md/src/core/options.ts`
- `/Users/jiangding/wiki2md/src/core/types.ts`
- `/Users/jiangding/wiki2md/src/popup.ts`
- `/Users/jiangding/wiki2md/src/types/turndown-plugin-gfm.d.ts`
- `/Users/jiangding/wiki2md/.github/workflows/ci.yml`
- `/Users/jiangding/wiki2md/UPGRADE_PLAN.md`
- `/Users/jiangding/wiki2md/public/popup.html`
- `/Users/jiangding/wiki2md/public/options.html`
- `/Users/jiangding/wiki2md/src/popup.ts`
- `/Users/jiangding/wiki2md/src/options.ts`

## Visual/Browser Findings
<!-- 
  WHAT: Information you learned from viewing images, PDFs, or browser results.
  WHY: CRITICAL - Visual/multimodal content doesn't persist in context. Must be captured as text.
  WHEN: IMMEDIATELY after viewing images or browser results. Don't wait!
  EXAMPLE:
    - Screenshot shows login form has email and password fields
    - Browser shows API returns JSON with "status" and "data" keys
-->
<!-- CRITICAL: Update after every 2 view/browser operations -->
<!-- Multimodal content must be captured as text immediately -->
- No browser/image/PDF analysis used in this task so far.

---
<!-- 
  REMINDER: The 2-Action Rule
  After every 2 view/browser/search operations, you MUST update this file.
  This prevents visual information from being lost when context resets.
-->
*Update this file after every 2 view/browser/search operations*
*This prevents visual information from being lost*
