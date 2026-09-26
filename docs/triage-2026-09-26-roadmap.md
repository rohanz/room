# Roadmap triage, 2026-09-26 (main e916670, 0.16.10)

A read-only pass over every open roadmap item: fixed (with proof), still real (with evidence), obsolete or
unverifiable. Probes in the session scratchpad; five suites plus targeted cases run, all passing.

## Still real, ranked for a three-person trial on one shared branch

1. **Claims are not revalidated after HEAD moves.** FIXED in 0.16.12 (c143ac2). roomd never touches claims (only release, done and the
   bridge call removeClaim, claims.ts:109,132). After a commit, clearOverlay drops the anchor text and
   claimRange falls back to the stored lines (doc.ts:362-378); a probe left a claim on a.py:10-12 open as
   {from:10,to:12}. Line ranges end up on different code and teammates get claim warnings for it. Fix: in
   pollHead, re-anchor against the new HEAD or release with a note.
2. **A note without a recipient reaches nobody unless it is interrupt priority.** FIXED in 0.16.12 (688f820). messages.ts:44 marks
   notes inbox:false and messageForMe returns false before checking priority (messages.ts:83); probe for
   rohanz+w1: fyi false, notify false, interrupt true. "Tell everyone X" lands only in the feed.
3. **A restart while the old process lingers renames you permanently.** FIXED in 0.16.12 (d9ee630). session.ts:318-323 moves you to
   +<host> and rememberTag (:337) saves it; later starts try it first (auto-tag.test.ts:143,151).
4. **Answers reach only the asker** (AnswerMsg has one `to`, messaging.ts:192).
5. **A preview without `run` says "merges cleanly" with no typecheck or tests** (FIXED in 0.16.12 (688f820): the reply says no tests ran and names the test command); only the skill mitigates it.
6. **An unreachable server's sharing ceiling is cached as `full` for the process** (FIXED in 0.16.12 (d9ee630)) (session.ts:214-223).
7. **Declared-sharing output is lost on restart** (FIXED in 0.16.12 (d9ee630)): retainedDeclaredPaths is in memory only (roomd/index.ts:260).
8. **room_state's recent bus is the last 10 messages by time, not ranked**, and has no lead summary line.
9. **Hook state is per worktree, not per session** (before-edit.mjs:33-35): a second session in the same
   folder gets no inbox or claim context.
10. **With no remote, a local commit says "ahead of base (unpushed): git push"** (FIXED in 0.16.12 (688f820)) (git.ts:209, roomd:735).
11. **`room`-authored notes and pr#<n> records are forgeable** (readonly.ts:141-146,259); the server keeps a
    second in-memory copy per room (readonly.ts:163-206). Low risk among trusted members.
12. Lead and batch items: quiet-worker detection is only a label; detached background leads and observer
    join are not built; preview with `run` materialises the full tree (files.ts:333); link inputs treat `\`
    as a separator (repo-path.ts:26); a Codex lead gets the missing-hook note after 2 calls and 30 s even
    with no edits (hooks-bridge.ts:470-476).
13. Not built: layered sharing rules 3-5 (gitattributes, path-only), .roomignore suggestions, machine load in
    room_state, a published server image, the Codex app-server mid-turn experiment.

## Fixed (roadmap can mark these)

Em dash corrupted by preview (0.15.1, a2f2f9a; tools.test.ts:831, collect.test.ts:933); preview env leak
(0.10.2, 59c147a; ROOM_* stripped, tools.test.ts:957); verdict trusts exit status (0.10.2, testVerdict +
pipefail); note shows no recipient (0.13.0); bare worker tag as addressee (0.10.2; notices.test.ts:70,81);
Codex hooks message to a Claude lead (0.10.2, bc0a335); every wake twice (0.15.1); eval mocks stale (0.15.1,
b57b3fb); workers finishing before review (0.15.0 resume); directory claims blocking others (0.10.2);
busy worker not seeing questions (before-edit hook delivers unread each tool call); recovery patch for landed
work (0.14.1); hook warning at spawn for Claude (0.14.1); committed files still read uncommitted (overlays
reseed against own HEAD); sharing banner repeated (0.10.1); measure on real repos (measure-room-perf.mts).

## Obsolete or unverifiable

Obsolete: "collected worker cannot take a fix-up" (by design since 0.15.0). Unverifiable: plugin web files
listed as uncommitted; full-suite hang with two suites (likely the fixed hash-object freeze); fyi noise on
narrowed claims; Python dotted-import narrowing in carried contracts; worker contracts never confirmed;
Codex worker git-dir sandbox access; the demo script end to end.

Big design items: repository-level rooms, the index document, more harnesses, the enterprise list, tasks
from issues and audit finding 28 are all open and not started.
