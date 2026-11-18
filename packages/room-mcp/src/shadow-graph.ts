/** Disposable event graph. All writes (including merge-tree's objects) stay in this bare repository. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { privateStateDirectory } from '@room/relay'
import { observeGit } from '@room/roomd/git'

export interface ShadowEntry { mode: string; oid: string; size?: number }
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
export class ShadowGraph {
  readonly repo: string
  deadline = Infinity
  private remaining = Infinity
  private children = new Set<ChildProcess>()
  private stopped = false
  abort(): void { this.stopped = true; for (const child of this.children) child.kill('SIGKILL') }
  async storageBudget(): Promise<number> {
    const size = async (dir: string): Promise<number> => {
      let total = 0
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('unsafe shadow state')
        const file = path.join(dir, entry.name)
        // Participant cleanup and Git's lock/ref renames can remove a listed entry.
        // Missing bytes consume no storage; other I/O failures must still stop the pass.
        try { total += entry.isDirectory() ? await size(file) : (await fs.stat(file)).size }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      return total
    }
    const used = await size(this.root)
    this.remaining = 200 * 1024 * 1024 - used
    return used
  }
  private comparisons = new Map<string, { paths: string[]; bases: string[] }>()
  private pins = new Map<string, string>()
  private gitlink?: string
  constructor(readonly root: string, readonly source: string) { this.repo = path.join(root, 'repo.git') }
  /** No inherited Git location, index, config injection or object-directory variables. */
  private environment(index?: string): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
    return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(this.root, 'no-global-config'),
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Room shadow', GIT_AUTHOR_EMAIL: 'shadow@localhost',
      GIT_COMMITTER_NAME: 'Room shadow', GIT_COMMITTER_EMAIL: 'shadow@localhost', ...(index ? { GIT_INDEX_FILE: index } : {}) }
  }
  async command(args: string[], input?: string | Buffer, index?: string, worktree?: string, raw = false): Promise<{ output: string; code: number }> {
    if (this.stopped) throw new Error('shadow stopped')
    const estimate = args[0] === 'merge-tree' ? 32 * 1024 * 1024 : args[0] === 'write-tree' || args[0] === 'update-index' ? Math.max(2 * 1024 * 1024, Buffer.byteLength(input ?? '') * 4)
      : args[0] === 'hash-object' ? Buffer.byteLength(input ?? '') + 1024 : args[0] === 'commit-tree' ? 65536 : 0
    if (estimate > 0 && estimate > this.remaining) throw new Error('over budget: storage')
    this.remaining -= estimate
    const remaining = this.deadline - performance.now()
    if (remaining <= 0) throw new Error('over budget')
    const argv = ['--git-dir', this.repo, ...(worktree ? ['--work-tree', worktree] : []), '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgsign=false', ...args]
    const done = observeGit(argv)
    try {
      return await new Promise((resolve, reject) => {
        const child = execFile('git', argv, { cwd: this.source, env: this.environment(index), killSignal: 'SIGKILL', timeout: Math.max(1, Math.floor(Math.min(3000, remaining))), maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          this.children.delete(child)
          const code = error ? (error as { code?: unknown }).code : 0
          if (code !== 0 && !(raw && code === 1)) { reject(new Error(`shadow Git step failed: ${args[0]}`)); return }
          resolve({ output: raw ? stdout : stdout.trim(), code: code as number })
        })
        this.children.add(child)
        child.stdin?.on('error', () => {})
        child.stdin?.end(input)
      })
    } finally { done() }
  }
  async run(args: string[], input?: string | Buffer, index?: string, worktree?: string): Promise<string> {
    return (await this.command(args, input, index, worktree)).output
  }
  async init(): Promise<void> {
    privateStateDirectory(this.root)
    // init needs no user Git configuration; --object-format preserves SHA-256 repositories too.
    const format = await this.sourceRead(['rev-parse', '--show-object-format'])
    if (format !== 'sha1' && format !== 'sha256') throw new Error('unsupported object format')
    await this.run(['init', '--bare', `--object-format=${format}`, this.repo])
    const common = await this.sourceRead(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    await fs.writeFile(path.join(this.repo, 'objects/info/alternates'), path.join(common, 'objects') + '\n', { mode: 0o600 })
  }
  private sourceRead(args: string[]): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('shadow stopped'))
    return new Promise((resolve, reject) => {
      const done = observeGit(args)
      const child = execFile('git', ['-C', this.source, ...args], { env: this.environment(), killSignal: 'SIGKILL', timeout: 3000, maxBuffer: 65536 }, (e, out) => {
        done(); this.children.delete(child); if (e) reject(new Error('shadow source unavailable')); else resolve(out.trim())
      })
      this.children.add(child)
    })
  }
  blob(text: string): Promise<string> { return this.run(['hash-object', '-w', '--stdin', '--no-filters'], text) }
  async entries(commit: string): Promise<Map<string, ShadowEntry>> {
    const output = await this.run(['ls-tree', '-r', '-l', '-z', commit])
    const entries = new Map<string, ShadowEntry>()
    for (const line of output.split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]+) +([0-9]+|-)\t([\s\S]+)$/.exec(line)
      // -r traverses trees (including empty trees, which contribute no files). Blobs are
      // regular/executable files or symlinks; snapshots exclude links without reading them.
      // Gitlinks name commits in another object database: never resolve those objects.
      if (!match || !oidPattern.test(match[3]) || !(match[2] === 'blob'
        ? ['100644', '100755', '120000'].includes(match[1]) && match[4] !== '-'
        : match[1] === '160000' && match[4] === '-')) throw new Error('unmodelled history: invalid tree entry kind or mode')
      entries.set(match[5], { mode: match[1], oid: match[3], ...(match[4] === '-' ? {} : { size: Number(match[4]) }) })
    }
    return entries
  }
  private async clearLock(file: string): Promise<void> {
    if (this.stopped || this.children.size) throw new Error('private Git still running or stopped')
    await fs.rm(file, { force: true })
  }
  async tree(entries: ReadonlyMap<string, ShadowEntry>, name = 'tree', worktree = this.source): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('invalid shadow identity')
    // All submodule pointers are deliberately opaque. Keep their structural gitlink
    // entry unchanged across observations/refreshes, with no dependency on its repo.
    if (!this.gitlink && [...entries.values()].some(e => e.mode === '160000'))
      this.gitlink = await this.event('opaque-gitlink', await this.tree(new Map(), 'opaque'), [])
    const index = path.join(this.root, `${name}.index`)
    await this.clearLock(index + '.lock')
    await this.run(['read-tree', '--empty'], undefined, index, worktree)
    if (entries.size) await this.run(['update-index', '-z', '--index-info'], [...entries].map(([p, e]) => `${e.mode} ${e.mode === '160000' ? this.gitlink : e.oid}\t${p}\0`).join(''), index, worktree)
    return this.run(['write-tree'], undefined, index, worktree)
  }
  async event(kind: string, tree: string, parents: string[]): Promise<string> {
    const commit = await this.run(['commit-tree', tree, ...[...new Set(parents)].flatMap(p => ['-p', p]), '-m', `${kind} ${randomUUID()}`])
    if (!oidPattern.test(commit)) throw new Error('invalid event commit')
    return commit
  }
  async pin(name: string, commit?: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('invalid shadow identity')
    const previous = this.pins.get(name)
    if (commit) {
      await this.clearLock(path.join(this.repo, 'refs/room/shadow', name + '.lock'))
      await this.run(['update-ref', `refs/room/shadow/${name}`, commit, previous ?? '0'.repeat(commit.length)]); this.pins.set(name, commit)
    } else {
      this.pins.delete(name); this.comparisons.clear()
      try {
        if (!this.stopped) {
          await this.clearLock(path.join(this.repo, 'refs/room/shadow', name + '.lock'))
          if (previous) await this.run(['update-ref', '-d', `refs/room/shadow/${name}`, previous])
        }
      } finally {
        await fs.rm(path.join(this.root, `${name}.index`), { force: true })
        await fs.rm(path.join(this.root, `${name}.index.lock`), { force: true })
      }
    }
  }
  async compare(a: string, b: string): Promise<{ paths: string[]; bases: string[] }> {
    const key = `${a}:${b}`, cached = this.comparisons.get(key)
    if (cached) {
      // The user's GC does not see private refs. Cached results cannot outlive alternate objects.
      await this.run(['rev-list', '--objects', '--quiet', '--missing=error', a, b, '--'])
      return cached
    }
    const { output, code } = await this.command(['merge-tree', '--write-tree', '-z', a, b], undefined, undefined, undefined, true)
    const tokens = output.split('\0')
    if (!oidPattern.test(tokens.shift() ?? '')) throw new Error('malformed merge result')
    const paths = new Set<string>()
    if (code === 1) {
      // Stage section ends at an empty field. Information records after it are typed, never English-parsed.
      let line: string | undefined
      while ((line = tokens.shift()) !== '') {
        const match = line && /^\d+ [a-f0-9]+ [123]\t([\s\S]+)$/.exec(line)
        if (!match) throw new Error('malformed merge stages')
        paths.add(match[1])
      }
      while (tokens.length && tokens[0] !== '') {
        const count = Number(tokens.shift())
        if (!Number.isSafeInteger(count) || count < 1 || count > 2000 || tokens.length < count + 2) throw new Error('malformed merge information')
        const involved = tokens.splice(0, count), type = tokens.shift()!
        tokens.shift() // English explanation is intentionally ignored.
        if (type.startsWith('CONFLICT')) for (const p of involved) paths.add(p)
      }
      if (!paths.size) throw new Error('conflict without paths')
    }
    await this.storageBudget()
    const bases = (await this.run(['merge-base', '--all', a, b])).split('\n')
    const result = { paths: [...paths].sort(), bases }
    if (this.comparisons.size >= 32) this.comparisons.delete(this.comparisons.keys().next().value!)
    this.comparisons.set(key, result)
    return result
  }
}
