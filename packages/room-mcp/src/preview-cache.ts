import { validPid, pidAlive } from '@room/relay/process'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/*
 * A clone and checkout-policy fingerprint select one shared worktree. A short-lived
 * lockf/flock child holds an OS advisory lock for the whole preview. It also
 * waits for recorded process groups after an MCP crash, so orphaned checks
 * cannot lose their tree. Contenders use a temporary tree immediately.
 * Metadata is written after use; eviction locks each candidate before Git removes
 * it. Windows and hosts without lockf/flock use temporary trees only.
 */
export function previewCapBytes(): number {
  const value = process.env.ROOM_PREVIEW_CACHE_GB
  if (value === undefined || value === '') return 4 * 1024 ** 3
  const gb = Number(value)
  return Number.isFinite(gb) && gb >= 0 ? gb * 1024 ** 3 : 4 * 1024 ** 3
}

let lockUnavailableForTests = false
export function setPreviewLockUnavailableForTests(value = false): void { lockUnavailableForTests = value }

export type PreviewUnlock = (() => Promise<void>) & { trackProcess(pid: number): Promise<void>; assertOwned(): void; onLost(listener: () => void): () => void }

/** One bounded, asynchronous `ps -A` read (never on the event loop), parsed into `{ key, stat }` rows. */
function readTable(column: 'pgid' | 'pid'): Promise<{ key: number; stat: string }[]> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', `${column}=,stat=`], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return }
      resolve(stdout.split('\n').flatMap(line => {
        const [key, stat] = line.trim().split(/\s+/)
        return key && stat && /^\d+$/.test(key) ? [{ key: Number(key), stat }] : []
      }))
    })
  })
}

/** `pgid stat` rows for every process, as `ps -A -o pgid=,stat=` prints them on BSD and GNU ps alike. */
export async function readProcessGroupTable(): Promise<{ pgid: number; stat: string }[]> {
  return (await readTable('pgid')).map(({ key, stat }) => ({ pgid: key, stat }))
}

/**
 * Whether a process group still has a running member. A zombie (exited, not yet reaped: `stat` starts with Z) keeps
 * `kill(-pgid, 0)` succeeding, so an orphaned check whose parent died in a container without an init process would
 * look alive forever and its cached tree could never be reclaimed. When the process table cannot be read, the signal
 * probe is the fallback.
 */
/** Whether one process is still running (a zombie has exited and only awaits reaping). Same fallback as the group check. */
export async function processAlive(pid: number, table: () => Promise<{ pid: number; stat: string }[]> = readProcessTable): Promise<boolean> {
  if (!validPid(pid)) return true
  let rows: { pid: number; stat: string }[]
  try { rows = await table() }
  catch { return pidAlive(pid) }
  return rows.some(row => row.pid === pid && !row.stat.startsWith('Z'))
}

async function readProcessTable(): Promise<{ pid: number; stat: string }[]> {
  return (await readTable('pid')).map(({ key, stat }) => ({ pid: key, stat }))
}

