/** Host evidence ports. Behavior-preserving extraction contract; no adapter is constructed here.
 * Lifetimes: pre-binding/fences per MCP, transports per target, log decoders per run/scope,
 * hook codecs per invocation, installation evidence per environment. */
export type HostId = 'claude' | 'codex'; // extend explicitly when a host ships
export type Env = Readonly<Record<string, string | undefined>>;
export type ProcessIdentity = { pid: number; startTime: string; executable: string };
export type Runtime = { model?: string; effort?: string };
export type Target = {
  host: HostId; id: string;
  surface: 'interactive' | 'shared-app-server' | 'exec-worker';
};
export type PreBindingEvidence = {
  env: Env; processDir: string; platform: string;
  parent?: ProcessIdentity; parentCommand?: string; rawMeta?: unknown;
};
export type StartupFacts = {
  fallbackDir: string; deferWorkspace: boolean;
  presenceKind: 'interactive' | 'shared-app-server';
  // These are independent compatibility decisions, not one unified selector.
};
export type CallFacts = { toolSessionId?: string; workspaceCandidates: readonly string[] };
export type BindingEvidence = {
  cwd: string; env: Env; parent?: ProcessIdentity; parentArgs?: string;
  records: readonly unknown[]; // existing reader acceptance, not a new full validator
  workerId?: string; workerSessionId?: string;
  toolSessionId?: string; logSessionId?: string;
};
export type IdentityResult =
  | { kind: 'bound'; target: Target; source: 'hook' | 'env' | 'tool' | 'worker' | 'log' }
  | { kind: 'pending'; reason: string; initialJoinWaitMs: number };
export type TurnState =
  | { kind: 'active' | 'idle'; source: 'host' | 'legacy' | 'contact' }
  | { kind: 'unknown'; source: 'host' | 'legacy' | 'contact'; reason: string }
  | { kind: 'unneeded' }; // transport handles both idle and busy, e.g. Claude inbox
export type WakeVia = 'queue' | 'socket' | 'channel' | 'turn';
export type WakeResult =
  | { kind: 'submitted' | 'uncertain'; via: WakeVia }
  | { kind: 'idle' } // raced with turn end; caller may try idle path
  | { kind: 'off' | 'unavailable' | 'failed'; reason?: string };
export type WakeStatus = {
  mode: 'auto' | 'socket' | 'channels' | 'off'; transport: string;
  availability: 'configured' | 'unknown' | 'off' | 'unavailable';
  limitation: string;
};
export type WorkerInput = {
  mode: 'fresh' | 'resume'; sessionId?: string; prompt: string;
  runtime: Runtime; tag: string; cwd: string; logDir: string;
  maxBudgetUsd?: string; env: Env;
  claudeChannel: string; pluginDir?: string; shellEnvHook: boolean;
  wakeChannels: boolean; inheritedShellEnvFile?: string;
};
export type WorkerCommandInput = Pick<WorkerInput,
  'mode' | 'sessionId' | 'prompt' | 'runtime' | 'tag' | 'maxBudgetUsd' |
  'claudeChannel' | 'pluginDir' | 'shellEnvHook' | 'wakeChannels'>;
export type WorkerPlan = {
  cmd: string; args: string[]; envPatch: Record<string, string>;
  artifacts: readonly { id: string; path: string; content: string; mode: number }[];
  // Applied only after the named artifact was successfully written.
  artifactEnv: readonly { artifactId: string; key: string }[];
  warnings: readonly string[];
};
export type HookEvent = {
  event: 'start' | 'before-tool'; sessionId?: string; cwd?: string;
  subagent: boolean; incomplete: boolean; source?: string;
  runtime: Runtime; transcriptPath?: string;
  tool?: {
    kind: 'shell' | 'patch' | 'write' | 'other';
    originalName: string; shellDialect?: 'posix' | 'powershell' | 'unknown';
    input: unknown; // retain original payload until equivalent typed normalization is proven
  };
};
export type LogFact =
  | { kind: 'session'; id: string }
  | { kind: 'resume-accepted' | 'session-missing'; id: string }
  | { kind: 'final'; text: string }
  | { kind: 'activity'; text: string; eventTimeMs?: number }
  | { kind: 'failure'; category: string; message?: string }
  | { kind: 'background'; id: string; state: 'open' | 'closed' | 'result-boundary' };
export type InstallEvidence = {
  cli: 'present' | 'absent' | 'unknown'; version?: string;
  listing: 'ok' | 'unknown'; plugin: 'present' | 'absent' | 'unknown';
  bundleRoot?: string; hooksRoot?: string; loadedVersion?: string;
  recordedVersion?: string; source?: 'cache' | 'directory';
  hookTrust: 'trusted' | 'modified' | 'absent' | 'unknown' | 'not-applicable';
  /** Compatibility: hook stamp and exact legacy cache-root equality are independent evidence. */
  hooksVersion?: string; cached?: boolean;
  remedies: readonly string[];
};
export type LogContext = {
  workerId: string; run: number; logStart: number; dir: string;
  scope: 'whole-run' | 'diagnostic-suffix' | 'activity-window';
};
export type TranscriptEvidence = {
  sessionRecord: unknown; previousRuntime: unknown;
  // Shared bounded reader supplies stat/cache and at most 64 KiB, not an unbounded transcript.
  transcript?: { path: string; mtimeMs: number; size: number; tail: string; startsMidFile: boolean };
};
export interface HostAdapter {
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
