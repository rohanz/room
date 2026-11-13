import { privateStateDirectory } from '@room/relay'
/** Ref erasure uses a known authorized write or an operation tip preserved under a recovery ref. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { boundedGitSync } from '@room/roomd/baseline'
import { writeAtomic } from './leases.js'
import type { WorkerRecord } from './worker-status.js'
import { retainWorkerItem, clearRetainedWorkerItem } from './worker-retained.js'

interface RefReceipt { ref: string; oid: string; owner: string }
export const RECOVERY_REF_AGE_MS = 7 * 24 * 60 * 60 * 1000
const file = (common: string, ref: string) => path.join(common, 'room', 'registry', 'ref-writes', createHash('sha256').update(ref).digest('hex') + '.json')
const run = (common: string, args: string[]) => boundedGitSync(common, ['--git-dir', common, '-c', 'core.hooksPath=/dev/null', ...args]).toString().trim()
function validRef(ref: string): void {
  if (!/^refs\/(heads|room)\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) throw new Error(`unsafe worker ref ${ref}`)
}
function recordedWorkerRef(common: string, ref: string, owner: string): string | undefined {
  try {
    const receipt = JSON.parse(fs.readFileSync(file(common, ref), 'utf8')) as RefReceipt
    return receipt.ref === ref && receipt.owner === owner && /^[0-9a-f]{40,64}$/.test(receipt.oid) ? receipt.oid : undefined
  } catch { return undefined }
}
/** Called only at the authorized write site; the receipt follows successful Git mutation. */
export function writeWorkerRef(common: string, ref: string, oid: string, owner: string, expected?: string): void {
  validRef(ref)
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('invalid worker ref OID')
  if (ref.startsWith('refs/heads/') && !expected) throw new Error('branch write requires a known expected value')
  const old = expected ?? recordedWorkerRef(common, ref, owner) ?? '0'.repeat(oid.length)
  try { run(common, ['update-ref', '--no-deref', ref, oid, old]) }
  catch (error) {
    throw new Error(retainWorkerItem(common, { kind: ref.startsWith('refs/heads/') ? 'branch' : 'ref', path: ref, id: owner,
      reason: `ref write did not match its authorized expectation; retained without overwriting: ${String(error)}` }))
  }
  rememberRefWrite(common, ref, oid, owner)
}
function rememberRefWrite(common: string, ref: string, oid: string, owner: string): void {
  privateStateDirectory(path.dirname(file(common, ref)))
  writeAtomic(file(common, ref), { ref, oid, owner })
  clearRetainedWorkerItem(common, ref.startsWith('refs/heads/') ? 'branch' : 'ref', ref)
}
/** Unknown/different values are a successful preservation outcome, not grounds to retry with a new OID. */
export function deleteWorkerRef(common: string, ref: string, owner: string, expected = recordedWorkerRef(common, ref, owner)): string | undefined {
  validRef(ref)
  // A missing name needs no authority; never use its current value as the expectation.
  try { run(common, ['show-ref', '--verify', '--quiet', ref]) } catch (error) {
    if ((error as { status?: number }).status === 1) {
      try { run(common, ['symbolic-ref', '-q', ref]) } catch (sym) {
        if ((sym as { status?: number }).status === 1) { clearRetainedWorkerItem(common, ref.startsWith('refs/heads/') ? 'branch' : 'ref', ref); clearRefReceipt(common, ref, owner); return }
      }
    }
  }
  const kind = ref.startsWith('refs/heads/') ? 'branch' : 'ref'
  if (!expected || !/^[0-9a-f]{40,64}$/.test(expected)) return retainWorkerItem(common, { kind, path: ref, id: owner, reason: 'no durable authorized-write expectation; remove manually after inspection' })
  try { run(common, ['update-ref', '--no-deref', '-d', ref, expected]) }
  catch { return retainWorkerItem(common, { kind, path: ref, id: owner, reason: `value differs from recorded ${expected}, or Git could not compare it; remove manually after inspection` }) }
  clearRetainedWorkerItem(common, kind, ref)
  clearRefReceipt(common, ref, owner)
}
export function restoreWorkerRef(common: string, ref: string, previous: string | undefined, owner: string): string | undefined {
  const expected = recordedWorkerRef(common, ref, owner)
  if (!previous) return deleteWorkerRef(common, ref, owner, expected)
  validRef(ref)
  if (!expected) return retainWorkerItem(common, { kind: 'ref', path: ref, id: owner, reason: 'no durable authorized-write expectation for rollback' })
  try { writeWorkerRef(common, ref, previous, owner, expected) }
  catch { return retainWorkerItem(common, { kind: 'ref', path: ref, id: owner, reason: 'ref changed before rollback; previous value not restored' }) }
}

