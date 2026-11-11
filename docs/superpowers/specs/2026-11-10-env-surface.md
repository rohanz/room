# ROOM_* environment surface audit (2026-11-10)

Status: audit updated for the tuning-constant retirement. Original base `520d18fd`; original author: worker `env-audit`. Historical counts below describe that baseline unless stated otherwise.

## Method

- Names: `grep -rhoE "ROOM_[A-Z_]+" packages/*/src | sort -u` (109 names; with digits allowed the set is the same).
  Every name was then read in context: a match is not necessarily an environment variable.
- Readers: every `process.env.X`, `env.X`, `e.X` and `env[...]` site in `packages/*/src`, `plugins/room/hooks/*.mjs`,
  `plugins/room/bin`, `scripts/` and `deploy/`, plus the Codex MCP allow-list `plugins/room/codex-mcp.json` (`env_vars`).
- Documented: `README.md`, `docs/reference.md`, `deploy/DEPLOYING.md`, `deploy/self-hosting.md`, `docs/upgrading.md`.
  "pkg README" means only `packages/room-mcp/README.md`, which is a contributor document, not user documentation.
- Dead code: `npx knip` is clean on the base, so no reader of a name sits in an unused export or file. A name is
  "remove" only when no source, hook, script, test fixture child or deploy file reads it.

Kinds:

- **user setting**: a person or operator is expected to set it (client side, or `(server)` for the team server).
- **internal handoff**: one Room process sets it for another (lead → worker, roomagent → MCP, Node → PowerShell,
  preview → check command). Users should not set it.
- **test-only seam**: exists so tests can steer behavior.
- **tuning knob**: a limit or interval with a working default.
- **not an env var**: a constant, error code, build define, or a substring of a longer identifier.

Verdicts: **keep**; **keep but document** (live, user-visible, not in user docs); **make a constant** (tuning knob
nobody should need; retired tuning settings are marked below); **remove** (never read).

## Table

