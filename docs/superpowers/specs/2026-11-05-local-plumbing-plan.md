# Local plumbing plan: order, deletions, release boundaries

> **Superseded in part, 2026-11-12.** Room no longer keeps cross-version compatibility: the support window, release pins and the compatibility matrix described here were removed after 0.17.48. See [upgrading](../../upgrading.md). The rest is kept as the design record.

Date: 2026-11-05. Status: proposed, for the maintainer's ordering decision. Ties together four specs written
and reviewed today, each by a Codex GPT-6.1 Sol writer and a GPT-6 Astra reviewer with one revision round:

| Spec | Review | Must-fix after revision |
| --- | --- | --- |
| [Protocol negotiation](2026-11-05-protocol-negotiation.md) | [review](../reviews/2026-11-05-spec-review-protocol-negotiation.md) | 0 of 3 open |
| [Standalone local daemon](2026-11-05-local-daemon.md) | [review](../reviews/2026-11-05-spec-review-local-daemon.md) | 0 of 2 open |
| [SQLite state](2026-11-05-sqlite-state.md) | [review](../reviews/2026-11-05-spec-review-sqlite-state.md) | 0 of 3 open |
| [Host adapters](2026-11-05-host-adapters.md) | [review](../reviews/2026-11-05-spec-review-host-adapters.md) | 0 of 4 open |

Why this work: the 0.17.25–0.17.32 releases fixed eleven defects in local coordination one at a time
(relay ownership by a worker, lagging owner, save on stop, kept worktrees with retired records, port
exhaustion, quarantine liveness, race after race in the file-based registry). Each fix was right; the class
keeps producing because the relay lives inside a session, durable state is hand-built from files, and host
quirks are spread through the code. These four specs remove the classes.

## Decisions already taken (2026-11-05)

- **Negotiation ships before the daemon.** The first negotiating release still permits the in-session relay; a
  new client may join an old compatible relay. The daemon arrives later as an explicitly drained cutover, the
  one upgrade that is not rolling. Both specs now state this and carry the same wire-versus-runtime matrix.
- **Hooks stay dependency-free file-and-loopback scripts** and never open SQLite; the MCP alone gates on
  node:sqlite with a catchable preflight and a restart remedy.
- **The adapter extraction is strictly behaviour-preserving.** Every behaviour change the review found
  (host precedence, active-install versus newest-cache, missing-record hook behaviour, stricter session-record
  validation) is a separate batch with its own acceptance test.
- **Only a bound client of the clone may start the daemon**; viewers do not keep it alive; idle shutdown
  after five minutes without a writer is the default; capacity failure and I/O failure are distinct states.

## Dependency order

```
1  negotiation (hub-core, shared, server, relay, room-mcp handshake)   rolling release
2  local daemon (relay lifetime moves out of the session)              drained cutover, needs 1
3a SQLite state (worker lifecycle + collection admission first)        independent of 1–2; its migration
                                                                        window is the same "stopped writers"
                                                                        discipline as 2, so pair them
3b host adapters (extraction only)                                     independent; shippable in slices
                                                                        at any time, smallest risk
```

Negotiation first because the daemon's handshake, the hook endpoint and the Codex worker version check all
need the capability selector it introduces; shipping the daemon without it would be a second hard cutover.
Adapters are independent and low-risk: start slicing them now in parallel with 1, one slice per release,
each with the suite green. SQLite's first scope is deliberately narrow (worker lifecycle and collection
admission) because that is where 0.17.26–0.17.32 kept finding races; preview-cache metadata, receipts and
cursors stay in files until an invariant demands otherwise.

## What each phase deletes

| Phase | Deleted | Kept on purpose |
| --- | --- | --- |
| Negotiation | the literal `HUB_PROTO` equality checks, the doctor's hardcoded schema/hub failure, the relay's "unsupported means absent" classification, the release-string Codex worker check (becomes a protocol and record-schema check), mutable viewer-asset lookup | archives, migration sources, recovery patches, the schema-2 adapter for the support window, stale-build warnings as diagnostics |
| Daemon | in-process relay creation and owned-stop semantics in the MCP, session-side takeover intervals, ownership-role detection used only for creation, the owner-warning transfer path, the worker "waiting for the lead" branch, takeover tests (replaced by separate-process lifetime tests) | the relay transport, proof and ticket logic, caps, hub, snapshot machinery, final-save retry, the authority lock, `roomd` |
| SQLite | JSON record files for workers, runs, reports, exits, operation and destination leases, review holds and cleanup intent; their quarantine-by-rename; the registry's bespoke rescan and reconciliation for those records | the Y.Doc memory snapshot, credentials and choice files, port reservations and owned-file leases (OS lock semantics), preview-cache metadata and locks, hook receipts and cursors |
| Adapters | the mixed-host `workerCommand`, host settings and install-root readers in `worker-config.ts`, host branches in `worker-launch.ts`, mixed `HostEvent` fields, doctor host-install parsing in shared evaluation, host field and tool aliases in shared hook coordination | the shared binding cache and repository retry, run-log scanner, liveness, ledger arbitration, hook caps and receipts, the worker-status state machine, frozen hooks, channels and queue fallbacks |

## Release boundaries

