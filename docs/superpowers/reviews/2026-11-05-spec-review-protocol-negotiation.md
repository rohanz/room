# Review: protocol negotiation and staged Room upgrades

Date: 2026-11-05. Reviewed the working-tree proposal against checkout `9183d80c221d9ef99db893b60744b6f1eb4d99f5` (0.17.32), the local-daemon proposal, and CLAUDE.md/AGENTS.md Engineering priorities. This is a static design/code review, not evidence of an implemented negotiation protocol or a passing mixed-version rehearsal. No old binaries or integration suites were run.

## Verdict

**Revise before implementation.** Team transport bootstrap is feasible if N retains the exact legacy HTTP, websocket, encryption and document contract. That does not establish a seamless local-runtime or worker rollout. The migration is an exclusive write-pause design, not concurrent schema translation; its receive-side fence and drain completion evidence need definition before claiming retained-data preservation. The test matrix currently mixes achievable wire compatibility with behavior that unmodified old processes cannot provide.

Against Engineering priorities: correctness/user control requires an explicit migration acceptance boundary and honest loss reporting; reliable end-to-end behavior requires testing actual old processes, including their refusal paths; maintainability requires one agreed local-runtime rollout; appropriate verification requires executable, bounded matrix jobs; measured efficiency requires aggregate negotiation/migration budgets; useful diagnostics requires correcting the citation errors below. No release or commit is recommended by this review.

## Must-fix

### M1. Resolve the contradictory local rollout contracts

The negotiation spec's “Local daemon, relay, workers and viewer” says a new client joins an old compatible relay and a new relay accepts old clients. Its bootstrap section promises no simultaneous fleet update. The local-daemon spec's “Compatibility and migration from 0.17.x clones”, steps 2 and 4, instead requires new clients to refuse live legacy owners, require daemon runtime metadata, and treats mixed old/new local sessions as unsupported.

**Concrete scenario:** an old lead and a new client share a clone. Negotiation says the new client should join the old owner's schema-2 relay; daemonization says it must refuse. Alternatively, both join the new daemon, it dies, and the old lead takes the existing authority lock and starts an in-process relay (`packages/relay/src/index.ts:732` onward). The new daemon client must now refuse that owner. A matching hub/schema did not preserve the promised lifecycle. The lock prevents two authorities; it does not prevent this runtime regression.

**Required change:** decide release ordering and publish a matrix separating wire compatibility from supported runtime coexistence. Either ship negotiation with the existing relay lifecycle first, followed by an explicitly drained daemon cutover, or require the daemon drain at N and narrow the rolling-upgrade promise to team transport. Include runtime requirements in the effective local profile. Test old-owner takeover as a refusal/recovery case, not seamless successful coexistence. Do not add a competing lock or silently force an owner out.

### M2. Define the receive-side migration barrier and a verifiable drain

Migration step 3 closes admission and says “stop publishers and hub mutations”, but does not specify how already-open sockets, queued Yjs updates, direct receipt/claim writes, hub expiry/trim timers and other document mutations become fenced. A repository admission lock alone does not serialize websocket input: the server attaches `setupWSConnection` at `packages/server/src/index.ts:1017`; the relay applies sync packets at `packages/relay/src/index.ts:264`. Direct document writes have no hub-post acknowledgement that proves their persistence.

**Concrete scenario:** two schema-2 clients coexist, one old and one new. The old session has disconnected as requested. The new client has a receipt or claim update queued on its existing socket when the authority closes admission and snapshots the source. While candidate construction/persistence awaits, that packet is applied to the old live document. The committed candidate omits it. Generation rejection on reconnect cannot repair a write accepted after the source snapshot. An analogous race is a selection sent before draining whose delayed ACK attaches sync after draining starts.

**Required change:** define an authority-side state machine and the exact linearization point after which every mutating path rejects or queues work. Fence existing connections and pending selection ACKs, not just new admissions; freeze hub background mutation; establish a per-client drain barrier covering raw Yjs writes as well as semantic operations; persist everything accepted before the barrier before capturing the source. State whether the barrier proves transport application or durable storage. Specify bounded timeout/abort behavior and restore the source on pre-commit abort. Test packets and ACKs immediately before/after the barrier and during every awaited persistence step.

