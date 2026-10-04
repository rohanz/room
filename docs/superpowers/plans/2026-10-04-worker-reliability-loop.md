# Worker reliability: fix, review, rehearse

Requested 2026-10-04: fix the findings from the eight-worker Werkzeug rerun, use periodic Codex Astra reviews, repeat Werkzeug until clean, then exercise HTTPX. No release or production deployment is implied by this evaluation.

## Acceptance

- Original retained Codex worker conversations resume before and after a planned lead restart, including when host thread IDs arrive through hook records instead of environment variables.
- A worker can read and preview finished siblings' shared files. A complete preview includes the requested participants; a passing partial preview is not combined validation.
- Genuine source conflicts are resolved through the original workers, with all independent requirements and tests retained.
- The lead obtains a complete combined preview with tests passing, uses normal collection, and reruns tests in the actual checkout.
- Clean, fully collected owned worktrees disappear without a separate forced discard for generated Python environments.
- No unresolved relevant Astra review finding or Room failure remains. This is bounded evidence, not proof that the software has no bugs.

## Implementation and review decisions

Graceful participant lease end must preserve the final publication. Losing publisher authority to a successor still withdraws it. Presence continues to end before potentially slow worker cleanup.

Local memory retains completed publications separately from live Yjs roots. The reader requires a currently accepted projection from the live lead naming the same worker ID, run and done status. Cached data cannot grant a lease, create live presence, or override a current publication. Only current manifest entries and already-shared text/base text are retained; held and excluded data stay unavailable.

The first Astra review reproduced resurrection when freshly copied live roots defeated a surviving replica's retirement tombstones. That design was replaced before rehearsal. A second review reproduced stale-cache replay after sharing was narrowed and the relay restarted again. Immutable revision markers, ordered by holder epoch, semantic revision and content revision, now survive payload eviction and compact to one latest record per participant. Both cached and stale live reads are checked against those markers. A bounded human-readable retirement archive is not used as permanent cache authorization.

The 5 MB local-memory target sheds oldest completed payloads before coordination. Revision markers contain no file text and remain after payload eviction. The existing 64 MB snapshot ceiling remains. Browser readers, file previews, participant proximity and conflict checking use the same validated snapshots; source graphs continue to require live publication.

Normal cleanup recognizes `.venv`/`venv` only with a regular bounded `pyvenv.cfg`, a version and home, an interpreter, and standard entry types. Standard environment directories and their contents are disposable, like installed dependencies. Unknown top-level files, wrong types, linked environment roots and unrecognized layouts retain the worktree. Tests include real uv-shaped metadata, internal ignore files, interpreter symlinks and `lib64 -> lib`; cleanup does not follow the interpreter link.

Only a worker's lead resumes it. A sibling addressing an already-finished worker is directed to that lead; the ownership boundary remains intentional.

After both first-candidate rehearsals passed, a separate preview in the supervising installed Room session exposed an inherited deleted working directory. The current `git merge-file` call lacked an explicit working directory and reproduced the exact failure in an isolated-child regression. It now runs in its existing private merge directory. Both Astra reviewers accepted the one-line fix; 12 targeted merge tests and typecheck passed. The origin of the installed process's deleted directory was not established. A rebuilt candidate and fresh rehearsals validated this fix; stale offline overlays from the supervisor's same checkout are not independent changes to merge back into source.

## Rehearsal method

Fresh history-free snapshots are prepared in `/tmp`. Leads and workers see task cards and their own checkout, not upstream solutions, previous rehearsal output or the Room development checkout. The frozen development plugin is injected through task-specific launchers, without modifying installed plugins or trusted hook content. Host-ID environment variables are removed from worker MCP processes to exercise hook binding. All live implementation workers use Codex; review agents use Codex Astra.

Werkzeug uses the same baseline tree and eight issue cards as the previous run: tree `930015924131fb57263912a351ee1afc8df9686d`, baseline 984 tests. HTTPX uses original rehearsal snapshot `88b5c0a7bfbfbf083a393a95ee617497014cc1e9`, tree `13b65805db11935d4e401d0eb12f9fa4c9121489`. Its eight-worker workload contains three historical issue cards plus five complementary implementation, integration-test and documentation tasks; it is not eight historical upstream issues.

HTTPX's 2023 warning-as-error baseline fails with modern unpinned Click's `isolated_filesystem` deprecation. Pinning Click 8.1.3 in the test invocation restores its baseline: 822 passed, one existing Python-version skip. The same environment pin must be used for previews and final validation; no source assertion is suppressed.

The machine suspended during early validation, causing a roughly seven-hour wall-clock jump and invalid timing-test results. Those runs are not acceptance evidence. Final commands use a temporary `caffeinate -i` wrapper while executing; no persistent power settings are changed.

## Local evidence

- Development validation: `/tmp/room-worker-fixes-*.log`.
- Werkzeug first candidate: `/tmp/room-werkzeug-clean-r1`, `/tmp/room-werkzeug-clean-r1-run`.
- HTTPX first candidate: `/tmp/room-httpx-clean-r1`, `/tmp/room-httpx-clean-r1-run`.

Raw logs can contain local viewer capabilities; only sanitized results belong in repository documentation. Final accepted reruns and their evidence directories (`/tmp/room-werkzeug-clean-r2-run` and `/tmp/room-httpx-clean-r2-run`) are recorded in the rehearsal notes.

## Candidate validation before the next live batch

On 2026-10-04, after the suspension-affected runs were discarded, the full suite passed **3,508 tests across 321 files** in 427.77 seconds. Typecheck and full plugin build passed. The focused cache/browser suites passed 60 tests. Two Codex Astra reviewers reported no remaining blocking finding in the reviewed scope. Frozen MCP bundle SHA-256: `78c743c5483b3e3d4137a300f11190a37d6b27f5efd3e477ab884973cf733e0c`. Codex CLI 0.160.0 `model/list` confirmed both GPT-6.1 Sol and GPT-6 Astra before launch.

After the additional Git working-directory fix, final full confirmation passed **3,509 tests across 321 files in 387.82 seconds**, without a competing live worker batch. Typecheck and full plugin build passed; final MCP bundle SHA-256 is `207437b0f923885048b11f1f74b8a5c86a00466a9aab8a132da49c2a913be642`. Validation history, including the corrected skill assertion and isolated timeout diagnosis, is retained in the [rehearsal record](../rehearsals/2026-10-04-worker-reliability-loop.md). The final-candidate Werkzeug run passed 1,179 tests with normal cleanup and independent Astra signoff; the final-candidate HTTPX run passed 995 tests with one existing skip, normal cleanup and independent Astra signoff. Both verified original-thread resume after a cold restart and complete finished-sibling shared previews. All acceptance checks are complete; changes remain local, uncommitted and unreleased.
