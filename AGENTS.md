# aitinkerhackathon — "Agents leaving the chatbox" hackathon

Rohan's entry. One-day build; a working prototype demoable by end of day.
`CLAUDE.md` is a symlink to this file.

## Read first

- `RULES.md` — the verbatim brief and the 4-criterion, 1–5 judging rubric. That file is
  the rules; this file is how we work.
- `docs/decisions.md` — what we're building and why (idea, environment, scope cuts).
  Empty until the idea is locked. **Do not start coding before it has an entry.**
- `docs/submission.md` — the deliverables checklist and demo script.

## Hard constraints (from RULES.md)

- **Build timing:** organiser confirmed (9 Sep) that pre-event building is fine; the "net-new during the event" text in RULES.md is from old rules. Keep a short "what was built when" note in `docs/decisions.md` anyway.
- Repo must be **public** on GitHub at submission. Never commit secrets; `.env` is
  gitignored, `.env.example` documents what's needed.
- Submission also needs: title, written description, 2-minute demo video, social post
  tagging event partners. See `docs/submission.md`.

## How the rubric should shape decisions

Each criterion is scored 1–5 and they're equally weighted, so a project that scores 4 on
everything beats a 5/5/2/3. Practical rules:

1. **End-to-end first, breadth never.** A 3 on "Core Requirements" needs the whole
   workflow working inside the real environment. Get the thin vertical slice running in
   the actual target (real Slack workspace, real browser extension, real device) before
   adding any second feature.
2. **The environment must be load-bearing.** The 1-score on Innovation is "the
   environment is irrelevant"; the 5 is "could not be reproduced in a standalone
   chatbox". Every feature should answer: what does the agent know or can it do *here*
   that it couldn't in a chat window? If the answer is "nothing", cut it.
3. **Failure handling is explicitly scored** (Technical Execution 5: "thoughtful failure
   handling"). Timeouts, retries, and a graceful "I couldn't do that" path are worth more
   than a fourth tool.
4. **User control is scored** (Usefulness 3–5: "reasonable user control", "clear and
   controllable"). Confirm-before-act for anything irreversible; show what the agent is
   doing.
5. Demo reliability beats capability. If a feature works 70% of the time it is a demo
   liability; either harden it or cut it before recording.

## Conventions

- Python via `uv` only (deps and running). Other stacks are fine if the environment
  demands it (e.g. a browser extension in TS); say so in `docs/decisions.md`.
- Claude models: default to `claude-fable-5-1` for the agent loop, `claude-haiku-4-5-20251001`
  for cheap classification/routing steps. Read the `claude-api` skill before writing
  API code; don't work from memory.
- Tests: pytest for anything non-trivial and testable offline. Under hackathon time
  pressure, prioritize a smoke test of the end-to-end path over unit coverage.
- Commit small and often on `main`. Commit messages state what changed and why.
- Clean up dead code before the final commit; the repo is part of the submission and
  judges read it.
- Log agent actions (tool calls, decisions) to stdout or a file — this doubles as demo
  material and as the "explain what it did" story.

## Layout (fill in as the project takes shape)

```
RULES.md            verbatim brief + rubric (do not edit)
AGENTS.md           this file (CLAUDE.md -> AGENTS.md)
docs/decisions.md   idea, environment, scope, what-was-built-when
docs/submission.md  deliverables checklist + demo script
.env.example        required env vars, no values
```
