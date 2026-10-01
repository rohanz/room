import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setGitObserver } from '@room/roomd/git'
import { carriedContentHash, carriedContentHashes } from '@room/roomd/baseline'
import { prepareWorktree } from '../src/worker-git.js'

// Carrying untracked files must cost a fixed number of Git processes, not one or more per file:
// spawning with ~200 untracked files spent ~7 s in per-file hash-object and update-index calls.
const repos: string[] = []
afterEach(() => { setGitObserver(undefined); for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }) })
function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'room-carry-batch-')); repos.push(dir)
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t')
  writeFileSync(join(dir, '.gitattributes'), '*.crlf text eol=crlf\n*.lf text eol=lf\n')
  writeFileSync(join(dir, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
  return { dir, git }
}
/** The per-file hash carry used before batching: by name for a file, link text on stdin for a link. */
function perFileHash(dir: string, rel: string, link?: string): string {
  return link === undefined
    ? execFileSync('git', ['hash-object', '--path=' + rel, '--', rel], { cwd: dir, encoding: 'utf8' }).trim()
    : execFileSync('git', ['hash-object', '--path=' + rel, '--stdin'], { cwd: dir, input: link, encoding: 'utf8' }).trim()
}
async function gitCount(dir: string, files: number, tag: string): Promise<number> {
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `u${i}.txt`), `file ${i}\n`)
  let count = 0
  setGitObserver(() => { count++ })
  try {
    const prepared = await prepareWorktree(dir, tag)
    expect(prepared.carryFailed).toBeFalsy()
    expect(prepared.carriedUntracked).toHaveLength(files)
  } finally { setGitObserver(undefined) }
  return count
}

describe('untracked carry is batched', () => {
  it('runs the same number of git processes for 3 and for 40 untracked files', async () => {
    const few = await gitCount(repo().dir, 3, 'few')
    const many = await gitCount(repo().dir, 40, 'many')
    expect(many).toBe(few)
  })

  it('records the same blobs, modes and retained tree as per-file hashing, for odd names, filters and links', async () => {
    const { dir, git } = repo()
    const names = ['plain.txt', 'with space.txt', 'tab\there.txt', 'new\nline.txt', '"quoted.txt', 'back\\slash.txt', 'trailing-cr\r',
      'ünïcödé.txt', 'win.crlf', 'unix.lf', 'deep/nested/dir/file.txt', 'run.sh']
    mkdirSync(join(dir, 'deep/nested/dir'), { recursive: true })
    for (const name of names) writeFileSync(join(dir, name), name.endsWith('.lf') ? 'a\r\nb\r\n' : `content of ${name}\r\n`)
    chmodSync(join(dir, 'run.sh'), 0o755)
    symlinkSync('plain.txt', join(dir, 'link'))
    symlinkSync('deep/nested', join(dir, 'link.crlf'))
    const expected = new Map([...names.map(n => [n, perFileHash(dir, n)] as const),
      ['link', perFileHash(dir, 'link', 'plain.txt')], ['link.crlf', perFileHash(dir, 'link.crlf', 'deep/nested')]])
    // The eol filter applies: the batch must hash as git status does, not the raw bytes.
    expect(expected.get('unix.lf')).not.toBe(git('hash-object', '--no-filters', 'unix.lf'))

    const prepared = await prepareWorktree(dir, 'odd')
    expect(prepared.carryFailed, prepared.carryError).toBeFalsy()
    expect(new Map(prepared.carriedUntracked!.map(c => [c.path, c.sha]))).toEqual(expected)
    expect(prepared.carriedUntracked!.find(c => c.path === 'run.sh')?.mode).toBe(0o755)
    for (const [rel, sha] of expected) expect(git('cat-file', '-t', sha), rel).toBe('blob')

    const tree = execFileSync('git', ['ls-tree', '-r', '-z', 'refs/room/carry-untracked/odd'], { cwd: dir, encoding: 'utf8' })
      .split('\0').filter(Boolean).map(line => {
        const tab = line.indexOf('\t'), [mode, , sha] = line.slice(0, tab).split(' ')
        return [line.slice(tab + 1), `${mode} ${sha}`] as const
      })
    const modeOf = (rel: string) => rel.startsWith('link') ? '120000' : rel === 'run.sh' ? '100755' : '100644'
    expect(new Map(tree)).toEqual(new Map([...expected].map(([rel, sha]) => [rel, `${modeOf(rel)} ${sha}`])))
  })

  it('carriedContentHashes matches carriedContentHash path by path, and stores blobs only when asked', () => {
    const { dir, git } = repo()
    for (const name of ['a.txt', 'b c.lf', 'new\nline.crlf']) writeFileSync(join(dir, name), `x\r\n${name}\n`)
    symlinkSync('a.txt', join(dir, 'l'))
    const paths = ['a.txt', 'l', 'b c.lf', 'new\nline.crlf']
    const hashes = carriedContentHashes(dir, paths)
    expect(hashes).toEqual(paths.map(p => carriedContentHash(dir, p)))
    expect(() => git('cat-file', '-e', hashes[0])).toThrow()
    expect(carriedContentHashes(dir, paths, true)).toEqual(hashes)
    for (const sha of hashes) expect(git('cat-file', '-t', sha)).toBe('blob')
    expect(carriedContentHashes(dir, [])).toEqual([])
  })

  it('still notices a carried file the lead changes during the carry, and retries the snapshot', async () => {
    const { dir } = repo()
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `u${i}.txt`), `file ${i}\n`)
    let hashes = 0
    setGitObserver(args => {
      if (args.includes('hash-object') && args.includes('-w') && ++hashes === 1) writeFileSync(join(dir, 'u3.txt'), 'changed by the lead\n')
    })
    const prepared = await prepareWorktree(dir, 'race')
    setGitObserver(undefined)
    expect(prepared.carryFailed, prepared.carryError).toBeFalsy()
    expect(hashes).toBeGreaterThan(1)
    expect(prepared.carriedUntracked!.find(c => c.path === 'u3.txt')?.sha).toBe(perFileHash(dir, 'u3.txt'))
  })
})
