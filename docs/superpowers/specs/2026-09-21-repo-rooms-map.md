# Map for repository-level rooms: where the branch is load-bearing

Produced 2026-09-21 by a read-only exploration of main at 0.10.0, as input to the design. Line numbers drift; treat them as pointers.
One finding is already fixed: `githubRepoOf` now accepts a name with no branch (risk d.2).


(Paths are relative to the repo root. I ignored the checked-in stale `dist/` trees — `packages/*/dist/*.js` mirror the same code and will regenerate.)

---

## 1. Room naming: construction, parsing, encoding, comparison

### The canonical shapes
- `packages/shared/src/views.ts:6` `roomNameParts(roomName)` — the one shared parser. `local/<repo>/<branch…>` (branch = `parts.slice(2).join('/')`), `github.com/<owner>/<repo>/<branch…>`, `git/<host>/<owner>/<repo>/<branch…>`. Falls back to `{repo: roomName, branch: ''}`. Everything human-facing goes through it.
- `packages/server/src/names.ts:24` `repoOf(roomName)` — strips the branch by slicing a *fixed segment count*: `parts.slice(0, startsWith('github.com/') ? 3 : startsWith('git/') ? 4 : 2)`. This is the server's "repo of a room".
- `packages/server/src/names.ts:5` `roomNameOf()` / `:3` `docNameOf()` — decode up to 3× (browsers double-encode); the decoded full name (with branch) is the doc key.
- `packages/server/src/names.ts:12` `githubRepoOf()` — regex `^github\.com\/([^/]+)\/([^/]+)\/` **requires a trailing slash**, i.e. requires a branch segment to exist. A bare `github.com/o/r` room name would return `undefined` and fall through to the non-GitHub admission branch. **This is a security-relevant landmine for the rename** (see risks).
- `packages/room-mcp/src/prs.ts:106` `branchOf(roomName)` — the mirror of `repoOf`, same fixed-slice trick, returns the branch tail.

### Name construction
- `packages/room-mcp/src/session.ts:187` `deriveRoomName(dir)` → `` `${gitOrigin(dir)}/${gitBranch(dir)}` ``. The single place a team room name is born.
- `packages/roomd/src/local.ts:25` `localRoomName(dir, localBranch?)` → `` `local/${basename(mainWorktree)}/${branch}` ``, branch read from the **main worktree**, so every worktree of a clone shares one name (this is the existing per-participant-branch precedent — see §4).
- `packages/room-mcp/src/session.ts:437` `normalizeLocalRoomName()` — prefixes `local/`, strips unsafe chars; explicit local names bypass branch derivation entirely.
- `packages/room-mcp/src/session.ts:380` `roomUrl = `${server}/${encodeRoom(roomName)}``; `:270-271` `encodeRoom`/`decodeRoom` = `encodeURIComponent`/`decodeURIComponent`.
- `packages/room-mcp/src/session.ts:409` and `:465` build `browserUrl` with the encoded roomUrl.
- `packages/roomd/src/index.ts:133` `splitRoomUrl()` — `parts.pop()` off the URL path to get the room name.
- `packages/room-mcp/src/session.ts:282` inside `startAutoTaggedRoomd`: `url.pathname.slice(0, url.pathname.lastIndexOf('/'))` to peel the room off the server URL for the identity probe.
- `packages/agent/src/cli.ts:10,40,46` — `deriveRoomName` + `encodeRoom`; `roomName = u.pathname.replace(/^\/+/,'')`; printed at `:72`.
- `packages/web/src/conn.ts:17-31` `roomLocationFromUrl` — `lastIndexOf('/')` split into `encodedRoomName`/`displayRoomName`/`serverUrl`.
- `packages/web/scripts/seed-scale.ts:17-18` seeds `sample/atlas-commerce/preview-<ts>` (a 3-segment fake "branch").

### The `lastIndexOf('/')`-strips-the-branch idiom (each is a "repo of a room" helper inlined)
- `packages/room-mcp/src/tools/join.ts:38` — `teamSharingNote`: `s.roomName.slice(0, lastIndexOf('/'))` to name the repo in the disclosure line.
- `packages/room-mcp/src/tools/join.ts:133` — `NoRoom` recovery: `github.com/` → `split('/').slice(1,3)`, else `slice(0, lastIndexOf('/'))`.
- `packages/room-mcp/src/tools/join.ts:205,208,212` — `room_close`: derives `repo` the same way for the message "closing the room for `<repo>`: every branch room…".
- `packages/room-mcp/src/tools/index.ts:63` — closed-room error: `rn.slice(0, rn.lastIndexOf('/'))`.
- `packages/room-mcp/src/session.ts:548,568` `authFor`/`refreshBrowserUrl` — `s.roomUrl.slice(0, lastIndexOf('/'))` to recover the *server* (not the repo) — these are safe under a rename as long as the name stays one URL segment.
- `packages/room-mcp/src/tools/join.ts:36,98` and `packages/room-mcp/src/tools/scope.ts:72` — same server-recovery idiom.

