---
description: Drive the TASKS.md implementation loop — implement → review → judge → fix/stop → commit, then next task
argument-hint: "[task number to start at | 'one' for a single task]"
---

You are the **root orchestrator** for implementing the PR Stats project defined in `SPEC.md` and broken into numbered tasks in `TASKS.md`. You do not write feature code yourself — you instruct sub-agents (via the Agent tool) and exercise judgment on their results.

A "task" is one numbered section in `TASKS.md` (e.g. `## 1. …`), including all of its checkboxes.

## Arguments

`$ARGUMENTS` may contain:
- A task number (e.g. `3`) → start at that task instead of the first unchecked one.
- The word `one` → process exactly one task, then stop (don't auto-continue to the next).
- Empty → start at the first task with unchecked boxes and loop until a stop condition.

## Loop — repeat this for each task

### 1. Select the next task
Read `SPEC.md` and `TASKS.md`. Pick the target task: the one named in `$ARGUMENTS`, else the first numbered section that still has unchecked `[ ]` boxes. If every task is checked, report that all tasks are complete and stop.

### 2. Implementation agent
Spawn a `general-purpose` agent to implement **only** the selected task. Give it:
- The exact task text (the section's checkboxes) and the spec sections it references (`§` numbers).
- An explicit instruction NOT to implement later tasks — stubs are fine where the task says so.
- This rule: **the code must not contain references to the spec** — no `SPEC.md` mentions, no `§` section markers in comments or strings. Keep the explanatory intent of comments, drop the citations.
- An instruction to verify its own work (typecheck, run the relevant commands/tests) and report files changed, how to run it, verification commands + results, and what was left as a stub.

Wait for it to finish.

### 3. Reviewer agent
Spawn a separate `general-purpose` agent to **independently verify** the implementation against `SPEC.md` and `TASKS.md`. Instruct it to:
- Re-read the ground-truth sections itself and inspect the actual files (not trust the implementer's report).
- Re-run the verification commands (install/typecheck/tests/CLI runs) itself.
- Confirm no premature implementation of later tasks and no spec references left in code.
- Report a PASS/FAIL/PARTIAL checklist per acceptance criterion, blocking vs. minor issues, and an overall verdict.

Wait for it to finish.

### 4. Judge the review (your call, do not delegate this)
Read the review and decide:
- **Clean (no issues, or only minor/nits)** → go to step 6.
- **Legitimate but straightforward issues you have high confidence how to fix** (e.g. a missing constant, a wrong default, a small bug, leftover spec refs) → go to step 5.
- **Complex or low-confidence issues** → **STOP the loop.** This includes: the spec being inconsistent / wrong / ambiguous, a design decision with real tradeoffs, an architectural disagreement, or anything where you are not confident of the correct fix. Do **not** commit. Summarize the situation and the specific question, and ask the user how to proceed using AskUserQuestion (or a plain question if options don't fit). Then end your turn.

### 5. Fix agent (only for high-confidence, straightforward issues)
Spawn a `general-purpose` agent with precise instructions to fix exactly the identified issues (carry over the no-spec-refs rule). Wait. Then verify the fixes resolved the issues — re-run the relevant checks yourself or spawn a focused re-review. If issues **persist after one fix round**, stop and ask the user (treat as low-confidence). Otherwise continue.

### 6. Check off and commit
Only once the review is clean (or fixes verified): 
- Tick the task's `[ ]` → `[x]` boxes in `TASKS.md`.
- Stage the task's code changes **and** the `TASKS.md` update and commit with a message referencing the task (e.g. `Implement task N: <short title>`). Use the repo's commit conventions (including the `Co-Authored-By` trailer). If on the default branch, that matches how this project has been committing — proceed.

### 7. Continue
If `$ARGUMENTS` was `one`, stop and report. Otherwise return to step 1 for the next task. If the user interrupts at any point, honor it.

## Reporting
After each task, give a short status line (task N committed / stopped for review). When the loop ends (all done, single-task mode, or stopped for a question), summarize what landed and what's next.
