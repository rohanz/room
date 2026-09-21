# Future work: Room on large production repos

Written 2026-09-21. Room today fits a small team on a shared branch. These are the known gaps
between that and a fifty-engineer production repo, in priority order. Nothing here is started.
Decide the order after the trial with real users; see "What decides the order" at the end.

## The design the gaps point at: cost scales with overlap

The gap list below says what breaks. This is the one idea that fixes most of it. Multiplayer
games call it area of interest: you receive only what is near you. Every agent already declares
a scope; today it is advisory. Make it the unit of everything.

**Three tiers of sharing**
1. **Facts go to everyone.** Presence, scope, the list of changed files with hash and size,
   claims, and contract changes at symbol level. A hundred engineers' worth is a few hundred
   kilobytes. This tier is what says "someone across the repo is changing a function you call"
   without shipping code.
2. **Text goes only where scopes overlap**, or where a contract change reaches your files.
3. **Everything else on demand**: `room_read` fetches a stranger's file at that moment.

**Git is already the shared content store.** Publish a patch against a commit the others have,
not the full file text. The receiver rebuilds the text from git plus the patch. Payloads shrink
by one or two orders of magnitude with no blob store and no new server. The same move fixes the
branch model: one room per repository, each participant carries a base commit, merges are
computed against the merge base that git finds locally.

**Falls out for free:** the daemon watches and indexes only the scope and its dependency
frontier (the graph cap and watcher cost stop mattering); path-only sharing is tier one without
tier two; per-directory access control becomes possible because text is exchanged by scope, not
broadcast; the browser loads the facts tier instantly and fetches text per opened file.

**Does not solve:** name-based symbol matching (needs import resolution) and the enterprise
list. **Build order:** patches against a base, then a room per repository, then scope-driven
watching and indexing.

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

## Found by the lifecycle batch lead (2026-09-21), next small batch

A Claude lead ran three Codex workers through a local room to build worker retirement. Seven
questions and six answers settled a shared record shape and a shared helper's signature; the
merge was clean. What got in the lead's way:
- A question to a worker that has already exited just times out. Tell the asker at once that
  the recipient has finished.
- `room_preview_merge` with `run` returns log lines but not the test runner's pass/fail summary.
- "Run only the files you touch" let intended behaviour changes break suites nobody owned. The
  preview could suggest tests that mention strings a worker changed.
- A finishing worker's full summary is repeated in every release line and in plan-cancelled
  interrupts. Say it once.
- A hook line described the lead as one of its own workers: the hook state file is confused when
  worktrees share a clone.
- "Idle" is wrong: it tracks file changes, not activity. Bump activity on every tool call (the
  before-edit hook and every room tool call), show "working" or "last action Nm ago", and let a
  lead flag a running worker with no action for several minutes.

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

## Browser view under load

Measured 2026-09-21 on a live room (8 participants, 88 changed files): heap 9 to 27 MB, about
4,700 DOM nodes, idle when the room is idle, median file open 17 ms. Memory is fine. CPU under
activity is not: every panel re-renders in full on every document update with no coalescing, and
the code pane re-runs the merge for the open file each time (542 ms for a 2,523-line file).
- Done in 0.7.0: one render scheduler, a memoised merge keyed by its input texts, and the
  large-file threshold lowered to 1,500 lines (258 long tasks down to none under a 200-update burst).
- A lead has no notion of how heavy its workers are beyond the thread budget (0.7.0); consider
  surfacing machine load in `room_state` for leads.

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