export async function processGroupAlive(pgid: number, table: () => Promise<{ pgid: number; stat: string }[]> = readProcessGroupTable): Promise<boolean> {
  if (!validPid(pgid)) return true
  let rows: { pgid: number; stat: string }[]
  try { rows = await table() }
  catch { try { process.kill(-pgid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' } }
  return rows.some(row => row.pgid === pgid && !row.stat.startsWith('Z'))
}

export async function tryPreviewLock(entry: string): Promise<PreviewUnlock | undefined> {
  const file = `${entry}.lock`
  const command = lockUnavailableForTests ? undefined : process.platform === 'darwin' ? 'lockf' : process.platform === 'linux' ? 'flock' : undefined
  if (!command) return undefined
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Read every process group while the owner is alive. EOF may mean normal
  // release or a killed owner; either way, wait for its children before unlock.
  const helper = "node=\"$1\"; printf READY; groups=\"\"; while IFS= read -r pgid; do case \"$pgid\" in *[!0-9]*|\"\") continue;; esac; groups=\"$groups $pgid\"; done; alive() { t=$(ps -A -o pgid=,stat= 2>/dev/null) || { \"$node\" -e 'const p=Number(process.argv[1]); if (!Number.isInteger(p) || p<=0 || p>2147483647) process.exit(0); try { process.kill(-p,0) } catch(e) { if(e.code===\"ESRCH\") process.exit(42) }' \"$1\"; result=$?; [ \"$result\" -ne 42 ]; return; }; printf \"%s\\n\" \"$t\" | awk -v g=\"$1\" '$1==g && $2 !~ /^Z/ {f=1} END {exit !f}'; }; for pgid in $groups; do while alive \"$pgid\"; do sleep 0.2; done; done"
  const args = command === 'lockf'
    ? ['-t', '0', file, 'sh', '-c', helper, 'room-preview', process.execPath]
    : ['-n', file, 'sh', '-c', helper, 'room-preview', process.execPath]
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    // A signaled child keeps exitCode null after close. Remember completion from
    // creation, and still wait for close when a live helper drains its groups.
    const closed = new Promise<void>(done => child.once('close', () => done()))
    let settled = false, lost = false, released = false
    const listeners = new Set<() => void>()
    const assertOwned = () => {
      if (lost || released || child.exitCode !== null || child.signalCode != null || !child.stdin.writable) throw new Error('preview cache lock ownership lost; tree is NOT certified')
    }
    let timer: NodeJS.Timeout | undefined
    const finish = (release?: PreviewUnlock) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (!release) child.stdin.end()
      resolve(release)
    }
    child.stdout.on('data', (data: Buffer) => {
      if (String(data).includes('READY')) finish(Object.assign(async () => {
        released = true
        child.stdin.end()
        await closed
      }, { assertOwned, onLost(listener: () => void) {
        try { assertOwned(); listeners.add(listener) } catch { listener() }
        return () => { listeners.delete(listener) }
      }, trackProcess(pid: number) {
        try { assertOwned() } catch (error) { return Promise.reject(error) }
        if (!validPid(pid)) return Promise.reject(new Error('invalid preview process registration'))
        return new Promise<void>((done, fail) => child.stdin.write(`${pid}\n`, error => error ? fail(error) : done()))
      } }))
    })
    const lose = () => { lost = true; for (const listener of listeners) listener(); finish() }
    child.on('error', lose)
    child.on('close', lose)
    timer = setTimeout(() => finish(), 1000)
  })
}

/*
 * Quarantine: a check whose processes outlived the cleanup deadline may have left a descendant in another process
 * group (detached, so the lock helper's group wait does not see it) with the tree as its working directory or its
 * output pipe open. The entry then gets a marker file; whoever next holds its lock neither resets, reuses nor removes
 * it until no process of this user has a working directory inside it, and clears the marker only then. When that
 * cannot be read (no /proc or lsof), the entry stays quarantined and checks use temporary trees.
 */
export const previewQuarantinePath = (entry: string): string => `${entry}.quarantine`

/**
 * Mark a cached tree that a process from a check may still use. `since` is when that check started (ms since the
 * epoch): a process that was already running then cannot be its descendant, which lets the probe disregard a
 * long-lived process whose working directory it cannot read.
 */
export async function quarantinePreview(entry: string, reason: string, since = Date.now()): Promise<void> {
  await fs.promises.writeFile(previewQuarantinePath(entry), JSON.stringify({ reason, at: new Date().toISOString(), since, pid: process.pid }), { mode: 0o600 })
}

let cwdsForTests: (() => Promise<string[] | undefined>) | undefined
/** Test seam: the working directories the quarantine probe sees (undefined: unreadable). */
export function setPreviewCwdsForTests(read?: () => Promise<string[] | undefined>): void { cwdsForTests = read }