The proposal already excludes simultaneous writable schema 2 and 3 and disclaims recovery of unacknowledged old-client updates. This finding is about making that exclusion enforceable and separating accepted retained data from uncertain client-only data, not demanding impossible lossless replay from unmodified clients.

### M3. Correct worker bootstrap claims and turn the matrix into attainable outcomes

The current-mechanism table calls the Codex worker release mismatch a warning. `packages/room-mcp/src/tools/workers.ts:179`–181 actually **returns an error before launch** when the applicable environment is present and `codexRoomVersionMismatch()` reports a mismatch. The helper at `worker-config.ts:193` compares the lead release against the highest installed cache directory. Changing N's preflight does not change an old lead.

**Concrete scenario:** a supported old Claude lead remains alive while the installed Codex Room plugin is updated to N. The lead attempts to spawn a Codex worker. It returns the version-mismatch error before the new child can negotiate with even a fully compatible N server. An old worker/lead also cannot report N's contract selection or N's new `starting`-until-joined lifecycle merely because a fixture wrapper observes its connection.

**Required change:** split “existing old worker reconnects”, “old lead launches newly installed worker”, and “new lead launches old worker”. Explicitly retain refusal as the expected result for the old-lead hard-check case, with restart/pinned-install recovery; or declare a separately backported baseline and stop promising this behavior for unmodified earlier patches. Do not patch fixture source and call it released behavior. Freeze actual commits/digests and list exact success/refusal assertions before adopting the support promise.

## Should-fix

1. **Complete the gate inventory.** The omissions below include durable sharing and worker records, not merely cosmetic version strings. Assign each an owner and a compatibility/migration policy. A wire selector cannot make an old MCP process read a newly versioned sharing file or worker registry.
2. **Specify local discovery downgrade behavior.** Remote TLS protects discovery and selection against the described network attacker; legacy fallback must also require TLS for remote origins, not just the negotiating route. Local health proves key possession through a nonce/port proof, not integrity of `compat`. On first contact, a stripped advertisement cannot be distinguished from an actual old relay by that proof. Either bind the manifest digest to a versioned proof, or explicitly limit initial fallback to the fixed supported baseline and require the real authority to reject it when retired. A legacy hello cannot confirm a full offer it never understands. Scope remembered local floors to clone/key identity rather than an ephemeral localhost port; define persistence, rotation and explicit reset. Add first-contact stripping and fallback-port tests. This is an underspecified guarantee, not evidence that TLS or AES-GCM can be bypassed.
3. **Bound the new work as a whole.** A five-second/8-KiB hello limit needs an ACK deadline, pending-connection budget, outbound selection limit, cancellation and lock-hold rule. Do not hold the repository lock while waiting for client input. Thirty-two 64-character capability names alone exceed the proposed 1-KiB manifest budget; define serialized-byte rejection and how implementations keep all required capabilities discoverable without truncation. Budget source, candidate, encoding buffers and journal together for migration; individually size-bounded documents can still exhaust the documented 512-MB deployment.
4. **Define semantic outbox scope and retention.** Specify which operations have stable IDs, how outboxes survive restart, sharing-policy revalidation, and reconciliation after dedup records expire. Existing post dedup checks message/mail/archive/outcome retention (`packages/hub-core/src/hub.ts:685`–689); it is not indefinite exactly-once execution for claims, receipts or other operations. Do not report unknown as absent and replay it automatically.
5. **Define unknown-field preservation semantically.** Copying typed values and binary bytes into a fresh Y.Doc does not preserve encoded Yjs relative positions. Existing `compactDoc` explicitly rebuilds known claim anchors and rejects unsupported XML/subdocuments (`packages/shared/src/compact.ts:87`, `:110`, `:127`). Require registered migrations for identity-bearing values and block unsupported cases. Byte equality alone is insufficient verification of an unknown record's meaning.
6. **Separate CI layers and their cost.** Current `.github/workflows/ci.yml` has a 45-minute Ubuntu full-check job and focused Windows jobs with fake hosts; it has no macOS job or old-release negotiation matrix. Add bounded process-level wire fixtures on each supported OS, browser/hook harnesses, and separate real-host release acceptance evidence. Preserve the existing required status and make new jobs part of its dependency gate where required. Freeze “latest 0.17.x”; avoid a moving tag. Define the initial exception to “previous minor family”: 0.16 is explicitly rejected, not supported. A support window is not established by generic previous/current table rows.