### Name comparison / keying
- `packages/room-mcp/src/tools/join.ts:99` — `targetRoom === cur.roomName` decides "already here, no move".
- `packages/room-mcp/src/registry.ts:101` `byName(roomName)`; `:39` `workerIdBase(roomName, lead, tag)` = `` `${roomName}|${lead}/${tag}` ``; `:154,167` reservation keys `'discard:'+s.roomName+':'+w.name`; `:221` `hkey = `${s.roomName}|${id}``. **All worker handles/ids are keyed by room name.**
- `packages/room-mcp/src/prs.ts:115` — ledger default path `.room/ledger/${s.roomName.replaceAll('/','_')}-<ts>.md`.

### Docs/README claims about per-branch rooms
- `README.md:11` "**Team rooms are currently per branch: teammates must use the same branch.**"
- `README.md:26-27` local room named `local/<repo>/<branch>`; `:135-139` "every branch of that repo has a room … `github.com/<owner>/<repo>/<branch>` … teammates must use the same branch"; `:337` PR mirror described as "targeting the room's branch"; `:411` "must be opened once before its **branch rooms** accept connections".
- `docs/onboarding.md:31-32` "**Teammates must be on the same branch:** team rooms are currently per branch. Removing that boundary is planned next."
- `docs/decisions.md:145-155` the 2026-09-14 decision "Rooms are opened per repo, joined per branch"; `:350` "Rooms remain per branch".
- `docs/roadmap.md:27, 42-48, 76-79` — already states the intended design and explicitly names the worker precedent: *"(they sit on `room/<tag>` branches inside the lead's room), so most of the machinery exists"*.
- `plugins/room/skills/room-join/SKILL.md:21-25,36,39` — "derives the room from the git origin and branch"; "every branch then has a room"; and the hard rule **"Do not work in the room on a different base."**
- `plugins/room/skills/room-etiquette/SKILL.md:37` — "`room_close` removes all branch rooms of a repo".
- `scripts/demo.sh:44` — "branch rooms derive from the clone, e.g. `local/origin/main`".

---

## 2. Branch following

- `packages/room-mcp/src/tools/join.ts:226-248` `followBranch()` — the whole mechanism. Today it: reads `git rev-parse --abbrev-ref HEAD`; compares to `roomName.slice(lastIndexOf('/')+1)`; if different, **leaves the room and joins `<repo>/<newbranch>`**, releasing all claims (`cleanupMine`), and returns a banner:
  `[room] your clone switched to branch X: left <old>, joined <new>. Scope and claims were reset; declare a scope before editing.`
  Guards: returns `''` when there is no session, the name has no `/`, or `s.pinnedRoom` is set (explicit `room=`, `ROOM_ROOM`, or any local room — `session.ts:484` sets `pinnedRoom: true` for every local session, so **local rooms never follow the branch today**).
- `packages/room-mcp/src/tools/index.ts:64` — `followBranch()` is called **before every single tool dispatch**; its return is prefixed to the tool reply (`:73` `const prefix = moved ? ... : ''`).
- `packages/room-mcp/src/tools/context.ts:105` / `:383` — the `followBranch` slot on `HandlerState`.
- **"Refuse to move rooms while workers are running"**: `packages/room-mcp/src/tools/join.ts:102-103` in `room_join`:
  `error: N worker(s) are running in <room>; they would be left behind. Wait for them, room_collect(discard=true) them, or stay in this room.`
  Note `followBranch` itself does **not** perform this check — an automatic branch switch can strand workers. (Related: `room_leave` has its own running-worker guard at `join.ts:178-180`.)
- `packages/roomd/src/index.ts:542` — the daemon re-reads `this.branch = await gitBranch(dir)` on every HEAD move, and `:572` writes `branch` into room `meta` on base advance.

---

## 3. Base tracking

### Schema (`packages/shared/src/doc.ts`)
- `:139-144` `baseTexts` — Y.Map `'basetext'`, **keyed `"<sha>:<path>"`**. Already sha-scoped, so multiple bases coexist fine. Write-once (`if (this.baseTexts.has(k)) return`).
- `:147-149` `bases` — Y.Map `'bases'`, **keyed by person**; `baseOf(person)` falls back to `meta.base`; `setBaseOf(person, sha)`.
- `:285` `meta.base` — the single room-wide base, plus `meta.branch`, `meta.repo`, `meta.seededBy`.
- `:129` retirement clears `bases[name]`.
- `packages/shared/src/types.ts:97-98` `BaseMsg { base, prev, commits, paths, summary }`; `:136-138` `Worker.branch` + optional `Worker.base`.

