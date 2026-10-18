# Documentation audit, Room 0.17.16 (2026-10-18, branch brief-slices, read-only)

Paths are under /Users/rohan/Documents/progwork/aitinkerhackathon/.

## 1. Concrete mismatches

| # | Doc (file:line) | What it says | What the code does (file:line) | Severity |
|---|---|---|---|---|
| 1 | docs/roadmap.md:43 | "Prune preview caches … never pruned" listed as open | LRU eviction shipped 0.17.0: packages/room-mcp/src/preview-cache.ts:14-17; unlock/remove/prune in packages/room-mcp/src/tools/files.ts:961-965; CHANGELOG.md:293; docs/reference.md:103 | stale |
| 2 | docs/roadmap.md:22 | "Detect running-versus-installed version mismatches before spawning workers or issuing links" open | packages/room-mcp/src/index.ts:76 "Room was updated on disk; restart this session"; prepended to room_state replies via tools/index.ts:84,248; room-join SKILL.md:44 documents it; CHANGELOG has no entry for it | stale (mark partly done) |
| 3 | docs/roadmap.md:48 | "Preview worktrees left locked after the lead quits" open | files.ts:961-965 unlocks/removes during eviction; reference.md:103 documents manual recovery | stale (verify crash case) |
| 4 | docs/reference.md:49-57 | Common tools table lacks `room_open` | tools/scope.ts:26, tools/index.ts:80; CHANGELOG 0.17.13 | missing |
| 5 | CHANGELOG.md:5-6 | Codex own-worker completion delivery + diagnostics | Code present (codex-app-server.ts:95, doctor.ts:114, wake-path.ts; changed in ee4a4a55) but overlaps 0.17.12 bullets at CHANGELOG.md:61-63; stray blank line at :7 | stale wording (low) |
| 6 | CHANGELOG.md:24 | "the graph rebuild budget is CPU time, not wall-clock" | Commit 61774576 touched only tests (graph-retention.test.ts, bridge.test.ts); graph-index.ts has no CPU budget | wrong wording (low) |
| 7 | docs/roadmap.md:24, :46 | Review-hold destination in status; claim clamp note | Still open, correctly: collection-review.ts:31-34 prints reviewer+reason only; claims.ts:57 clamps silently | accurate |
| 8 | docs/reference.md:95 | "exec-form arguments (Claude Code 2.1.139+)" | Only occurrence in repo; worker-shell-env.ts:7-12 cites 2.0.10, 2.1.286, Codex 0.146.0 | unverified (low) |
| 9 | room-etiquette/SKILL.md:99 | "introduced in 2.1.285" | Only occurrence; elsewhere 2.1.300 "verified" (reference.md:99, room-workers:50, worker-config.ts:144) | unverified (low) |
| 10 | reference.md / README / skills | Undocumented but implemented params: room_join(takeover,name,room,dir,server) join.ts:34,140; room_create(share,…) join.ts:32; room_login(provider=oidc,credentials,wait 90/600) join.ts:30,128; room_spawn(allowOutside,dir,share) workers.ts:54,217; room_preview_merge(includeOffline,person) files.ts:37,254; room_read(person,diff,cursor) files.ts:33,95; room_state(path,from,to) scope.ts:31; room_send(type="changed",paths,symbols,message) messaging.ts:33-44,174-177 while reference.md:31 says no changed message is needed; room_release(summary,done) claims.ts:15; room_done(pr_note) workers.ts:52; room_pr_note(number) prs.ts:9; room_export(path) join.ts:40; room_wait(timeoutMs 30000/100000) messaging.ts:16-17,46 | missing (low) |
| 11 | docs/onboarding.md:3,19-25,33 | Copies README.md:9, :37-43, :60 | Three copies of version numbers to keep aligned | duplicate |
| 12 | docs/upgrading.md:86 | "A v0.16.40 tag … if added later" | No such tag; also no v0.17.6–v0.17.15 tags despite CHANGELOG headings (AGENTS.md:126-127 says tag each release) | unresolved |
| 13 | AGENTS.md:126-127 release flow | Tag the release | v0.17.16 points at 61774576 (tests), two commits after "Release 0.17.16" ee4a4a55; b4fb2c52 and 61774576 each added a CHANGELOG line post-release; end state consistent (bundle and hooks/common.mjs:8 at 0.17.16) | process note |

## Verified consistent
Preview 5 min/4 MB/25 lines (files.ts:629,639,1189); carry 5 MiB/50 MiB (worker-git.ts:333) and scratch (worker-git.ts:545,582-583); keep rules (collect.ts:277-278); checkpoint arg rules (collect.ts:824-830); room_wait 30 s/100 s; defaults: 8 workers (config.ts:19), 7 stale days (:20), nice 10 (worker-config.ts:57), 4 GiB cache (preview-cache.ts:15), 512 KiB/8 MiB (roomd/src/index.ts:418-419), 5-min fetch window (roomd/src/base.ts:216), 7-day recovery patch (worker-registry.ts:1247), 3 s link (worker-deps.ts:14), 1 MB log (index.ts:46), 7-day view key (server/src/index.ts:109), 64 MiB cap (server/src/index.ts:145-149), 60 s cap retry (session.ts:955), .room/workers (worker-git.ts:15); 0.17.15 limits (parse/client.ts:37,39; graph-index.ts:18,21-23,39; relay/src/limits.ts:4-6); all 22 documented env vars exist; build-output list = shared/src/build-output.ts:3-6; host versions consistent across files; install commands match `claude plugin`/`codex plugin` help and manifests (all 0.17.16); doctor cache path real; CHANGELOG 0.17.16/0.17.15 entries all map to code (messaging.ts:391; worker-registry.ts:176-179; package.json:17; worker-shell-env.ts:69; files.ts:426,1189; worker-registry.ts:76; relay/src/memory.ts:72-74; conflict-set.ts:776; kept-publication.ts); nothing shipped since 0.17.15 is missing from the CHANGELOG except housekeeping commits.

## Merge/archive candidates
- docs/onboarding.md: fold unique paragraphs (:11-15, :27-31) into README "How people use it" and delete, updating links at README.md:45, docs/README.md:8, reference.md:3, submission.md:3; or trim duplicates.
- docs/roadmap.md: move "Fixed in 0.16.x" (:53-96) and "Found 2026-09-27" (:574-590) to docs/archive; mark :22, :43, :48.
- README.md:87-95 five dated validation records -> one archive link.

## Accurate, no change
README defaults table; reference.md Workers/Files/Env/Resource sections; upgrading.md commands; skills parameter usage; manifests; CHANGELOG 0.17.15 and 0.17.16 apart from the two wording notes. Uncommitted skill edits on brief-slices are prose only. decisions.md ends 2026-10-13, nothing contradictory.