## Citation audit

All **101 unique file/line targets exist and their line numbers are in range**. The table below enumerates every target, grouped by source file. “Supported” means the cited line and its surrounding declaration/section support the associated claim; a heading or function entry is not necessarily the exact operative line. This does not turn proposed behavior into shipped behavior.

Corrections to claims attached to existing citations:

- `tools/workers.ts:179` contradicts “warning rather than negotiating”: this path blocks launch. See M3.
- The server HTTP row says “handover/export also require schema 2”. Export is implemented at `index.ts:815`; no server `/handover` route exists. `index.ts:733` is `/ws-ticket`, not handover. Name ticket issuance instead; do not conflate the deleted local handover prototype with server HTTP behavior.
- The historical browser-link paragraph is too broad: `CHANGELOG.md:388` explicitly says old **team query-form view links still open**. Local old HTTP/key links and old credential-bearing requests differ. Do not describe all old links as unusable.
- `packages/web/src/conn.ts:80` directly proves ticket schema, not provider options. Provider configuration later in that file supplies `roomConnection`; cite that separately.
- The hook row's “unknown shapes fail” is true for invalid operations/binding fields, not strict rejection of extra keys. `arbitration.ts:43` validates key/op/session/batch but has no field allowlist. Unlike the hub hello parser, it accepts surplus fields.

| Source | All cited lines | Result |
| --- | --- | --- |
| `CHANGELOG.md` | 224, 230, 267, 269, 273, 303, 371, 388, 394, 1066, 1082 | Supported except overbroad old-link claim at 388; see corrections. |
| `docs/upgrading.md` | 5, 57, 63, 153, 159 | Supported in surrounding declaration/section. |
| `packages/server/src/index.ts` | 484, 547, 558, 652, 671, 689, 733, 758, 815, 1064, 1069, 1077, 1102, 1124 | Supported for actual routes; 733 is tickets, not handover. |
| `packages/shared/src/compact.ts` | 15, 21, 46, 65 | Supported in surrounding declaration/section. |
| `docs/roadmap.md` | 23, 25, 42, 506 | Supported in surrounding declaration/section. |
| `docs/decisions.md` | 363 | Supported in surrounding declaration/section. |
| `packages/hub-core/src/protocol.ts` | 9, 30 | Supported in surrounding declaration/section. |
| `packages/hub-core/src/hub.ts` | 543, 557, 571 | Supported in surrounding declaration/section. |
| `packages/shared/src/types.ts` | 204 | Supported in surrounding declaration/section. |
| `packages/shared/src/doc.ts` | 56, 108, 156, 483 | Supported in surrounding declaration/section. |
| `packages/shared/src/views.ts` | 26 | Supported in surrounding declaration/section. |
| `packages/shared/src/graph.ts` | 15 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/policy-store.ts` | 18 | Supported in surrounding declaration/section. |
| `packages/shared/src/messages.ts` | 22, 195, 229 | Supported in surrounding declaration/section. |
| `packages/server/src/admit.ts` | 1 | Supported in surrounding declaration/section. |
| `packages/server/src/http.ts` | 9, 123, 181 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/session.ts` | 502, 577, 593, 620, 1110, 1134, 1144 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/hub-client.ts` | 166 | Supported in surrounding declaration/section. |
| `packages/relay/src/index.ts` | 133, 332, 361, 370, 394, 517, 560, 588 | Supported in surrounding declaration/section. |
| `packages/relay/src/secure.ts` | 3 | Supported in surrounding declaration/section. |
| `plugins/room/hooks/common.mjs` | 9, 235, 239, 292 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/arbitration.ts` | 43, 45, 99 | Supported with extra-field validation qualification above. |
| `packages/room-mcp/src/index.ts` | 31, 92 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/tools/workers.ts` | 179 | Contradicts warning-only claim; hard refusal. |
| `packages/room-mcp/src/worker-config.ts` | 185 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/doctor.ts` | 113, 148 | Supported in surrounding declaration/section. |
| `packages/room-mcp/src/stale-version.ts` | 1 | Supported in surrounding declaration/section. |
| `packages/web/src/conn.ts` | 80 | 80 supports ticket issuance; provider options need another anchor. |
| `packages/relay/src/proof.ts` | 47 | Supported in surrounding declaration/section. |
| `packages/relay/src/hub.ts` | 19 | Supported in surrounding declaration/section. |
| `docs/reference.md` | 162 | Supported in surrounding declaration/section. |
| `deploy/self-hosting.md` | 10, 41, 49, 71, 234, 246, 249 | Supported in surrounding declaration/section. |