### roomd's decisions (`packages/roomd/src/index.ts`)
- `:245-252` start reads `gitBranch`, `gitHead`, `gitOrigin`, `gitTracked`.
- `:259` `setBaseOf(this.name, this.base)` — every participant always publishes its own HEAD.
- `:260-272` **the blocker**: if `meta.base` exists and differs, it computes `gitRelation`; `ahead`→advance, `behind`→log, otherwise **`setStatus('error: …')` and `throw new RoomdError(…, 2)`**:
  `local HEAD <x> has diverged from room base <y> — rebase or merge onto the room base, then $room-join`
  `room base <y> is not in this clone (local HEAD <x>) — git pull, then $room-join`
  Two people on two feature branches are *always* `diverged` ⇒ the second one **cannot join at all**. This is the single hardest change.
- `:273-281` first joiner seeds `meta` with `{repo, branch, base, createdAt, seededBy}` — i.e. the room base is "whoever got there first".
- `:528-550` `pollHead()` (every `basePollMs`, default 3 s): on HEAD change re-reads branch/tracked, `setBaseOf`, re-seeds overlay, maybe advances the room base.
- `:554-565` `maybeAdvance()` — only advances if `gitIsOnRemote(to)`, else status `'ahead of base (unpushed): git push'`.
- `:567-576` `advanceBase()` — sets `meta.base`+`meta.branch` and posts a `BaseMsg`.
- `:579-589` `refreshBaseStatus()` — the labels: `synced`, `behind base by N commits: git pull`, `ahead of base (unpushed): git push`, `behind base (fetch): git pull`, `diverged from base: git pull`.
- `:677-746` overlay publication: diffs disk against **`this.base` (own HEAD)**, and `:746` `setBaseText(this.base, relpath, base)` — so each participant already uploads base text under its own sha. **Overlays are already per-participant-base deltas.**

### Consumers
- `packages/room-mcp/src/tools/context.ts:300-306` — `base(s) = s.room.meta.base ?? 'HEAD'`; `baseFor(s, person)` = worker's `w.base` → `room.baseOf(person)` → room base; `baseText` reads `gitShow` at that per-person base.
- `packages/room-mcp/src/tools/context.ts:309-317` `liveText` — person's overlay over their own base; throws `NeedFetch(person, baseFor(...))` when their HEAD isn't in this clone.
- `packages/shared/src/messages.ts:44` — the "moved the base" wake line: `<who> moved the base to <sha> (+N commits: <summary>) — git pull to catch up`; wakes everyone with uncommitted work.
- `packages/shared/src/views.ts` `ParticipantInput.roomBase`/`basesByPerson` and `:behindBase = Boolean(roomBase && ownBase && ownBase !== roomBase)` — a pure inequality, so on a repo-level room *everyone on a different branch reads "behind base"*. Rendered by `packages/web/src/panels.ts:110` and `:157-158`.
- `packages/shared/src/views.ts:326` and `packages/web/src/conflicts.ts:60` — conflict spans resolved as `'base moved'` and `hidden: true` when a `base` message matches the current room base.
- **What happens today with different bases**: outside worker worktrees it effectively cannot happen — roomd refuses to start. Within the merge tools it *is* handled (§4).

---

## 4. Conflict and merge logic — already per-participant

This is the good news; the design can lean on it.

- `packages/room-mcp/src/conflicts.ts:61-75` `mergePath()`:
  ```ts
  const myBase = d.baseFor(d.me.name), theirBase = d.baseFor(person)
  let ancestor = myBase
  if (theirBase !== myBase) {
    try { ancestor = await d.mergeBase(myBase, theirBase) } catch { return { status: 'unknown', lines: [] } }
  }
  ```
  **Exactly the target semantics.** `mergeBase` is declared at `:28` ("throws when one is not in this clone") and wired at `packages/room-mcp/src/tools/claims.ts:191-192`.
