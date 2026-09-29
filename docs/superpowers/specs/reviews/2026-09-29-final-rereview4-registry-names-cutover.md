# Final fix-round re-review, round 4 — registry, names and cutover/config

**Range:** `git diff b66b9e3 9fb9581`; reviewed HEAD `9fb95817d44413a6b87ad4c0351f49bc6af7ff7e`, assigned fix `77311ea`.

**Counts: 4 RESOLVED / 0 PARTIAL / 0 NOT RESOLVED; 0 new must-fix / 0 new should-fix.**

Read-only re-review of round-3 N1–N4 against the redesign plan, repository-room spec §B1/§B2, naming map, rehearsal F1–F3, and the lead's explicit destination-precedence rulings. Bundle bytes and other review areas are excluded. The confirmed 0.16 transition window, private claim hash outside the area, claims kept on host exit, done-after-follow-up, and local carried reads remain accepted rulings. Only this report is retained; no source change, commit, or push.

| Assigned item | Disposition | Evidence |
|---|---|---|
| **N1 — create bypasses a remembered self-hosted URL** | **RESOLVED** | `packages/room-mcp/src/tools/join.ts:146` resolves the caller/environment/remembered choice before applying the create-only hosted fallback at lines 150–152. Checked-in HTTP-boundary tests and disposable handler probes confirm explicit URL > `ROOM_SERVER` > `ROOM_URL` > remembered team URL > hosted fallback. A remembered `hosted` or concrete URL does not beat `ROOM_SERVER`. No configured or remembered server creates on the hosted default. Remembered local choice also creates on hosted, and its saved local room-name override is discarded when deriving the repository name. No tested create destination is local. |
| **N2 — login/logout retains startup destination after moving** | **RESOLVED** | `join.ts:101` returns freshly resolved configuration; `join.ts:106` supplies it to `serverOf`; `join.ts:334` selects explicit server, then current session's concrete server, then fresh resolution. A disposable probe executes `room_join(where=<custom URL>)` through the actual handler with a successful stubbed join boundary, leaving startup config and `ROOM_SERVER` pointing at hosted. Subsequent bare login and logout target the joined custom server. An explicit login URL overrides the current session. With no session, a changed remembered URL overrides stale startup configuration. Logout removes only that server's credential and pending login, sends only that server's session to `/auth/logout`, and preserves the other server's entries. A caller-selected credential file is honored independently; the original file remains intact. |
| **N3 — Codex drops `ROOM_WAKE`** | **RESOLVED** | `plugins/room/codex-mcp.json:45` adds `ROOM_WAKE`. The added launch-behavior test at `packages/room-mcp/test/codex-env.test.ts:29` and the disposable repro both project `ROOM_WAKE=channels` through the actual manifest and verify that the resulting Claude command includes `--dangerously-load-development-channels`. This matches the consumer at `packages/room-mcp/src/worker-launch.ts:87`. Manifest environment names are valid and unique; existing worker-variable coverage still passes. |
| **N4 — demo prints the old Codex recipe** | **RESOLVED** | Both recipes at `scripts/demo.sh:58` and `scripts/demo.sh:59` now contain `codex --no-daemon`. A disposable extraction probe checks the two actual script lines, and `bash -n scripts/demo.sh` passes. Installed `codex-cli 0.158.0` help describes the flag as running without the shared background server. This is consistent with rehearsal F2's observed workaround; no claim is made about the first version introducing the flag. |

## New must-fix

None established in the assigned area. The tested create/login/logout paths do not send users to the wrong server or remove another server's credentials. No new spec-invariant violation, data loss, duplication, leak, or hang was established.

## New should-fix

None established. Custom-server join/create success replies, unjoined remembered-server login/logout replies, current-session login/logout replies, explicit login override replies, and the checked-in custom-server missing-room/login guidance identify the selected destination without naming the hosted default. The local-only login help may still mention hosted as an example; that is not a reply claiming a different server was used.

## Test-expectation audit

No existing assertion was removed or weakened in the assigned diff. The new `HandlerState.serverOf` parameter at `packages/room-mcp/src/tools/context.ts:122` carries the freshly resolved fallback; the login caller supplies it.

| Changed test | Assessment |
|---|---|
| `packages/room-mcp/test/open-confirm.test.ts:72` | Correctly exercises remembered URL selection through `createTools` and records the actual HTTP hosts; its explicit nonempty-request assertion avoids vacuous success. |
| `packages/room-mcp/test/open-confirm.test.ts:84` | Correctly covers absent choice, remembered local choice, and explicit URL override. These cases retain the expected daemon-boundary sentinel. Each requires the join to progress through the real preflight/open code, although the test's `every()` assertions alone would not establish nonempty traffic. The disposable probes separately assert exactly one join call and its destination. |
| `packages/room-mcp/test/open-confirm.test.ts:128` | Correctly covers fresh remembered resolution after startup and explicit login override, with isolated credentials. Its logout case has no stored credential, so it does not by itself prove selective deletion or revocation. The disposable credential test fills that evidence gap. |
| `packages/room-mcp/test/open-confirm.test.ts:143` | Correctly establishes current-session priority through `serverOf`, but supplies a synthetic current session rather than performing a move. The disposable handler sequence executes the join handler first, then login/logout, while retaining stale startup configuration. |
| `packages/room-mcp/test/codex-env.test.ts:24` and `:29` | The membership and resulting-command expectations are complementary. The new behavioral assertion catches the original lost-selector defect. It is an offline forwarding/command-construction check, not a live Codex-to-Claude wake rehearsal. |

**Checked-in verification: 50 distinct tests passed** across `config.test.ts`, `choice.test.ts`, `open-confirm.test.ts`, and `codex-env.test.ts`. These retain the round-3 alias/caller and confirmation-gating checks. Tests ran with `--maxWorkers=1 --no-file-parallelism` against an isolated archive of the reviewed HEAD, with workspace package links pointing into that archive and third-party dependencies reused. The first run passed 49 tests and failed one close-guidance test because the scratch Git repository had no HEAD. Fetching the existing reviewed commit into the scratch repository corrected that setup; the entire 21-test open-confirm suite then passed. No production source or checked-in expectation was altered.

**Disposable verification: 13 tests passed**, recreating the round-3 N1–N4 probes against HEAD with corrected-behavior expectations:

- Seven create matrix cases: no choice, remembered local, remembered URL, environment over remembered hosted, environment over remembered URL, explicit URL over both, and explicit local never creating locally.
- `ROOM_URL` over a remembered URL, including its repository-name component.
- Remembered local room-name removal during hosted fallback, deriving the repository from Git origin.
- Successful handler-level explicit join followed by current-server login/logout, explicit login override, per-server pending/credential isolation, and independent credential-file selection.
- Unjoined login/logout after a remembered destination changes, preserving the hosted credential.
- Manifest filtering followed by Claude command construction, plus valid/unique environment names.
- Extraction of both actual Codex demo recipes.

HTTP was stubbed, credentials were fake and confined to temporary files, and join success was supplied at the `doJoin` boundary for the handler sequence. No real account was logged out, no server room was opened, and no host session or demo server was launched. These results establish configuration, caller, credential, and command-construction behavior; they do not replace the live rehearsal. No full build, full suite, or unrelated relay test was rerun. `nice -n 10` was attempted but the sandbox denied `setpriority`; jobs remained serial and within the assigned thread budget.

The disposable test and scratch archive were deleted. The final `room_preview_merge(people=["rohanz"])` reported **no conflicts** over `9fb95817d4`, with one path changed only by this worker and no teammate paths applied. Final `git diff --check` passed; the only worktree change is this new report.