## Search audit: omitted checks and contracts

Searched all five requested package trees with `rg -n -i 'schema|version|hub:|protocol'`, inspected production hits, and supplemented with `v` equality/literal searches because durable formats use that spelling. Tests, package metadata, imports, logs, JSON tool argument schemas and file-content “versions” are not additional negotiated versions. The current inventory is not exhaustive:

| Omitted or incompletely inventoried location | Actual check/contract and consequence |
| --- | --- |
| `packages/server/src/migrate.ts:174`, `:195`, `:327` | A canonical document whose meta schema is **not 2** is classified as legacy; migration writes schema 2. A future schema-3 document must not reach this classifier as if it were 0.16. Admission policy alone is insufficient; dispatch storage migrations by explicit source schema. |
| `packages/server/src/names.ts:20`, `:27`; `index.ts:170` | Schema-dependent parsing/canonicalization changes allowed name shapes and repository identity. The spec describes the effect but omits the central implementation from its inventory. |
| `packages/server/src/index.ts:879`, `:917` | `/github/prs` and `/github/pr-note` independently select parsing with schema 2. These HTTP routes are missing from the list. |
| `packages/server/src/index.ts:1014`, `:1016` | The post-upgrade connection callback parses and selects document identity again, then attaches automatic Yjs sync. Updating admission without updating this callback is insufficient. |
| `packages/server/src/index.ts:488`, `:698`, `:706`–712, `:764`–789, `:1191`, `:1198`, `:1206` | Additional checks within already named surfaces: legacy credential treatment, legacy-create refusal and initial schema stamping, view-token migration/response shape, old browser-link migration state, legacy credential extraction and websocket-triggered migration. Inventory these as adapter obligations, not merely hello changes. |
| `packages/relay/src/index.ts:507`, `:658` | Local `/ws-ticket` explicitly requires body schema 2; discovery writer stamps schema 2. The cited websocket/discovery-reader checks do not enumerate these independent writers/gates. |
| `packages/room-mcp/src/hub-client.ts:322`, `:394` | Incoming replies/pushes with envelope `v !== 1` are ignored; outgoing requests explicitly stamp `v:1`. The spec inventories the server parser but not the client decoder gate. |
| `packages/room-mcp/src/session.ts:1113`, `:1163` | Admission preflight requires `/view-token` response `hub === 1`; link issuance separately sends schema 2. The first lies near an existing citation but the table only names request constants, omitting the hard response check. Preserve `hub:1` in legacy HTTP responses as well as `/health`. |
| `packages/room-mcp/src/config.ts:85`; `choice.ts:24`, `:65`, `:81`, `:85` | Missing choice schema triggers legacy local branch-name migration; writers stamp 2. This is a durable destination-choice format, independent of a room's negotiated schema. |
| `packages/room-mcp/src/policy-store.ts:82` | Sharing record **`v:1`** is validated and mismatches throw. This is distinct from the disclosure counter mentioned in the spec. |
| `packages/room-mcp/src/tools/join.ts:69` | Disclosure version below 2 triggers renewed sharing disclosure. Mentioned counter has an actual behavior gate, not just a stored number. |
| `packages/room-mcp/src/worker-registry.ts:276`; `worker-status.ts:41`; `worker-registry.ts:43`, `:1299` | Worker record reader requires `v === 1`; worker records and migration maps have versioned durable shapes. Migration-map initialization is a format declaration, not a separate validated negotiation handshake. Mixed MCP versions share these files even when websocket profiles match. |
| `packages/room-mcp/src/prs.ts:171` | Archive export sends schema 2 separately from the session HTTP helpers. |
| `packages/room-mcp/src/doctor.ts:278` | Local identity diagnostic checks schema 2 separately from the inventoried team health check. |
| `packages/room-mcp/src/graph-index.ts:1174` | Producer stamps graph version 1; shared `GraphSnapshot.version` is a type declaration, not a runtime negotiation validator. |

