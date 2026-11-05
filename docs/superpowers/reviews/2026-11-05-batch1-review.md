# Batch 1 pre-release review — 2026-11-05

Scope: uncommitted changes against HEAD and the requested untracked source, test, script, hook and CI files. This is a static review, not release acceptance evidence. No full suite, process matrix or real-host batch was run. Priorities follow CLAUDE.md, the five Unreleased entries, the negotiation spec and its review, the local-plumbing maintainer decisions, and the dated Codex host survey.

## Must-fix

### M1. HTTP upgrade refusals can leave the publisher permanently connecting

**Location:** `packages/roomd/src/ws-auth.ts:39`.

The new `unexpected-response` listener consumes every non-upgrade HTTP response but terminates the WebSocket only for 426. In the installed `ws` implementation (`node_modules/ws/lib/websocket.js:929`), emitting this event successfully suppresses the default `abortHandshake`. Draining the response is not a replacement for that abort.

**Failure scenario:** a hosted publisher reconnects while the authority returns 503 (or admission returns 401/403). There is no secure-handshake timer on this hosted path, and the negotiation timer starts only after WebSocket open. The socket remains CONNECTING without the error/close event that lets y-websocket retry. Initial joins eventually report a sync timeout; an already joined publisher can remain disconnected after the server recovers. This also changes the non-negotiating hosted client path.

Explicitly end every rejected HTTP handshake, preserving retryable close/error behavior for ordinary failures and terminal compatibility guidance for 426. Add a focused test with a first upgrade returning 503 and a subsequent successful connection, plus a permanent authentication refusal.

### M2. The registry cache can retain stale record text indefinitely after a same-tick rewrite

**Location:** `packages/room-mcp/src/worker-registry.ts:65` and `:75`.

Only timestamps exactly divisible by one second are treated as potentially coarse. Fractional timestamps are trusted immediately. Nanosecond-valued stat fields do not establish nanosecond filesystem resolution, or guarantee that two writes receive different timestamps.

**Failure scenario:** read and cache a worker JSON file; rewrite it in place with equal-length content during the same filesystem timestamp tick. On a filesystem with millisecond or microsecond timestamps, inode, size, mtime and ctime can all remain identical while both timestamps have a fractional-second component. Every subsequent read returns the old text, even after the tick has passed. The cache has no expiration or later validation that repairs this entry. Directory-list caching has the corresponding missed-addition/removal risk when directory metadata collides.

The existing in-place rewrite test depends on real writes receiving distinct timestamps and therefore does not establish the advertised guarantee. Add controlled stat-collision cases. Use a defensible racy-timestamp policy that eventually rereads entries captured in a possibly shared tick, or enforce and validate an immutable replacement protocol for every writer; do not equate fractional timestamps with safe cache hits. Fresh JSON parsing protects caller isolation but does not repair stale bytes.

### M3. Retention does not serialize with worker operations and can release a surviving record's tag

**Location:** `packages/room-mcp/src/worker-registry.ts:991`, `:999`, and `:1004`.

The operation check and borrower set are snapshots taken before awaited lease work. Deletion subsequently uses `guarded(workerFile)`, whereas `update()` uses `guarded(opFile)` (`:779`) and operation acquisition uses the operation lease (`:798`). These are different exclusion domains. The final check covers only phase and sequence, not operation ownership, borrowers or kept-worktree existence. Tag release also precedes this final check.