/**
 * Working directories of this user's processes, or undefined when the listing is not complete: a quarantine clears
 * only on a complete listing, so every unreadable or partial result fails closed.
 * Linux: a /proc entry that vanished (ENOENT, ESRCH) is a process that exited; one that belongs to another user
 * (EACCES/EPERM with a foreign owner) is not ours to wait for; any other failure makes the listing incomplete.
 * macOS: only a clean, complete lsof listing counts; an error, timeout or overflowed buffer is incomplete.
 */
async function processCwds(since?: number): Promise<string[] | undefined> {
  if (cwdsForTests) return cwdsForTests()
  if (process.platform === 'linux') {
    const pids = await fs.promises.readdir('/proc').catch(() => undefined)
    if (!pids) return undefined
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    return procCwds(pids.filter(name => /^\d+$/.test(name)), uid, {
      readCwd: pid => fs.promises.readlink(`/proc/${pid}/cwd`),
      ownerOf: pid => fs.promises.stat(`/proc/${pid}`).then(st => st.uid, () => undefined),
      startedAt: linuxProcessStart,
    }, since)
  }
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return undefined
  const uid = String(process.getuid())
  return new Promise(resolve => {
    execFile('lsof', ['-a', '-d', 'cwd', '-u', uid, '-Fn'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(lsofCwds(error, stdout)))
  })
}

/** macOS: only a clean, complete lsof listing counts; an error, timeout or overflowed buffer is incomplete. */
export function lsofCwds(error: Error | null, stdout: string): string[] | undefined {
  if (error) return undefined
  const cwds = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
  // lsof lists this process itself, so an empty listing is not a complete one.
  return cwds.length ? cwds : undefined
}

export type ProcReaders = {
  readCwd: (pid: string) => Promise<string>
  ownerOf: (pid: string) => Promise<number | undefined>
  /** When the process started, ms since the epoch; undefined when unreadable. */
  startedAt: (pid: string) => Promise<number | undefined>
}

/**
 * Linux: a /proc entry that vanished (ENOENT, ESRCH) is a process that exited; one that another user owns
 * (EACCES/EPERM) is not ours to wait for; our own process with an unreadable working directory (non-dumpable:
 * setuid or setcap) is disregarded only when it provably started before the check (`since`), since it cannot be
 * that check's descendant; any other failure makes the listing incomplete.
 */
export async function procCwds(pids: string[], uid: number | undefined, read: ProcReaders, since?: number): Promise<string[] | undefined> {
  const cwds: string[] = []
  for (const pid of pids) {
    try { cwds.push((await read.readCwd(pid)).replace(/ \(deleted\)$/, '')) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ESRCH') continue
      if (code === 'EACCES' || code === 'EPERM') {
        const owner = await read.ownerOf(pid)
        if (owner === undefined || owner !== uid) continue
        const started = since === undefined ? undefined : await read.startedAt(pid)
        if (started !== undefined && started < since!) continue
      }
      return undefined
    }
  }
  return cwds
}

/** Linux clock ticks per second for /proc/<pid>/stat starttime (CONFIG_HZ is irrelevant: user-facing ticks are 100). */
const LINUX_CLK_TCK = 100
let linuxBootMs: Promise<number | undefined> | undefined
/** Process start as ms since the epoch from /proc/<pid>/stat field 22, readable even when the cwd is not. */
async function linuxProcessStart(pid: string): Promise<number | undefined> {
  linuxBootMs ??= fs.promises.readFile('/proc/stat', 'utf8')
    .then(text => { const m = /^btime (\d+)$/m.exec(text); return m ? Number(m[1]) * 1000 : undefined }, () => undefined)
  const boot = await linuxBootMs
  const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined)
  if (boot === undefined || !stat) return undefined
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(fields[19]) // field 22 of the whole line; the first two fields precede the comm
  return Number.isFinite(ticks) ? boot + ticks * (1000 / LINUX_CLK_TCK) : undefined
}

