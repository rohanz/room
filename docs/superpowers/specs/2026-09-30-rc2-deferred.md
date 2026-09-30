# 0.17.0-rc2: deferred items and proportionality notes

Written 2026-09-30 at the end of the rc2 fix batch. rc2 was fixed round by round against two reviewers (security and
whole-release, both `gpt-6-astra` high, read-only, in a clean clone) until both reported **zero must-fix** (round 5 of each, at `d7e7e37`). What remained, and what the proportionality review recommended for later,
is listed here for post-release work.

## Must-fix counts per round

| Round | Commit reviewed | Security must-fix / should-fix | Release must-fix / should-fix |
| --- | --- | --- | --- |
| rc1 | `fb11191` | 7 / 6 | 3 / 4 |
| 1 | `4ca6069` (release), `121788a` (security) | 5 / 5 | 3 / 4 |
| 2 | `e5721c5` | 4 / 2 | 1 / 6 |
| 3 | `f1719d3` | 4 / 2 | 2 / 3 |
| 4 | `e274970` | 1 / 1 | 1 / 3 |
| 5 | `d7e7e37` | 0 / 2 | 0 / 2 |

The review reports are kept outside the repository, in the lead session's scratchpad under `n3/rc2-reviews/`
(`sec-r2` to `sec-r6` and `release-r1` to `release-r5`: security files are numbered one higher because of the stopped
first run; `prop-out.md` is the proportionality review and `simp-out.md` the security re-review of the final pass,
which found the four final changes sound). The first security run of round 1 was stopped by the model provider's content filter while it ran proof-of-concept
inputs; it was rerun with the instruction to review by reading source and tests. Its two interim findings (relay
ticket body of `null`, unbounded replies to repeated state requests) were fixed before the rerun.

## Should-fix items from the last round

| Item | Reviewer | Where | Risk | Status / proposed fix |
| --- | --- | --- | --- | --- |
| Disconnected upgrades release admission capacity before their permission check finishes | security round 5, S1 | `packages/server/src/index.ts` upgrade handler, `admit.ts` | A valid GitHub login can exceed the pending-admission limits with short connections to distinct repository names; bounded by the 600/minute upgrade limit and the 10 s fetch timeout | **Fixed in the final simplification pass** (one pending-work reservation held until admission settles) |
| GitHub rate limiting (403) treated as revoked access: live sockets closed with 4403 and clients stop reconnecting | security round 5, S2; release round 5, S1 | `packages/server/src/admit.ts` | An authorised user who exhausts their GitHub API allowance is disconnected from every room until they rejoin by hand; introduced in fix round 4 | **Fixed in the final pass**: a 403 with rate-limit headers or message, or a 429, is "unavailable" and the grant is kept |
| Connection-limit table described viewer limits as per address | release round 5, S2 | `deploy/self-hosting.md` | Documentation only | **Fixed** (`5c6719d`): per view key |

## Deferred to after the release (from the proportionality review)

| Item | Where | Risk of leaving it | Proposed work |
| --- | --- | --- | --- |
| Decide whether restart continuity is worth the hub's private lease store | `packages/hub-core/src/hub.ts` (`LeaseStore`, `adoptStored`, `flushLeases`), `packages/server/src/hub.ts` `serverLeaseFile`, `packages/relay/src/hub.ts` | None for security; about 120–150 lines and two file adapters kept | If a bounded pause and fresh grants after a restart are acceptable: start with empty lease tables, wait one `LEASE_TTL_MS` on non-fresh hubs, invalidate cached leases in `HubClient.hello()` on a changed incarnation, delete the store. Changes the spec's "leases kept" promise |
| 21 of the 46 new `ROOM_*` settings could be constants | `packages/server/src/index.ts`, `deploy/self-hosting.md` | Operator surface and untested combinations | **Done in the 2026-09-30 constants batch:** made fixed constants of: `ROOM_MAX_BODY_KB`, `ROOM_BODY_TIMEOUT_MS`, `ROOM_MAX_PR_NOTE_MB`, `ROOM_AWARENESS_MAX_MESSAGE_KB`, `ROOM_AWARENESS_MAX_STATE_KB`, `ROOM_AWARENESS_IDS_PER_CONNECTION`, `ROOM_VIEW_MAX_PER_PRINCIPAL`, `ROOM_VIEW_ISSUE_PER_HOUR`, `ROOM_WS_TICKET_TTL_MS`, `ROOM_MIGRATION_MAX_RECORD_KB`, `ROOM_MIGRATION_MAX_REBUILDS`, `ROOM_MAX_EXPORTS_PER_PRINCIPAL`, `ROOM_EXPORT_CHUNK_KB`, `ROOM_EXPORT_DEADLINE_MS`, `ROOM_MAX_HTTP_RESPONSES_PER_PRINCIPAL`, `ROOM_HTTP_RESPONSE_DEADLINE_MS`, `ROOM_LISTS_PER_MINUTE`, `ROOM_GH_DENIAL_CACHE_MS`, `ROOM_MAX_PR_NOTES_PER_PRINCIPAL`, `ROOM_MAX_PR_LISTS_PER_PRINCIPAL`, `ROOM_PR_OPERATIONS_PER_MINUTE`; tests use the real capacity limits and inject shortened lifetimes through a test entry instead of environment shortcuts |
| Owner-only IPC for the local relay | `packages/relay`, `packages/roomd/src/ws-auth.ts`, `packages/web` | See the transport note below | A deliberate platform project: Windows pipe ACLs, long socket paths, generation migration and browser authentication first |
| Test-only hooks in the server | `packages/server/src/index.ts` (`ROOM_TEST_UPGRADE_DELAY_MS`, `ROOM_TEST_ARCHIVE_LOAD_DELAY_MS`, the `archiveLoads` health field), all gated by `NODE_ENV=test` | None in production (the image sets `NODE_ENV=production`) | Replace with injected options when the server gains a testable entry module |

