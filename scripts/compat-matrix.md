# Compatibility process matrix

Run `npx tsx scripts/compat-matrix.mts` after `npm ci`. It fetches the exact pinned
release tags into a disposable Git repository, verifies recorded commits, installs
locked dependencies and runs each tag's server and plugin build scripts unchanged.
The relay in the plugin is also exported in a fixture bundle with that release's
actual client/provider APIs. No old source is rewritten and no model calls run.
The current candidate includes tracked and untracked local edits in an isolated
worktree; it does not rebuild or overwrite the caller's plugin assets.

Each old/new server/client and relay/client pair has a 30-second deadline, bounded
output and subprocess cleanup. Tags run sequentially to limit memory and disk use.
The report includes exact commits, Node version, lockfile and SHA-256 bundle hashes.
CI runs on Linux, macOS and Windows with a 15-minute job budget. These wire fixtures
are separate from installed-host acceptance, browser/hook and migration coverage;
a passing wire matrix alone does not certify those release prerequisites.

`npx tsx scripts/compat-matrix.mts --list` prints the planned pairs without fetching,
building, installing dependencies or opening sockets. In a sandbox that blocks the
`tsx` launcher’s own IPC socket, use
`node --import tsx scripts/compat-matrix.mts --list` instead.

`npm run bump -- VERSION` appends `vVERSION` to `scripts/compat-pins.json` and leaves
all previous pins in place. Before the tag exists, only that exact candidate's
unpinned tag may be reported pending. Immediately after `git tag vVERSION`, run:

```sh
node scripts/compat-pins.mjs VERSION --pin-commit
```

Commit the resulting manifest SHA before publishing. The matrix refuses any existing
tag without its recorded commit, including the manifest candidate after tagging,
and names the freezing command. Only the single manifest candidate whose tag does
not exist may remain pending. A missing released tag or a moved immutable pin is a failure. Older pins are retired by hand, never by bump:

```sh
node scripts/compat-pins.mjs VERSION --retire vOLD.VERSION.PATCH
```

Retirement refuses pins in the current or previous three minor releases (for
example, 0.17 remains protected through 0.20). Review support-floor changes and
release notes explicitly. Initial 0.17.0 and 0.17.32 commits come from the protocol
negotiation spec; the matrix prints build digests for the maintainer's artifact
archive. It does not claim rebuilt artifacts were previously archived.

To rerun a selected release or transport, use `--only v0.17.32:relay` or
`--only candidate:server`; omitting the transport runs both. A selected old tag runs
both authority/client directions. `--list` accepts the same filter. Pin checks
still cover the full manifest, so filtering cannot hide an unfrozen release.

Before any candidate pair opens sockets, the matrix loads the built
`plugins/room/server/compat.json` and checks its release against the plugin manifest,
its SHA-256 digest against `room-mcp.mjs`, and its advertisement and worker-record
schema against the constants exported by the exercised fixture implementation.
Malformed or mismatched descriptors fail preflight. Descriptor absence is allowed
only for the pinned pre-descriptor `v0.17.0` and `v0.17.32` implementations, which
export neither contract constant; the candidate always requires it. The validator
and pin checks can be tested without sockets.

Relay fixtures acquire and post under the client's actual kernel process identity
from that release's process probe, so the relay can verify the holder remains alive.

The relay conservatively runs the hub's five-second replica settle window even for
this empty temporary room; hosted rooms created by the fixture are marked fresh and
skip it. A relay acquire can therefore receive five `starting` refusals with
`retryMs: 1000` before succeeding. This precedes holder liveness checks and is not
process-probe settling. The trace records `reason` and `retryMs`, and asserts that
all acquire refusals are `starting` with the advertised cadence and at most
`ceil(SETTLE_MS / STARTING_RETRY_MS)` retries. The exercised `HubClient` retains its
own request timeout plus settle budget (10 seconds locally); the fixture adds no
retry loop or startup sleep. Reports include acquire attempts, refusals, budgets
and elapsed milliseconds, with the existing 30-second pair deadline as the outer bound.
