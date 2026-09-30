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

export type PreviewUnlock = (() => Promise<void>) & { trackProcess(pid: number): Promise<void> }

export async function tryPreviewLock(entry: string): Promise<PreviewUnlock | undefined> {
  const file = `${entry}.lock`
  const command = lockUnavailableForTests ? undefined : process.platform === 'darwin' ? 'lockf' : process.platform === 'linux' ? 'flock' : undefined
  if (!command) return undefined
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Read every process group while the owner is alive. EOF may mean normal
  // release or a killed owner; either way, wait for its children before unlock.
  const helper = 'printf READY; groups=""; while IFS= read -r pgid; do case "$pgid" in *[!0-9]*|"") continue;; esac; groups="$groups $pgid"; done; for pgid in $groups; do while kill -0 "-$pgid" 2>/dev/null; do sleep 0.2; done; done'
  const args = command === 'lockf'
    ? ['-t', '0', file, 'sh', '-c', helper]
    : ['-n', file, 'sh', '-c', helper]
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
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
        child.stdin.end()
        if (child.exitCode === null) await new Promise<void>(done => child.once('close', () => done()))
      }, { trackProcess(pid: number) {
        if (!Number.isSafeInteger(pid) || pid <= 0 || !child.stdin.writable) return Promise.reject(new Error('preview lock lost before process registration'))
        return new Promise<void>((done, fail) => child.stdin.write(`${pid}\n`, error => error ? fail(error) : done()))
      } }))
    })
    child.on('error', () => finish())
    child.on('close', () => finish())
    timer = setTimeout(() => finish(), 1000)
  })
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