- `packages/room-mcp/src/conflicts.ts:281` — merge memo hash already includes *both* bases, so a base move invalidates it correctly.
- `packages/room-mcp/src/conflicts.ts:218` `checkOverlap` uses only **my own** base — correct as-is.
- `packages/room-mcp/src/tools/combined-tree.ts:33-39` (`room_preview_merge`, `room_collect`): folds every participant's base into one ancestor via repeated `git merge-base`, with the honest failure `"<person>'s HEAD <sha> is not in this clone; git fetch, then retry"`. `:50` diffs each worktree against that ancestor; `:53-55` adds paths from `merge-base..their-base` so *committed-but-not-shared* work on their branch shows up. `:100` prints `common ancestor <sha>`.
- `packages/room-mcp/src/tools/collect.ts:158-167` overrides `baseFor` with live `rev-parse HEAD` per worker and reuses the same engine.
- **Worker precedent** — `packages/room-mcp/src/workers.ts:211-224` `prepareWorktree`: worktree `.room/workers/<tag>` on branch `room/<tag>`, recording `base = rev-parse HEAD` at creation. `:324` collection falls back to `git merge-base HEAD <branch>`. Workers join the **lead's** local room (`packages/room-mcp/src/tools/workers.ts:189-197` `ensureWorkersRoom` → `doJoin({server: LOCAL})` → `localRoomName` from the *main* worktree), so a worker on `room/<tag>` is already a participant in a room whose name says a different branch, carrying its own base via `Worker.base`. Their roomd instance does not trip the divergence throw only because the worktree starts at the lead's HEAD; subsequent worker commits land in the `ahead`/unpushed path, not the `diverged` path.
- `packages/web/src/merged.ts:73` `classifyNWay(base, participants)` — takes **one** base string for all participants.

---

## 5. Local persistence keyed by room name

- `packages/relay/src/memory.ts:9-11` `memoryFile(commonDir, room)` = `<git common dir>/room-local/<encodeURIComponent(room)>.ydoc`. Load `:14`, atomic save `:31`, `forget()` `:92` (`room_close` on a local room). 5 MB cap.
- `packages/relay/src/index.ts:66` per-connection doc key `encodeURIComponent(decodeURIComponent(path))`; `:126` `LOCAL_FILE = 'room-local.json'` (discovery + relay key, 0600); `:206` `docs.get(encodeURIComponent(room))`; `:347` `/memory?room=<encoded>`.
- `packages/room-mcp/src/choice.ts:15` `room-choice.json` in the git common dir — holds `where`, per-worktree `tags`, and `warned` keys. `:69` tags keyed by worktree path; `:80` warned keys `resolve(worktree) + '#' + destination` (destination = **server**, not room) — so the sharing disclosure survives a rename.
- `packages/roomd/src/room-file.ts:8-10` `<git dir>/room.json` (`{room, name, dir}`) — the private per-clone record of the joined room name; `packages/room-mcp/src/session.ts:175` `findRoomFile` walks up for it.
- `packages/room-mcp/src/config.ts:63` reads `room-choice.json`; `:102` room precedence `args.room ?? ROOM_ROOM ?? URL path`; `:130` `<git dir>/room-session.json`.
- `packages/room-mcp/src/prs.ts:115` ledger filename embeds the room name.

---

## 6. Server side

- **Open** — `packages/server/src/index.ts:223-233` `POST /rooms`: admits, then keys the registry by `repoOf(roomNameOf(room))`. Already repo-level: `{by, at, branches: []}` (`packages/server/src/store.ts:11` `OpenRepo`).
- **Admit a branch room under it** — `index.ts:354-383` on websocket upgrade: `roomName = roomNameOf(url.pathname)`; `accept()` requires `rooms.has(repoOf(roomName))` (`:355`); `noteBranch()` (`:103-109`) appends the full room name to `r.branches`; refusal is `404 Not Found: no room for <repo> yet` (`:97`, `:373`).
- **Doc keys** — `docs` map keyed by the full decoded name including branch (`index.ts:313`, `docNameOf`). Persistence: `store.ts` Level/File/Pg all key by that same doc name; `index.ts:137` `clearDocument(name)` per branch room.
- **Caps** — `index.ts:310-314` `docMeter(roomName)` and `:360-361` `capLogged` are **per branch room**: `refusing writes: room <name> is X MB (cap Y MB)`. Collapsing rooms multiplies per-doc size by the number of branches.
- **View keys** — `index.ts:234-246` `POST /view-token`: `viewTokens.set(view, {room: roomNameOf(room), exp})`, TTL-checked; `:377` a view token admits read-only iff `v.room === roomName` — i.e. **exact full room name including branch**.
- **Close** — `index.ts:124-141` `closeRepo(repo)`: unions `r.branches` with every live `docs` key whose `repoOf` matches, drops connections with ws code 4001 "room closed", deletes persisted docs, purges view tokens (`:131`). Logs `room closed: <repo> (N branch room(s))`.
- **Idle expiry** — `index.ts:113-120`, per repo, `repoOf(n)` over doc names.
- **Audit** — `index.ts:363` `audit({event:'join', room: roomName, …})` records the **branch-level** name; `:220,231` room_opened/room_closed record the repo. `store.ts:17` `AuditEntry.room`.
- **Admission is already repo-granular** — `packages/server/src/admit.ts:50-78`: `githubRepoOf(room)` → push-access check on `owner/repo`; the branch is never consulted. `index.ts:207` even fakes a branch (`` `${repo}/x` ``) to reuse the rule for `GET /rooms`.
- **PR proxy** — `index.ts:254-270` `GET /github/prs`: derives the branch with `name.slice('github.com/<repo>/'.length)` and asks `github.openPrs(token, repo, branch, {head})`. `:272-290` `POST /github/pr-note`. `packages/server/src/github.ts` caches per repo+branch (60 s, see `packages/server/test/github.test.ts:59-68`).
- **PR mirror client side** — `packages/room-mcp/src/prs.ts:88-101` posts `room: s.roomName`; `packages/room-mcp/src/tools/prs.ts:17,26,42,66,70` all require `s.roomName.startsWith('github.com/')` and use `branchOf(s.roomName)` as the PR target/head branch; `prs.ts:186-187` renders `### Room ledger for \`<branch>\``.

