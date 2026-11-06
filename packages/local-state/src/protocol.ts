/**
 * Frozen slice-2 contracts for clone-local storage maintenance (docs/superpowers/plans/2026-11-06-sqlite-state.md,
 * "Contracts to agree before dependent work"). Types and constants only: importing this module loads no SQLite,
 * no filesystem code and no other package, so hooks, the MCP, the daemon and the offline command share one definition.
 *
 * Slice 2 keeps files authoritative. The gate is the admission authority before SQL exists and stays so after
 * conversion. Items marked "decided, not in spec" are lead decisions for this slice that the spec text does not state.
 */
import type { InstanceToken, ProcessIdentity } from './leases.js'

// ---------------------------------------------------------------------------------------------------------------
// Builds and runtime floor
// ---------------------------------------------------------------------------------------------------------------

/**
 * Storage capability of this build, independent of wire/Y.Doc compatibility (hub-core CURRENT_COMPAT).
 * 1 = the compatibility release: gate-aware, legacy file storage, no SQL. Slice 4 raises it.
 * A gate whose minReader/minWriter exceeds a process's build refuses that process with `incompatible`.
 */
export const STORAGE_BUILD = 1
/** Minimum official Node.js release; older runtimes are refused exactly, never approximated. */
export const NODE_FLOOR = '22.22.3'
/** SQLite bundled with NODE_FLOOR; a lower sqlite_version() is refused even on an accepted Node. */
export const SQLITE_FLOOR = '3.51.3'
/** The only qualified major line. Other majors and non-official vendors are unqualified. */
export const NODE_MAJOR = 22

// ---------------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------------

export const GATE_LIMITS = {
  /** Registered processes (MCPs, helpers, daemon, maintenance) per clone; the cap refuses, never evicts. */
  registrations: 256,
  /** Concurrent admission tickets per clone; the cap refuses admission, never drops a ticket. */
  tickets: 4096,
  /** Records examined per yielded drain/status pass. */
  scanBatch: 200,
  /** Wait for the short gate guard before `unavailable` (decided, not in spec). */
  guardWaitMs: 2_000,
  /** Explicit migration drain. Timeout leaves the gate draining; it never reopens automatically. */
  drainMs: 120_000,
  /** MCP/daemon startup maintenance check, including preflight; refuses rather than waits longer. */
  startupMs: 10_000,
  /** Runtime/filesystem preflight, including asynchronous BUSY retries. */
  preflightMs: 10_000,
  /** migration.lock ownership wait (existing 30 s rule). */
  migrationLockWaitMs: 30_000,
} as const

// ---------------------------------------------------------------------------------------------------------------
// Durable layout (relative to the canonical Git common directory)
// ---------------------------------------------------------------------------------------------------------------

export const STORAGE_PATHS = {
  /** Gate record. All admission and phase transitions serialize on `${gate}.guard` (relay withGuard). */
  gate: 'room/storage-gate.json',
  /** One private file per registration, named `<instance nonce>.json`. */
  registrations: 'room/storage-gate/registrations',
  /** One private file per live ticket, named `<holder nonce>.<ticket id>.json`; finish removes it. */
  tickets: 'room/storage-gate/tickets',
  /** Append-only bounded audit of dead-ticket resolutions (decided, not in spec). */
  resolutions: 'room/storage-gate/resolutions',
  /** Existing exclusive migration ownership and stable pre-registry assignments; never moved. */
  migrationLock: 'room/registry/migration.lock',
  migrationMap: 'room/registry/migration.json',
  /** Activation evidence. Any of these without a readable gate refuses operation; slice 2 never creates them. */
  database: 'room/state.sqlite',
  activationMarker: 'room/state.active.json',
  /** Private preflight scratch; each probe uses and removes only its own `<nonce>` subdirectory. */
  preflightScratch: 'room/preflight',
} as const

// ---------------------------------------------------------------------------------------------------------------
// Gate record
// ---------------------------------------------------------------------------------------------------------------

export type GatePhase = 'legacy' | 'draining' | 'staging' | 'db-complete' | 'active'

/** The offline owner: the process holding migration.lock, registered with kind `maintenance`. */
export interface GateOwner { instance: InstanceToken; token: string }