**Failure scenario:** pruning observes an expired ended owner with no operation, then another instance acquires an operation on that owner while resuming a borrower (`resume()` acquires the owner's operation lease). The owner record's sequence need not change. Pruning can delete the owner and its run facts while the operation needs them. Separately, an updater can change the record after the pruning snapshot: pruning releases its tag, notices the sequence change, and skips deletion, leaving the surviving record without its reservation. A further cross-process update can race the final read/unlink because it does not use the worker-file guard.

Claim retention authority through the same operation/ownership protocol as lifecycle mutations; revalidate all retention predicates under that authority, including borrowers. Order tag release and record deletion so an aborted prune cannot leave an active/recovered record unreserved. Add forced interleavings, not only sequential expiry examples.

### M4. Memoizing carried facts also freezes the stale-inputs guard

**Location:** `packages/room-mcp/src/conflict-set.ts:489` and `:727`.

The pass memo is used both for computation and for every freshness comparison. Once captured, `carriedOf(other)` can never return a changed value during that pass. Previously the peer's carried baseline SHA was reread by `pairInputs` when the guard ran.

**Failure scenario:** a conflict pass captures a peer's carried baseline, awaits Git/file work, and a concurrent resume or registry update changes that baseline before the room projection changes. The guard compares the original memoized SHA with itself and permits publishing or withdrawing conflict results calculated against the superseded baseline. An eventual later pass does not make the stale publication correct.

Keep once-per-pass materialization for expensive baseline reads, but capture a registry revision/freshness token and independently revalidate it before publishing. Add a test that changes the carried source during an awaited comparison while room metadata stays unchanged.

## Should-fix

### S1. New release pins remain movable unless someone runs an extra command

**Location:** `scripts/compat-pins.mjs:26`; `scripts/compat-matrix.mts` at the `if (pin.commit && commit !== pin.commit)` check.

Bumping appends only a tag. CI checks immutability only when a commit is present, and `--pin-commit` is a separate manual action rather than part of the documented bump/build/tag sequence. After a release, moving that tag silently changes the archived implementation exercised by subsequent runs. The two initial pins are frozen; automatically added releases are not.

Make freezing newly published tags a required release completion step and reject missing commit pins for already published, non-candidate releases. Retain the narrow pre-tag candidate exception. The existing retirement function does not itself drop a pin inside the same-major three-minor window.

### S2. The matrix does not verify the descriptor it claims to consume

**Location:** `scripts/compat-matrix.mts:46`; `scripts/compat-pair.mts` in `client()`.

The matrix hashes the generated plugin, but clients import a separate `.compat-exports.bundle.mjs` and use its source-exported constants. Neither matrix script reads `server/compat.json`. A descriptor with the wrong worker-record schema or advertisement can therefore coexist with passing process pairs, even though installed worker preflight relies on that descriptor. The Unreleased statement that both consumers read it is inaccurate.

Have the candidate matrix validate the descriptor's release, bundle digest, advertisement and record schema against the exercised implementation, with an explicit descriptor-absent legacy case. A corrupted descriptor should fail the matrix before starting pairs.

## Noted-not-blocking

- The current selector uses fixed registry ordering, numeric descending candidate versions and order-independent capability intersections. With the same offers and policy, successful selection is deterministic and symmetric for the implemented baseline. Refusal attribution is intentionally role-dependent. `validateSelection` validates an allowed subset rather than recomputing the maximal selection from the full offers; it can accept omitted optional capabilities. That is not evidence of two current honest peers choosing different contracts, but should be revisited before multiple implemented profiles ship.
- `supportWindow` implements current plus three minor families with the 0.17 floor for the current major. Maintainer decision 3 supersedes the spec's older “current and previous” wording. The window is release-tooling policy, not a runtime release-string gate.
- Hosted negotiating sockets attach document handlers only after ACK and authority checks; relay negotiation similarly precedes `attachReady`. Both register the compat hello with the hub at ACK. The receiver payload limits cover fragmented input, with pending budgets and handshake deadlines. The client-side HTTP failure path in M1 is separate from those server gates.
- The relay health proof still covers nonce and port, **not the advertisement**. This is explicitly permitted for release N by the revised spec's security section: first-contact stripping may select only the frozen baseline; encrypted framing and authority-side baseline enforcement remain mandatory. Learned floors reject later disappearance. Do not describe this as first-contact downgrade detection or as the advertisement-bound proof required for release D.
- The two first-frame fixture source-hash sets were checked against `git show v0.17.32:<path>`; all five hashes match. The legacy hello/encryption serializers and the tag's sync-first server/relay paths were compared. The new legacy branches retain those wire formats rather than sending an extended hello. This source comparison does not substitute for executing the replay fixtures, browser paths or mixed-version matrix. The relay additionally introduces a generation gate; byte identity should be claimed for the frozen baseline exchange, not all possible historical behavior.
- The relay diff does not replace the lead-only ownership or final-save mechanisms. No change to `plugins/room/hooks.json` appears in either diff stat or numstat. Hook no-overlap returns before selection/confirmation, preserving owed delivery. The worker preflight checks a digest-bound executable descriptor and record schema, and supplies reconnect guidance; old unmodified leads retain their historical release mismatch refusal.
- The pinned MCP protocol list equals the installed SDK 1.30.0's `SUPPORTED_PROTOCOL_VERSIONS`. A second valid Codex thread ID throws before dispatch and does not overwrite the first ID. This assessment uses installed SDK code and the supplied dated host survey; it is not a new live-host pooling test.
- Matrix planning includes both old/new directions for both transports per pin, plus new/new pairs. The harness starts actual authority and client processes and uses release-derived APIs rather than changing old constants. The three-OS `compat` job is a dependency of the required `test` aggregate. Execution success, timing budget and real-host spawn/collect acceptance remain unverified in this review.

## Verdict

Do not release this working tree until M1–M4 are resolved and their failure interleavings are covered. Preserve existing release checks and obtain the process-matrix and real-host evidence required by the plan after fixes. No files other than this report were modified; no commits were made.

Must-fix count: **4**. Should-fix count: **2**.