---

## 7. Tests that encode per-branch naming

**Must be rewritten:**
- `packages/server/test/names.test.ts:6-14` — `docNameOf('/github.com%2Fa%2Fb%2Fmain')`, double-encoded variant, `local%2Fshop%2Fmain`; `repoOf('github.com/a/b/feature/x') === 'github.com/a/b'`, `repoOf('local/dir/main') === 'local/dir'`.
- `packages/server/test/server.test.ts:67-103` — "fake login -> open a github.com repo -> **join its branch room**"; `:74` `join('github.com/o/r/feature/x')` → 101 with the comment *"any branch of an open repo"*; `:90-103` local/token/session matrix all on `<…>/main` names.
- `packages/server/test/store.test.ts:13,18,26,103` — `saveRooms({'github.com/o/r': {branches: ['github.com/o/r/main']}})`, audit rows with branch-level `room`.
- `packages/server/test/admit.test.ts:5-6,66` — `GH='github.com/o/r/main'`, `LOCAL='local/dir/main'`, `admitted('github.com/any/repo/dev')`.
- `packages/room-mcp/test/local-naming.test.ts` — the densest one: `:27` default name `local/<basename>/main`; `:29-31` *"keeps a worker/bridge local name even when its branch differs"*; `:34-38` `ROOM_ROOM` pinning; `:96-97` the running-worker refusal text; `:109-110` the `moved from local/custom to local/<x>/main` banner; `:125-131`.
- `packages/room-mcp/test/local.test.ts:46-63` — `local/anything`, *"preserves an explicit local worker room across branch overrides"*, `roomName === local/<basename>/main`.
- `packages/web/src/panels.test.ts:73-83,109-123` — `roomNameParts` table including `['github.com/rohanz/room/main', {host, owner, repo, branch:'main', local:false}]` and `['local/room/main', …]`; header chip rendering asserts the branch chip.
- `packages/roomd/test/roomd.test.ts:476-486` — *"a diverged clone is refused with a rebase hint"*, `expect(error.message).toContain('diverged')`. **This test encodes the rule that must be deleted/inverted.** Also `:466-467,521` assert the exact `behind base by 1 commit: git pull` status strings.
- `packages/room-mcp/test/prs.test.ts:148,218` — `roomName: 'github.com/o/r/feat/login'` drives `branchOf` in the rendered ledger header.
- `packages/room-mcp/test/conflicts.test.ts:28,47` — `roomName 'github.com/o/r/main'`, and `close` returning `['github.com/o/r/main','github.com/o/r/dev']`.
- `packages/room-mcp/test/workers.test.ts:178,309-315,432,511,584` and `packages/room-mcp/test/lead-bridge.test.ts:35,57` — the team-vs-workers-room split asserted via `local/x/main` vs `github.com/rohanz/x/main` pairs.
- `packages/server/test/github.test.ts:44-68,147` — "lists open PRs targeting the branch", "caches per repo+branch", "lists the PR whose head is the branch".

**Incidental** (room name is just an opaque string; a rename costs nothing): `packages/room-mcp/test/tools.test.ts`, `areas.test.ts`, `share.test.ts`, `hooks.test.ts`, `registry.test.ts`, `bridge.test.ts`, `consent.test.ts`, `notices.test.ts`, `retirement.test.ts`, `worker-memory.test.ts`, `runtime-presence.test.ts` — these use `'r'`, `'local/x/main'` etc. as labels only.