| Phase | Ships how | Flag or cutover |
| --- | --- | --- |
| Negotiation server/relay | release N: negotiating server and relay still serving exact schema 2 / proto 1 | rolling; old clients unaffected |
| Negotiation clients | release N+1: negotiating clients with the legacy adapter | rolling; a client older than the support floor is refused with the exact side that must change |
| Daemon | release D after N+1 | **cutover**: per clone, inventory old local clients, drain, verify the old owner dead, then daemon runtime required; mixed local runtimes refused with pid, port and remedy |
| SQLite | release S, any time after N; pair its migration window with D when both are ready | **cutover per clone** by one offline migration owner with a durable generation, whole-operation drain, legacy authority retained until completion |
| Adapters | one slice per release from now on | none; each slice is a refactor with characterization tests before and after |

## Live checks before each merge

- **Negotiation:** CI matrix of old/new pairs pinned to tags (first stable baseline 0.17.0, commit
  ec13dcd8), plus one real pair on this machine: a 0.17.32 lead joining a negotiating relay, and a
  negotiating lead joining a 0.17.32 relay, both with a Codex worker spawned and collected.
- **Daemon:** on macOS and Linux (Docker, unprivileged user, init): lead leaves with workers alive; daemon
  crash with a replica surviving in one client; port taken on restart; full-disk stop; two leads in one
  clone; Windows smoke in CI. Then one real batch led from this checkout.
- **SQLite:** migrate this repository's registry (53 retired records, several quarantined) and the
  weaestudyapp and creativewriting registries on copies; forced interleavings from the spec; then one real
  batch.
- **Adapters:** suite green per slice, the fake-host Windows smoke, and one real Claude and one real Codex
  worker spawned, messaged and collected after each slice that touches launch or wake.

## Maintainer decisions (2026-11-05, Rohan: "I think these are good")

1. Daemon lifetime: five-minute idle stop with no writer; any bound client of the clone may start it; viewers never keep it alive.
2. Acknowledged posts: a post may be lost only if every replica is lost inside the delayed-snapshot window; no write per post.
3. Support window: three minor releases back; the release step pins the newest tag into the CI matrix automatically; older pins retired by hand.
4. SQLite runtime floor: official Node.js 22.22.3 with SQLite 3.51.3, enforced by the MCP's startup preflight with a restart remedy.
   Addendum from the Codex snapshot: Codex itself forces DELETE journaling for its SQLite databases on NFS (0.166.0); Room's preflight must detect a network filesystem under the git common dir and use DELETE journaling there or refuse, and the spec's WAL section must say so.
5. SQLite scope: worker lifecycle and collection admission only in the first release.
6. Codex conversation ownership: keep the one-MCP-per-conversation assumption with a check that fails loudly; no per-call selection yet. Made concrete by the [2026-11-05 Codex snapshot](../../archive/reports/host-survey-2026-11-05-codex.md): Codex 0.166.0 can pool one stdio MCP process across chats behind `mcp_connection_sharing` + `mcp_2026_07_28` (both under development, default off, no per-server opt-out, no per-chat id passed to the server). Room's server keeps negotiating the MCP protocol version its SDK offers today, and a tool call from a second Codex thread id is refused with the flag names, not logged. This is the first adapter slice.
7. Order: negotiation, then the drained daemon cutover; adapter slices throughout; SQLite's migration window paired with the daemon cutover.

Before each batch that touches a host, re-read that host's current docs and changelog (CLAUDE.md "Host features change weekly").

## Questions for the maintainer (answered above; kept for the record)

1. **Daemon lifetime and authority.** Idle stop after five minutes with no writer, started by any bound
   client, viewers never keep it alive: confirm, or name a different policy.
2. **Acknowledged-post guarantee.** The daemon spec accepts losing an acknowledged post only if every replica
   is lost inside the delayed-snapshot window. Acceptable, or must posts be durable before acknowledgement
   (costs a write per post)?
3. **Negotiation support window.** The first stable baseline is 0.17.0. How many releases back must a client
   be able to join, and who owns the CI fixture matrix (proposal: the release step pins the newest tag
   automatically; older pins are retired by hand)?
4. **SQLite runtime floor.** The spec names the official Node.js 22.22.3 distribution with SQLite 3.51.3 as
   the floor. Confirm that both hosts on your machines and your friends' resolve that Node for the MCP, or
   choose a lower floor with the WAL advisory accepted.
5. **SQLite scope.** Worker lifecycle and collection admission only in the first release: confirm, or name
   another domain with a demonstrated race.
6. **Adapters and conversation ownership.** Current code assumes one MCP process per conversation on
   Codex. If a future Codex surface breaks that, Room needs per-call adapter and session selection; decide
   whether to design for it now or accept the assumption with a check that fails loudly.
7. **Order.** Negotiation, then daemon, with adapters slicing throughout and SQLite paired with the daemon
   cutover: confirm, or reorder.

## Open items noted today, outside these specs

- Codex worker version check should say "reconnect" and compare protocol and record schema rather than the
  release string (roadmap, 2026-11-05). Folded into the negotiation spec.
- The graph-retention 500-withdrawal test is disk-bound; its fixture could shrink (test-only).
- Run-log facts validate a 4 KB head and tail of the consumed region; a same-size rewrite that leaves both
  windows identical is undetected (documented limit).
