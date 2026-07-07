# Task Plan: Optimize And Upgrade wiki2md By Priority
<!-- 
  WHAT: This is your roadmap for the entire task. Think of it as your "working memory on disk."
  WHY: After 50+ tool calls, your original goals can get forgotten. This file keeps them fresh.
  WHEN: Create this FIRST, before starting any work. Update after each phase completes.
-->

## Goal
<!-- 
  WHAT: One clear sentence describing what you're trying to achieve.
  WHY: This is your north star. Re-reading this keeps you focused on the end state.
  EXAMPLE: "Create a Python CLI todo app with add, list, and delete functionality."
-->
Deliver a prioritized optimization and upgrade implementation for wiki2md based on prior assessment, including best-practice UI/UX upgrades for popup and options pages.

## Current Phase
<!-- 
  WHAT: Which phase you're currently working on (e.g., "Phase 1", "Phase 3").
  WHY: Quick reference for where you are in the task. Update this as you progress.
-->
Phase 5

## Phases
<!-- 
  WHAT: Break your task into 3-7 logical phases. Each phase should be completable.
  WHY: Breaking work into phases prevents overwhelm and makes progress visible.
  WHEN: Update status after completing each phase: pending → in_progress → complete
-->

### Phase 1: Prioritized Upgrade Planning
<!-- 
  WHAT: Understand what needs to be done and gather initial information.
  WHY: Starting without understanding leads to wasted effort. This phase prevents that.
-->
- [x] Translate prior assessment into prioritized backlog
- [x] Define high/medium/low upgrade scopes
- [x] Capture implementation order and acceptance checks
- **Status:** complete
<!-- 
  STATUS VALUES:
  - pending: Not started yet
  - in_progress: Currently working on this
  - complete: Finished this phase
-->

### Phase 2: High Priority Optimization
<!-- 
  WHAT: Decide how you'll approach the problem and what structure you'll use.
  WHY: Good planning prevents rework. Document decisions so you remember why you chose them.
-->
- [x] Refactor high-risk core flow for maintainability
- [x] Remove duplicated validation/logic hotspots
- [x] Preserve behavior and add observability where useful
- **Status:** complete

### Phase 3: Medium Priority Optimization
<!-- 
  WHAT: Actually build/create/write the solution.
  WHY: This is where the work happens. Break into smaller sub-tasks if needed.
-->
- [x] Improve engineering baseline (check scripts / CI)
- [x] Harden guard rails for future iteration
- [x] Keep changes low-cost and incremental
- **Status:** complete

### Phase 4: Low Priority Optimization
<!-- 
  WHAT: Verify everything works and meets requirements.
  WHY: Catching issues early saves time. Document test results in progress.md.
-->
- [x] Add supporting docs for upgrade roadmap and next iterations
- [x] Record deferred items and rationale
- [x] Ensure handoff clarity
- **Status:** complete

### Phase 4.1: Popup/Options UX Upgrade
- [x] Redesign popup visual hierarchy and state feedback
- [x] Redesign options information architecture and control grouping
- [x] Improve interaction behaviors (dirty state, validation hints,快捷保存)
- [x] Verify compile/build after UI refactor
- **Status:** complete

### Phase 5: Delivery
<!-- 
  WHAT: Final review and handoff to user.
  WHY: Ensures nothing is forgotten and deliverables are complete.
-->
- [x] Validate modified code (typecheck/build)
- [x] Summarize what was optimized by priority
- [x] List remaining recommended improvements
- **Status:** in_progress

## Key Questions
<!-- 
  WHAT: Important questions you need to answer during the task.
  WHY: These guide your research and decision-making. Answer them as you go.
  EXAMPLE: 
    1. Should tasks persist between sessions? (Yes - need file storage)
    2. What format for storing tasks? (JSON file)
-->
1. Which assessed risks should be treated as P0 and fixed first in code? (Answered)
2. How to optimize with minimal behavioral regression risk? (Answered)
3. Which improvements are better deferred with explicit rationale? (Answered)

## Decisions Made
<!-- 
  WHAT: Technical and design decisions you've made, with the reasoning behind them.
  WHY: You'll forget why you made choices. This table helps you remember and justify decisions.
  WHEN: Update whenever you make a significant choice (technology, approach, structure).
  EXAMPLE:
    | Use JSON for storage | Simple, human-readable, built-in Python support |
-->
| Decision | Rationale |
|----------|-----------|
| Use file-based planning artifacts for this analysis | Task is multi-step and research-heavy; persistent notes reduce context loss |
| Prioritize runtime code path over README claims | Ensures conclusions are accurate for future engineering iteration |
| Execute optimization in strict P0 -> P1 -> P2 order | Aligns with user request and reduces change blast radius |

## Errors Encountered
<!-- 
  WHAT: Every error you encounter, what attempt number it was, and how you resolved it.
  WHY: Logging errors prevents repeating the same mistakes. This is critical for learning.
  WHEN: Add immediately when an error occurs, even if you fix it quickly.
  EXAMPLE:
    | FileNotFoundError | 1 | Check if file exists, create empty list if not |
    | JSONDecodeError | 2 | Handle empty file case explicitly |
-->
| Error | Attempt | Resolution |
|-------|---------|------------|
| `rg: command not found` | 1 | Switched to `find`/`sed` for code discovery |
| `npm run check` failed (`TS7016`, `TS2322`) | 1 | Added `turndown-plugin-gfm` declaration + tightened option typing |

## Notes
<!-- 
  REMINDERS:
  - Update phase status as you progress: pending → in_progress → complete
  - Re-read this plan before major decisions (attention manipulation)
  - Log ALL errors - they help avoid repetition
  - Never repeat a failed action - mutate your approach instead
-->
- Update phase status as you progress: pending → in_progress → complete
- Re-read this plan before major decisions (attention manipulation)
- Log ALL errors - they help avoid repetition