---

## 8. Anything that shows a branch to a human or agent

- `packages/room-mcp/src/tools/join.ts:144` join reply line 1: `joined <roomName> as <name> (base <sha10>, clone <dir>)` — roomName carries the branch.
- `join.ts:145` the move banner `moved from <old> to <new>; links to the old room no longer show this session.`
- `join.ts:39` team-sharing disclosure names the repo (already branch-stripped).
- `join.ts:187` `left <roomName>; released N claim(s)`; `:201,212` close messages.
- `packages/room-mcp/src/tools/scope.ts:70` OFFLINE line, `:72` `room: <roomName> — <where>; workers room: local (<name>, this machine only)`, `:73` `you: <name> in <roomName> (base <sha10>)` — **the first three lines of `room_state`**. `:148` PR lines "open PRs targeting this branch"; `:152` workers-room line.
- `packages/shared/src/views.ts:~workerLine` second line: `… · branch ${w.branch} …` in `room_state` worker listings.
- `packages/shared/src/messages.ts:44` the "moved the base" bus line.
- Browser header: `packages/web/src/panels.ts:988-999` — `roomNameParts` → `owner / repo` label + a `local` chip + a **branch chip** (`title=branch`) + `base <sha7>` + active count.
- `packages/web/src/panels.ts:110` the `behind base` status pill; `:705-707,729-730` the Compare/Merged tabs' base selection.
- `packages/room-mcp/src/prs.ts:186-187` PR-note heading `### Room ledger for \`<branch>\`` / "Generated … from `<roomName>`".
- `packages/agent/src/cli.ts:72` `[roomagent] <name>'s agent online in <roomName> @ <server>`.
- Skills: `plugins/room/skills/room-join/SKILL.md:21-25,36,39` (incl. the "Do not work in the room on a different base" rule), `room-etiquette/SKILL.md:37`, `room-workers/SKILL.md:21`.

---

# (a) Behaviour that must CHANGE, by package

**`packages/roomd`** — the critical path.
1. `src/index.ts:260-272` — delete/replace the divergence throw. Two people on different branches must both join. Needs a merge-base-aware relation instead of `gitRelation(base, roomBase)`.
2. `src/index.ts:273-281` — `meta.base`/`meta.branch` seeding: a repo room has no single base. Either drop `meta.base` to advisory ("default branch tip") or remove it.
3. `src/index.ts:554-589` `maybeAdvance`/`advanceBase`/`refreshBaseStatus` — "advance the shared base" is meaningless per-repo; a participant on a feature branch must not drag the room base, and the `behind/ahead/diverged` statuses must become relative to *their own* upstream, not to a foreign participant's HEAD.
4. `src/local.ts:25` `localRoomName` — drop the branch segment.

**`packages/room-mcp`**
5. `src/session.ts:187` `deriveRoomName` — drop `/${branch}`; keep branch as a *participant* fact (publish into presence/`bases`, which roomd already does).
6. `src/tools/join.ts:226-248` `followBranch` — must stop moving rooms. It becomes "re-seed my overlay/base and announce the branch change to the room" (and the `pinnedRoom` guard becomes moot). The claim-reset side effect should probably go with it.
7. `src/tools/join.ts:102-103` — the running-worker move refusal loses its main trigger (a branch switch no longer moves rooms); keep it for explicit `room_join` re-targeting.
8. `src/prs.ts:106` `branchOf(roomName)` + `src/tools/prs.ts:17,26,66,70` — the PR mirror must take the branch from **the participant** (`gitBranch(s.dir)` / presence), not from the room name. A repo room may have several relevant branches; decide whether `room_pr_note` targets *my* branch (probably) and whether the mirror unions all participants' branches.
9. `src/tools/context.ts:300` `base(s) = meta.base ?? 'HEAD'` — the last single-base fallback; each of its callers needs a per-person base or a merge base. In particular `src/tools/scope.ts:173` loads **CODEOWNERS at the room base** for area assignment.
10. `src/graph-index.ts:54,94,167` — the symbol index rebuilds on `meta.base` change and reads base text at `this.base` (room base). Must become own-HEAD-based.

