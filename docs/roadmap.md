# Future work: Room on large production repos

Written 2026-09-21. Room today fits a small team on a shared branch. These are the known gaps
between that and a fifty-engineer production repo, in priority order. Nothing here is started.
Decide the order after the trial with real users; see "What decides the order" at the end.

## Structural gaps

1. **Rooms are per branch; real teams work one branch per person.** A session joins
   `<host>/<owner>/<repo>/<branch>`. When everyone is on their own feature branch, everyone is
   alone and Room does nothing. The PR mirror only helps people sitting in the target branch's
   room. Fix: one room per repository (or per area), each participant carrying their own base
   commit, merges and conflict checks computed against the merge base. Per-person base tracking
   already exists (`setBaseOf`, `mergeBase` in the conflict watcher), so this is a redesign of
   room naming and conflict logic, not a rewrite.
2. **Every client syncs the whole document.** One Y.Doc holds the full text of every changed
   file for every person, base texts, claims, the bus and graph snapshots; every agent process
   and browser tab downloads and keeps all of it. Fix: a small index document everyone syncs
   (presence, scopes, claims, messages, file list with hashes and sizes) and file contents
   fetched on demand. This also enables path-only sharing and per-directory access control.
3. **The symbol graph is name-based and capped at 3,000 files.** A use of `total` links to every
   file defining a `total`; in a large codebase that makes contract notices noisy. Fix: resolve
   imports (tree-sitter or a language server), or read an existing index (SCIP), and scope the
   index to the declared area instead of the whole repo.

## Sharing rules (smaller, can ship before the structural work)

Layered, in order of authority, never silent:
1. `.gitignore`: never shared (already true).
2. `.roomignore`: never shared (already true).
3. `.gitattributes` marks a file generated, vendored, binary or no-diff: share path-only
   (changed, by whom, size; no text). Conflict detection on the path still works.
4. Size fallback: untracked files over about 100 KB, and any file over the per-file cap, become
   path-only instead of skipped.
5. Every path-only decision is reported once to the agent and shown in the browser.
Origin: an untracked 31,871-line CSV in a repo with no ignore rules hung the code view
(2026-09-21). The view is now bounded; this is the upstream half.

## Orchestration (a lead with workers)

Seen in a real 17-worker session on 2026-09-21: the lead spawned, broadcast and answered well,
but never called `room_wait`, never previewed a merge and integrated by copying folders. The
`room-workers` skill (0.7.0) now spells out the finish. Beyond what a skill can fix:
- **A finished worker cannot take new instructions.** Headless workers are one-shot; the lead
  spawns a follow-up. A `room_spawn` that resumes a worker's session in its worktree would fix it.
- **Quiet workers are not flagged.** The lead learns of trouble only when it looks or waits. Flag
  a running worker with no edits, messages or tool activity for N minutes.
- **No lead summary.** `room_state` lists everything; a lead wants "3 done, 2 waiting on you,
  1 quiet" as the first lines, with the questions addressed to it.

## Less ritual

- **Claim only where someone is near.** With company, an agent claims before every edit; two
  agents under `api/` produced eleven claim/release/announce rounds for one-line edits. The
  before-edit hook already knows others' scopes, claims and changed files, so it can say "nobody
  is near this file, no claim needed" and ask for a claim only on overlap. Keep the scope call.
- **Suggest `.roomignore` entries, once, by rule.** At first sync the daemon flags shared files
  that look like data or generated output (the same detection as path-only sharing); the join
  reply carries one line naming them and the entry to add; the agent relays it and writes the
  line on a yes. Never edit `.roomignore` unasked; stay silent when nothing matches. The rule
  lives in the daemon, not in the model's judgement.

## What an enterprise would ask before installing

- **Permission checks beyond GitHub.com.** Only GitHub.com rooms verify push access. On GitHub
  Enterprise, GitLab or Bitbucket, anyone who passes single sign-on can enter any repo's room.
- **Secret redaction.** The daemon broadcasts uncommitted text; scan before publish.
- **Mixed plugin versions in one room.** The document has no schema version; add one and a
  compatibility rule, since clients update at different times.
- **Server operations.** One process, one machine, one volume; a deploy drops every connection.
  Needs room-to-node affinity or a Redis-backed sync layer, backups, metrics, rolling deploys.
- **Claude Code wake-ups need a research-preview flag.** Needs Room on Anthropic's channel
  allowlist; a conversation, not code.
- **Scale limits degrade by truncation.** File watcher on very large trees, the 8 MB sharing
  budget during a mass codemod, the graph cap. Scoping the daemon to the declared area of work
  addresses all three.
- **Platforms.** Windows, sparse checkouts, submodules and LFS are untested.

## Housekeeping

- **CI.** Nothing runs the test suite on push. Add a GitHub Actions workflow (typecheck, tests,
  web build, plugin bundle is up to date).
- **Published server image** (see decisions, 2026-09-16): multi-stage Dockerfile, GHCR on tags.
- **Hook at the point of decision** for built-in subagents: only if trials show agents picking
  built-in subagents for parallel edits. The phrasing check on 2026-09-21 was six of six after
  one tool-description change, so it is not needed yet.

## What decides the order

The trial. If Kieran and Hrishi each work on their own branch, gap 1 is confirmed as first. If
they find notices noisy, gap 3 moves up. If nobody outside friends is asking, the enterprise
list waits.
