# Host adapters

Date: 2026-11-05. Status: proposed; this document changes no runtime behavior.

**Revision 2026-11-05.** Responds to the full [host-adapter review](../reviews/2026-11-05-spec-review-host-adapters.md). Adds pre-binding classification, metadata decoding and workspace admission, with startup/call characterization (M1); makes extraction strictly behavior-preserving and separates four behavior changes into independently tested future batches (M2); retains shell dialect/original tool evidence and defines bounded transcript reduction (M3); adds activity event time, run directory and separate scanner scopes (M4). Also makes shipping stages, artifact feedback and codec builds concrete (S1), defines the interactive-only third-host minimum and durable worker capability gates (S2), makes inputs/optional facets/lifetimes explicit (S3), narrows Codex fallback claims (S4), and qualifies current-version evidence and unknown-version behavior (S5). Completes the inventory and corrects citation/acceptance qualifications. November 5 current Claude release verification remains an implementation prerequisite, not a claim of this revision.

## Problem

Implement the adapter item in `docs/roadmap.md:37`: one Claude Code adapter and one Codex adapter own the interpretation of their host's evidence and protocols. Room continues to own coordination, authorization and worker lifecycle. The goal is to make a host upgrade reviewable in one place without making unlike host capabilities appear equivalent.

The existing boundaries are useful but incomplete. `binding.ts` delegates matching to `session.ts`, which interprets both hosts; `wake-path.ts` selects transports while startup in `index.ts` constructs the production Codex probe and `wake-reconciler.ts` also supplies a default; `worker-launch.ts` knows Claude shell setup and plugin-directory rules; `run-log-facts.ts` stores both hosts' event shapes. Doctor and hooks implement additional interpretations independently. In particular, `worker-status.ts` is largely **shared lifecycle policy**, not another host log parser (`packages/room-mcp/src/worker-status.ts:85`). Moving that state machine into adapters would duplicate the most consequential rules.

Recent fixes show the cost of these dispersed assumptions:

- **False host death:** a Windows Codex session stopped roughly 40 seconds after joining because its hook record named a transient or obsolete process. 0.17.21 required corroboration from the MCP parent; 0.17.22 handled unreadable parent identity; 0.17.23 stopped recording a shell as the host and made cached Windows identity reads nonblocking (`CHANGELOG.md:67`, `CHANGELOG.md:75`, `CHANGELOG.md:81`). Identity discovery must preserve “unknown” separately from “dead.”
- **Configured wake without binding:** starting Claude before `git init` cached “not a repository” forever. Seven workers completed without waking their lead. 0.17.25 added rediscovery and an explicit unbound diagnostic (`CHANGELOG.md:57`; current retry: `packages/room-mcp/src/binding.ts:41`). This is a shared binding-cache bug, not a socket failure; an adapter must not conceal it.
- **Wrong install evidence:** stale Claude bookkeeping was blamed for a missing wake even though a directory marketplace loaded the checkout. 0.17.26 restricted the warning to an actually loaded cache and made failed listings inconclusive (`CHANGELOG.md:50`; `packages/room-mcp/src/doctor.ts:95`, `packages/room-mcp/src/doctor.ts:115`). Codex separately loads bundle and hook files from different roots (`packages/room-mcp/src/doctor.ts:186`).
- **Exec mistaken for app-server:** all 14 Codex workers in a November 4 batch joined under process identity then rebound to thread identity. 0.17.28 waits up to five seconds for binding evidence and suppresses inapplicable mid-turn posts to exec workers (`CHANGELOG.md:38`; `packages/room-mcp/src/binding.ts:24`, `packages/room-mcp/src/binding.ts:29`, `packages/room-mcp/src/index.ts:216`, `packages/room-mcp/src/wake-path.ts:183`).
- **Log and process evidence confused:** 0.17.28 preserved kill signals and stopped quoting arbitrary command output as failure summaries; 0.17.30 restricted no-report summaries to model final text; 0.17.31 cached run-log facts and bounded hook reads (`CHANGELOG.md:38`, `CHANGELOG.md:18`, `CHANGELOG.md:7`). Parsing a host's “result” must never manufacture an OS exit observation or a Room completion receipt.

Not every fix in 0.17.20–0.17.32 belongs here. PID reuse during collection (0.17.20), worker relay takeover and retained-worktree cleanup (0.17.31), and Linux preview quarantine (0.17.32) remain shared process, relay and collection concerns (`CHANGELOG.md:87`, `CHANGELOG.md:7`, `CHANGELOG.md:3`). Extraction preserves those fixes; it does not claim to solve them again.

### Evidence and host-version baseline

Read this with `CLAUDE.md:95` (“Host features change weekly”), `docs/reference.md:71` (delivery), `docs/reference.md:87` (workers), and `docs/reference.md:176` (presence). The September surveys are historical evidence, not present-day setup instructions. The Claude survey used 2.1.281; the Codex survey used 0.155.1 and reported 0.156.1 as latest (`docs/archive/reports/host-survey-2026-09-24-claude-code.md:9`, `docs/archive/reports/host-survey-2026-09-24-codex.md:9`).