No additional independent Room protocol-number gate was found in hub-core or shared beyond the inventoried envelope/hello, generation and graph/meta contracts. Their implicit record readers still need compatibility tests; absence of a runtime version validator does not mean arbitrary new fields/types are safe. Server/relay hub wrappers also emit literal v1 errors before dispatch (`packages/server/src/hub.ts:374`, `packages/relay/src/index.ts:182`); retain those in the legacy adapter and route bootstrap errors separately.

Excluded from Room contract selection but explicitly accounted for: doctor Node/host version checks, `worker-shell-env.ts:90` host-feature checks, `codex-app-server.ts:66` diagnostic initialize version, wake-path host protocols, Python environment detection at `worker-git.ts:27`, package dependency versions, release-version tests and MCP argument `inputSchema` validation. This review does not assert current external host feature availability or propose new host APIs.

## Notes on the requested judgments

- **Old client → first negotiating team server:** possible only through a legacy route that admits the frozen profile before any document exchange and preserves old automatic sync ordering. Old MCP probes synchronize before hello (`session.ts:593`–621); putting every socket behind a mandatory new hello/ACK would deadlock/refuse them. The spec distinguishes the routes, but implementation tests must assert this exception. Preserve old HTTP `hub:1`, ticket issuance, read-only behavior, generation handling and shared event vocabulary, not just hello fields.
- **New client → old team server:** possible through the exact implemented adapter after valid protected baseline discovery. No extended hello may reach the strict parser. An old server ignores unknown URL query parameters, so discovery/connect races must end in a new client's fail-closed early-frame handling, not attachment to its actual Y.Doc. Unexpected pre-bootstrap Yjs data must never be applied. No capability-based feature can be inferred from release equality.
- **Concurrent old/new writers:** mixed software versions can write schema 2 only while all shared semantics remain baseline-safe. There is no safe concurrent schema-2/schema-3 writing path in this design, nor a claim to provide one. Old unacknowledged/offline writes remain unrecoverable without user-visible recovery; M2 covers accepted writes at the drain boundary. A claim that migration is lossless must identify precisely which retained source state and accepted operations it covers.
- **Downgrade resistance:** self-hosting documents TLS, trusted admitted writers, read-only bearer views, and a same-account filesystem trust boundary; it has no standalone formal threat-model section. Under those assumptions, minimum server policy plus authenticated selection can enforce retired-profile refusal. An admitted member lying about capabilities cannot be prevented from lying, and negotiation cannot constrain arbitrary Yjs writes under the observe-only identity guard. Do not elevate that into a new malicious-writer guarantee. Initial local discovery and floor identity need the clarification in should-fix 2.
- **Daemon interaction:** independent transport ownership and per-session roomd publishing are different axes. A reconnect of the final publisher must validate a fresh connection selection even if it uses the same session identity and lease as its probe. Local selective snapshots also do not persist every unknown root: a full migration source/candidate artifact must be separate from ordinary selective memory snapshots if unknown-field retention is promised. M1 must be resolved before choosing expected local test outcomes.
- **CI realism:** real archived provider/reader/hook bundles are practical for deterministic wire tests, but no evidence here establishes their availability or execution cost. Whole old/new host, lead, worker, viewer, OS and restart cross-products need explicit partitioning and release acceptance ownership. Old-client refusal is sometimes the correct passing assertion. Tests that merely change current constants or use N's readers for old data do not prove compatibility.

## Three questions the maintainer must answer

1. **Which rollout promise wins locally?** Will negotiation ship before daemonization with legacy relay coexistence, or will N require the daemon spec's drained cutover and explicitly exclude mixed local runtimes?
2. **What exactly must survive migration?** Define the authority-side receive barrier, durable drain evidence and accepted-operation boundary; decide whether uncertain old-client writes block migration or require an explicit acknowledged recovery-point loss decision.
3. **Which immutable builds and operations are actually supported for the promised window?** Identify the first stable baseline, patch exceptions/security floors, old-lead worker refusal cases, and the owner/budget for fixture upkeep, cross-platform CI and real-host acceptance.

Must-fix count: **3**.