**`packages/server`**
11. `src/names.ts:12` `githubRepoOf` — its `\/$` requirement breaks on a branchless name; must accept `github.com/o/r` exactly. `src/names.ts:24` `repoOf` becomes the identity function.
12. `src/index.ts:103-109` `noteBranch` / `store.ts:11` `OpenRepo.branches` — the branch list becomes vestigial; `closeRepo` (`:124-141`) simplifies to one doc.
13. `src/index.ts:310-314` per-room doc cap — one doc now holds every branch's overlays; the 5 MB local cap (`relay/src/memory.ts:7`) and `ROOM_DOC_MAX_MB` need re-sizing.
14. `src/index.ts:254-290` PR endpoints — `openPrs(token, repo, branch)` needs the branch from the request body, not parsed off the room name.

**`packages/web`**
15. `src/panels.ts:729-730` (Merged tab) picks `baseOf(people[0])` — **already wrong** with mixed bases and will now be hit constantly. Needs a real common ancestor, or a client-side "bases differ, showing against X" disclosure. `src/merged.ts:73` `classifyNWay` takes one base by signature.
16. `src/panels.ts:110` + `shared/src/views.ts` `behindBase` — `ownBase !== roomBase` must not mean "behind" for someone on a feature branch.

**`packages/relay`**
17. `src/memory.ts:9` snapshot path — old `<encoded local/repo/branch>.ydoc` files orphan on rename (see risks).

**docs/skills** — `README.md:11,26,135-139,337,411`, `docs/onboarding.md:31-32`, `plugins/room/skills/room-join/SKILL.md:21-39` (esp. "Do not work in the room on a different base"), `room-etiquette/SKILL.md:37`, `scripts/demo.sh:44`, and a new `docs/decisions.md` entry superseding `:145-155`.

# (b) Rename / format only

- `packages/shared/src/views.ts:6` `roomNameParts` — same function, `branch` becomes `''`; the branch chip in `panels.ts:993` just disappears.
- `packages/room-mcp/src/session.ts:270-271,380,409,465`, `roomd/src/index.ts:133`, `web/src/conn.ts:17`, `agent/src/cli.ts:46` — encode/decode/split are branch-agnostic; a shorter name changes nothing.
- All the `lastIndexOf('/')`-to-get-the-repo sites (`join.ts:38,133,205`, `tools/index.ts:63`) become `s.roomName` itself — pure simplification.
- `packages/server/src/admit.ts` — no logic change at all (already branch-blind).
- `packages/room-mcp/src/registry.ts:39,101,154,167,221` and `prs.ts:115` — keyed by room name; the key string just gets shorter.
- `packages/room-mcp/src/session.ts:437` `normalizeLocalRoomName`, `config.ts:102` `ROOM_ROOM` precedence — unchanged.
- `packages/roomd/src/room-file.ts` `room.json`, `choice.ts` `room-choice.json` — format unchanged.
- Server audit/view-token/doc keys — unchanged mechanically.

# (c) Existing machinery that already supports per-participant branch/base — reuse as is