| Name | Read in (packages/…/src) | Kind | Documented | Verdict | Note |
|---|---|---|---|---|---|
| `ROOM_AUTO_FETCH` | roomd/base.ts | user setting | README, reference | keep | `0` disables missing-base fetches |
| `ROOM_CLAUDE_WORKER_EFFORT` | room-mcp/hosts/instructions.ts | user setting | README, reference | keep | per-host defaults; candidate to fold into the generic pair |
| `ROOM_CLAUDE_WORKER_MODEL` | room-mcp/hosts/instructions.ts | user setting | README, reference | keep | per-host defaults; candidate to fold into the generic pair |
| `ROOM_CODEX_WORKER_EFFORT` | room-mcp/hosts/instructions.ts | user setting | README, reference | keep | per-host defaults; candidate to fold into the generic pair |
| `ROOM_CODEX_WORKER_MODEL` | room-mcp/hosts/instructions.ts | user setting | README, reference | keep | per-host defaults; candidate to fold into the generic pair |
| `ROOM_CREDENTIALS` | agent/cli.ts, room-mcp/config.ts, room-mcp/credentials.ts | user setting | reference | keep |  |
| `ROOM_KIND` | room-mcp/config.ts, room-mcp/session.ts, room-mcp/worker-config.ts | user setting | pkg README only | keep but document | `agent`/`bot`/`ci`; scrubbed from workers |
| `ROOM_LOCAL_KEY` | agent/cli.ts | user setting | nowhere | keep but document | roomagent CLI fallbacks for `--session` / `--key` (scripts/demo.sh, say.mts) |
| `ROOM_LOG_FILE` | room-mcp/config.ts, room-mcp/index.ts, room-mcp/worker-config.ts +2 | user setting | reference | keep | also worker handoff (per-tag MCP log) |
| `ROOM_MAX_WORKERS` | room-mcp/config.ts | user setting | README, reference | keep | default 8 |
| `ROOM_NAME` | agent/cli.ts, room-mcp/config.ts, room-mcp/worker-config.ts | user setting | pkg README only | keep but document | roomagent writes it for its MCP child; scrubbed from workers |
| `ROOM_OWNER` | room-mcp/config.ts, room-mcp/session.ts, room-mcp/worker-config.ts | user setting | pkg README only | keep but document | also worker handoff (workers inherit the lead owner) |
| `ROOM_ROOM` | room-mcp/config.ts, room-mcp/tools/join.ts, room-mcp/worker-config.ts +1 | user setting | pkg README only | keep but document | explicit room name; how workers get the lead room |
| `ROOM_SERVER` | agent/cli.ts, room-mcp/choice.ts, room-mcp/config.ts +5 | user setting | README, reference, self-hosting | keep | also worker handoff; in Codex allow-list |
| `ROOM_SESSION` | agent/cli.ts | user setting | nowhere | keep but document | roomagent CLI fallbacks for `--session` / `--key` (scripts/demo.sh, say.mts) |
| `ROOM_SHARE` | room-mcp/config.ts, room-mcp/session.ts, room-mcp/worker-config.ts | user setting | README, reference | keep | also worker handoff |
| `ROOM_TAG` | room-mcp/config.ts, room-mcp/index.ts, room-mcp/names.ts +4 | user setting | README, reference | keep | also worker handoff |
| `ROOM_TOKEN` | agent/cli.ts, room-mcp/choice.ts, room-mcp/config.ts +8 | user setting | reference, DEPLOYING, self-hosting | keep | client shared token and server admission token; also worker handoff |
| `ROOM_URL` | agent/cli.ts, room-mcp/choice.ts, room-mcp/config.ts +4 | user setting | reference | keep | legacy team URL; roomagent writes it for its MCP child |
| `ROOM_WAKE` | room-mcp/hosts/diagnostics.ts, room-mcp/hosts/prompt.ts, room-mcp/hosts/wake-mode.ts +2 | user setting | README, reference | keep | `auto`/`socket`/`off` |
| `ROOM_WEB` | room-mcp/config.ts | user setting | reference | keep |  |
| `ROOM_WORKER_EFFORT` | room-mcp/config.ts, room-mcp/hosts/selection.ts, room-mcp/tools/workers.ts +1 | user setting | README, reference | keep | also written into worker env so nested spawns inherit |
| `ROOM_WORKER_MAX_BUDGET_USD` | room-mcp/worker-config.ts | user setting | README, reference | keep | Claude `--max-budget-usd` |
| `ROOM_WORKER_MODEL` | room-mcp/config.ts, room-mcp/hosts/selection.ts, room-mcp/tools/workers.ts +1 | user setting | README, reference | keep | also written into worker env so nested spawns inherit |
| `ROOM_ADMINS` | server/auth.ts, server/index.ts | user setting (server) | DEPLOYING, self-hosting, upgrading | keep | read directly from process.env (not settingsFromEnv) |
| `ROOM_DOC_MAX_MB` | hub-core/doc-cap.ts, hub-core/hub.ts, server/index.ts +3 | user setting (server) | README, reference, DEPLOYING, self-hosting, upgrading | keep | error messages tell operators to raise it |
| `ROOM_IDENTITY_GUARD` | server/index.ts | user setting (server) | README, reference, DEPLOYING, self-hosting | keep | experimental `enforce`; read directly from process.env |
| `ROOM_IDLE_DAYS` | server/index.ts, server/settings.ts | user setting (server) | README, reference, DEPLOYING, self-hosting | keep |  |
| `ROOM_MANAGED_REPOS` | server/index.ts | user setting (server) | DEPLOYING, self-hosting, upgrading | keep | read directly from process.env |
| `ROOM_MAX_MESSAGE_MB` | server/index.ts, server/settings.ts | user setting (server) | README, reference, DEPLOYING, self-hosting, upgrading | keep |  |
| `ROOM_SHARE_MAX` | room-mcp/session.ts, room-mcp/tools/share.ts, server/index.ts | user setting (server) | README, reference, DEPLOYING, self-hosting | keep | read directly from process.env |
| `ROOM_STATIC` | server/index.ts | user setting (server) | self-hosting | keep | web bundle directory |
| `ROOM_TRUST_PROXY` | server/index.ts | user setting (server) | reference, DEPLOYING, self-hosting | keep | read directly from process.env |
| `ROOM_DIR` | agent/cli.ts, room-mcp/hosts/claude-binding.ts, room-mcp/hosts/codex-binding.ts +3 | internal handoff | pkg README (worker env list) | keep | worker and roomagent → MCP working directory |
| `ROOM_HOST` | room-mcp/hosts/codex-binding.ts, room-mcp/hosts/codex-worker-warning.ts, room-mcp/hosts/diagnostics.ts +1 | internal handoff | roadmap only | keep | set to `codex` by codex-mcp.json; host detection |
| `ROOM_LAUNCH_NONCE` | room-mcp/ledger.ts, room-mcp/tools/workers.ts, room-mcp/worker-config.ts +1 | internal handoff | nowhere | keep | worker launch identity checked against the registry (group 3) |
| `ROOM_LEAD` | room-mcp/worker-config.ts, room-mcp/session.ts | internal handoff | pkg README (worker env list) | **remove** (done) | written into every worker env and the Codex allow-list; never read by any source, hook or script since it was introduced (f5b070cf) |
| `ROOM_LEAD_CLONE` | room-mcp/session.ts, room-mcp/worker-config.ts | internal handoff | nowhere | keep | lead git common dir for local workers (group 3) |
| `ROOM_MERGED_TREE` | room-mcp/tools/files.ts | internal handoff | nowhere (tool text only) | keep but document | set for room_preview_merge `run` commands; user check scripts may read it |
| `ROOM_NAME_EPOCH` | room-mcp/names.ts, room-mcp/session.ts, room-mcp/worker-config.ts | internal handoff | nowhere | keep | name-reservation epoch the worker takes over (group 3) |
| `ROOM_PRIVATE_PATH` | relay/private-state.ts | internal handoff | nowhere | keep | passes a path to a PowerShell child (Windows ACLs); not user-facing |
| `ROOM_REGISTRY` | room-mcp/hosts/claude-shell.ts, room-mcp/worker-config.ts, room-mcp/worker-registry.ts | internal handoff | reference | keep | group 3 |
| `ROOM_WORKER_HOST` | room-mcp/hosts/codex-identity.ts, room-mcp/hosts/selection.ts, room-mcp/worker-config.ts | internal handoff | nowhere | keep | worker host selection (group 3) |
| `ROOM_WORKER_ID` | room-mcp/config.ts, room-mcp/hosts/claude-shell.ts, room-mcp/hosts/codex-identity.ts +9 | internal handoff | reference | keep | marks a worker process (hooks/session-start.mjs reads it; headless detection) |
| `ROOM_WORKER_MEM_GB` | room-mcp/tools/workers.ts, room-mcp/worker-config.ts, room-mcp/worker-launch.ts | internal handoff | README, reference | keep | computed budget shown to a worker; README also offers them as user overrides; nested spawns divide them |
| `ROOM_WORKER_RUN` | room-mcp/ledger.ts, room-mcp/tools/workers.ts, room-mcp/worker-config.ts +1 | internal handoff | nowhere | keep | worker launch identity checked against the registry (group 3) |
| `ROOM_WORKER_THREADS` | room-mcp/tools/workers.ts, room-mcp/worker-config.ts | internal handoff | README, reference | keep | computed budget shown to a worker; README also offers them as user overrides; nested spawns divide them |
| `ROOM_ARCHIVE_LIST_MAX_KEYS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `ARCHIVE_LIST_MAX_KEYS = 1000` (the old clamp default) |
| `ROOM_AUDIT_KEEP_FILES` | server/settings.ts, server/store.ts | tuning knob | self-hosting | keep | audit disk retention; unset keeps all |
| `ROOM_AUDIT_ROTATE_MB` | server/settings.ts, server/store.ts | tuning knob | self-hosting | keep | audit disk retention |
| `ROOM_AUDIT_SCAN_MB` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.auditScanBytes = 64 * 1048576` |
| `ROOM_AWARENESS_IDS_PER_ROOM` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.awarenessIdsPerRoom = 4096` |
| `ROOM_AWARENESS_MESSAGES_PER_MINUTE` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.awarenessMessagesPerMinute = 6000` |
| `ROOM_COMPACT_MIN_DELETED` | relay/daemon.ts, server/index.ts | tuning knob | reference, self-hosting | keep | server and local relay; `off` switch; soak.mts seam |
| `ROOM_EXPORT_MAX_FRAME_MB` | room-mcp/prs.ts | tuning knob | self-hosting, upgrading | keep but document | client-side frame cap that must track the server ROOM_DOC_MAX_MB; missing from the Codex allow-list |
| `ROOM_GIT_TIMEOUT_MS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `DEFAULT_GIT_TIMEOUT_MS = 30000`; whole-tree scaling still adds 15 ms/path, capped at 300000 ms. Explicit call options and `setGitTimeoutForTest` replace the test env seam |
| `ROOM_IDLE_LEASE_MS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `IDLE_LEASE_MS = 30 * 60000`; tests inject `PresenceEndOptions.idleLeaseMs` and tick timing |
| `ROOM_LEGACY_DAYS` | shared/retired-env.ts (startup diagnostic only) | retired setting | upgrading (retirement notice) | retired (migration owner) | 0.16 migration code and environment reader removed by retire-016; included in shared startup diagnostic |
| `ROOM_LOAD_MAX_MB` | server/index.ts, server/limits.ts, server/settings.ts | tuning knob | DEPLOYING, self-hosting, upgrading | keep | load ceiling coupled to ROOM_DOC_MAX_MB; read twice (limits.ts and settings.ts) |
| `ROOM_MAX_BODY_READS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxBodyReads = 32` |
| `ROOM_MAX_CONNECTIONS` | server/settings.ts | tuning knob | reference, self-hosting | keep | capacity |
| `ROOM_MAX_CONNECTIONS_PER_PRINCIPAL` | server/settings.ts | tuning knob | self-hosting | keep | capacity |
| `ROOM_MAX_CONNECTIONS_PER_ROOM` | server/settings.ts | tuning knob | self-hosting | keep | capacity |
| `ROOM_MAX_EXPORTS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxExports = 2` |
| `ROOM_MAX_HTTP_RESPONSES` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxHttpResponses = 32` |
| `ROOM_MAX_PENDING_ADMISSIONS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxPendingAdmissions = 256`; spawned tests inject `overrideSettingsForTest` |
| `ROOM_MAX_PENDING_LOGINS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxPendingLogins = 1000`; Auth constructor injection remains available |
| `ROOM_MAX_PENDING_PER_ADDRESS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxPendingPerAddress = 16`; spawned tests inject `overrideSettingsForTest` |
| `ROOM_MAX_PR_OPERATIONS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxPrOperations = 8` |
| `ROOM_MAX_QUEUED_MB` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `docMaxBytes + SERVER_FAIRNESS.queuedDocumentHeadroomBytes` (4 * 1048576); tracks ROOM_DOC_MAX_MB as before |
| `ROOM_MAX_ROOMS` | server/settings.ts | tuning knob | reference, self-hosting | keep | capacity |
| `ROOM_MAX_ROOM_LISTS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.maxRoomLists = 8`; spawned tests inject `overrideSettingsForTest` |
| `ROOM_MAX_TOTAL_QUEUED_MB` | server/index.ts, server/settings.ts | tuning knob | self-hosting, upgrading | keep | server memory ceiling |
| `ROOM_MIGRATION_MAX_READ_MB` | shared/retired-env.ts (startup diagnostic only) | retired setting | upgrading (retirement notice) | retired (migration owner) | 0.16 migration code and environment reader removed by retire-016; included in shared startup diagnostic |
| `ROOM_MIGRATION_MAX_RECORDS` | shared/retired-env.ts (startup diagnostic only) | retired setting | upgrading (retirement notice) | retired (migration owner) | 0.16 migration code and environment reader removed by retire-016; included in shared startup diagnostic |
| `ROOM_MIGRATION_MAX_SOURCES` | shared/retired-env.ts (startup diagnostic only) | retired setting | upgrading (retirement notice) | retired (migration owner) | 0.16 migration code and environment reader removed by retire-016; included in shared startup diagnostic |
| `ROOM_PREVIEW_CACHE_GB` | room-mcp/preview-cache.ts | tuning knob | README, reference | keep | `0` disables reuse; a real disk-use choice |
| `ROOM_REVALIDATE_MINUTES` | server/index.ts | tuning knob | reference, self-hosting | keep | push-permission recheck; `0` disables; read outside settingsFromEnv |
| `ROOM_STALE_DAYS` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `ROOM_STALE_MS = 7 * 24 * 60 * 60 * 1000`, shared with the hub expiry; staleDays argument/config field removed |
| `ROOM_VIEW_MAX_PER_ROOM` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.viewMaxPerRoom = 200` |
| `ROOM_VIEW_MAX_TOTAL` | shared/retired-env.ts (startup diagnostic only) | retired setting | reference (retirement notice) | constant (done) | `SERVER_FAIRNESS.viewMaxTotal = 10000` |
| `ROOM_VIEW_TTL_MS` | server/settings.ts | tuning knob | self-hosting | keep | view-key lifetime: a security policy |
| `ROOM_WORKER_NICE` | room-mcp/worker-config.ts, room-mcp/worker-launch.ts | tuning knob | nowhere | keep but document | worker priority (default 10); the resume path also passes it to workerPriority through a synthetic env object |
| `ROOM_MACHINE_ID` | roomd/index.ts | test-only seam | nowhere | keep | overrides the per-machine salt so tests stay out of ~/.config/room |
| `ROOM_TEST_ARCHIVE_LOAD_DELAY_MS` | server/index.ts | test-only seam | nowhere | keep | gated on NODE_ENV=test (group candidate: one injected delay hook) |
| `ROOM_TEST_INVENTORY_DELAY_MS` | server/index.ts | test-only seam | nowhere | keep | gated on NODE_ENV=test (group candidate: one injected delay hook) |
| `ROOM_TEST_STORED_TABLES_DELAY_MS` | server/index.ts | test-only seam | nowhere | keep | gated on NODE_ENV=test (group candidate: one injected delay hook) |
| `ROOM_TEST_UPGRADE_DELAY_MS` | server/index.ts | test-only seam | nowhere | keep | gated on NODE_ENV=test (group candidate: one injected delay hook) |
| `ROOM_TREE_SITTER_WASM_DIR` | room-mcp/parse/engine.ts | test-only seam | nowhere | keep | grammar directory override; only parse-engine.test.ts sets it |
| `ROOM_CARRY_IDENTITY` | room-mcp/worker-git.ts, room-mcp/worker-refresh.ts, room-mcp/worker-state.ts | not an env var | — | n/a | constant: git author of carried-edit commits |
| `ROOM_CLAUDE_WORKER_` | room-mcp/hosts/selection.ts | not an env var | README | n/a | prefix used to compose the per-host `_MODEL`/`_EFFORT` names (grep cannot see composed names) |
| `ROOM_CLOSED_CODE` | room-mcp/session.ts | not an env var | — | n/a | websocket close-code constants |
| `ROOM_CODEX_WORKER_` | room-mcp/hosts/selection.ts | not an env var | README | n/a | prefix used to compose the per-host `_MODEL`/`_EFFORT` names (grep cannot see composed names) |
| `ROOM_DAEMON_RELEASE__` | relay/daemon.ts | not an env var | — | n/a | esbuild define `__ROOM_DAEMON_RELEASE__` |
| `ROOM_DOC_MAX_BYTES` | hub-core/doc-cap.ts, relay/index.ts, relay/local-migrate.ts +4 | not an env var | — | n/a | constant (64 MiB) in @room/shared; mirrors server default of ROOM_DOC_MAX_MB |
| `ROOM_FILE` | roomd/index.ts | not an env var | — | n/a | constants: `.room.json` and its 16 KiB read bound |
| `ROOM_FILE_MAX_BYTES` | roomd/room-file.ts | not an env var | — | n/a | constants: `.room.json` and its 16 KiB read bound |
| `ROOM_FILE_TOO_LARGE` | roomd/bounded-read.ts | not an env var | — | n/a | error `code` strings |
| `ROOM_HOOKS_FILE_SHA256` | room-mcp/hosts/codex-install.ts | not an env var | — | n/a | substring of `CODEX_ROOM_HOOK_HASHES` / `CODEX_ROOM_HOOKS_FILE_SHA256` |
| `ROOM_HOOK_HASHES` | room-mcp/hosts/codex-install.ts | not an env var | — | n/a | substring of `CODEX_ROOM_HOOK_HASHES` / `CODEX_ROOM_HOOKS_FILE_SHA256` |
| `ROOM_LISTS` | server/settings.ts, server/index.ts | not an env var | — | n/a | substring of `MAX_ROOM_LISTS[_PER_PRINCIPAL]` constants |
| `ROOM_LISTS_PER_PRINCIPAL` | server/index.ts | not an env var | — | n/a | substring of `MAX_ROOM_LISTS[_PER_PRINCIPAL]` constants |
| `ROOM_LOG` | room-mcp/index.ts | not an env var | — | n/a | constants: `room-mcp.log` name and its 1 MiB cap |
| `ROOM_LOG_MAX_BYTES` | room-mcp/index.ts | not an env var | — | n/a | constants: `room-mcp.log` name and its 1 MiB cap |
| `ROOM_MESSAGE_TYPES` | server/readonly.ts | not an env var | — | n/a | substring of `TRUSTED_ROOM_MESSAGE_TYPES` |
| `ROOM_NOT_A_FILE` | roomd/bounded-read.ts | not an env var | — | n/a | error `code` strings |
| `ROOM_SIZE_CAP_CODE` | room-mcp/session.ts | not an env var | — | n/a | websocket close-code constants |
| `ROOM_STALE_MS` | room-mcp/config.ts, room-mcp/local-state-gc.ts, room-mcp/retire.ts +2 | not an env var | — | n/a | constant: fixed 7-day hub expiry |
| `ROOM_TEXT_TOO_LARGE` | room-mcp/tools/disk-text.ts, shared/manifest.ts | not an env var | — | n/a | error `code` strings |