On November 5, this design also checked installed `codex-cli 0.166.0` via `codex --help` (including `queue` and `--no-daemon`), the [official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [OpenAI plugin hook documentation](https://developers.openai.com/plugins/build/plugins), Claude's [documentation index](https://code.claude.com/docs/llms.txt), [hooks reference](https://code.claude.com/docs/en/hooks), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), and [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). No live host behavior was exercised for this document. Current documentation confirms hook trust remains a separate concern from plugin installation; exact cache layouts below are observations of Room's implementation, not promised host APIs.

The review could not verify November 5's current Claude release: its raw changelog response was headed **2.1.269**, with no verified current revision; **2.1.281** is only September's surveyed version. Neither is a verified November 5 baseline. Before implementation, save dated, linked extracts of the required primary pages and changelog revision in each batch brief, with exact installed/tested CLI versions and retrieval failures. No such new snapshot is claimed here.

Keep historical introduction versions beside the capability tests: Claude inbox 2.1.224 on macOS/Linux, 2.1.234 on native Windows; MCP session-id environment 2.1.154; Codex queue 0.149 and shell filters 0.146.0. Sources: `docs/archive/reports/host-survey-2026-09-24-claude-code.md:13`, `docs/archive/reports/host-survey-2026-09-24-claude-code.md:35`, `docs/archive/reports/host-survey-2026-09-24-codex.md:106`, and `packages/room-mcp/src/worker-shell-env.ts:12`. Codex external tool-output messaging was surveyed through SDK 0.155.0 with CLI 0.151+; attachment to a TUI-owned daemon thread was explicitly an inference then (`docs/archive/reports/host-survey-2026-09-24-codex.md:13`). Room's later capability proof is `docs/superpowers/rehearsals/2026-10-08-midturn-delivery.md`; retain its limits. Do not turn the older MCP Events proposal into an implemented capability (`docs/roadmap.md:54`).

## Current mechanism

Paths in the table are repository-relative; `:N` denotes an actual line in the pre-extraction source. “Both” means shared code currently interprets host-specific evidence.

| Concern | Host | Mechanism and source |
|---|---|---|
| Binding wrapper | Both | Synthetic receipt identity, one-second cache, repository rediscovery and migration: `packages/room-mcp/src/binding.ts:32`, `packages/room-mcp/src/binding.ts:70`. |
| Session identity | Claude | Worker-provided id; newest matching worker record or parent-chain record; environment fallback so `/clear` can supersede spawn-time identity: `packages/room-mcp/src/session.ts:257`. |
| Session identity | Codex | Process-global first valid metadata thread is retained and conflicting ids are ignored/logged; worker matching hook record precedes log/tool ids; non-worker shared app-server must not guess a thread from cwd, while recognized non-daemon parents can match hook records: `packages/room-mcp/src/session.ts:244`, `packages/room-mcp/src/session.ts:270`. Exec predicate: `packages/room-mcp/src/binding.ts:24`; five-second constant and autojoin wiring: `packages/room-mcp/src/binding.ts:29`, `packages/room-mcp/src/index.ts:216`. |
| Wake transport | Claude | `ROOM_WAKE`, socket/token JSONL, 1.5 s timeout, then admitted channel in auto mode; explicit channels mode: `packages/room-mcp/src/wake-path.ts:52`, `packages/room-mcp/src/wake-path.ts:96`, `packages/room-mcp/src/wake-path.ts:144`. |
| Wake transport | Codex | `codex queue --thread … --message …`, 10 s timeout; app-server tool-output post with uncertain/idle/unavailable outcomes; exec exclusion: `packages/room-mcp/src/wake-path.ts:119`, `packages/room-mcp/src/wake-path.ts:174`. |
| Turn state | Codex | Host status, exact-thread rollout lifecycle fallback, recent contact means active but old contact never proves idle: `packages/room-mcp/src/codex-turn.ts:33`. Control socket lookup: `packages/room-mcp/src/codex-app-server.ts:13`. |
| Wake arbitration | Both, with Codex branch | Ledger/frontier/reservation/solo filtering, retries and content-free pointers; Codex state read and urgent busy-turn path: `packages/room-mcp/src/wake-reconciler.ts:201`, `packages/room-mcp/src/wake-reconciler.ts:262`, `packages/room-mcp/src/wake-reconciler.ts:290`, `packages/room-mcp/src/wake-reconciler.ts:373`. Awareness helper call: `packages/room-mcp/src/wake-reconciler.ts:174`; implementation: `packages/room-mcp/src/prompt.ts:7`. |
| Runtime defaults | Both | Explicit > per-host Room env > generic Room env; reading public host settings: `packages/room-mcp/src/worker-config.ts:12`, `packages/room-mcp/src/worker-config.ts:22`. |
| Launch | Claude | `claude -p`, stream JSON, acceptEdits/allowedTools, optional name/id/model/effort/budget, development plugin override: `packages/room-mcp/src/worker-config.ts:170`, `packages/room-mcp/src/worker-config.ts:198`. Minimal effort maps to low at `packages/room-mcp/src/worker-config.ts:166`. |
| Launch | Codex | `codex exec -s workspace-write --json`, model and effort config, newest-cache version reader: `packages/room-mcp/src/worker-config.ts:185`; mismatch helper/caller: `packages/room-mcp/src/worker-config.ts:193`, `packages/room-mcp/src/tools/workers.ts:179`; command: `packages/room-mcp/src/worker-config.ts:202`. |
| Resume | Claude / Codex | `--resume <id>` versus `exec resume <id>`; both require retained host identity: `packages/room-mcp/src/worker-config.ts:198`. Shared launch lifecycle and shell-specific branches: `packages/room-mcp/src/worker-launch.ts:88`, `packages/room-mcp/src/worker-launch.ts:106`, `packages/room-mcp/src/worker-launch.ts:125`. |
| Worker environment | Both | Strip lead-only values, add explicit worker identity/run/nonce/room, budget and virtualenv: `packages/room-mcp/src/worker-config.ts:95`, `packages/room-mcp/src/worker-config.ts:105`, `packages/room-mcp/src/worker-config.ts:224`. Claude env-file assignment is at `packages/room-mcp/src/worker-config.ts:124`. |
| Shell isolation | Claude | `CLAUDE_ENV_FILE` for Bash, worker-only PowerShell updatedInput hook; best effort, never an allow decision: `packages/room-mcp/src/worker-shell-env.ts:29`, `packages/room-mcp/src/worker-shell-env.ts:41`, `packages/room-mcp/src/worker-shell-env.ts:74`. |
| Shell isolation | Codex | Merging `shell_environment_policy.filters` and version warning; MCP env allowlist remains separate: `packages/room-mcp/src/worker-shell-env.ts:12`, `packages/room-mcp/src/worker-shell-env.ts:21`, `packages/room-mcp/src/worker-shell-env.ts:90`. |
| Log acceptance/final text | Claude | Assistant session ids, zero-turn missing-session result, result/assistant text: `packages/room-mcp/src/run-log-facts.ts:63`, `packages/room-mcp/src/run-log-facts.ts:72`; accessors `packages/room-mcp/src/worker-process.ts:66`. |
| Log acceptance/final text | Codex | `turn.started.thread_id` directly or the prior `thread.started` id, `agent_message` final text: `packages/room-mcp/src/run-log-facts.ts:82`; accessors `packages/room-mcp/src/worker-process.ts:66`. |
| Other log interpretation | Both | Failure events and Claude background task events: `packages/room-mcp/src/worker-process.ts:152`, `packages/room-mcp/src/worker-process.ts:201`; host tool/item activity labels: `packages/room-mcp/src/worker-activity.ts:86`, `packages/room-mcp/src/worker-activity.ts:99`, `packages/room-mcp/src/worker-activity.ts:123`. |
| Lifecycle projection | Both | Nonce/run reports, witnessed exits, process liveness and resume/signal capabilities: `packages/room-mcp/src/worker-status.ts:85`, `packages/room-mcp/src/worker-status.ts:148`. No per-host event decoding here. |
| Hook identity/input | Claude | SessionStart `--host claude`; transcript/model handling and `agent_id` subagent guard: `plugins/room/hooks/session-start.mjs:13`, `plugins/room/hooks/session-start.mjs:34`; `plugins/room/hooks/before-edit.mjs:34`, `plugins/room/hooks/before-edit.mjs:65`. |
| Hook identity/input | Codex | Frozen invocation supplies no host flag, so SessionStart defaults to Codex; startup accepts id aliases, before-edit requires `session_id`: `plugins/room/hooks/session-start.mjs:13`; `plugins/room/hooks/before-edit.mjs:16`. |
| Tool input normalization | Both | Shell aliases, command/cmd and path field aliases, patch headers: `plugins/room/hooks/common.mjs:436`, `plugins/room/hooks/common.mjs:448`, `plugins/room/hooks/common.mjs:591`. Bounded stdin and incomplete-prefix handling: `plugins/room/hooks/common.mjs:53`, `plugins/room/hooks/common.mjs:107`. |
| Install detection | Claude | Directory marketplace versus install-cache root and recorded version; CLI listing: `packages/room-mcp/src/doctor.ts:179`, `packages/room-mcp/src/doctor.ts:220`. |
| Install detection | Codex | Cache bundle root versus marketplace hook root; frozen hook hashes/trust: `packages/room-mcp/src/doctor.ts:18`, `packages/room-mcp/src/doctor.ts:79`, `packages/room-mcp/src/doctor.ts:186`. |
| Diagnostic policy | Both | Failed listings are unknown; record drift only matters for loaded cache; delivery configuration is not receipt evidence: `packages/room-mcp/src/doctor.ts:95`, `packages/room-mcp/src/doctor.ts:115`, `packages/room-mcp/src/doctor.ts:140`. |

### Additional callers and explicit exclusions

These rows complete the review's inventory audit. Step numbers refer to the extraction order below; host evidence moves, shared policy remains.

| Mechanism / source | Disposition |
|---|---|
| `packages/room-mcp/src/workspace.ts:15`, `packages/room-mcp/src/workspace.ts:29`, `packages/room-mcp/src/workspace.ts:44`, `packages/room-mcp/src/workspace.ts:54`, `packages/room-mcp/src/workspace.ts:98`, `packages/room-mcp/src/workspace.ts:122`, `packages/room-mcp/src/workspace.ts:138` | Step 2: move host cwd/PWD rules, deferral and raw metadata interpretation to pre-binding facets; retain shared canonical-root/Git checks, retry, single-workspace binding and rejection. |
| `packages/room-mcp/src/index.ts:93`, `packages/room-mcp/src/index.ts:97`, `packages/room-mcp/src/index.ts:114`, `packages/room-mcp/src/index.ts:216`, `packages/room-mcp/src/index.ts:260`, `packages/room-mcp/src/index.ts:265` | Step 2: characterize existing channel advertisement, bootstrap deferral, metadata admission order and doctor bypass; step 7: bind-wait evidence; step 8: production probe and exec exclusion wiring. |
| `packages/room-mcp/src/config.ts:134`, `packages/room-mcp/src/config.ts:148`; `packages/room-mcp/src/presence-end.ts:63` | Step 2: preserve explicit empty channel and each resolver's distinct precedence/failure policy in compatibility wrappers; classify presence before binding, keeping liveness shared. |
| `packages/room-mcp/src/tools/workers.ts:177`, `packages/room-mcp/src/tools/workers.ts:178`, `packages/room-mcp/src/tools/workers.ts:179`, `packages/room-mcp/src/tools/workers.ts:233`, `packages/room-mcp/src/tools/workers.ts:241`, `packages/room-mcp/src/tools/workers.ts:280` | Steps 2–4: public host validation stays shared; move spawn default selection, Claude fresh-id allocation, conditional mismatch evidence and channel command inputs; seed existing durable capabilities before intent. |
| `packages/room-mcp/src/worker-registry.ts:112`, `packages/room-mcp/src/worker-registry.ts:116`, `packages/room-mcp/src/worker-registry.ts:882`; `packages/room-mcp/src/worker-projector.ts:55` | Steps 5/7: adapter interprets env host-session fallback and missing-resume log facts; registry admission, authority, status and receipt policy stay shared. |
| `packages/room-mcp/src/hooks-bridge.ts:202`, `packages/room-mcp/src/hooks-bridge.ts:228`, `packages/room-mcp/src/hooks-bridge.ts:241` | Steps 3/6: adapter supplies wording and host evidence for warning timing; preserve Codex up-front versus Claude observed-edit timing and shared once/session tracking. |
| `packages/room-mcp/src/prompt.ts:7`, `packages/room-mcp/src/prompt.ts:16`, `packages/room-mcp/src/prompt.ts:28`; `packages/room-mcp/src/tools/join.ts:306`; `packages/room-mcp/src/tools/scope.ts:154`; `packages/room-mcp/src/tools/workers.ts:327`; `packages/room-mcp/src/tools/messaging.ts:389` | Steps 8/9: move wake advice/evidence, including Claude end-turn advice, retaining company/spawn/timeout conditions and deduplication. |
| `packages/room-mcp/src/channel.ts:8`; `packages/room-mcp/src/tools/context.ts:55`; `packages/room-mcp/src/tools/state.ts:145`; `packages/room-mcp/src/registry.ts:265`, `packages/room-mcp/src/registry.ts:324` | Step 8: move wire format and probe/channel plumbing; allowlist typed forwarding ports until callers migrate. |
| `plugins/room/hooks/common.mjs:353`, `plugins/room/hooks/common.mjs:634`; `plugins/room/hooks/claude.json:8`, `plugins/room/hooks/claude.json:20` | Step 6: own native executable recognition and envelope-limit evidence in codec integration; retain current shared 10,000-character cap and separate invocation contracts. |
| `packages/room-mcp/src/stale-version.ts:4`, `packages/room-mcp/src/stale-version.ts:50`; `packages/room-mcp/src/index.ts:25`; `packages/room-mcp/src/names.ts:203`; `packages/room-mcp/src/worker-registry.ts:280`, `packages/room-mcp/src/worker-registry.ts:374` | Explicit compatibility exclusions: manifest release/staleness lookup, legacy host-tag migration, persisted host validation and legacy Codex default remain; do not erase these literals. |

`auto-join.ts`, `inbox-budget.ts`, `ledger.ts`, `solo.ts`, `tools/index.ts` and `worker-status.ts` retain generic binding-wait, inbox/receipt, arbitration and lifecycle policy. They are not additional host protocol implementations.

## Proposed design

### Ownership and interface

Add `src/hosts/{types,index,claude,codex}.ts`. Each host module exports one adapter factory and may have private helpers under its directory. There is no inheritance hierarchy, dynamic plugin loader or adapter for every host version. The registry is a small explicit map. Identity admission state belongs to one MCP process and is shared across its rooms. It must not be recreated per room or workspace attempt. Target-specific transport state resets on binding changes. The worker path selects its adapter from the durable worker record, independently of the lead's host.

Use narrow facets with separate entry points. A hook-only process imports a pure codec export without constructing a session adapter or stubbing sockets, install inspection, worker registry or Yjs. The following is the proposed contract, not an assertion that these types exist today:

```ts
type HostId = 'claude' | 'codex'; // extend explicitly when a host ships
type Env = Readonly<Record<string, string | undefined>>;
type ProcessIdentity = { pid: number; startTime: string; executable: string };
type Runtime = { model?: string; effort?: string };
type Target = {
  host: HostId; id: string;
  surface: 'interactive' | 'shared-app-server' | 'exec-worker';
};
type PreBindingEvidence = {
  env: Env; processDir: string; platform: string;
  parent?: ProcessIdentity; parentCommand?: string; rawMeta?: unknown;
};
type StartupFacts = {
  fallbackDir: string; deferWorkspace: boolean;
  presenceKind: 'interactive' | 'shared-app-server';
  // These are independent compatibility decisions, not one unified selector.
};
type CallFacts = { toolSessionId?: string; workspaceCandidates: readonly string[] };
type BindingEvidence = {
  cwd: string; env: Env; parent?: ProcessIdentity; parentArgs?: string;
  records: readonly unknown[]; // existing reader acceptance, not a new full validator
  workerId?: string; workerSessionId?: string;
  toolSessionId?: string; logSessionId?: string;
};
type IdentityResult =
  | { kind: 'bound'; target: Target; source: 'hook' | 'env' | 'tool' | 'worker' | 'log' }
  | { kind: 'pending'; reason: string; initialJoinWaitMs: number };
type TurnState =
  | { kind: 'active' | 'idle'; source: 'host' | 'legacy' | 'contact' }
  | { kind: 'unknown'; source: 'host' | 'legacy' | 'contact'; reason: string }
  | { kind: 'unneeded' }; // transport handles both idle and busy, e.g. Claude inbox
type WakeVia = 'queue' | 'socket' | 'channel' | 'turn';
type WakeResult =
  | { kind: 'submitted' | 'uncertain'; via: WakeVia }
  | { kind: 'idle' } // raced with turn end; caller may try idle path
  | { kind: 'off' | 'unavailable' | 'failed'; reason?: string };
type WakeStatus = {
  mode: 'auto' | 'socket' | 'channels' | 'off'; transport: string;
  availability: 'configured' | 'unknown' | 'off' | 'unavailable';
  limitation: string;
};
type WorkerInput = {
  mode: 'fresh' | 'resume'; sessionId?: string; prompt: string;
  runtime: Runtime; tag: string; cwd: string; logDir: string;
  maxBudgetUsd?: string; env: Env;
  claudeChannel: string; pluginDir?: string; shellEnvHook: boolean;
  wakeChannels: boolean; inheritedShellEnvFile?: string;
};
type WorkerCommandInput = Pick<WorkerInput,
  'mode' | 'sessionId' | 'prompt' | 'runtime' | 'tag' | 'maxBudgetUsd' |
  'claudeChannel' | 'pluginDir' | 'shellEnvHook' | 'wakeChannels'>;
type WorkerPlan = {
  cmd: string; args: string[]; envPatch: Record<string, string>;
  artifacts: readonly { id: string; path: string; content: string; mode: number }[];
  // Applied only after the named artifact was successfully written.
  artifactEnv: readonly { artifactId: string; key: string }[];
  warnings: readonly string[];
};
type HookEvent = {
  event: 'start' | 'before-tool'; sessionId?: string; cwd?: string;
  subagent: boolean; incomplete: boolean; source?: string;
  runtime: Runtime; transcriptPath?: string;
  tool?: {
    kind: 'shell' | 'patch' | 'write' | 'other';
    originalName: string; shellDialect?: 'posix' | 'powershell' | 'unknown';
    input: unknown; // retain original payload until equivalent typed normalization is proven
  };
};
type LogFact =
  | { kind: 'session'; id: string }
  | { kind: 'resume-accepted' | 'session-missing'; id: string }
  | { kind: 'final'; text: string }
  | { kind: 'activity'; text: string; eventTimeMs?: number }
  | { kind: 'failure'; category: string; message?: string }
  | { kind: 'background'; id: string; state: 'open' | 'closed' | 'result-boundary' };
type InstallEvidence = {
  cli: 'present' | 'absent' | 'unknown'; version?: string;
  listing: 'ok' | 'unknown'; plugin: 'present' | 'absent' | 'unknown';
  bundleRoot?: string; hooksRoot?: string; loadedVersion?: string;
  recordedVersion?: string; source?: 'cache' | 'directory';
  hookTrust: 'trusted' | 'modified' | 'absent' | 'unknown' | 'not-applicable';
  remedies: readonly string[];
};
type LogContext = {
  workerId: string; run: number; logStart: number; dir: string;
  scope: 'whole-run' | 'diagnostic-suffix' | 'activity-window';
};
type TranscriptEvidence = {
  sessionRecord: unknown; previousRuntime: unknown;
  // Shared bounded reader supplies stat/cache and at most 64 KiB, not an unbounded transcript.
  transcript?: { path: string; mtimeMs: number; size: number; tail: string; startsMidFile: boolean };
};
interface HostAdapter {
  readonly id: HostId;
  readonly preBinding: {
    startup(evidence: PreBindingEvidence): StartupFacts;
    decodeCall(rawMeta: unknown): CallFacts;
  };
  identify(evidence: BindingEvidence): IdentityResult;
  admitToolSession(id: string): void; // validates, first-id fence where appropriate
  readonly wake?: {
    describe(target: Target): WakeStatus;
    state(target: Target): Promise<TurnState>;
    send(target: Target, pointer: string, phase: 'idle' | 'active'): Promise<WakeResult>;
  };
  readonly worker?: {
    capabilities: { resume: boolean }; // advertised support, persisted before intent
    freshSessionId(): string | undefined;
    defaults(cwd: string): Runtime; // synchronous public-config reader via injected filesystem
    normalizeRuntime(runtime: Runtime): Runtime;
    command(input: WorkerCommandInput): Pick<WorkerPlan, 'cmd' | 'args'>; // pure, sync wrapper seam
    plan(input: WorkerInput): Promise<WorkerPlan>;
  };
  readonly hooks?: {
    decode(event: 'start' | 'before-tool', raw: unknown, argv: readonly string[]): HookEvent;
    reduceRuntime(event: HookEvent, evidence: TranscriptEvidence): unknown;
    context(event: HookEvent['event'], text: string): unknown;
    matchesHostProcess(process: ProcessIdentity): boolean;
  };
  createLogDecoder?(context: LogContext): { push(raw: unknown): readonly LogFact[] };
  inspectInstall(): Promise<InstallEvidence>;
  dispose(): void;
}
```

The existing `SessionRecord` type is a static view, not proof of full runtime validation. Preserve reader-specific acceptance: `readSessionRecord` checks matching `session_id`; enumeration checks a truthy id and its hashed directory, skipping the currently handled parse/missing-file errors (`packages/room-mcp/src/session.ts:160`, `packages/room-mcp/src/session.ts:165`). Matching then checks host, worker/cwd or chain as today. Fixture partial/legacy records, missing optional fields, wrong id/directory, malformed JSON and current error propagation separately for both readers before extraction. Do not add required fields or a stricter common validator under this refactor. Hook decode returns incomplete/unknown identity explicitly and never infers main-conversation identity from an absent field in truncated input. Reasons and diagnostics use bounded categories, not raw host output, credentials or peer content. Keep raw failure text local and apply existing redaction/bounds before presenting it.

Factories receive injected ports for command execution, bounded filesystem reads, process snapshots, socket posting, MCP notification, time and logging. Preserve synchronous `workerRuntime`, `hostWorkerEffort`, `hostDefaultRuntime` and `workerCommand` wrapper signatures while delegating to adapters. `defaults` remains a synchronous filesystem reader, not a pure function; command/runtime transformations and hook reducers are pure. Existing asynchronous install/transport operations stay asynchronous. The synchronous `workerCommand` wrapper maps its existing parameters/options to `worker.command`; the asynchronous launch path can then obtain the artifact plan using the same command builder. No caller is converted to async merely for uniformity. Worker plans receive channel, plugin override, shell-hook/wake settings and inherited env-file explicitly; test each override and explicit empty channel, with no new ambient reads inside plan generation. Plans contain argv arrays, never a shell command string. Artifact paths are suggestions validated and written by shared secure file helpers, retaining the symlink checks of `packages/room-mcp/src/worker-shell-env.ts:74`. Disposal cancels probes and closes transports; the shared reconciler owns retry timers.

Lifetimes are independent: inspection evidence/cache is per installation/environment with the existing freshness policy; classification and identity fencing are per MCP process before Target exists; target transport resources reset on rebind; each run/directory/scanner scope gets its own decoder; each hook invocation uses pure codecs and explicit persisted runtime evidence. Hook imports cannot instantiate the process adapter.

Capabilities are assessed from **surface and protocol evidence**, with observed version recorded when readable. Unknown version means unknown version, not unavailable capability: retain evidence-based Claude socket availability and Codex's warning-only old-filter check. Do not add version gating during extraction; an unreadable version does not disable an existing path. No `supportsWake: true` constant grants permission to submit or signal. Unsupported capabilities return explicit evidence; worker launch is optional for a future host (the worker facet is absent). Both initial adapters provide it; shared launch checks its presence before preparing a worker. Absent wake/hooks facets report unavailable and never claim idle wake or pre-edit support; tool-reply receipts still work. A missing optional facet on a future host does not change the existing complete-input, missing-record hook compatibility path. A host without structured logs emits no log facts. No model or effort default is introduced.

### Mapping the mechanisms

**Pre-binding classification and workspace admission (M1).** Before constructing a Target, the adapter's startup facet interprets host cwd/PWD/ROOM_DIR rules and daemon evidence; its call decoder reads raw `x-codex-turn-metadata.thread_id` and `.workspaces`. Shared filesystem/repository helpers canonicalize candidate directories, collect repository roots (otherwise plain directories), and retain `codexWorkspace`'s single-root selection. Shared `createWorkspaceBinding` retains permanent process workspace, worktree-root AND common-Git checks, retry-after-failed-init, cancellation and rejection diagnostics (`packages/room-mcp/src/workspace.ts:54`, `packages/room-mcp/src/workspace.ts:98`). Passing candidates rather than an already chosen cwd makes this admission part of the adapter integration without moving repository authority into host code.

Preserve `index.ts` ordering: channel capability advertisement at startup; process-global thread admission before dispatch, even before a call is rejected for missing/wrong workspace; deferred initialization for shared Codex; and the `room_state(check=true)` diagnostic bypass that can inspect the requested directory without binding/joining it (`packages/room-mcp/src/index.ts:93`, `packages/room-mcp/src/index.ts:97`, `packages/room-mcp/src/index.ts:260`, `packages/room-mcp/src/index.ts:265`). Do not reorder thread admission after workspace admission as an incidental hardening. The startup facts independently carry presence classification: `packages/room-mcp/src/presence-end.ts:63` currently treats an unreadable parent as interactive, whereas workspace deferral treats it conservatively as deferred. Preserve that disagreement rather than deriving both from a bound Target.

Characterization must cover ROOM_DIR override; Claude inherited PWD in another clone versus symlink spelling of its actual cwd; Codex PWD/INIT_CWD fallback; unknown, empty and throwing parent reads; native Windows deferral without ROOM_DIR; app-server and recognized non-daemon parents; multiple workspace keys resolving to one root versus ambiguous distinct roots; inaccessible entries; lone non-repository folder; metadata with thread id but no workspaces; subfolder acceptance versus sibling-worktree rejection even with the same common Git directory; failed initialization retry and shutdown races. Exercise metadata-before-workspace rejection and process-global first-thread fencing across multiple rooms, including later conflicting ids. Deferred startup must never join/share the inherited wrong clone. These tests pin existing startup discovery, not the roadmap's new discovery proposal.

**Identity and binding.** Shared code gathers repository/process evidence and records using existing acceptance rules, invokes host interpretation, retains binding-cache invalidation/repository retries and migrates receipt directories. Claude owns `/clear` precedence, env fallback and executable recognition. Codex owns id validation, app-server non-guessing, recognized non-daemon parent-chain matching, exec classification, log fallback and five-second initial grace. Matching worker hook records precede log/tool ids (`packages/room-mcp/src/session.ts:270`); only non-worker shared app-server guessing is forbidden. Keep grace scheduling shared through `initialJoinWaitMs`, wired into autojoin, with no sleep in `identify`.

Selection uses named compatibility wrappers, not a unified precedence: `boundSession`'s explicit host wins, then either Claude Room variable wins over Codex variables, then parent recognition (`packages/room-mcp/src/session.ts:261`); `resolveSessionHost` prefers worker host then Room host then parent/Claude-session-env (`packages/room-mcp/src/config.ts:148`); spawn prefers explicit host then Room host then worker host, selecting Claude unless the result is Codex (`packages/room-mcp/src/tools/workers.ts:178`). With worker=codex/host=claude these respectively choose Claude/Codex/Claude. Characterize all permutations, invalid/absent values and parent-read failure; preserve these outcomes through wrappers. Unknown identity remains pending where it does today, but contradictions do not become a new rejection rule.

Keep admission state once per MCP process across all room bindings. Shared liveness retains alive/dead/unknown, parent corroboration, idle lease and H1 policy. Pre-binding presence classification selects its existing policy even before identity resolves; no missing pid or unreadable version changes that policy. Pending identity remains visible to doctor and wake health.

**Wake.** Move socket JSONL/auth and channel admission to Claude; move queue, `CodexTurnProbe` and app-server RPC to Codex. `state = unneeded` lets the shared reconciler use Claude's transport without an artificial idle test. Codex keeps active/idle/unknown, its exact-thread fallback and exec-worker exclusion. `submitted` is only transport handoff: for a socket, it means bytes written; for a queue, queue command success. Neither it nor `uncertain` is a ledger receipt. Unknown host state retains existing backoff and forbids an opportunistic queue send.

The shared reconciler still selects owed, above-frontier, unreserved messages; excludes waits and own-commit notices; applies company and priority rules; batches pointers; enforces retry limits and cooldowns; rechecks binding after awaits; and records wake evidence. A busy-turn submission remains eligible for the existing idle follow-up while content is owed (`packages/room-mcp/src/wake-reconciler.ts:285`). Keep `idle` race handling, uncertain records and binding-change reset. Replace `target.host === 'codex'` and the `codexTurn` option with the facet, not with a policy engine hidden inside each adapter. Return host delivery limitations from `describe` so doctor does not invent its own host switch. Replace the Claude-only awareness helper with adapter evidence while preserving the existing awareness field and meaning for old peers.

**Launch, resume and environment.** Shared code resolves explicit/per-host/generic Room options, computes budgets, prepares worktrees/dependencies and prompt, reserves names/ports, journals intent, spawns, captures child identity, records exit and handles cancellation. The adapter returns exact fresh/resume arguments and host env additions. Claude owns `--plugin-dir` suppression of the installed plugin, name/id/effort/budget flags, Bash env-file content and PowerShell scrub hook settings. Codex owns workspace-write fresh/resume syntax, JSON output, shell filters and installed-version mismatch evidence. Keep distinct compatibility readers for doctor listing evidence and the numerically newest-cache worker warning, including its existing conditional call at `packages/room-mcp/src/tools/workers.ts:179`. Moving them under one adapter must not unify their authority or freshness rules; active-install selection is deferred.

Preserve two environments: the host/MCP receives explicitly selected Room coordination values; model-run shell commands exclude **all** `ROOM_*`. Lead-only variable removal, thread caps, virtualenv rebasing and identity injection remain shared. Host-specific runtime names and shell-policy encodings move to adapters. Shared artifact execution returns per-artifact success/failure; apply `artifactEnv` (including CLAUDE_ENV_FILE) only for a successful write, preserving the inherited environment on failure as today (`packages/room-mcp/src/worker-launch.ts:106`). A precomputed unconditional envPatch must never reference a failed artifact. A failed Claude env-file write and a pre-0.146 Codex filter remain visible warnings with their current limitations; the PowerShell hook never approves a tool. Do not broaden sandbox, network access, allowedTools or hook trust during extraction. A successful child spawn is not proof that a resume prompt was accepted.

**Log parsing.** The shared scanner owns bounded chunks, partial-line buffering, offset/run boundaries, inode/truncation/rewrite checks and cache eviction (`packages/room-mcp/src/run-log-facts.ts:87`, `packages/room-mcp/src/run-log-facts.ts:110`, `packages/room-mcp/src/run-log-facts.ts:145`). Each adapter owns the event schema and decoder state. Claude emits acceptance only from session-matching assistant activity and preserves zero-turn missing-session evidence; Codex accepts `turn.started.thread_id` directly or falls back to a prior `thread.started`; requiring both events would tighten acceptance (`packages/room-mcp/src/run-log-facts.ts:82`). A session-id announcement alone is not acceptance. Normalize final text, errors, activity and background facts too, removing the parallel parsers in `worker-process.ts` and `worker-activity.ts` rather than leaving them behind.

Activity facts carry optional parsed `eventTimeMs` (ISO or positive finite epoch milliseconds) and decoder context includes worker/run identity, run offset and directory. Preserve worktree-relative/privacy-bounded labels and event-time parsing inside the adapter (`packages/room-mcp/src/worker-activity.ts:86`, `packages/room-mcp/src/worker-activity.ts:99`, `packages/room-mcp/src/worker-activity.ts:115`). Shared activity scanning retains whether the activity was the last complete line, last write clamped to now, previous poll/run-start/birthtime fallback and final timestamp clamp (`packages/room-mcp/src/worker-activity.ts:158`). Do not parse host timestamps again in shared reducers. Test timestamped edits followed much later by non-activity result lines, missing/invalid/future timestamps, first/subsequent polls, directory-relative paths, bounded suffixes cutting a partial line, and rewrite/truncation. Activity age must match the old tracker exactly.

Create separate decoder instances/state for whole-run acceptance, bounded suffix failure/background diagnostics and activity windows. Never feed whole-run background state into a suffix reducer: incomplete suffix evidence stays incomplete. Include scope and directory as well as adapter id/decoder revision in cache identity during migration; never reuse facts from another host or run. Preserve separate evidence scopes: acceptance scans the whole run; diagnostics/background analysis currently use bounded suffixes. Do not silently turn incomplete suffix evidence into a complete task history. Shared reducers preserve current result-text precedence and the existing Codex background-count behavior; represent lack of task evidence as unknown internally. `statusOf`, durable reports, run nonce checks, exit witnesses and resume/collect/signal capabilities remain unchanged.

**Hook input and output.** Keep `session-start.mjs`, `before-edit.mjs`, their CLI contracts and `common.mjs` version stamp at the same paths. Their thin entry points select a host codec, then call shared hook coordination. SessionStart retains `--host claude` and the no-flag Codex default. Before-edit has no new argv flag: use the session record's host when present, preserving its existing reader checks. If missing, retain a compatibility codec for existing fields. For a complete valid `session_id` with exact live endpoint ownership, preserve selection, print and confirmation without a known host record (`plugins/room/hooks/before-edit.mjs:80`). Hook activity and hook receipt writes still happen before loading `session.json` (`plugins/room/hooks/before-edit.mjs:25`). The existing subagent/incomplete guard suppresses main-conversation selection/confirmation and told-claim/company receipts, not those earlier activity writes. Missing record alone adds no rejection. Do not substitute `ROOM_HOST` for a session record without testing daemon inheritance.

The codecs own host field aliases, model/effort/transcript interpretation, subagent classification, tool aliases and the output envelope. Shared hook code retains stdin byte/deadline caps and prefix recovery, receipt validation, advisory shell/path analysis, claim/nearby formatting, context budget, select/print/confirm and endpoint bounds. Keep both `originalName` and explicit shell dialect through shared analysis. In the initial move call the compatibility analyzer with the original discriminator and original payload: `pathsOf` still selects PowerShell via `toolName === 'PowerShell'` (`plugins/room/hooks/common.mjs:591`). Do not treat every shell as POSIX or hide the discriminator in opaque input. Fixtures compare Bash/PowerShell writes, command/cmd aliases, patch headers, path aliases, Windows roots and claimed/nearby context and receipts. Only replace the payload with typed command/path normalization after equivalent analyzer outputs are characterized.

`decode` performs no transcript I/O. Shared bounded reading supplies `TranscriptEvidence` to the host-owned pure `reduceRuntime`; retain the 64-KiB tail limit, mid-file handling, persisted path/mtime/size cache and retry on unreadable/rotated transcript (`plugins/room/hooks/before-edit.mjs:42`). On the first transcript read SessionStart's model wins; subsequent changed tails can reflect `/model`. Fixture initial lagging transcript, unchanged stat, later model switch, effort updates, rotation/read failure and Codex event-model behavior, comparing runtime.json and cache writes. Shared helpers can decode the common Claude-format envelope; each adapter explicitly accepts its fields. Preserve the current difference between startup id aliases and before-edit's required `session_id` until a separate tested change authorizes broadening it.

Build the small hook codecs from the same host-owned source into standalone ESM shipped beside the hooks. Do not make hooks import the MCP server bundle or require an MCP connection just to identify their input. Add codec entry points to `scripts/build-plugin.mjs:25` (currently MCP/parse only) and committed-output freshness coverage in the same change that imports them from hooks. Test generated codec output for drift and run hook fixtures against shipped standalone ESM. **`plugins/room/hooks.json` remains byte-for-byte frozen**, including command paths, arguments, matchers and hashes (`CLAUDE.md:108`; `packages/room-mcp/src/doctor.ts:18`). No new hook events, trust bypass or manifest migration is part of extraction.

**Install detection.** Adapters collect CLI/listing/version/root/hook-trust facts and appropriate host commands; shared doctor evaluates Room compatibility and formats rows. Preserve Claude directory-versus-cache distinction and Codex marketplace-hooks-versus-cache-bundle distinction. Failed or malformed listings mean unknown, not absence. A running Room session is separate positive evidence even when listings fail. Inspection is read-only: it never updates plugins or edits trust/config. Keep the current Codex frozen-hash checks as version-specific compatibility code inside Codex until a separately verified supported query replaces them.

### What stays shared

Room names, room selection, credentials, sharing policy, schema/hub compatibility, relay authority, ledger selection and receipts, solo/priority policy, claims, worktrees/carry/preview/collect, registry ownership/journals, process probing and safe signalling, compute budgets, secure file I/O and resource limits stay shared. OS behavior belongs to existing process/filesystem helpers, not duplicated Windows implementations per host. Host-specific prompt advice may come from the adapter, but common worker instructions and the tool schema remain shared. Adding a host never authorizes delegation: explicit Room requests still route to Room workers, generic requests to native host delegation (`CLAUDE.md:135`).

## How a third host is added

First verify its current primary docs, CLI help and changelog, record exact tested versions, and run a live capability proof. Survey recommendations and effort estimates are not acceptance evidence. Register one adapter factory, add packaging/tool transport glue, extend host validation and public host enums deliberately, and supply contract fixtures. Do not add host comparisons to binding, wake arbitration, worker lifecycle or doctor formatting.

**The first third-host minimum is interactive tools only.** Worker, resume, wake and pre-edit support are separately advertised capabilities requiring their own proof. Minimum interactive integration provides a stable session id tied to the actual checkout, a lifecycle/identity boundary that prevents one conversation consuming another's inbox, a tool transport (stdio MCP or a native wrapper around shared tool handlers), instructions/skills, and an honest install/diagnostic path. Tool results can carry messages without idle wake or hooks; report that limitation. A host without verified pre-edit context cannot advertise pre-edit coordination. Worker support additionally requires explicit argv/permission policy, same-session resume or an explicit non-resumable capability, shell/MCP environment separation, structured log evidence and an owned process handle compatible with shared stop/liveness logic. Missing resume never becomes “start a new conversation and call it resume.”

Executable interactive acceptance: run two simultaneous conversations in distinct checkouts and verify each tool result/receipt consumes only its own inbox; reject cross-worktree calls; restart and re-establish the exact checkout/conversation identity without consuming another conversation's receipts; exercise tool-reply select/flush/confirm, including failed flush; show explicit unavailable idle-wake and pre-edit-hook diagnostics. Verify installation/instructions and teardown with the pinned native host. This checklist passes without workers, resume or hooks.

Before worker intent creation, shared spawn requires the worker facet and persists `capabilities.resume` from its advertised evidence, instead of unconditional true (`packages/room-mcp/src/tools/workers.ts:241`). Signal and collect remain shared process/worktree authority decisions. Initial Claude/Codex adapters report resume=true, preserving existing records and behavior; legacy record interpretation remains unchanged. A future worker-only/non-resumable host reports false. Test that false is durable across restart, disables advertised resume, and rejects a follow-up before reserving a run, posting a resume prompt or spawning; no fresh-session substitute. Missing worker facet rejects spawn before worktree/intent creation. A true capability still requires retained id, durable authority and same-session acceptance before receipting. Read capability from the durable record for subsequent actions; a new lead's capabilities cannot upgrade it.

| Candidate | Survey evidence, not a current support promise | Smallest addition and proof needed |
|---|---|---|
| OpenCode | In-process TS hooks receive sessionID; SDK promptAsync can wake, experimental system transform can supply context; run JSON and `-s` resume described. `docs/archive/reports/host-survey-2026-09-24-gemini-opencode.md:61`, `docs/archive/reports/host-survey-2026-09-24-gemini-opencode.md:125`, `docs/archive/reports/host-survey-2026-09-24-gemini-opencode.md:138`. | MCP/config registration plus id bridge first. Later a TS plugin maps events to normalized hooks and wake calls. Verify busy-session semantics and experimental transform timing. Workers must explicitly disclose/resolve the surveyed absence of an OS sandbox; Room still creates worktrees. |
| Pi | Survey 0.87.1 describes extension session manager ids, native tools rather than built-in MCP, sendMessage steer/followUp/nextTurn, JSON/RPC workers and session resume. `docs/archive/reports/host-survey-2026-09-24-cursor-pi.md:11`. | A native extension wraps shared tool handlers, exports exact identity and injects context through Pi events. Packaging/bridge code is outside the MCP process but belongs to the Pi adapter integration. Pin and verify extension version; preserve custom-message authority. Do not inherit Claude permission or sandbox assumptions. |
| Copilot | Landscape survey at CLI 1.0.88 describes MCP, Claude-like hooks, Agent Plugins, `-p`/resume and extension joinSession steering; some conclusions rely on inference/secondary sources. `docs/archive/reports/host-survey-2026-09-24-landscape.md:22`, `docs/archive/reports/host-survey-2026-09-24-landscape.md:102`. | MCP and packaged instructions first, then a tested hook field/output codec. Prove CLI versus VS Code identity and extension messaging separately; one product name does not establish parity across surfaces. Add workers only after resume, permission and shell-env tests. |

The Cursor/Gemini findings are useful negative capability cases: surveyed hooks could not inject context before an allowed edit, and idle interactive wake was not documented (`docs/archive/reports/host-survey-2026-09-24-cursor-pi.md:33`; `docs/archive/reports/host-survey-2026-09-24-gemini-opencode.md:21`). Do not simulate parity with terminal keystrokes. ACP workers may later implement a reusable worker facet, as proposed in `docs/archive/reports/host-survey-2026-09-24-landscape.md:62`; ACP support alone does not supply interactive wake or prove filesystem isolation.

## Testing seam per host

Keep three layers of evidence: deterministic adapter contracts, native OS smoke with fake hosts, then pinned real-host checks. Fake-host success proves Room's protocol/process behavior, not that a released host still accepts those protocols.

Existing Windows smoke already uses a real native executable copied from Node, paths with spaces, a transient shell above the hook, process-table failure injection, actual stop escalation and same-session resume (`packages/room-mcp/test/windows-smoke.test.ts:61`, `packages/room-mcp/test/windows-smoke.test.ts:158`, `packages/room-mcp/test/windows-smoke.test.ts:176`). Its spawner swaps only the executable and prepends the fixture script while retaining Room's built arguments (`packages/room-mcp/test/windows-smoke.test.ts:187`). The current fixture speaks **Claude only**, parses `--resume`/`--session-id` and emits an assistant event (`packages/room-mcp/test/fixtures/windows-fake-host.mjs:1`). Extend this seam with a Codex-speaking fixture; do not describe the current smoke as proving both hosts.

| Seam | Claude contracts | Codex contracts |
|---|---|---|
| Identity | Env fallback, `/clear` newest matching record, worker id/cwd isolation, subagent and truncated-input receipts, absent host ancestor. | First valid metadata id retained across rooms; conflicts ignored/logged; non-worker shared daemon rejects hook-record guessing; metadata without workspaces still admits thread but defers workspace; recognized non-daemon parent can match hook record; worker hook record wins over log/tool ids; delayed exec hook within/beyond five seconds. |
| Wake | Socket auth/order, clean close versus acceptance, timeout, admitted auto fallback, explicit modes/off, unavailable inbox. Fake socket/pipe and notification ports. | Active/idle/unknown probes, notLoaded fallback, scan caps, never infer idle from old contact, urgent tool-output post, idle race, uncertain submission, exec exclusion and queue failures. Fake RPC/queue ports. |
| Worker argv/env | Fresh/resume argv, minimal→low, optional plugin override/name/id/budget; Bash inherited env script; visible PowerShell prefix without allow; artifact write failure. | Fresh/resume sandbox flags, filters merge, model/effort pass-through, old-version warning, installed-version mismatch, structured JSON session/turn events. |
| Logs | Assistant acceptance versus zero-turn missing session; result precedence, API failures, background tasks around final result, activity tool names. | Thread announcement alone rejected as acceptance; session-matching turn acceptance, agent final text, turn.failed and item activity. |
| Install | Directory source versus cache; stale bookkeeping; failed/malformed listing unknown; loaded bundle versus record version. | Cache bundle versus marketplace hooks; missing/modified/trusted hash; listing failure unknown; installed cache alone not proof of active plugin. |

Run the shared reconciler suite against both fake facets with fake time: coalescing, unknown-state backoff, reentrant document updates, binding changes during awaited sends, retry cooldowns and **wake never creates a receipt**. Exercise shared log scanners against append, partial JSON, replacement, truncate/regrow and resume offsets with both decoders. Preserve lifecycle tests for witnessed versus unwitnessed exits, nonce mismatch, failed/ambiguous resume and inability to signal an unverified process.

Native smoke stays in the Windows CI job and runs on POSIX too. Add Codex delayed SessionStart and fake exec resume to it; keep fake-host deadlines and teardown waiting for actual exits. Real-host acceptance requires fresh and resumed workers, interactive idle wake and a busy turn, `/clear` on Claude, shared-daemon and exec/`--no-daemon` on Codex, and a plugin update with an old session alive. Record version, OS, installation source and failures. No claim that this document has run these proposed checks.

## Order of extraction

Each step is independently shippable, keeps existing entry points as temporary delegating wrappers, and changes no user behavior. Before/after fixtures retain the baseline expectations; extraction never silently updates them to a preferred rule. Do not combine a protocol upgrade or a new host with the extraction.

1. **Characterize and define types.** Add host ports and fixtures around current argv, hook envelopes, install facts and wake outcomes. Identify every host switch with `rg` and keep an explicit allowlist for compatibility entry points. Preserve the regression cases above before moving their implementations.
2. **Extract pre-binding and selection, then worker command/runtime rules.** First migrate `workspace.ts` host rules, `index.ts` startup/metadata dispatch, `config.ts` selection/channel rules and `presence-end.ts` classification to pre-binding facets and compatibility wrappers; keep shared workspace admission. Pass all M1 characterization cases before later identity/wake removal. Delegate `workerCommand`, effort normalization, fresh-id allocation and synchronous filesystem-backed public-default reading to adapters with unchanged wrapper signatures. Keep environment assembly, prompt, budgets, spawn/exit journal and safe file writes shared. Verify exact argv and fresh/resume equivalence.
3. **Extract installation readers and host diagnostics.** Move root resolution, listing decoding and trust evidence; preserve separate doctor and newest-cache warning readers and their callers/conditions. Keep existing user-facing rows/remedies, especially unknown listing and directory marketplace behavior. This step does not repair installations automatically.
4. **Extract shell isolation.** Move filter/env-script/PowerShell encodings into worker plans. Shared launch writes validated artifacts, reports write outcomes and conditionally merges artifact env; failure cannot inject a new CLAUDE_ENV_FILE path. Test both command shells and MCP env separation; preserve warnings and current permission boundaries.
5. **Extract log decoders.** Introduce normalized facts behind old accessors, migrate activity/failure/background consumers, and preserve scanner caches and scope limits. Status projection consumes the same durable facts throughout. Delete mixed HostEvent interpretation only when all consumers have moved.
6. **Extract hook codecs.** Add standalone codec build entry points and generated freshness checks together with hook imports. Build lightweight host codecs, retain old executable paths and frozen invocation contracts. Compare emitted JSON/receipts, run Windows transient-shell smoke, and check frozen hooks bytes/hash. No new hook event or matcher.
7. **Extract identity resolution.** Move `boundSession` host matching and tool-id admission behind the adapter; retain shared repository retries, migration, process probing and liveness. Prove `/clear`, process-global first-id fencing, worker-record precedence/non-daemon fallback, exec grace, new-repository binding and all characterized selection disagreements. Reuse step 2 pre-binding evidence.
8. **Extract wake transport and probe.** Delegate existing senders, status and Codex turn state. Remove the reconciler's host branches in favor of facet outcomes; keep policy, timers and persisted evidence shared. Replay uncertain/idle races and live-host checks before shipping.
9. **Delete forwarding wrappers and audit.** Move remaining host-specific prompt/diagnostic wording, remove obsolete exports/combined event types, and allow direct host identifiers only in adapters, registration, schemas and compatibility boundaries. Rebuild committed plugin/hook artifacts with the normal build. Do not introduce the roadmap's database move or a new host in this cleanup.

During implementation run focused Vitest tests and typecheck at each relevant step. Before shipping **each step**, rebuild and include committed bundles/codec assets and use the repository checks: `npm run typecheck`, `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`, `npm run build -w @room/web`, `npm run build:plugin`, committed-asset freshness and required hygiene/Windows CI; CI's opt-in scale coverage remains required. Preserve validation evidence across steps. Re-run plugin routing evals if tool descriptions or delegation routing change; that is not intended here. This document-only change requires citation and diff review, not provider/model calls or a bundle rebuild.

## Compatibility

Keep existing `claude`/`codex` identifiers, tool inputs, environment precedence, model defaults, persisted session/worker records, receipt/wake formats and registry capabilities. Infer surface at runtime from existing evidence; no storage migration in the initial extraction. Do not alter hub or Y.Doc schema. Existing wrappers translate old types into adapter calls during migration; never persist adapter objects or raw transport details.

Frozen hook bytes and executable paths survive upgrades. The generated hook codec is shipped with its scripts, with no new dependency on a separately installed package. Existing sessions can retain old paths/bundles, so restart and stale-bundle diagnostics remain (`docs/reference.md:160`). A cache path is not a version-negotiation protocol. Keep the Codex installed-plugin versus Claude development-checkout warning and keep receipt-format compatibility between the hook bundle and MCP server.

Retain socket→admitted-channel fallback, explicit channels behavior and `ROOM_WAKE=off` on both hosts. Retain Codex queue, bounded exact-thread rollout fallback and unknown-state degradation until replacements have separate proof. The host survey's recommendation to stop *guessing identity* from rollouts does not justify deleting exact-id *turn-state* inspection. The roadmap's startup discovery and MCP Events work remain separate proposals (`docs/roadmap.md:34`, `docs/roadmap.md:54`). Do not add a turn-start workaround, broaden permissions or enable a channel to hide an unsupported capability. Preserve existing idle queue wake and the documented active-to-idle RPC race that can create a turn; eliminating that race is separate behavior work (`docs/superpowers/rehearsals/2026-10-08-midturn-delivery.md`).

## What is deleted

After migration, delete the mixed-host `workerCommand` implementation, host settings readers and install-root readers from `worker-config.ts`; host-specific branches in `worker-launch.ts`; mixed `HostEvent` and Claude/Codex fields in `RunLogFacts`; duplicated event interpretation in activity/failure/answer accessors; host detection/matching in `session.ts`; the exported exec-worker predicate from `binding.ts`; and Codex production probe construction from `index.ts` plus default probe construction/host switching from `wake-reconciler.ts`. Replace host-specific startup/metadata decoding in `workspace.ts`/`index.ts`, config selection and presence classification with the facets and named compatibility wrappers; retain shared workspace binding/admission. Move their required behavior into adapters before removing wrappers.

Delete doctor host installation/trust parsing and host-specific remedial text from shared evaluation, replacing them with adapter evidence. Remove host field/tool aliases and transcript interpretation from shared hook coordination after codecs own them. Small shared hook-format helpers can remain where genuinely identical. Private Codex protocol modules and Claude transport helpers can move under their host directory; their existence is not dead code.

Do **not** delete the shared binding cache/repository retry, run-log scanner, liveness implementation, ledger arbitration, hook caps/receipts, worker-status state machine, frozen hooks, channels fallback, queue fallback, installed-version warning or restart guidance. Do not claim all literal host strings disappear: persisted schema validation, registration and compatibility shims still name hosts.

## Changes deferred to their own batches

These are behavior changes, excluded from every extraction step. Each needs its own design/authorization and baseline-versus-proposed fixtures; listing a test does not choose the new rule.

| Separate batch | Preserved baseline and acceptance test for the later change |
|---|---|
| Unified host precedence | Preserve the three selectors and fallback policies above. Later enumerate explicit/env/parent combinations, especially worker=codex/host=claude (Claude/Codex/Claude today); specify the new outcome at each caller and assert changes to binding, naming and spawning together, including unknown/invalid evidence. Do not silently make contradictory evidence pending. |
| Active-install versus newest-cache warning | Preserve newest numeric Codex cache for worker mismatch and CLI listings for doctor. Later fixture cache A+B with A listed active, lead A/lead B, failed/malformed/stale listing and loaded-bundle disagreement. Assert exactly when spawn is blocked/warned versus unknown, retaining doctor behavior and documenting evidence freshness. |
| Missing-record hook rejection | Preserve early activity/hook receipts and complete-input exact-endpoint select/print/confirm without session.json. Later compare absent record plus live exact endpoint, wrong endpoint owner, incomplete/subagent input and failed stdout. Specify which activity, hook, ledger-confirmation or told-context receipt changes and why; rejected/failed handoffs must leave ledger messages owed. |
| Stricter session-record validation | Preserve the two existing reader acceptance rules and downstream checks. Later fixture legacy/partial records missing at/cwd/chain/hostPid/model, missing or mismatched host/id, wrong hashed directory and malformed JSON. Document every newly rejected shape, migration/recovery and diagnostics; verify restart, `/clear`, worker matching and hook delivery remain correct for supported shapes. |

Other protocol replacements, envelope-cap changes, broader hook id aliases, changes to suffix evidence or user-facing background unknown, and elimination of the Codex idle race likewise require separate behavior work. None is bundled into extraction.

## Addendum 2026-11-05 (slice 4): installation readers

0.17.33 replaced the newest-cache reader with the authenticated contract listing (`installedCodexRoomContract` in worker-config.ts), so the "newest-cache versus active-install" change deferred below no longer exists as a behaviour to defer; slice 4 moved the contract reader unchanged behind the Codex adapter. Steps 1–3 of the extraction order shipped together in this release.

## Addendum 2026-11-05: Codex MCP connection sharing

Codex 0.166.0 can share one local stdio MCP process across chats (`mcp_connection_sharing`, gated with
`mcp_2026_07_28`; both `Stage::UnderDevelopment`, default off; see
[host-survey-2026-11-05-codex.md](../../archive/reports/host-survey-2026-11-05-codex.md)). A pooled server
receives no per-chat identifier in tool calls and there is no per-server opt-out key. Decision: the Codex
adapter's first slice makes the existing assumption enforceable rather than silent:

- Room's MCP server negotiates only the protocol version its SDK offers today; it does not advertise
  `2026-07-28` until Codex passes a per-chat identity the adapter can bind to.
- `admitCodexThread` (session.ts:247) currently logs and ignores a second thread id. The adapter refuses the
  tool call with an error naming both flags and the remedy (disable `mcp_connection_sharing` for Room, or
  wait for a Room release that supports it), so a pooled process can never act for the wrong conversation.
- A test drives two thread ids through one process and asserts the refusal.

## Open questions

- **Host identity versus session identity:** can all supported Codex surfaces continue guaranteeing one MCP process per conversation? Current code explicitly depends on that (`packages/room-mcp/src/session.ts:244`). If a future broker multiplexes threads, adapter lookup must be keyed by authenticated call context, admission fences and caches must become per-thread, and no ambient process-global binding can select another thread's receipts. Unknown ownership must remain unbound.
- In the deferred install batch, which reliable source should determine the active Codex install for worker mismatch warnings when multiple caches exist? Doctor listings and a loaded running bundle are stronger evidence than newest-directory sorting; define freshness and preserve unknown when they disagree.
- Can a supported host query replace Codex's local hash/cache parsing and exact-thread rollout fallback? Require versioned live proof and failure/restart tests; neither a new API announcement nor a survey recommendation suffices.
- How should a native extension supply its hook codec and transport without pulling server-only dependencies into the host? Start with a tiny generated codec entry point; extract a shared integration package only when Pi/OpenCode implementation demonstrates the need.
- How should background-task coverage be presented on a host whose JSON logs do not expose it? Preserve current behavior during extraction, then decide whether user-facing “unknown” warrants a separate change.

- One adapter owns each host's identity, transport, worker dialect and evidence decoding.
- Room keeps coordination policy, receipts, process safety and worker lifecycle shared.
- Extraction ships in small behavior-preserving steps with fake-host and real-host checks.
- Frozen hooks, persisted formats, permission boundaries and existing fallbacks remain compatible.
- Third hosts add explicit capabilities and packaging after versioned proof, without shared host branches.

Biggest open question: will hosts preserve a provable conversation-to-MCP ownership boundary, or must Room support authenticated per-call adapter and session selection?
