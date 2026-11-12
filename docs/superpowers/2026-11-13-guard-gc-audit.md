# Collector lock recovery audit — 2026-11-13

The hourly collector must not unlink a lock after separately deciding its holder is dead.
A later acquirer may have recovered it and installed a live successor before that unlink.
Lock recovery belongs to acquisition; name and publisher payload cleanup remains useful,
but must use the existing guarded `recover()` operation.

## Lock families and recovery evidence

Paths below are relative to the common Git directory's `room/`. Source line numbers
refer to the audited tree. All guards use `packages/relay/src/leases.ts`: synchronous
`withGuard` at line 196 reaches `acquireGuard` at line 168; asynchronous `withGuardAsync`
at line 344 reaches `acquireGuardAsync` at line 291. Both inspect a dead holder, acquire
an outer `.guard`, reread the current holder under it, then unlink only a holder still
dead (lines 175 and 300). Release compares the holder nonce (lines 188 and 272).

| Family | Acquiring owner and on-demand recovery |
|---|---|
| `preview-evidence/<checkout-hash>-publication.guard` | `packages/room-mcp/src/preview-evidence.ts:226`, `withGuardAsync`; no collector-specific recovery needed |
| `names/<hash>.json.guard` | `packages/room-mcp/src/names.ts:74` uses `recover`, line 80 uses `replace`, line 90 uses `compareAndRelease`; each reaches `withGuard` in `packages/relay/src/leases.ts:355`, `:364`, `:374` |
| `publishers/<worktree-hash>.json.guard` | `packages/room-mcp/src/publisher-lease.ts:145`, `:149`, `:107` use the same recovery/replacement/release primitives |
| `hub/authority.lock.guard` | `packages/relay/src/hub.ts:29` uses `recover` on take; line 40 uses `compareAndRelease` on release |
| `registry/capacity.guard` | `packages/room-mcp/src/worker-file-store.ts:504`, `:774`, `:919`, `:1284` use the retrying `guarded` helper, which calls `withGuard` at line 177 |
| `registry/tags/<tag>.json.guard` | `packages/room-mcp/src/worker-tags.ts:13` calls `withGuard`; spawn, resume, retirement and bootstrap-gap recovery acquire it |
| `registry/workers/<id>.json.guard` | `packages/room-mcp/src/worker-file-store.ts:444` uses `guarded` for legacy adoption |
| `registry/workers/<id>.op.guard` | `packages/room-mcp/src/worker-file-store.ts:687` guards updates, line 736 recovers a dead operation lease, line 1289 calls `withGuard` directly during bootstrap-gap recovery |
| `registry/collect/<hash>.json.guard` | `packages/room-mcp/src/worker-file-store.ts:749` recovers the collection lease on take; line 763 releases it with nonce comparison |
| `registry/runs/<id>/<run>.writer.guard` | `packages/room-mcp/src/worker-file-store.ts:1190` uses `replace` for a dead run writer in the same session; line 1194 uses `guarded` |
| `registry/runs/<id>/<run>.exit.json.guard` | `packages/room-mcp/src/worker-file-store.ts:1214` uses `guarded` |
| `sessions/idle-episode.json.guard` | `packages/room-mcp/src/presence-end.ts:27` calls `withGuard` |
| `sessions/<session>/idle-claims/<hash>.json.guard` | `packages/room-mcp/src/idle-claims.ts:101`, `:128` use `guarded`, calling `withGuard` at line 44 |
| `sharing/legacy-baseline.json.lock.guard` | `packages/room-mcp/src/policy-store.ts:30` calls `withGuard` |
| Any of these plus additional `.guard` suffixes | Recursive acquisition in `packages/relay/src/leases.ts:175` and `:300` recovers dead outer guards when recovering the inner lock |
| `worktree-operation.guard` and its outer guards | Already owner-managed before this fix; `packages/roomd/src/git-worktree-lock.ts:36` calls `withGuardAsyncOperation`, reaching the same async recovery at `packages/relay/src/leases.ts:332` |
| `hub/authority.lock` (separate old collector rule) | `packages/relay/src/hub.ts:24` takes it with exclusive creation followed by `recover` and exclusive creation at line 29 |

The generic suffix matcher used to cover any `.guard` entry **visited** by the collector,
including unknown or historical guard names. It does not recursively visit registry
families or session journals: `packages/room-mcp/src/local-state-gc.ts:145` visits one
directory level except quarantine. Those nested guards were already owner-managed in
practice. `relay/*` is also matched by its earlier owner rule. The similarly named
`room-choice.json.lock.guard` (`packages/room-mcp/src/choice.ts:59`) is outside `room/`
and was never collected. There is no other current `.guard` writer in the audited sources.
Historical paths with no current acquirer cannot block a current operation.