/** Captured once under the worker operation lease, before any destructive cleanup. */
export interface BranchCleanupReceipt { tip?: string; recoveryRef?: string; reason?: string; absent?: true }
export function captureWorkerBranch(common: string, worker: { id: string; tag: string; branch: string }): BranchCleanupReceipt {
  const ref = `refs/heads/${worker.branch}`
  try {
    validRef(ref)
    const entry = directEntry(common, ref)
    if (!entry) {
      if (symbolicName(common, ref)) throw new Error('symbolic branch retained; its target was not followed')
      return { absent: true }
    }
    if (entry[2]) throw new Error('symbolic branch retained; its target was not followed')
    if (!/^[0-9a-f]{40,64}$/.test(entry[1])) throw new Error('invalid branch tip')
    return { tip: entry[1] }
  } catch (error) {
    const reason = `cannot capture operation branch tip: ${String(error)}`
    retainWorkerItem(common, { kind: 'branch', path: ref, id: worker.id, tag: worker.tag, reason })
    return { reason }
  }
}
const directEntry = (common: string, ref: string) => run(common, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref])
  .split('\n').map(line => line.split('\0')).find(fields => fields[0] === ref)
function symbolicName(common: string, ref: string): boolean {
  try { run(common, ['symbolic-ref', '-q', ref]); return true }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error }
}
/** Pin only after preflight succeeds, using the lease's original read without observing a new tip. */
export function preserveWorkerBranch(common: string, worker: { id: string; tag: string; branch: string }, captured = captureWorkerBranch(common, worker), renew = false): BranchCleanupReceipt {
  if (!captured.tip || captured.reason || captured.absent) return captured
  const tip = captured.tip, recoveryRef = `refs/room/recovery/${worker.tag}/${tip}`
  try {
    validRef(recoveryRef)
    if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error('invalid worker ref OID')
    const existing = directEntry(common, recoveryRef)
    // for-each-ref omits dangling symrefs, so inspect the name as well.
    if (existing?.[2] || symbolicName(common, recoveryRef)) throw new Error('recovery name is already occupied by a symbolic ref; retained without following it')
    if (existing) {
      if (run(common, ['rev-parse', `${existing[1]}^{}`]) !== tip) throw new Error('recovery name is already occupied by another ref')
    }
    // A new discard must not inherit an almost-expired pin from a prior operation.
    // Foreign/legacy pins have no automatic expiry and remain untouched.
    let renewPin = false
    if (existing && renew) try { renewPin = !!recoveryPin(common, existing[1]) } catch { /* unmarked pin */ }
    if (!existing || renewPin) {
      const tag = `object ${tip}\ntype ${run(common, ['cat-file', '-t', tip])}\ntag room-recovery-${randomUUID()}\ntagger Room <room@localhost> ${Math.floor(Date.now() / 1000)} +0000\n\nRoom recovery pin\n`
      const oid = boundedGitSync(common, ['--git-dir', common, 'mktag'], { input: Buffer.from(tag) }).toString().trim()
      run(common, ['update-ref', '--no-deref', recoveryRef, oid, existing?.[1] ?? '0'.repeat(oid.length)])
    }
    return { tip, recoveryRef }
  } catch (error) {
    const reason = `could not preserve operation branch tip under ${recoveryRef}: ${String(error)}`
    retainWorkerItem(common, { kind: 'branch', path: `refs/heads/${worker.branch}`, id: worker.id, tag: worker.tag, reason })
    return { tip, reason }
  }
}
export function deletePreservedWorkerBranch(common: string, worker: { id: string; tag: string; branch: string }, receipt: BranchCleanupReceipt): string | undefined {
  return mutatePreservedRef(common, worker, `refs/heads/${worker.branch}`, receipt)
}
function mutatePreservedRef(common: string, worker: { id: string; tag: string }, ref: string, receipt: BranchCleanupReceipt, next?: string): string | undefined {
  validRef(ref)
  const kind = ref.startsWith('refs/heads/') ? 'branch' : 'ref'
  if (!receipt.tip || !receipt.recoveryRef || receipt.reason) {
    if (next) return retainWorkerItem(common, { kind, path: ref, id: worker.id, tag: worker.tag, reason: receipt.reason ?? 'no preserved operation value for replacement' })
    // Absence is harmless, but a new name must not inherit deletion authority.
    const named = run(common, ['for-each-ref', '--format=%(refname)', ref]).split('\n').includes(ref)
    let symbolic = false
    try { run(common, ['symbolic-ref', '-q', ref]); symbolic = true } catch (error) { if ((error as { status?: number }).status !== 1) throw error }
    if (!named && !symbolic) { clearRetainedWorkerItem(common, kind, ref); return }
    return retainWorkerItem(common, { kind, path: ref, id: worker.id, tag: worker.tag, reason: receipt.reason ?? (receipt.absent ? 'branch was absent at operation start; later name retained' : 'no preserved operation tip') })
  }
  let pinOid: string
  try {
    const expectedRef = `refs/room/recovery/${worker.tag}/${receipt.tip}`
    if (receipt.recoveryRef !== expectedRef) throw new Error('recovery ref receipt does not match this worker/tip')
    const entry = directEntry(common, expectedRef)
    if (!entry || entry[2] || run(common, ['rev-parse', `${entry[1]}^{}`]) !== receipt.tip) throw new Error('preserved commit is no longer pinned by its exact recovery ref')
    pinOid = entry[1]
  } catch (error) {
    return retainWorkerItem(common, { kind, path: ref, id: worker.id, tag: worker.tag, reason: String(error) })
  }
  try {
    // Git 2.45 verifies a symref's resolved OID even with --no-deref. Updating
    // the pin to the same OID materializes it as direct under the transaction
    // lock, while a different OID or dangling replacement fails the comparison.
    if (next && !/^[a-f0-9]{40,64}$/.test(next)) throw new Error('invalid ref replacement OID')
    const mutation = next ? `update ${ref} ${next} ${receipt.tip}` : `delete ${ref} ${receipt.tip}`
    const commands = `start\noption no-deref\nupdate ${receipt.recoveryRef} ${pinOid} ${pinOid}\n${mutation}\nprepare\ncommit\n`
    boundedGitSync(common, ['--git-dir', common, '-c', 'core.hooksPath=/dev/null', 'update-ref', '--no-deref', '--stdin'], { input: Buffer.from(commands) })
  } catch (error) {
    return retainWorkerItem(common, { kind, path: ref, id: worker.id, tag: worker.tag, reason: `branch or recovery pin changed, or Git could not complete the transaction: ${String(error)}` })
  }
  clearRetainedWorkerItem(common, kind, ref)
  if (next) rememberRefWrite(common, ref, next, worker.id)
  else clearRefReceipt(common, ref, worker.id)
}