export interface StorageGateRecord {
  v: 1
  /** Random at initialization; a copied clone's gate names another clone and refuses (`incompatible`). */
  cloneId: string
  /** Canonical common directory at initialization (realpath). Mismatch refuses. */
  commonDir: string
  /** Starts at 1. Every drain increments it; nothing ever resets or decrements it. */
  generation: number
  phase: GatePhase
  /** Present in every phase except `legacy`. */
  owner?: GateOwner
  /**
   * While draining: tickets with generation <= this value were admitted before the transition and may finish
   * (and spawn parented children). The successor never invalidates their finish/acknowledgement path.
   */
  drainingFrom?: number
  minReader: number
  minWriter: number
  sourceSchema?: number
  targetSchema?: number
  dbId?: string
  manifestDigest?: string
  backupDigest?: string
  importCheckpoint?: string
  /** Daemon storage-close acknowledgement for this generation (slice 3+; absent in slice 2: no SQL is open). */
  closed?: StorageCloseAck
  /**
   * Whether this clone needed a pre-registry (0.16) import when its gate was first initialized, decided once by the
   * initializer's legacy-evidence check, like the startup migration it replaces (decided, not in spec). Consulted only
   * while migration.json is absent; `done` in migration.json always wins. Absent field = `required` (conservative).
   */
  preRegistryImport?: 'required' | 'not-needed'
  updatedAt: number
}

/** The daemon has closed both SQL connections for `generation` and will not reopen without an active gate. */
export interface StorageCloseAck { generation: number; daemon: InstanceToken; daemonNonce: string; at: number }

// ---------------------------------------------------------------------------------------------------------------
// Registrations and tickets
// ---------------------------------------------------------------------------------------------------------------

/** `helper` = an independently running process (e.g. a preview helper) that outlives its parent's call. */
export type RegistrationKind = 'mcp' | 'helper' | 'daemon' | 'maintenance'

export interface Registration {
  v: 1
  instance: InstanceToken
  kind: RegistrationKind
  build: number
  /** Release string for diagnostics only; `build` decides compatibility. */
  release: string
  /** Generation observed at registration. */
  generation: number
  registeredAt: number
}

/**
 * Operation kinds for diagnostics and drain reports. Not an authorization scheme: every kind is admitted or
 * refused identically. `read` is never ticketed (see ReadValidation).
 */
export type OperationKind =
  | 'spawn' | 'resume' | 'message' | 'stop' | 'collect' | 'discard' | 'retire' | 'prune'
  | 'report' | 'exit' | 'launch-callback' | 'reconcile' | 'project' | 'idle-release' | 'preview' | 'admit-worker'
  | 'maintenance-status'

export interface Ticket {
  v: 1
  /** 128-bit random hex. Doubles as the call token for lifecycle lanes (decided, not in spec). */
  id: string
  /** Registration nonce that holds the ticket. */
  holder: string
  /** The holder's process identity, so drain can verify liveness even if its registration is damaged. */
  identity: ProcessIdentity
  kind: OperationKind
  generation: number
  /** Parent ticket for a detached callback/helper admitted before its parent finished. */
  parent?: string
  admittedAt: number
}

/**
 * Refusal reasons shared with the slice-3 LocalState client. Slice 2's gate uses the first four plus `busy`:
 * - maintenance: phase is not `legacy` for a build-1 process, or the generation changed under a read
 * - incompatible: build below minReader/minWriter, foreign clone ID/common dir, or an active (SQL) gate for build 1
 * - capacity: registration or ticket cap reached (existing tickets untouched)
 * - unavailable: unreadable/corrupt gate, guard timeout, activation evidence without a gate, I/O failure
 * - busy: unregister while the registration still holds tickets
 */
export type StorageRefusalReason = 'maintenance' | 'incompatible' | 'capacity' | 'unavailable'
  | 'blocked' | 'busy' | 'pressure' | 'uncertain'

/**
 * Gate methods throw this on refusal (decided, not in spec: throw, not a union return). `detail` is bounded
 * (<= 512 chars), never contains task text, tokens or file contents, and `remedy` names the operator command.
 */