1. **`RoomDoc.bases` (per-person sha) + `basetext` keyed `<sha>:<path>`** — `shared/src/doc.ts:139-149`. The document schema is *already* multi-base; nothing to migrate.
2. **roomd always publishes its own HEAD and diffs overlays against it** — `roomd/src/index.ts:259, 544, 677-746`. Overlays are already per-participant-base deltas.
3. **`baseFor(s, person)`** — `room-mcp/src/tools/context.ts:302-306`, with the worker-base override already in place.
4. **`mergePath`'s merge-base logic** — `room-mcp/src/conflicts.ts:61-75`. Literally the target algorithm, including the `unknown` bail-out when a commit isn't fetched.
5. **`buildCombinedTree`'s N-way ancestor fold + "diff ancestor..their base" path collection** — `room-mcp/src/tools/combined-tree.ts:33-39, 50-55`. Handles committed-on-their-branch work, which is exactly the new common case.
6. **The worker precedent end-to-end**: `workers.ts:211-224` (`room/<tag>` worktree + recorded `base`), `tools/workers.ts:189-197` (join the *lead's* room under a different branch), `tools/collect.ts:158-167` (live per-worker HEADs into the same merge engine), `workers.ts:324` (`merge-base HEAD <branch>` fallback).
7. **`NeedFetch`** — `context.ts:316` already gives the right UX for "their HEAD isn't in my clone", which becomes the dominant failure mode.
8. **Server admission, view tokens, open/close, PR push-access check** — all repo-scoped already (`admit.ts`, `index.ts:207,355`).
9. **`localRoomName` reading the *main* worktree's branch** — `roomd/src/local.ts:25-32`: the "several branches, one room" pattern already ships for worktrees.

# (d) Risks and surprises

1. **roomd refuses to start on divergence — `roomd/src/index.ts:265-271`.** Not a cosmetic check: it throws out of `start()`, so today the second person on a different branch simply cannot join. This is the change the whole redesign hinges on, and `packages/roomd/test/roomd.test.ts:476-486` asserts the current behaviour.
2. **`githubRepoOf` needs a trailing slash — `server/src/names.ts:12-15`.** `^github\.com\/([^/]+)\/([^/]+)\/` returns `undefined` for a branchless `github.com/o/r`. In `admit.ts:53-64` a falsy `repo` takes the **non-GitHub** path: with no `ROOM_TOKEN` and no login provider it returns `{ok: true}` — i.e. **renaming rooms to `github.com/o/r` without fixing this regex silently converts every GitHub room into an open room.** Highest-severity item in the whole map.
3. **Branch separation is *not* a permission boundary today, but teams may believe it is.** `admit.ts` never looks at the branch; `server.test.ts:74` explicitly asserts any branch of an open repo joins. What branch rooms *do* provide is *content* separation: separate Y.Docs, so branch X's uncommitted overlays are physically absent from branch Y's doc. Merging rooms removes that. Anyone with push access will now see uncommitted work from every branch in one document — including a release/secrets branch. The existing mitigation is `room_share` levels (`intent`/`declared`, `roomd` `share`/`shareMax`) and `.roomignore`, not room naming. This deserves an explicit callout in the design and probably a one-time disclosure (`choice.ts:78` `markWarned` already exists and is keyed by worktree+**server**, so it will *not* re-warn on the room rename — consider adding the room to that key).
4. **Silent state orphaning on rename:**
   - `relay/src/memory.ts:9` — `<common>/room-local/local%2Frepo%2Fmain.ydoc` will not be found under the new name; all local room history (timeline, retired workers) silently starts empty. No migration path exists today.
   - `roomd/src/room-file.ts` `<git dir>/room.json` holds the old room string.
   - Server-side: LevelDB/File/Pg docs keyed by the old branch names remain, un-GCed, and `closeRepo` will only find them via `r.branches` (which the new code would stop populating) — so **stop trimming `branches` before writing a migration**, or old docs become unreachable garbage that still counts against storage.
   - `packages/room-mcp/src/prs.ts:115` ledger filenames change shape.
5. **Doc size.** Every branch's overlays + `basetext` (one entry per `<sha>:<path>`, write-once and **never garbage-collected**, `doc.ts:141-144`) now share one document. With N participants on N branches, `basetext` grows ~N× and never shrinks. `server/src/index.ts:358-361` will start refusing writes (`refusing writes: room X is N MB`) and `relay/src/memory.ts:7` will skip local snapshots past 5 MB. Needs a basetext eviction policy.
6. **`behindBase` becomes permanent noise.** `shared/src/views.ts` computes it as `ownBase !== roomBase`; with no shared base everyone shows the `behind base` pill (`web/src/panels.ts:110`) and roomd sets presence status `diverged from base: git pull` (`roomd/src/index.ts:588`) — actively wrong advice for someone on a feature branch.
7. **`meta.base` has many quiet consumers** that will read a stale/arbitrary sha: `graph-index.ts:54,94,167` (symbol index), `scope.ts:173` (CODEOWNERS/area assignment — so *area membership* would be computed at a foreign commit), `web/src/network.ts:127` ("Snapshot is on an older room base"), `web/src/panels.ts:685,861,999`, `web/src/board.ts:67`, and the `'base moved'` conflict-resolution heuristic in `shared/src/views.ts:326`, which **hides conflict spans** when a base message matches the room base — with per-participant bases this could hide live conflicts.
8. **`followBranch` runs before *every* tool call** (`tools/index.ts:64`) and today silently drops claims and can strand running workers (it has no running-worker guard, unlike `room_join`). Whatever replaces it inherits that hot path; make sure the new version is cheap (it shells out to `git rev-parse` on every tool call already).
9. **`web/src/panels.ts:729-730` Merged tab uses `baseOf(people[0])`** — an existing latent bug that only survives because bases are forced equal. It will become the default rendering path.
10. **Workers' local room is derived from the *main worktree's* branch** (`roomd/src/local.ts:25`). Once the branch leaves the name, the lead's team room name and the workers' local room name become structurally identical strings differing only by the `local/` prefix; check `registry.ts` keying (`byName`, `hkey`, discard reservations) and `bridge.ts` team↔local pairing for accidental collisions.
11. **`room_close`'s user-facing contract** ("removes every branch room of this repo", `tools/join.ts:203,208,212`) and `closeRepo`'s log line stop being true; the message is what users consent to, so it must be re-worded in the same change.
12. **`docs/roadmap.md:42-48` already sketches this design** and names the worker precedent — worth reading before writing the spec so the two documents agree.