## Retained size and limits

Clean release removes its token. A crash may leave one JSON process token per guard
path, usually a few hundred bytes of content (filesystem allocation can be larger).
The primitive adds no payload to outer guards. There is no clone-wide file-count cap:
distinct one-off names, checkouts and worker/run IDs can leave tokens indefinitely.
The authority lock has one fixed path per clone. No worker patches, publications or
logs gain a new lifetime from this change.

Recursive recovery refuses depth greater than 12 (`packages/relay/src/leases.ts:169`,
`:292`), so at most 13 guard levels can be created for one base path. An outer orphan
is not visited when an absent inner guard can be created directly. If a crash leaves
all 13 levels dead, recovering them needs a fourteenth level and hits the existing
depth error. This is a remaining primitive limit, not a new collector workaround.
Unreadable holders also remain blocking; the old collector could not judge them either.

## Other collector rules

- **Name/publisher payloads — fixed.** The old dead-holder check could read a dead
  token, a taker could recover and replace it, and `rm` would delete the live lease.
  Cleanup now calls `recover()` and rechecks idle age while holding the normal mutation
  guard (`packages/room-mcp/src/local-state-gc.ts:124`). A recent successor stays even
  if that successor has also died. Dry runs remain read-only estimates.
- **Session entries — remaining race.** After the final stale child stat at
  `packages/room-mcp/src/local-state-gc.ts:135`, SessionStart can replace `session.json`
  (`packages/room-mcp/src/session.ts:164`), or a hook/MCP can refresh another record;
  recursive `rm` at line 136 then removes the fresh record. Idle journals deeper than
  one level are not included in this newest-file calculation. The separate idle-episode
  age rule can likewise unlink a newly advanced counter after its stale stat.
  Session/hook writers do not share a collector guard, so this needs broader ownership
  work rather than another stat check.
- **Discovery — no collector replacement race.** `relay.json` and `hub/incarnation.json`
  are kept (`packages/room-mcp/src/local-state-gc.ts:52`); the collector never removes
  them. `hub/authority.lock` had the same race as generic guards and is now owner-managed.
- **Preview evidence — remaining race.** The age rule at
  `packages/room-mcp/src/local-state-gc.ts:123` can stat an old `<hash>-latest.json`, a
  publisher can atomically replace it under its publication guard
  (`packages/room-mcp/src/preview-evidence.ts:273`), then GC removes the new attempt.
  Cleanup needs that async publication guard; adding async coordination to this
  synchronous collector is outside this fix.
- **Sharing — remaining race.** GC reads a record for a gone checkout and stats it
  (`packages/room-mcp/src/local-state-gc.ts:111`); `PolicyStore.open` can replace that
  participant's record for another checkout (`packages/room-mcp/src/policy-store.ts:92`)
  before GC unlinks it. Writers do not share a guard with collection.
- **Patches — no same-path live successor found.** The generic collector treats
  `registry/patches` as owner-managed. `packages/room-mcp/src/worker-file-store.ts:1429`
  ages a stable patch only for an absent/retired worker; `:1022` only publishes a patch
  for a discarding worker with a recorded hash, never replaces a retired worker's patch.
  Scratch cleanup at `:1065` runs under that worker's operation lease. Worker IDs are
  not reassigned by that cleanup.
- **Profiles — no same-path live successor found.** Profiles use a timestamp filename
  and exclusive creation (`packages/room-mcp/src/cpu-watchdog.ts:71`), then are immutable.
  Ordinary writes cannot replace the old file GC judged. Clock rollback or a writer
  suspended over seven days could affect age-based retention, but is not the lock
  takeover race. Browser redirects, by contrast, reuse destination hashes
  (`packages/room-mcp/src/browser-open.ts:36`); a stale stat followed by a fresh rename
  and GC unlink can lose the new redirect.
- **Other residuals.** Hook receipts are replaced at stable session hashes and have
  the same age-check/unlink window. Generic one-hour temp cleanup can remove a live
  writer's temp if it is suspended that long; unlike lease orphan-temp cleanup it
  does not check the writer. Resolved worker metadata at
  `packages/room-mcp/src/worker-metadata-gc.ts:34` compares bytes before unlinking, but
  a fresh diagnostic/ref receipt can still be written after the comparison. These
  writers need shared ownership synchronization; they are not fixed here.

The supplied guard regression was first copied unchanged and failed because GC deleted
the live successor. With owner management the old stat hook is never reached, so its
replacement assertion now accepts the stronger outcome (the dead token is untouched),
then installs a successor and checks it too. The previous preview-only race test is
covered by the generalized lock-family regression. The table test now expects old
authority/guard files to remain. Name/publisher regressions cover replacement and a
fresh idle timestamp between selection and guarded recovery.