export class StorageRefused extends Error {
  readonly name = 'StorageRefused'
  constructor(readonly reason: StorageRefusalReason, readonly detail: string, readonly remedy?: string) {
    super(`Room storage ${reason}: ${detail}${remedy ? `; ${remedy}` : ''}`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// StorageGate
// ---------------------------------------------------------------------------------------------------------------

export interface RegisterInput {
  instance: InstanceToken
  kind: RegistrationKind
  release: string
  /** Defaults to STORAGE_BUILD. Tests use it to exercise build-range refusals. */
  build?: number
  /** Recorded only if this call initializes the gate; ignored otherwise. Default `required`. */
  preRegistryImport?: 'required' | 'not-needed'
}

export interface AdmitOptions {
  /**
   * Detached child of a live ticket. Admitted even while draining when the parent is a live predecessor ticket
   * (generation <= drainingFrom); refused once the parent finished. The child must finish on its own.
   */
  parent?: Ticket
}

export interface DrainProgress {
  generation: number
  phase: GatePhase
  /**
   * True only when no ticket of any generation remains. Ticketless registrations need no acknowledgement: admission
   * and the drain transition share the guard, so they can only observe the new phase (decided, not in spec).
   * Verified-dead ticketless registrations are pruned during drain.
   */
  complete: boolean
  live: TicketView[]
  /** Holder identity unreadable or ambiguous: blocks; never reclaimed by age. */
  unknown: TicketView[]
  /** Holder verified dead: blocks until `resolveDead` records reconciliation. */
  dead: TicketView[]
  /** Records not yet examined this pass (bounded scans). */
  pending: number
}

export interface TicketView { id: string; kind: OperationKind; generation: number; holder: string; pid: number; parent?: string; admittedAt: number }
/** A read-only ticket listing for operators: holder liveness from the identity probe; damaged records are `unreadable`. */
export interface TicketListing { tickets: (TicketView & { holderState: 'alive' | 'dead' | 'unknown' | 'unreadable' })[]; total: number; truncated: boolean }

export interface GateStatus {
  /** `absent` = no gate and no activation evidence (initializable). */
  state: 'absent' | 'present' | 'unreadable' | 'evidence-without-gate'
  gate?: StorageGateRecord
  registrations: number
  tickets: number
  /**
   * migration.json as found, read-only. `absent` is not a verdict: whether a pre-registry import is needed is
   * decided by the room-mcp legacy-evidence predicate, which owns those formats.
   */
  legacyImport: 'done' | 'pending' | 'absent' | 'unreadable'
  /** True when this build cannot be admitted now; `refusal` says why. */
  maintenanceRequired: boolean
  refusal?: { reason: StorageRefusalReason; detail: string; remedy?: string }
}

/**
 * The whole-operation admission barrier for one canonical common directory (`openStorageGate(commonDir)` in gate.ts
 * canonicalizes it and requires HEAD before returning). Every call holds the guard only for short synchronous file
 * work and never waits while holding it. Admission and drain transition serialize on the same guard.
 */
export interface StorageGate {
  readonly commonDir: string
  /**
   * Validate canonical common dir/HEAD, initialize an absent gate (generation 1, legacy, minReader=minWriter=1)
   * only after proving no activation evidence, check build range, then write the registration. Concurrent
   * initializers cannot overwrite each other. Idempotent for the same instance nonce.
   */
  register(input: RegisterInput): Promise<Registration>
  /** Write a durable ticket under the guard. Refuses new work unless phase is `legacy` (or AdmitOptions.parent). */
  admit(registration: Registration, kind: OperationKind, options?: AdmitOptions): Promise<Ticket>
  /** Remove the ticket. Idempotent; always permitted for a predecessor ticket, including while draining. */
  finish(ticket: Ticket): Promise<void>
  /** Remove the registration; refuses (`busy`) while it still holds tickets. */
  unregister(registration: Registration): Promise<void>
  /**
   * Offline owner only: requires migration.lock held by `owner.instance`. First call publishes generation+1,
   * phase `draining`, drainingFrom = previous generation; later calls report progress. Bounded scans; no waiting
   * under the guard. Stale/losing owners (token or generation mismatch) refuse and publish nothing.
   */
  drain(owner: GateOwner): Promise<DrainProgress>
  /**
   * Offline owner only: a ticket whose holder is verified dead, after the owner reconciled its intent (slice 2:
   * the file registry's own recovery evidence). Records an audit entry, then removes the ticket.
   */
  resolveDead(owner: GateOwner, ticketId: string, note: string): Promise<void>
  /**
   * Offline owner only, after recovering migration.lock from a verified-dead holder: adopt a draining generation
   * whose recorded owner is verified dead. Publishes generation+1 so the old owner's token/generation is stale.
   */
  takeOver(owner: GateOwner): Promise<DrainProgress>
  /** Offline owner only: draining -> legacy after legacy-only maintenance; generation unchanged. Never automatic.
   * Optional epoch-ms notAfter is checked under the guard immediately before publishing; expiry leaves draining.
   */
  reopen(owner: GateOwner, options?: { notAfter?: number }): Promise<StorageGateRecord>
  /** Read-only; never initializes, takes no guard and writes nothing. */
  status(): Promise<GateStatus>
  /** Read-only: at most `limit` (default and maximum GATE_LIMITS.scanBatch) tickets with holder liveness, for operators. */
  listTickets(limit?: number): Promise<TicketListing>
  /**
   * ReadValidation primitive: the current generation/phase without a guard or any write. An absent gate without
   * activation evidence is `{ generation: 0, phase: 'legacy' }`; unreadable gates and evidence without a gate throw.
   */
  observe(): Promise<ReadValidation>
}

// ---------------------------------------------------------------------------------------------------------------
// Read validation (decided, not in spec)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Display snapshots outside an admitted operation take no durable ticket. They read the gate before and after the
 * snapshot (no guard) and keep the result only when both reads show phase `legacy` with the same generation.
 * A change between two legacy observations (e.g. initialization 0 -> 1, or a completed legacy maintenance) retries
 * the read a bounded number of times; a non-legacy observation refuses with `maintenance`. Inside an admitted operation, snapshots run under that ticket.
 * A migrator publishes its generation before changing any lifecycle file, so this cannot accept a torn import.
 */
export interface ReadValidation { generation: number; phase: GatePhase }

// ---------------------------------------------------------------------------------------------------------------
// Runtime and filesystem preflight
// ---------------------------------------------------------------------------------------------------------------

export type PreflightSurface = 'mcp' | 'daemon' | 'offline'

export type FilesystemKind =
  | 'apfs' | 'ext4' | 'ntfs'                // qualified local single-host filesystems (maintainer decision 2)
  | 'network' | 'synchronized' | 'unknown' // refused for writable storage
  | 'other-local'                          // detected local but unqualified: refused

export interface FilesystemResult {
  kind: FilesystemKind
  /** Raw evidence: statfs f_type (hex) and mount type on macOS/Linux; drive type / UNC on Windows. */
  detail: string
  /** Path whose filesystem was probed (canonical). */
  path: string
  /** Journal mode this filesystem would use; `refuse` for every non-qualified kind in the first release. */
  journal: 'wal' | 'refuse'
}

export type PreflightFailure =
  | 'node-version'      // below NODE_FLOOR or not major NODE_MAJOR
  | 'node-vendor'       // not an official nodejs.org distribution (process.release.name !== 'node' etc.)
  | 'sqlite-import'     // import('node:sqlite') threw
  | 'sqlite-api'        // DatabaseSync/required API missing
  | 'sqlite-version'    // sqlite_version() below SQLITE_FLOOR
  | 'pragma'            // foreign_keys / trusted_schema / extension loading could not be set and verified
  | 'journal'           // WAL two-connection commit/reopen probe failed
  | 'permission'        // private scratch could not be created/verified
  | 'timeout'           // GATE_LIMITS.preflightMs elapsed

export interface PreflightEvidence {
  surface: PreflightSurface
  /** fs.realpathSync(process.execPath). */
  executable: string
  node: string
  /** process.release.name, process.release.sourceUrl host, process.platform/arch. */
  vendor: { name: string; source?: string; platform: string; arch: string }
  sqlite?: string
  filesystem?: FilesystemResult
  elapsedMs: number
}

/**
 * Slice-2 policy (decided, not in spec): every PreflightFailure (all are runtime failures) refuses the
 * surface before it registers or touches Room state. An unqualified filesystem does NOT refuse legacy file
 * operation in the compatibility release; it is reported (`storage: 'unqualified'`) and will refuse activation
 * in slice 4. WAL is probed only on a qualified filesystem: never open WAL on a path not proven local.
 */
export type PreflightResult =
  | { ok: true; storage: 'qualified' | 'unqualified'; evidence: PreflightEvidence }
  | { ok: false; failure: PreflightFailure; evidence: PreflightEvidence; detail: string; remedy: string }