/** Lease metadata does not advance the worker record's lifecycle revision. */
export function operationBranchReceipt(common: string, id: string): BranchCleanupReceipt | undefined {
  if (!/^w_[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined
  const lease = path.join(common, 'room', 'registry', 'workers', `${id}.op`)
  try {
    const stat = fs.lstatSync(lease)
    if (!stat.isFile() || stat.size > 16384) throw new Error('invalid operation lease')
    const value = JSON.parse(fs.readFileSync(lease, 'utf8')) as { branchCleanup?: BranchCleanupReceipt }
    return value.branchCleanup
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { reason: 'operation branch receipt is unreadable; branch retained' }
  }
}

function clearRefReceipt(common: string, ref: string, owner: string): void {
  const target = file(common, ref)
  try {
    const before = fs.readFileSync(target, 'utf8'), receipt = JSON.parse(before) as RefReceipt
    if (receipt.ref === ref && receipt.owner === owner && fs.readFileSync(target, 'utf8') === before) fs.unlinkSync(target)
  } catch { /* unreadable or concurrently changed evidence stays */ }
}

/** Creation evidence lives in the immutable tag object, never in a side receipt. */
function recoveryPin(common: string, oid: string): { createdAt: number } | undefined {
  const tag = run(common, ['cat-file', 'tag', oid])
  const match = /^object [a-f0-9]{40,64}\ntype (?:commit|tree)\ntag [^\n]+\ntagger Room <room@localhost> (\d+) \+0000\n\nRoom recovery pin(?:\n|$)/.exec(tag)
  return match && Number.isSafeInteger(Number(match[1])) ? { createdAt: Number(match[1]) * 1000 } : undefined
}
export function recoveryRefDescription(common: string, ref: string): string {
  try { if (recoveryPin(common, run(common, ['rev-parse', ref]))) return `${ref} (kept for seven days)` } catch { /* Legacy or unreadable pins remain. */ }
  return `${ref} (creation time unrecorded; retained for manual inspection)`
}

/** Only Room-marked annotated pins expire; compare the immutable tag's exact OID. */
export function collectRecoveryRefs(common: string, now = Date.now(), dryRun = false): string[] {
  const removed: string[] = []
  let refs: string
  try { refs = run(common, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/room/recovery/']) } catch { return removed }
  for (const line of refs.split('\n')) {
    const [ref, oid] = line.split('\0')
    try {
      const pin = recoveryPin(common, oid)
      if (!pin || now - pin.createdAt < RECOVERY_REF_AGE_MS) continue
      // Git 2.45 cannot atomically require a direct ref here; see reference.md.
      const entry = directEntry(common, ref)
      if (!entry || entry[1] !== oid || entry[2] || symbolicName(common, ref)) continue
      if (!dryRun) {
        const input = `start\noption no-deref\ndelete ${ref} ${oid}\nprepare\ncommit\n`
        boundedGitSync(common, ['--git-dir', common, '-c', 'core.hooksPath=/dev/null', 'update-ref', '--no-deref', '--stdin'], { input: Buffer.from(input) })
        clearRetainedWorkerItem(common, 'ref', ref)
      }
      removed.push(ref)
    } catch { /* Foreign/unreadable objects and failed comparisons remain. */ }
  }
  return removed
}

/** The four mutable worker-private ref names in v0.17.47. */
type RefRecord = Pick<WorkerRecord, 'id' | 'tag' | 'branch' | 'base' | 'carriedBase' | 'collectedKeep'> & Partial<Pick<WorkerRecord, 'prep'>>
function legacyRefExpectation(common: string, ref: string, worker: RefRecord): { expected?: string; preserved?: BranchCleanupReceipt } {
  if (!worker.prep || worker.prep.identityRequired || recordedWorkerRef(common, ref, worker.id)) return {}
  const carry = `refs/room/carry/${worker.tag}`, head = `refs/room/collect-head/${worker.tag}/${worker.id}`
  if (![carry, head, `refs/room/carry-untracked/${worker.tag}`, `refs/room/collect-base/${worker.tag}/${worker.id}`].includes(ref)) return {}
  const expected = ref === carry ? worker.carriedBase : ref === head && worker.collectedKeep ? worker.base : undefined
  if (expected) return { expected }
  // Old records did not retain every private pin's OID. Read it once under the
  // operation lease, then keep its object reachable in the same transaction as
  // replacement/deletion. New identity-required records never use this path.
  const entry = directEntry(common, ref)
  if (entry?.[2] || symbolicName(common, ref)) throw new Error('symbolic legacy private ref retained without following its target')
  if (!entry) return {}
  if (!/^[a-f0-9]{40,64}$/.test(entry[1])) throw new Error('invalid legacy private ref value')
  return { preserved: preserveWorkerBranch(common, worker, { tip: entry[1] }) }
}
export function writeWorkerRecordRef(common: string, ref: string, oid: string, worker: RefRecord, recoveryRefs?: Set<string>): void {
  try {
    const { expected, preserved } = legacyRefExpectation(common, ref, worker)
    if (preserved?.recoveryRef) recoveryRefs?.add(preserved.recoveryRef)
    if (!preserved) return writeWorkerRef(common, ref, oid, worker.id, expected)
    const retained = mutatePreservedRef(common, worker, ref, preserved, oid)
    if (retained) throw new Error(retained)
  } catch (error) {
    throw new Error(retainWorkerItem(common, { kind: 'ref', path: ref, id: worker.id, tag: worker.tag, reason: String(error) }))
  }
}
export function deleteWorkerRecordRef(common: string, ref: string, worker: RefRecord, recoveryRefs?: Set<string>): string | undefined {
  try {
    const { expected, preserved } = legacyRefExpectation(common, ref, worker)
    if (preserved?.recoveryRef) recoveryRefs?.add(preserved.recoveryRef)
    return preserved ? mutatePreservedRef(common, worker, ref, preserved) : deleteWorkerRef(common, ref, worker.id, expected)
  } catch (error) { return retainWorkerItem(common, { kind: 'ref', path: ref, id: worker.id, tag: worker.tag, reason: String(error) }) }
}
