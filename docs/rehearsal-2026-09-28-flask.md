# Rehearsal: Flask at declared sharing, 2026-09-28

This was the fourth codebase. Every agent shared only its declared files. It ran on Room 0.16.31.

## Setup

- **Repository:** private `rohanz/flask-rehearsal`, a snapshot of pallets/flask at 06ea505. The check passes 491 tests at the base.
- **Cards,** from upstream PRs #6013, #6096 and #6133:
  - #1: autoescaping ignored upper-case template extensions.
  - #2: IPv6 `host:port` broke `app.run()` and test-client sessions.
  - #3: add an `@app.query` route shortcut.
- **Overlap:**
  - All three add a line to the same `CHANGES.rst` section.
  - #2 and #3 both edit `tests/test_basic.py`.
  - #3 changes `Scaffold`, the base class of `App`.
  - No two change the same source file, because recent Flask changes are all small.
- **Sessions:** three clones, driven in plain words: Ana (Claude Code) #1, Ben (Claude Code) #2, Cy (Codex) #3.

## What happened

- **Joining:** Ana opened the room at declared sharing; Ben and Cy joined at declared.
- **Working, about two minutes each:**
  - Each declared and claimed only its lines.
  - Ben and Cy agreed to keep their edits in `tests/test_basic.py` and `CHANGES.rst` apart.
- **Ana's preview caught Ben mid-task.** It had his new tests but not yet his fix to `app.py`, so three of his tests failed in her combined tree. She read it correctly, as "their fix is still in progress", and did not raise a false alarm.
- **Pushing at the same moment:**
  - Ana pushed first.
  - **Ben and Cy were both rejected, and both stopped and asked before rebasing,** as 0.16.30 requires. Cy quoted the rule.
  - On "yes" each rebased, reran the tests and pushed. Neither had any conflicts.
- **Result:**
  - `rehearsal` = 80a9ef7 (#1), 1db536b (#2), 3f2fb30 (#3).
  - A fresh clone passes 530 tests. **The answer key passes 171 of 171**: upstream's final `test_basic.py` and `test_testing.py`, plus a case-sensitivity test for #1.
  - All issues are closed.

## Findings

1. **The 0.16.30 catch-up rule works:** two of two rejected pushes stopped and asked.
2. **Declared sharing gives partial previews while teammates are mid-task.** The preview should say how current each teammate's shared files are, or which of their scope's files are not shared yet, so an agent does not mistake work in progress for a regression. This is for after the trial.
