import type { WakePathStatus } from './wake-types.js'
/** Host evidence ports. Behavior-preserving extraction contract; no adapter is constructed here.
 * Lifetimes: pre-binding/fences per MCP, transports per target, log decoders per run/scope,
 * hook codecs per invocation, installation evidence per environment. */
export type HostId = 'claude' | 'codex'; // extend explicitly when a host ships
export type PresenceKind = 'shared-app-server' | 'interactive'
export function isHostId(value: unknown): value is HostId { return value === 'claude' || value === 'codex' }
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
  cwd?: string; env: Env; parent?: ProcessIdentity; parentArgs?: string;
  /** Lazy shared repository discovery; omitted evidence denotes an available repository. */
  repositoryAvailable?: boolean; appServer?: boolean;
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
/** The shared path status, plus what this host's delivery cannot prove. */
export type WakeStatus = WakePathStatus & { limitation: string };
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
    /** Undefined when the sender reports no path (an unobserved transport). */
    describe(target: Target): WakeStatus | undefined;
    state(target: Target): Promise<TurnState>;
    send(target: Target, pointer: string, phase: 'idle' | 'active'): Promise<WakeResult>;
  };
  readonly worker?: {
    capabilities: { resume: boolean }; // advertised support, persisted before intent
    freshSessionId(): string | undefined;
    defaults(cwd: string): Runtime; // synchronous public-config reader via injected filesystem
    normalizeRuntime(runtime: Runtime): Runtime;
    plan(input: WorkerInput): Promise<WorkerPlan>;
  };
  readonly hooks?: {
    decode(event: 'start' | 'before-tool', raw: unknown, argv: readonly string[]): HookEvent;
    reduceRuntime(event: HookEvent, evidence: TranscriptEvidence): unknown;
    context(event: HookEvent['event'], text: string): unknown;
  };
  createLogDecoder?(context: LogContext): HostLogDecoder;
  inspectInstall(): Promise<InstallEvidence>;
  dispose(): void;
}

/** Shared artifact execution reports facts; the host plan owns diagnostic wording. */
export type WorkerArtifactOutcome = { artifactId: string; path: string } & (
  | { written: true }
  | { written: false; error: string }
);
export type WorkerLaunchPlan = WorkerPlan & {
  artifactWarnings(outcomes: readonly WorkerArtifactOutcome[]): string[];
};

/** Worker shell isolation capabilities. */
export type WorkerShellIsolation = {
  plan(input: WorkerInput): Promise<WorkerLaunchPlan>;
  launchOptions: { shellEnvHook: boolean; developmentPlugin: boolean };
  inheritedShellEnvFile?: string;
  shellEnv(file?: string): Record<string, string>;
  shellWarnings(written: { warning?: string }, version?: () => Promise<string | undefined>): Promise<string[]>;
};

/** Host-normalized evidence shared by every log decoder and scanner consumer. */
export type NormalizedHostFailure = { text: string; transient?: 'model capacity' | 'rate limit' }
export type NormalizedLogFact =
  | { kind: 'session' | 'resume-accepted' | 'session-missing'; id: string }
  /** Preferred text can be cleared by an empty result; fallback retains non-empty model text. */
  | { kind: 'final'; slot: 'preferred' | 'fallback'; text: string }
  | { kind: 'activity'; text: string; eventTimeMs?: number }
  /** Snapshot after host-specific precedence; undefined explicitly clears the previous error. */
  | { kind: 'failure'; failure: NormalizedHostFailure | undefined }
  | { kind: 'background'; state: 'result-boundary' }
  | { kind: 'background'; id: string; state: 'backgrounded' | 'closed' }
  | { kind: 'background'; id: string; state: 'open'; shell: boolean }
export interface HostLogDecoder {
  readonly backgroundTasks: 'observed' | 'unknown'
  acceptsLine(line: string): boolean
  push(raw: unknown): readonly NormalizedLogFact[]
}

export const WORKER_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