/**
 * Whether a quarantined entry may be used again, removing its marker when so. An entry without a marker is usable.
 * The caller holds the entry's lock.
 */
export async function clearPreviewQuarantine(entry: string): Promise<boolean> {
  const marker = previewQuarantinePath(entry)
  const marked = await fs.promises.lstat(marker).then(() => true, error => (error as NodeJS.ErrnoException).code !== 'ENOENT')
  if (!marked) return true
  const real = await fs.promises.realpath(entry).catch(() => path.resolve(entry))
  const since = await fs.promises.readFile(marker, 'utf8').then(text => { const v = (JSON.parse(text) as { since?: unknown }).since; return typeof v === 'number' ? v : undefined }, () => undefined)
  const cwds = await processCwds(since)
  if (!cwds || cwds.some(cwd => cwd === real || cwd.startsWith(`${real}${path.sep}`))) return false
  await fs.promises.rm(marker, { force: true })
  return true
}

type PreviewMeta = { bytes: number; used: number }
export const previewMetaPath = (entry: string): string => `${entry}.meta.json`

/** du measures allocated bytes quickly even for large node_modules trees. */
async function measurePreview(entry: string, cap: number): Promise<number> {
  const du = await new Promise<number | undefined>(resolve => {
    execFile('du', ['-sk', entry], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const kb = Number(/^\s*(\d+)\s/.exec(stdout)?.[1])
      resolve(error || !Number.isSafeInteger(kb) ? undefined : kb * 1024)
    })
  })
  if (du !== undefined) return du
  // du can be missing or fail on a concurrently changing tree. Never follow links.
  const pending = [entry]
  let bytes = 0, seen = 0
  while (pending.length) {
    const current = pending.pop()!
    const stat = await fs.promises.lstat(current).catch(() => undefined)
    if (!stat) continue
    bytes += stat.blocks ? stat.blocks * 512 : stat.size
    if (++seen > 1_000_000 || bytes > cap) return cap + 1
    if (stat.isDirectory()) for (const name of await fs.promises.readdir(current)) pending.push(path.join(current, name))
  }
  return bytes
}

export async function touchPreview(entry: string, cap: number, now = Date.now()): Promise<void> {
  const meta: PreviewMeta = { bytes: await measurePreview(entry, cap), used: now }
  const file = previewMetaPath(entry)
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  await fs.promises.writeFile(temporary, JSON.stringify(meta), { mode: 0o600 })
  await fs.promises.rename(temporary, file)
}

export async function evictPreviewLru(root: string, cap: number, remove: (entry: string, used: number) => Promise<boolean>): Promise<void> {
  const keys = await fs.promises.readdir(root).catch(() => [] as string[])
  const entries: { entry: string; bytes: number; used: number }[] = []
  for (const key of keys.filter(name => /^[a-f0-9]{20}(?:\.slots)?$/.test(name))) {
    const folder = path.join(root, key)
    if (!(await fs.promises.lstat(folder).catch(() => undefined))?.isDirectory()) continue
    for (const name of await fs.promises.readdir(folder)) {
      if (!/^shared-[a-f0-9]{16}$/.test(name)) continue
      const entry = path.join(folder, name)
      let meta: PreviewMeta
      try { meta = JSON.parse(await fs.promises.readFile(previewMetaPath(entry), 'utf8')) as PreviewMeta }
      catch { meta = { bytes: cap + 1, used: 0 } }
      if (!Number.isFinite(meta.bytes) || !Number.isFinite(meta.used) || meta.bytes < 0) meta = { bytes: cap + 1, used: 0 }
      entries.push({ entry, ...meta })
    }
  }
  let total = entries.reduce((n, entry) => n + entry.bytes, 0)
  for (const entry of entries.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break
    if (await remove(entry.entry, entry.used)) total -= entry.bytes
  }
}
