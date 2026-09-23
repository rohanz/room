# Future work: Room on large production repos

Written 2026-09-21. Room today fits a small team on a shared branch. These are the known gaps
between that and a fifty-engineer production repo, in priority order. Completed work is marked below.
Decide the order after the trial with real users; see "What decides the order" at the end.

**Start here:** [the full review of 0.10.0](audit-2026-09-21-review.md) (30 of its 33 findings fixed in 0.10.1, three partly; each is marked in the file), then [is Room invisible?](audit-2026-09-21-invisibility.md) (two independent audits of 0.8.0 against the product's own standard) and [the audit of the longest real use](audit-2026-09-21-qube.md) ranks what real
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

**Does not solve:** name-based symbol matching (now narrowed by imports for common names, but
still without type resolution) and the enterprise
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
3. ~~**The symbol graph only understands Python and JS/TS.**~~ **Done in 0.10.0:** the MCP
   indexer uses tree-sitter across the supported language set. A name defined in more than a
   handful of files (currently 5, held in a named constant) is narrowed with imports. The graph
   is still name-based and capped at 3,000 files: there is no type resolution, and method calls
   are matched by method name. A large repository can still need an existing index such as SCIP
   and an index scoped to the declared area rather than the whole repo.

## Sharing rules (smaller, can ship before the structural work)

Deferred from the 2026-09-22 readiness review:

- **Preserve finished `declared` output across completion and restart.** Persist the published-path
  boundary per worktree independently of the active scope, and use that boundary consistently for
  publishing, reads and previews. Remove its entries on deliberate withdrawal, clean integration
  or collection.
- **Do not cache an unavailable server sharing ceiling as `full`.** Distinguish a failed ceiling
  fetch from a legacy server with no ceiling field and refresh it on reconnect. The server ceiling
  will not change during the first trial, so this is deferred.
- **Revalidate claims after HEAD moves.** Release or redeclare unanchored claims after a base change
  rather than leaving their line ranges attached to different code. This is too risky to change
  immediately before the first trial.

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
- **Done in 0.13.0: background batches, with the lead as a worker.** Tested for real on
  2026-09-23: a headless top session handed a three-part job to a background lead. It spawned
  two Codex workers into worktrees nested under its own, collected them, ran the tests and
  finished. The top collected everything in one step; its own uncommitted work was untouched.
  A worker's workers share its advisory compute budget, split among them. The browser shows the
  lead-worker once, with its workers nested under it. Workers spawned by a `--plugin-dir` session
  run the installed `room@room` plugin, not the plugin-dir build. This run took about 80 seconds;
  whether a headless lead holds a `room_wait` loop for hours remains unmeasured.
- **Detached background leads.** A lead-worker still dies with the human's session: when that
  session ends, the lead-worker and its workers stop together and say "the lead's session ended".
  A new session sees them stopped and can take their partial edits by tag or discard them. A
  detached mode that survives the human's session remains open.

### Tasks from issues

Every batch today starts with a hand-written brief, while on a real team the intent already
lives in an issue tracker. Room already talks to GitHub (PR proxy, PR notes, device login), so
reading issues is the same plumbing. In order:
1. **An issue as the source of a scope.** "Take issue 212": the agent reads it and declares its
   scope with the issue attached. The room shows who is on which issue and warns when two
   people pick up the same one, or two issues that touch the same files. Cheap and invisible.
2. **A lead splits a set of issues.** "Work through the `v2-cleanup` label": the lead reads the
   issues, uses the dependency graph to decide which can run in parallel and which collide,
   and spawns one worker per issue with the issue text as the brief. The graph is what makes
   this more than a to-do list. Issues rarely name files, so this depends on the lead guessing
   well from text plus graph; the trial should show how well leads do that.
3. **Report back only when asked.** On collect the lead offers to open a PR that references
   the issue. Same rule as commits: nothing is posted to GitHub unless the human says so.

Rules: no autonomous triage (agents never pick up, comment on or label issues unprompted: an
agent posting on a team's tracker is the opposite of invisible, and is what gets a tool switched
off). Design for "a task with an id, a title and a body"; GitHub is only the first adapter
(Linear and Jira exist). Not before the trial; filing the trial's task cards as real issues on
the fork tests step 1 for free.

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

### From the tree-sitter batch (six Codex workers, 2026-09-21, open)

- **A worker deep in a long turn does not see addressed questions.** One worker ignored three
  askers for about ten minutes until the lead interrupted it. Questions should reach a busy
  worker at its next tool call, not at the end of its turn.
- **Directory claims block other people's own files.** A worker claimed a whole test directory
  and two others stopped on files that were explicitly theirs. Warn on, or refuse, a directory
  claim that covers files in another participant's declared scope.
- **A clean merge preview hid a semantic break.** Two workers shared `graph.ts` by region; the
  text merged cleanly, Room raised nothing, and one worker's change broke the other's tests.
  Preview should run typecheck and tests by default and report them next to "merges cleanly".
- **A collected worker cannot take a fix-up.** Cleanup removes it, so a defect found afterwards
  goes to the lead. Same root as "a finished worker cannot take new instructions" above.
- **Noise:** fyi messages about cancelled plans while a claim is being narrowed; the sharing
  banner prepended to tool output when tools are driven from a script.

### Uncommitted work and worker worktrees

**Fixed in 0.11.0–0.11.1:** Workers start with the lead's eligible uncommitted work,
and the worker prompt attributes carried paths to the lead. Lead-side previews and
collection use the recorded worker base; contract notices reach workers when the lead
changes or removes definitions they use.

**Fixed in 0.12.0:** Carry skips and reports oversized or unsafe paths and linked inputs,
keeps copied untracked files off ordinary worker branches, and retains a private base
for merging them. Spawn handles moving HEAD, Git config and hooks, failed startup and
occupied worktrees. Worker-side previews, live conflict checks, graph observations,
contract notices and the browser Merged tab use the worker's own base, preserving
the lead's carried ownership. Preview materialization no longer writes through an
archived symlink. Retirement retains ignored output or failed cleanup. Local joins
retry and explain failures, including after an explicit join; relay discovery
validates identity; changed-file seeding
and batch base reads remove the tracked-file join cost. Team workers publish a
fetchable base instead of their local carried commit.

Python dotted-import narrowing remains weak in carried contract checks. The broader
orchestration and sharing work above remains open.

### After 0.12.0 (2026-09-23, open)

- **The full test suite occasionally freezes.** Seen twice by the batch lead and once in the final
  check: one vitest worker sits idle forever. The same suite then passes in about 70 s. Suspects:
  a child process (relay, preview `git archive | tar`, a worker's vitest) outliving its test.
  Find it with `--reporter=verbose` the next time it happens, and give CI a global timeout.
- **Measure on real repos, not only fixtures.** The batch's join benchmark used 5,000 tracked
  files; the real failing repo had 399 tracked and 13 GB of untracked art. Keep a copy-on-write
  clone (`cp -Rc`) of one real, messy repo as the standing join and carry benchmark.

### From the carry-wip batch (four workers, two Codex and two Claude, 2026-09-23, open)

The busy-worker problem did not recur: every question was acknowledged within about a minute.
- **Kept worktrees for regenerable build output.** Collect kept three worktrees and listed about 35
  lines of ignored `dist/` and `*.tsbuildinfo` from the workers' own typechecks as artefacts worth
  keeping. The ignored-artefact rule should treat common build output like caches, or ask once.
- **Recovery patches for work that already landed.** Discarding an already-collected worktree still
  wrote a "recovery patch".
- **The before-edit hook warning fired at spawn**, before the lead had edited anything.
- **Broadcast rulings went out as `fyi`**, so the lead had to resend them as `notify`: a note to
  everyone from a lead should reach them.

### From the carry-hardening batch (seven workers, 2026-09-23, open)

- **A finished worker cannot take defects back.** `room_spawn` refuses a done tag until it is
  discarded, so review findings went to a second wave of new workers instead of the authors.
- **Answers did not reach a waiting worker.** The docs worker asked the same question three times;
  only a `to`-addressed interrupt note arrived. A done worker whose worktree was later discarded
  showed as "discarded", and a teammate read that as its work being dropped.
- **Kept worktrees and recovery patches for build output** (above) recurred for every worker.
- **Unhandled `EPIPE` in preview.** `materializeGitTree` pipes `git archive` into `tar` with no
  error handler on `tar`'s stdin; one full-suite run reported it as an unhandled error.
- **Full-suite runs hung twice when two suites ran on the machine at once** (a lead's and a
  worker's); alone, the suite passes in about a minute.
- **A restart while the old process lingers saves the tag `+agent`** permanently (`rememberTag`).

### From the review-fixes batch (eight Codex workers, 2026-09-21, open)

Recurred from the tree-sitter batch: a busy worker left three questions unanswered until the lead
ruled; a directory scope (`packages/room-mcp/test/`) was accepted without a warning; a collected
worker could not take a fix-up, so the lead patched a finding itself. The semantic-break problem
did not recur only because every preview was run with tests.
- **Preview leaks its environment into the tests it runs.** The MCP process's `ROOM_HOST` reached
  the test run, so one suite failed only inside previews.
- **Preview's verdict trusts the exit status alone.** A piped test command exited 0 while the
  runner printed failures, and the preview said "tests: PASSED".
- **A note sent to one recipient shows no recipient.** The sender cannot tell it was addressed.
- **A bare worker tag is accepted as an addressee.** The lead sent to `graph` instead of
  `rohanz+graph`; Room took it without complaint and it may have reached nobody. Resolve a bare
  tag to the sender's own worker, or refuse it.
- **"Hooks are not running… In Codex, approve them" was shown to a Claude lead.**
- Still open from the review itself: finding 6 (notices posted as `room` and `pr#<n>` records are
  still forgeable by a member; the identity guard keeps a second copy of each room document in
  server memory), finding 29 (finished output published at `declared` is lost on a restart after
  `room_done`, and collection does not withdraw it), finding 30 (the demo script was not run end
  to end).

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