## Names outside `packages/*/src`

| Name | Where | Kind | Verdict |
|---|---|---|---|
| `ROOM_GEN` | packages/room-mcp/test/config.test.ts, pkg README | legacy (removed with the 2026-09-28 registry) | test kept: it asserts the variable is ignored. The pkg README still listed it as a worker setting: **removed from the README** (done). |
| `ROOM_TEST_PROCESS_TABLE` | plugins/room/hooks/common.mjs | test-only seam (NODE_ENV=test) | keep |
| `ROOM_CONNECT_TIMEOUT_MS` | scripts/say.mts | dev-script knob | keep (dev script only) |
| `ROOM_IMAGE_TAG` | deploy/docker-compose.yml, .env.example, self-hosting.md | compose interpolation | keep |
| `ROOM_PORT` | deploy/docker-compose.yml | compose interpolation | keep but document (absent from self-hosting.md and .env.example) |
| `ROOM_MIGRATION_*` | self-hosting.md | doc shorthand for the three migration budgets | n/a |
| `ROOM_B`, `ROOM_C`, `ROOM_FAKE`, `ROOM_FROM_LEAD_FILE`, `ROOM_LEAD_FILE`, `ROOM_PREVIEW_SECRET`, `ROOM_REAL_GIT`, `ROOM_SECURITY_MARKER`, `ROOM_SYNC_GIT_LOG`, `ROOM_TEST_BARRIER`, `ROOM_TEST_FAIL_DIR`, `ROOM_TEST_FILE`, `ROOM_TEST_MARKER`, `ROOM_TEST_PATH`, `ROOM_TEST_PATHS`, `ROOM_TEST_PRIVATE_PARENT`, `ROOM_TEST_ROOT`, `ROOM_TEST_WRITER` | packages/*/test | test fixtures: values passed to child processes, or deliberately `ROOM_`-prefixed to prove the scrubbers remove them | keep; not product surface |

Non-`ROOM_` variables (`YPERSISTENCE`, `GITHUB_CLIENT_ID`, `OIDC_*`, `CLAUDE_CODE_ENTRYPOINT`, `SOAK_*`, …) are out of
scope. Peer note: `wait-headless` adds a reader of `ROOM_WORKER_ID` and of the host variable `CLAUDE_CODE_ENTRYPOINT`
for headless detection; no new `ROOM_*` name.

## What was removed

`ROOM_LEAD` (the only provably dead variable). `workerProcessEnv` wrote it into every worker's environment, the
Codex allow-list forwarded it, and `LEAD_ONLY_ENV` scrubbed it, but nothing ever read it; the lead's name reaches the
worker through its prompt and `ROOM_OWNER`. Changes:

- `packages/room-mcp/src/worker-config.ts`: dropped from the worker env, from `LEAD_ONLY_ENV` and its comment; the
  `lead` option of `workerProcessEnv` existed only to fill it and is gone (`worker-launch.ts` still passes
  `policy.lead` to `workerPrompt`).
- `plugins/room/codex-mcp.json`: dropped from `env_vars` (not `hooks.json`; no hook-trust impact).
- Tests: `workers.test.ts` asserts `ROOM_OWNER` where it asserted `ROOM_LEAD`, and its exact worker key list no longer
  contains it; `local-naming.test.ts` no longer stubs it; the `lead:` field is gone from `workerProcessEnv` literals.
- `packages/room-mcp/README.md`: worker env list; also the stale `ROOM_GEN` mention.

Scrub lists: the Claude worker shell scrub (`Get-ChildItem Env:ROOM_*` / `CLAUDE_ENV_FILE`), the Codex
`shell_environment_policy` filter (`ROOM_*`) and vitest `isolateTestEnv` (`ROOM_` prefix) are prefix-based and
need no change. `LEAD_ONLY_ENV` is the one explicit list and now matches what `workerProcessEnv` writes.
`codex-env.test.ts` still proves every launched `ROOM_` variable is in the Codex allow-list.

## Tuning retirement (implemented)

The 18 non-migration tuning variables are fixed at their former unset defaults (see the table). Server capacities, audit retention, view-key lifetime, compaction and other keep/keep-but-document rows remain configurable. The four 0.16 migration variables are removed by the separate migration-retirement change; their completed table state is recorded here by agreement with its owner.

`shared/retired-env.ts` is the single server/client retirement list. Each entry point logs one line per applicable set variable at startup, including empty or malformed values, without printing values or refusing startup. The list also contains the four retired migration variables, agreed with the migration owner. This diagnostic can only see a process's environment: Codex's allow-list no longer forwards the three retired client names, so a value hidden by that host produces no MCP warning. No hook or extra handoff is introduced.

`carry-cleanliness.test.ts` now calls `setGitTimeoutForTest`; `PresenceEnd` already accepts explicit lease options. The spawned-server entry receives admission/list limits as structured command arguments through `devServers.start`, never through environment settings. Startup/settings tests cover the fixed defaults, derived queue headroom and diagnostic behavior. Historical rehearsal records and CHANGELOG entries retain the variable names as evidence of the versions they describe.

## Other findings

- Codex allow-list gaps: `ROOM_EXPORT_MAX_FRAME_MB` (documented client knob), `ROOM_COMPACT_MIN_DELETED` (the local
  relay daemon inherits the MCP environment), `ROOM_MACHINE_ID` and `ROOM_TREE_SITTER_WASM_DIR` are not in
  `codex-mcp.json` `env_vars`, so under Codex they never take effect. Only the first matters to users; better still,
  derive the client frame cap from the server's advertised document cap and drop the knob.
- Server settings read outside `settingsFromEnv` are not validated at boot: `ROOM_ADMINS`, `ROOM_MANAGED_REPOS`,
  `ROOM_SHARE_MAX`, `ROOM_TRUST_PROXY`, `ROOM_STATIC`, `ROOM_IDENTITY_GUARD`,
  `ROOM_REVALIDATE_MINUTES`, `ROOM_COMPACT_MIN_DELETED`. A typo such as `ROOM_TRUST_PROXY=yes` silently means false.
  `ROOM_LOAD_MAX_MB` and (before migration retirement) `ROOM_MIGRATION_*` are read twice (validated in settings.ts, then
  re-read from `process.env` in auth.ts / limits.ts / migrate.ts).
- The resume path passes `ROOM_WORKER_NICE` to `workerPriority` through a synthetic `{ ...process.env, ROOM_WORKER_NICE }`
  object: an argument disguised as an environment variable.
- `ROOM_STALE_DAYS` is now only an exported day-count constant in `@room/shared/expiry.ts` and a retired-environment diagnostic name; the configurable MCP label and hub both use `ROOM_STALE_MS`. The web participant panel retains its unrelated fixed ten-minute offline-claim flag (`shared/views.ts:245`), by the lead's scope decision.

## Original audit counts

By kind (109 names from `packages/*/src`):

| Kind | Count |
|---|---|
| user setting (client 24, server 9) | 33 |
| tuning knob (client 7, server 29) | 36 |
| internal handoff | 14 |
| test-only seam | 6 |
| not an env var | 20 |
| **total** | **109** |

So 89 of the 109 are environment variables; 33 are settings a person is meant to touch.

By verdict: keep 57 · keep but document 9 · make a constant 22 · remove 1 (done) · n/a 20.
If the "make a constant" list lands, 66 environment variables remain: 19 team-server settings and 47 client-side (28 settings or knobs, 13 handoff, 6 test seams).

## Original prioritization (historical)

1. **Server fairness budgets (15 names → 0).** They bound per-principal or per-request work (body reads, HTTP
   responses, PR operations, room lists, exports, pending admissions/logins, awareness rates, view keys, per-socket
   queue). Their defaults protect the server; there is no deployment decision an operator makes with them, and
   `settings.ts` already centralises them, so the change is mechanical. Keep the capacity knobs (`ROOM_MAX_ROOMS`,
   `ROOM_MAX_CONNECTIONS*`, `ROOM_MAX_TOTAL_QUEUED_MB`) that do encode a deployment size.
2. **Worker launch identity (7 handoff names → 1).** `ROOM_WORKER_ID`, `ROOM_WORKER_RUN`, `ROOM_LAUNCH_NONCE`,
   `ROOM_REGISTRY`, `ROOM_NAME_EPOCH`, `ROOM_LEAD_CLONE` and `ROOM_WORKER_HOST` always travel together and must be
   kept in step across `workerProcessEnv`, `LEAD_ONLY_ENV` and the Codex allow-list; a missing allow-list entry already
   broke Codex workers' `room_done` once (2026-09-28 wave 2 rehearsal). One variable naming a 0600 launch record in the
   registry (or one JSON value) removes that class of bug. `ROOM_WORKER_ID` alone should stay visible as the
   "this is a worker" marker the hooks read. Needs care for resumed workers launched by an older bundle.
3. **0.16 cutover budgets (4 names → 0).** `ROOM_LEGACY_DAYS` and the three `ROOM_MIGRATION_*` caps exist only for the
   one-time 0.16 → 0.17 migration. Retire them with that code path when it leaves the supported upgrade window;
   until then they cost little but they dominate the upgrading guide's settings section.

Runner-up: the six worker model/effort variables (`ROOM_WORKER_*` plus four per-host variants) could become two
values with an optional `host:` prefix, but they are documented user settings and cheap; collapse later.
