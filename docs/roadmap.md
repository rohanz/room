# Future work: Room on large production repos

Written 2026-09-21. Room today fits a small team on a shared branch. These are the known gaps
between that and a fifty-engineer production repo, in priority order. Completed work is marked below.
Decide the order after the trial with real users; see "What decides the order" at the end.

**Start here:** [is Room invisible?](audit-2026-09-21-invisibility.md) (two independent audits of 0.8.0 against the product's own standard) and [the audit of the longest real use](audit-2026-09-21-qube.md) ranks what real
use broke and proposes the order of work.

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

## Decided 2026-09-21: what a room is

**A room forms around the work.** Not around a branch (today's bug: teams with a branch per
person all sit alone), not around a folder (rejected: see below), and at scale not around the
whole repository either.

*Now, before the trial:* one room per repository. Each participant carries their own branch and
base commit; checks between two people use their common ancestor. Spawned workers already work
this way (they sit on `room/<tag>` branches inside the lead's room), so most of the machinery
exists. This is the overlap design below in the case where everyone is near everyone.

*Later, when someone with a very large repository needs it:* everyone is "in" the repository's
room in concept, but each session only ever receives the state of the people near it. "Near"
means one of two things: working on the same files, or a dependency between what they are
changing and what I am working on. Each participant publishes their own small document; others
subscribe to their neighbours' documents; the server keeps only an index of who is working on
what (paths and symbol names, never code) and tells each session who its neighbours are. Presence
is routed the same way: five thousand people announcing themselves every fifteen seconds to
everyone is over a million messages a second. Use the repository's real dependency graph where
one exists (the build system, a code index) instead of Room's name-based one, which connects
everything to everything through names like `get` and `Config`. Files that touch everything
(lockfiles, root configs, shared constants) must not count as overlap, or "near" means the whole
company.

*Rejected: folder rooms* (a checked-in file declaring a directory subtree to be a room). They miss
the collisions that matter most in a large repository (a payments engineer editing the shared
money library sits in the payments room, so the library's owners never see it), somebody has to
set them up, and the design above replaces them with no configuration.

*Continuity:* 0.9.0 introduced one rule for "someone is near this path" (`near.ts`, used by
`room_claim` and the before-edit hook). Keep it the ONE definition used for claims, notices, who
appears in `room_state` and who counts as company; scaling later then means moving that rule to
the server, not redesigning Room.

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
- **Quiet workers require a status check.** State already labels workers quiet after five minutes
  without activity. Proactive detection of a worker needing intervention remains open.
- **No lead summary.** `room_state` lists everything; a lead wants "3 done, 2 waiting on you,
  1 quiet" as the first lines, with the questions addressed to it.

## Found by batch leads using Room to build Room (2026-09-21)

Two batches ran as a Claude lead with three Codex workers in a local room. Both merged cleanly;
the workers settled shared record shapes and helper signatures through questions and plan lines.

**Fixed in 0.7.0 by the second batch:** a question to someone who has finished, been retired or
never existed is answered at once instead of timing out; a finishing worker's summary is said
once; hook state is resolved by session, not by working directory, so a lead is no longer
described as one of its workers; "idle" is gone (activity follows tool calls: "working",
"last action 4m ago", and for a lead's workers "running" / "running · quiet 6m"); merge previews
report the test runner's verdict; workers start at lower scheduling priority; read markers are
saved with a local room's memory.

**Still open after 0.8.0 (third batch lead and the live tests):**
- Labels compare against the room's base, not the last commit: after a lead commits locally its
  files still read "uncommitted, not yet pushed" and its branch "ahead of base: git push", even
  in a repo with no remote. Say "committed locally, not pushed" when the working tree matches
  HEAD, and drop the push advice when there is no remote.
- Hook state files (`room-state.json`, `room-hook-seen.json`) are per folder, not per session.
  Declined as out of scope in the 0.8.0 batch; it matters when two sessions share one folder.
- An answer reaches only the asker. A lead ruling on a shared signature had to repeat it to the
  second worker. Let an answer be addressed to several participants, or offer "answer and note".
- **Fixed in 0.9.0:** claims are required only where another participant’s work overlaps;
  routine releases and changed announcements are no longer required.
- Shared files (`types.ts`, `join.ts`, `prompt.ts`) had no named owner and cost the lead five
  rulings. A brief format or a `room_scope` convention for "shared, ask the lead" would help.
- A contract between two workers can be satisfied by the combined typecheck without either ever
  confirming it to the other. Fine when it compiles; invisible when it does not.
- **Fixed in 0.9.0:** wait-ending messages are not repeated in the inbox, requested collection
  commits have short subjects with details in the body, and quiet timeouts do not mandate a report.

**Earlier, still open:**
- **Fixed in 0.7.0:** a wait timeout with running workers says nothing needs you yet; it no longer
  asks you to supervise a healthy wait.
- `room_state`'s recent-bus section is dominated by claim and release lines; the lead had to run
  `room_export` to find the questions and answers. Rank questions, answers, notices and done
  messages above claim traffic, at least for a lead.
- After the lead committed, `room_state` still listed `plugins/room/web` files as uncommitted.
  Needs investigation: daemon staleness after a commit in the same clone, or an ignore rule.
- **Fixed in 0.9.0:** the company line uses participant names and current work, once per session.
- "Run only the files you touch" let intended behaviour changes break suites nobody owned (first
  batch). The preview could suggest tests that mention strings a worker changed.

## Less ritual

- **Done in 0.9.0: claim only where someone is near.** Hooks and tools use the same overlap
  rule over participants’ scopes, claims and changed paths; the initial scope declaration remains.
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

- **Done in 0.7.0:** GitHub Actions runs typechecks, tests, web/plugin builds and committed
  plugin asset freshness checks on pushes and pull requests.
- **Published server image** (see decisions, 2026-09-16): multi-stage Dockerfile, GHCR on tags.
- **Hook at the point of decision** for built-in subagents: only if trials show agents picking
  built-in subagents for parallel edits. The phrasing check on 2026-09-21 was six of six after
  one tool-description change, so it is not needed yet.

## What decides the order

The trial. If Kieran and Hrishi each work on their own branch, gap 1 is confirmed as first. If
they find notices noisy, gap 3 moves up. If nobody outside friends is asking, the enterprise
list waits.