## Not verified in this batch

- ~~The local viewer in a real browser.~~ **Verified after rc2 (2026-09-30).** A local room with a relay, two
  participants, overlays and messages was started in a scratch repository through the bundled MCP server, and the
  `file://…/viewer.html` link it printed was opened with Playwright in headless Chromium 151, WebKit 26.6 and
  Firefox 155. In each: the page is a secure context with `crypto.subtle`, connects and syncs, shows participants,
  changed files, overlay text and messages; a document write or presence forced from the page reaches no other
  viewer; a wrong view key, an old `key=` link, and a reused, unknown or expired (60 s) ticket are refused. Two
  defects were fixed: the refusal message was painted under the header and the reconnect banner, and a refused page
  listed its own reader as the one participant online. The viewer uses only standard APIs (Web Crypto HMAC, HKDF and
  AES-GCM, `BigInt`, ARIA reflection, `ResizeObserver`, `replaceChildren`); the only prefixed CSS is
  `-webkit-line-clamp` with `-webkit-box`, which all three engines implement. Safari itself was not run: Playwright's
  WebKit build stands in for it.
- **The staging snapshot and restore rehearsal** in `deploy/DEPLOYING.md` and `docs/upgrading.md` (documented, not run).
- **The model-based routing evals** (`claude plugin eval`) were not rerun; tool descriptions were not reworded.
- **An intermittent hang of the full suite** with the default reporter (twice in this batch: one vitest worker idle
  until killed). The same tree passed with `--reporter=verbose` each time; the hanging file was not identified.

## Proportionality review (2026-09-30, `fb11191..5c6719d`)

Full text: the reviewer's report is summarised here; the verdict per mechanism was **keep** for everything except
the four items marked below.

rc2 against rc1: 133 files, +6,946/−931 lines outside the built bundles and the lockfile; production source and
scripts are 52 files, +3,064/−621; the rest is regression coverage.

| Mechanism | Verdict |
| --- | --- |
| Local relay: HMAC proofs, encrypted session, derived view key, tickets (4 modules, 294 lines) | Keep for rc2 (see below) |
| Hub lease authority store | Simplify after release (deferred above) |
| HTTP work/response slots and byte accounting | Keep |
| Export's second response deadline | **Removed in the final pass** |
| Periodic outbound-budget sweep | **Removed in the final pass** |
| File-based local viewer | Keep |
| Presence budgets, state-request limits, view-key caps | Keep |
| Connection reservations and pending admission (two overlapping pending counters) | **Unified in the final pass** |
| Bounded cutover, namespace parsing and registry quarantine, sharing baseline, message validation, hub bounds | Keep |
| Environment-variable surface | Simplify after release (deferred above) |
| Persistence recovery, counter validation, credential revocation and tickets | Keep |

### Why the local relay keeps its authenticated, encrypted sessions for rc2

The alternative considered was the standard one for a loopback service: a Unix domain socket in the clone's git common
dir with owner-only permissions (0600 socket in a 0700 directory; a named pipe with an owner-only ACL on Windows) for
MCP clients and workers, plus a loopback TCP listener only for the read-only browser view, authenticated by a
short-lived token in the link. The reviewer's conclusion, which this batch follows:

- **On POSIX the socket fully covers the Node-client threats** (a process occupying the relay's old port; connection
  substitution during takeover): the OS decides who may connect, and no key crosses the wire.
- **The browser half is not equivalent.** A short-lived bearer token proves the browser to the listener, not the
  listener to the browser: a process that takes the port can receive the token, show fabricated room content, or
  forward the connection and read source text, messages and plans. Read-only does not make that disclosure acceptable
  under the threat model (other local users without access to the user's files).
- **Windows.** Node can listen on a named pipe but exposes no way to set an owner-only security descriptor without
  native code; `chmod 0600` has no equivalent there.
- **Socket paths** are limited to about 104 bytes on macOS, so deep clones need a checked short fallback directory.
- **Nothing could be deleted.** A hybrid (POSIX socket, an authenticated Windows fallback, an authenticated read-only
  TCP viewer) keeps `secure.ts`, `secure-websocket.ts`, `ws-auth.ts` and most of `proof.ts`, and adds a transport.
  A per-clone key checked on each loopback TCP connection is not enough: sent to the wrong listener it is captured.

So the socket is a later platform project, not a simplification of rc2.
