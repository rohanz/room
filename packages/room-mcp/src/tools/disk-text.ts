import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { containedRepoPath } from '@room/roomd'
import { gitBlobInfoMany, gitCatFileBatch, gitCommitMissing, observeGit } from '@room/roomd/git'

/** Local reads use the same per-file ceiling as the default publisher. */
export const DISK_TEXT_LIMIT = 512 * 1024

/** Small synchronous local probes, such as test-command manifests, use a descriptor cap too. */
export { readBoundedFileSync as readBoundedDiskTextSync } from '@room/roomd'

export class HistoricalTextTooLarge extends Error {
  readonly code = 'ROOM_TEXT_TOO_LARGE'
  constructor(readonly path: string) { super(`historical text exceeds Room's ${DISK_TEXT_LIMIT}-byte read limit: ${path}`) }
}

/** A commit's file never changes: reads by full commit id are kept, bounded by entries and bytes, in-flight ones shared. */
const HISTORICAL_ENTRIES = 512, HISTORICAL_BYTES = 32 * 1024 * 1024
const historical = new Map<string, { text: Promise<string | undefined>; bytes: number }>()
let historicalBytes = 0

/**
 * Check blob size before asking Git for any historical text. A full commit id is read from Git once while cached:
 * a lead's claim and conflict reconciles ask for the same base files on every room change (R4, 2026-10-02).
 */
export function readBoundedHistoricalText(dir: string, base: string, rel: string): Promise<string | undefined> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) return readHistoricalFromGit(dir, base, rel)
  const key = `${dir}\0${base}\0${rel}`
  const hit = historical.get(key)
  if (hit) { historical.delete(key); historical.set(key, hit); return hit.text }
  const entry = { text: readHistoricalFromGit(dir, base, rel), bytes: 0 }
  historical.set(key, entry)
  entry.text.then(text => {
    if (historical.get(key) !== entry) return
    entry.bytes = text === undefined ? 0 : Buffer.byteLength(text)
    historicalBytes += entry.bytes
    for (const [old, value] of historical) {
      if (historical.size <= HISTORICAL_ENTRIES && historicalBytes <= HISTORICAL_BYTES) break
      historical.delete(old)
      historicalBytes -= value.bytes
    }
  }, () => { if (historical.get(key) === entry) historical.delete(key) })
  return entry.text
}

async function readHistoricalFromGit(dir: string, base: string, rel: string): Promise<string | undefined> {
  const text = (await readBoundedHistoricalTexts(dir, base, [rel])).get(rel)
  if (text instanceof HistoricalTextTooLarge) throw text
  return text
}

/**
 * Bytes of blob text per `git cat-file --batch`. Output is buffered whole, so this bounds memory per
 * call; 4 MB is eight texts at the per-file limit and typically a few hundred source files.
 */
const HISTORICAL_BATCH_BYTES = 4 * 1024 * 1024

/**
 * Many paths at one commit, by the rules of readBoundedHistoricalText: blob sizes are checked before
 * any text is read, a path over DISK_TEXT_LIMIT maps to HistoricalTextTooLarge, an absent path to
 * undefined, and an unavailable commit rejects. Two Git calls per HISTORICAL_BATCH_BYTES instead of
 * two per path. Uncached: a caller that reads each path once, such as a graph build, owns its results.
 */
export async function readBoundedHistoricalTexts(dir: string, base: string, rels: readonly string[]): Promise<Map<string, string | undefined | HistoricalTextTooLarge>> {
  const info = await gitBlobInfoMany(dir, base, rels)
  const out = new Map<string, string | undefined | HistoricalTextTooLarge>()
  let group: string[] = [], bytes = 0, commitChecked = false
  const flush = async () => {
    const objects = await gitCatFileBatch(dir, group.map(rel => info.get(rel)!.hash))
    // `toString('utf8')` decodes exactly as `git cat-file -p` output in readBoundedCheckoutText does.
    for (const [i, rel] of group.entries()) out.set(rel, objects[i]?.type === 'blob' ? objects[i]!.bytes.toString('utf8') : undefined)
    group = []; bytes = 0
  }
  for (const rel of rels) {
    const blob = info.get(rel)
    if (!blob) {
      if (!commitChecked && await gitCommitMissing(dir, base)) throw new Error(`historical base ${base} is unavailable`)
      commitChecked = true
      out.set(rel, undefined)
    } else if (blob.size > DISK_TEXT_LIMIT) out.set(rel, new HistoricalTextTooLarge(rel))
    else {
      if (group.length && bytes + blob.size > HISTORICAL_BATCH_BYTES) await flush()
      group.push(rel); bytes += blob.size
    }
  }
  if (group.length) await flush()
  return out
}

/** Checkout filters can expand a small blob, so cap their output as well as the input blob. */
export async function readBoundedCheckoutText(dir: string, object: string, rel: string, encoding: BufferEncoding = 'utf8', filtered = true, knownSize?: number, limit = DISK_TEXT_LIMIT): Promise<string | undefined> {
  const size = knownSize ?? await new Promise<number | undefined>((resolve, reject) => {
    const args = ['cat-file', '-s', object], done = observeGit(args)
    execFile('git', args, { cwd: dir, timeout: 30_000, maxBuffer: 4096 }, (error, stdout, stderr) => {
      done()
      if (error) { if (/does not exist|not a valid object|could not get object info|path .* not in/i.test(String(stderr))) resolve(undefined); else reject(error); return }
      resolve(Number(String(stdout).trim()))
    })
  })
  if (size === undefined) return undefined
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new HistoricalTextTooLarge(rel)
  return new Promise<string | undefined>((resolve, reject) => {
    const args = filtered ? ['cat-file', '--filters', `--path=${rel}`, object] : ['cat-file', '-p', object]
    const done = observeGit(args)
    execFile('git', args, { cwd: dir, encoding: 'buffer', timeout: 30_000, maxBuffer: limit + 1 }, (error, stdout, stderr) => {
      done()
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new HistoricalTextTooLarge(rel))
        else if (/does not exist|exists on disk, but not in|path .* not in/i.test(String(stderr))) resolve(undefined)
        else reject(error)
        return
      }
      if (stdout.length > limit) { reject(new HistoricalTextTooLarge(rel)); return }
      resolve(stdout.toString(encoding))
    })
  })
}

/** Read from one descriptor, with a hard byte limit even if the file grows after stat. */
export async function readBoundedDiskText(file: string, encoding: BufferEncoding = 'utf8', boundary?: { root: string; path: string }, limit = DISK_TEXT_LIMIT): Promise<string> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    const verify = () => {
      if (!boundary) return
      const resolved = containedRepoPath(boundary.root, boundary.path, { leaf: 'read-contained-link' })
      if (!resolved.ok) throw new Error('unsafe Room read path: ' + boundary.path)
      const current = fs.lstatSync(resolved.path)
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('unsafe Room read path changed: ' + boundary.path)
    }
    verify()
    if (!stat.isFile()) throw new Error('not a file: ' + file)
    if (stat.size > limit) throw new Error(`file too large for Room read (${stat.size} bytes): ${file}`)
    const bytes = Buffer.allocUnsafe(limit + 1)
    let used = 0
    while (used <= limit) {
      const { bytesRead } = await handle.read(bytes, used, Math.min(64 * 1024, bytes.length - used), null)
      if (bytesRead === 0) { verify(); return bytes.subarray(0, used).toString(encoding) }
      used += bytesRead
    }
    throw new Error(`file too large for Room read (over ${limit} bytes): ${file}`)
  } finally { await handle.close() }
}
