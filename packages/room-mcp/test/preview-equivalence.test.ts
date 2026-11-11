import { base, git, lead, previewSetup, put, root, second, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { manifestKey } from '@room/shared'
import { publishFixture } from './fixtures/manifest.js'
import { realGitCommonDir } from '@room/roomd'
import { collectedTreeEvidence, fingerprintTree, beginPreviewAttempt, validateFingerprintSync } from '../src/preview-evidence.js'
import * as previewEvidence from '../src/preview-evidence.js'
import { withGuard } from '../src/leases.js'
import { collectLocalState } from '../src/local-state-gc.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlers as fileHandlers, runInMergedTree, previewCachePath, setPreviewCheckLimitsForTests } from '../src/tools/files.js'

async function recordPreviewEvidence(clone: string, tree: Awaited<ReturnType<typeof fingerprintTree>>, command: string, result: { complete: boolean; exitCode: number | null; passed: boolean }, at: string) {
  const finish = await beginPreviewAttempt(clone, command, at)
  const head = git(clone, 'rev-parse', 'HEAD')
  await finish(tree, result, head)
  return (completion: typeof result) => finish(tree, completion, head)
}

async function preview(command = 'true') {
  const t = await previewSetup()
  Object.assign(t.state, {
    rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
    others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
    baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
  })
  put(worker, 'output.txt', 'worker output\n')
  const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: command })
  return { t, result }
}
afterEach(() => { setPreviewCheckLimitsForTests(); vi.restoreAllMocks() })

describe('preview/collect tree equivalence', () => {
  it.each([{}, { keep: true }, { mode: 'copy', paths: ['output.txt'] }])('reports the identical tree and command after collection %j', async options => {
    const { t, result } = await preview('cat output.txt')
    expect(result).toContain('exit 0')
    const collected = await t.call({ tag: 'test', ...options })
    expect(collected).toContain('collected tree is identical to the tree that passed "cat output.txt" (preview at ')
    expect(collected).toContain('same files, same command only; Git state (HEAD, refs, index), environment and ignored files are not compared')
  })
  it('names a worker edit after the preview', async () => {
    const { t } = await preview()
    put(worker, 'output.txt', 'changed\n')
    expect(await t.call({ tag: 'test' })).toContain('collected tree differs from the most recent preview in 1 file(s): output.txt')
  })
  it('names a lead edit after the preview', async () => {
    const { t } = await preview()
    put(lead, 'lead-edit.txt', 'later\n')
    expect(await t.call({ tag: 'test' })).toContain('collected tree differs from the most recent preview in 1 file(s): lead-edit.txt')
  })
  it('names output from a worker not covered by the preview', async () => {
    const t = await previewSetup(), other = second(t)
    put(worker, 'output.txt', 'first\n'); put(other, 'uncovered.txt', 'second\n')
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test', 'lead+second'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    await t.sync()
    expect(await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'true' })).toContain('exit 0')
    expect(await t.call({})).toContain('collected tree differs from the most recent preview in 1 file(s): uncovered.txt')
  })
  it('reports the most recent failure on an identical tree', async () => {
    const { t } = await preview('true')
    await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'exit 7' })
    const collected = await t.call({ tag: 'test' })
    expect(collected).toContain('collected tree is identical to the tree whose preview failed "exit 7"')
    expect(collected).toContain('exit 7')
    expect(collected).not.toContain('tree that passed')
  })
  it('never treats a timed-out run as a pass', async () => {
    setPreviewCheckLimitsForTests({ timeoutMs: 100, maxBuffer: 4096 })
    const { t, result } = await preview('sleep 5')
    expect(result).toContain('command completion: incomplete')
    const collected = await t.call({ tag: 'test' })
    expect(collected).toContain('preview was incomplete')
    expect(collected).not.toContain('tree that passed')
  })
  it('never treats output-limited runs as a pass', async () => {
    setPreviewCheckLimitsForTests({ timeoutMs: 10_000, maxBuffer: 1024 })
    const { t } = await preview('yes output')
    const collected = await t.call({ tag: 'test' })
    expect(collected).toContain('preview was incomplete')
    expect(collected).not.toContain('tree that passed')
  })
  it('does not mutate the lead index, stash or refs while fingerprinting a preview', async () => {
    const t = await previewSetup()
    put(lead, 'stashed.txt', 'stash\n'); git(lead, 'add', '.'); git(lead, 'stash', 'push', '-m', 'keep stash')
    put(lead, 'staged.txt', 'staged\n'); git(lead, 'add', '.')
    const index = path.join(lead, '.git', 'index')
    const before = fs.readFileSync(index), refs = git(lead, 'show-ref'), stash = git(lead, 'stash', 'list')
    await runInMergedTree(t.s, base, new Map([['output.txt', 'preview\n']]), 'true')
    expect(fs.readFileSync(index)).toEqual(before)
    expect(git(lead, 'show-ref')).toEqual(refs)
    expect(git(lead, 'stash', 'list')).toEqual(stash)
  })
  it('asks for validation without a command preview', async () => {
    const t = await previewSetup(); put(worker, 'output.txt', 'output\n')
    expect(await t.call({ tag: 'test' })).toContain('no preview ran a command on this tree; validate it')
  })
  it('treats an older matching tree as a cache miss after a newer preview', async () => {
    const { t } = await preview('echo first')
    put(worker, 'output.txt', 'second tree\n')
    await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'echo second' })
    put(worker, 'output.txt', 'worker output\n')
    const report = await t.call({ tag: 'test' })
    expect(report).toContain('no preview result is recorded for this tree; validate it')
    expect(report).not.toContain('tree that passed')
  })
  it('excludes ignored output on both sides', async () => {
    put(lead, 'artifact.bin', 'before\n')
    const { t } = await preview()
    put(lead, 'artifact.bin', 'after\n')
    expect(await t.call({ tag: 'test' })).toContain('tree that passed "true"')
  })
  it.skipIf(process.platform === 'win32').for([0o755, 0o4644])('compares mode %i even when Git ignores mode changes', async (mode, context) => {
    const { t } = await preview()
    git(lead, 'config', 'core.fileMode', 'false')
    fs.chmodSync(path.join(lead, 'file.txt'), mode)
    if ((fs.statSync(path.join(lead, 'file.txt')).mode & 0o7777) !== mode) context.skip('filesystem/sandbox does not preserve this permission mode')
    expect(await t.call({ tag: 'test' })).toContain('1 file(s): file.txt')
  })
  it('compares raw bytes even when a Git clean filter would hide a change', async () => {
    const { t } = await preview()
    git(lead, 'config', 'filter.fixed.clean', 'printf "base\\n"')
    git(lead, 'config', 'filter.fixed.smudge', 'cat')
    fs.writeFileSync(path.join(lead, '.git', 'info', 'attributes'), 'file.txt filter=fixed\n')
    put(lead, 'file.txt', 'different raw bytes\n')
    expect(await t.call({ tag: 'test' })).toContain('1 file(s): file.txt')
  })
  it('does not promote a partial preview that exits zero', async () => {
    const t = await previewSetup()
    put(worker, 'output.txt', 'output\n')
    publishFixture(t.s.room, 'missing', 'gap.txt', 'unavailable text\n', { base })
    t.s.room.overlays.delete(manifestKey('missing', '1'))
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test', 'missing'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    const result = await fileHandlers(t.state).room_preview_merge({ people: ['lead+test', 'missing'], run: 'echo "1 passed"' })
    expect(result).toContain('PARTIAL')
    const collected = await t.call({ tag: 'test' })
    expect(collected).not.toContain('tree that passed')
    expect(collected).toContain('preview was incomplete')
  })
  it('treats a masked test failure as failed even with exit zero', async () => {
    const command = 'echo "1 failed"'
    const { t } = await preview(command)
    expect(await t.call({ tag: 'test' })).toContain('tree whose preview failed ' + JSON.stringify(command))
  })
  it('compares binary additions and deletions', async () => {
    const t = await previewSetup()
    fs.unlinkSync(path.join(worker, 'file.txt'))
    fs.writeFileSync(path.join(worker, 'bytes.bin'), Buffer.from([0, 255, 1, 128]))
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'true' })
    expect(await t.call({ tag: 'test' })).toContain('tree that passed "true"')
  })
})

describe('review2 evidence boundaries and Git context', () => {
  const passed = { complete: true, exitCode: 0, passed: true }
  it('review2: a mutation during final revalidation must prevent an identical-pass claim', async () => {
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'z.txt']
    for (const name of names) put(lead, name, 'initial\n')
    git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'files')
    const paths = ['.gitignore', ...names, 'file.txt'].sort()
    const tree = await fingerprintTree(lead, paths)
    await recordPreviewEvidence(lead, tree, 'test files', passed, new Date().toISOString())
    const original = fs.promises.lstat.bind(fs.promises)
    let lastStats = 0, mutated = false
    const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (String(args[0]) === path.join(lead, 'z.txt') && ++lastStats === 3) {
        put(lead, 'a.txt', 'changed after a.txt final check\n'); mutated = true
      }
      return value
    })
    const evidence = await collectedTreeEvidence(lead)
    spy.mockRestore()
    expect(mutated).toBe(true)
    expect((await fingerprintTree(lead, paths)).hash).not.toBe(tree.hash)
    expect(evidence).not.toContain('tree that passed')
  })
  it('review2: a clean preview index cannot exempt commands reading the collected index', async () => {
    const t = await previewSetup()
    put(worker, 'file.txt', 'staged lead change\n')
    put(lead, 'file.txt', 'staged lead change\n'); git(lead, 'add', 'file.txt')
    const command = 'git diff --cached --quiet'
    const result = await runInMergedTree(t.s, base, new Map([['file.txt', 'staged lead change\n']]), command)
    expect(result.text).toContain('exit 0')
    const collected = await t.call({ tag: 'test', keep: true })
    expect(() => git(lead, 'diff', '--cached', '--quiet')).toThrow()
    expect(collected).toContain('Git state (HEAD, refs, index), environment and ignored files are not compared')
    expect(collected).toContain('rerun commands that read Git state on the collected tree')
    expect(result.text).toContain('preview Git context: detached worktree at ' + base)
  })
  it('review2: retained passing evidence exposes a HEAD move with identical files', async () => {
    const t = await previewSetup()
    const command = `test "$(git rev-parse HEAD)" = ${base}`
    expect((await runInMergedTree(t.s, base, new Map(), command)).text).toContain('exit 0')
    git(lead, 'commit', '-q', '--allow-empty', '-m', 'HEAD moved without changing files')
    const head = git(lead, 'rev-parse', 'HEAD')
    const collected = await t.call({ tag: 'test', keep: true })
    expect(head).not.toBe(base)
    expect(collected).not.toContain('tree that passed')
    expect(collected).toContain(`HEAD moved from ${base} to ${head}`)
    expect(collected).toContain('identical files')
  })
  it.each(['failed', 'pending'])('review2: an earlier pending pass completing late cannot hide a newer %s run', async kind => {
    const tree = await fingerprintTree(lead, ['.gitignore', 'file.txt'])
    const finishOld = await recordPreviewEvidence(lead, tree, 'npm test', { complete: false, exitCode: null, passed: false }, '2026-11-10T12:00:00.000Z')
    await recordPreviewEvidence(lead, tree, 'npm test', { complete: kind === 'failed', exitCode: kind === 'failed' ? 7 : null, passed: false }, '2026-11-10T12:00:01.000Z')
    await finishOld(passed)
    const evidence = await collectedTreeEvidence(lead)
    expect(evidence).toContain(kind === 'failed' ? 'preview failed "npm test"' : 'preview was incomplete "npm test"')
    expect(evidence).not.toContain('tree that passed')
  })
  it('review2: a preview-tree edit after hashing but before launch cannot certify the old bytes', async () => {
    const t = await previewSetup(), cache = await previewCachePath(lead)
    const original = fs.promises.rename.bind(fs.promises)
    const originalSync = fs.renameSync.bind(fs)
    let changed = false
    const afterRename = (destination: unknown) => {
      if (!changed && String(destination).includes('/preview-evidence/') && String(destination).endsWith('.json') && JSON.parse(fs.readFileSync(String(destination), 'utf8')).tree !== null) {
        put(cache, 'file.txt', 'changed after fingerprint\n'); changed = true
      }
    }
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      await original(...args)
      afterRename(args[1])
    })
    const syncSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => { originalSync(...args); afterRename(args[1]) })
    const result = await runInMergedTree(t.s, base, new Map(), 'test "$(cat file.txt)" = "changed after fingerprint"')
    spy.mockRestore(); syncSpy.mockRestore()
    expect(changed).toBe(true)
    expect(result.text).toContain('exit 0')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    const collected = await t.call({ tag: 'test', keep: true })
    expect(collected).not.toContain('tree that passed')
    expect(collected).toContain('included tree changed before command launch')
  })
  it.each(['file.txt', 'created.txt'])('review2: a command rewriting included files or paths (%s) cannot certify its input tree', async file => {
    const t = await previewSetup()
    const command = `printf rewritten > ${file}; echo '1 passed'`
    const result = await runInMergedTree(t.s, base, new Map(), command)
    expect(result.text).toContain('exit 0')
    expect(result.passed).toBe(false)
    const collected = await t.call({ tag: 'test', keep: true })
    expect(collected).not.toContain('tree that passed')
    expect(collected).toContain('included tree changed during command')
  })
})

it('review4: a later failed command after wall-clock rollback is not hidden by an older pass', async () => {
  const t = await previewSetup(), merged = new Map([['output.txt', 'worker output\n']])
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-11-11T04:00:00.000Z'))
    expect((await runInMergedTree(t.s, base, merged, 'true')).text).toContain('exit 0')
    vi.setSystemTime(new Date('2026-11-11T03:59:00.000Z'))
    expect((await runInMergedTree(t.s, base, merged, 'exit 7')).text).toContain('exit 7')
    put(lead, 'output.txt', 'worker output\n')
    const report = await collectedTreeEvidence(lead)
    expect(report).toContain('preview failed')
    expect(report).not.toContain('tree that passed')
  } finally { vi.useRealTimers() }
})

it('reserves its pending attempt before asynchronous materialization starts', async () => {
  const t = await previewSetup()
  await runInMergedTree(t.s, base, new Map(), 'true')
  const folder = path.join(await realGitCommonDir(lead), 'room', 'preview-evidence')
  let observed = false
  vi.stubEnv('ROOM_PREVIEW_CACHE_GB', '0')
  try {
    let pending: any[] = []
    const result = await runInMergedTree(t.s, base, new Map(), 'exit 7', { observe: { baseMaterialized() {
      observed = true
      pending = fs.readdirSync(folder).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')))
    } } })
    expect(result.text).toContain('exit 7')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ command: 'exit 7', tree: null, complete: false, passed: false })
    expect(observed).toBe(true)
  } finally { vi.unstubAllEnvs() }
})

describe('review3 latest attempt snapshot', () => {
  const passed = { complete: true, exitCode: 0, passed: true }
  it.each(['failed', 'pending'] as const)('review3: newer %s evidence arriving during collect supersedes the earlier attempt', async state => {
    const tree = await fingerprintTree(lead, ['.gitignore', 'file.txt'])
    await recordPreviewEvidence(lead, tree, 'npm test', passed, '2026-11-10T12:00:00.000Z')
    const original = fs.promises.open.bind(fs.promises)
    let interleaved = false
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (!interleaved && String(args[0]) === path.join(lead, 'file.txt')) {
        interleaved = true
        await recordPreviewEvidence(lead, tree, 'npm test', state === 'failed'
          ? { complete: true, exitCode: 7, passed: false }
          : { complete: false, exitCode: null, passed: false }, '2026-11-10T12:00:01.000Z')
      }
      return original(...args)
    })
    const result = await collectedTreeEvidence(lead)
    expect(interleaved).toBe(true)
    expect(result).toContain(state === 'failed' ? 'preview failed' : 'preview was incomplete')
    expect(result).not.toContain('tree that passed')
  })
  it.each(['apply', 'copy', 'second-keep'] as const)('review3: %s collection sees failure published while it fingerprints', async mode => {
    const t = await previewSetup(), command = 'echo "1 passed"'
    put(worker, 'output.txt', 'worker output\n')
    const tested = await fingerprintTree(worker, ['.gitignore', 'file.txt', 'output.txt'])
    expect((await runInMergedTree(t.s, base, new Map([['output.txt', 'worker output\n']]), command)).text).toContain('exit 0')
    if (mode === 'second-keep') expect(await t.call({ tag: 'test', keep: true })).toContain('tree that passed')
    // Gate on resolver entry, so kept-publication acknowledgement cannot trigger the injection early.
    const resolve = previewEvidence.collectedTreeEvidence
    let resolverEntered = false, interleaved = false
    vi.spyOn(previewEvidence, 'collectedTreeEvidence').mockImplementation((...args) => {
      resolverEntered = true
      return resolve(...args)
    })
    const original = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (resolverEntered && !interleaved && String(args[0]) === path.join(lead, 'output.txt')) {
        interleaved = true
        await recordPreviewEvidence(lead, tested, command, { complete: true, exitCode: 7, passed: false }, new Date(Date.now() + 1000).toISOString())
      }
      return original(...args)
    })
    const result = await t.call(mode === 'copy' ? { tag: 'test', mode: 'copy', paths: ['output.txt'] }
      : mode === 'second-keep' ? { tag: 'test', keep: true } : { tag: 'test' })
    expect(resolverEntered).toBe(true)
    expect(interleaved).toBe(true)
    expect(result).toContain('preview failed')
    expect(result).not.toContain('tree that passed')
  })
  it('review3: another process cannot publish evidence while the publisher guard is held', async () => {
    const finishOld = await recordPreviewEvidence(lead, await fingerprintTree(lead, ['.gitignore', 'file.txt']), 'npm test', passed, '2026-11-10T12:00:00.000Z')
    const folder = path.join(await realGitCommonDir(lead), 'room', 'preview-evidence')
    const prefix = createHash('sha256').update(fs.realpathSync(lead)).digest('hex') + '-'
    const guard = path.join(folder, prefix + 'publication')
    const contended = path.join(root, 'publisher-contended'), published = path.join(root, 'publisher-finished')
    const script = path.join(root, 'evidence-publisher.mjs')
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      import { fingerprintTree, beginPreviewAttempt } from ${JSON.stringify(new URL('../src/preview-evidence.ts', import.meta.url).href)};
      const link = fs.linkSync.bind(fs);
      fs.linkSync = (...args) => { try { return link(...args) } catch (error) {
        if (String(args[1]) === ${JSON.stringify(guard + '.guard')} && error.code === 'EEXIST') fs.writeFileSync(${JSON.stringify(contended)}, 'waiting');
        throw error;
      } };
      const finish = await beginPreviewAttempt(${JSON.stringify(lead)}, 'npm test');
      const tree = await fingerprintTree(${JSON.stringify(lead)}, ['.gitignore', 'file.txt']);
      await finish(tree, { complete: true, exitCode: 7, passed: false }, ${JSON.stringify(base)});
      fs.writeFileSync(${JSON.stringify(published)}, 'published');
    `)
    let child: ChildProcess | undefined, closed: Promise<number | null> | undefined
    try {
      withGuard(guard, () => {
        child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'ignore', cwd: path.dirname(fileURLToPath(import.meta.url)) })
        closed = new Promise(resolve => child!.once('close', resolve))
        const deadline = performance.now() + 10_000
        const sleeper = new Int32Array(new SharedArrayBuffer(4))
        while (!fs.existsSync(contended) && !fs.existsSync(published) && performance.now() < deadline) Atomics.wait(sleeper, 0, 0, 10)
        expect(fs.existsSync(contended) || fs.existsSync(published), 'publisher neither attempted the guard nor finished').toBe(true)
        expect(fs.existsSync(contended), 'publisher bypassed the publisher guard').toBe(true)
        expect(fs.existsSync(published)).toBe(false)
      })
      expect(await closed).toBe(0)
      expect(await finishOld(passed)).toBe(false)
      expect(await collectedTreeEvidence(lead)).toContain('preview failed')
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL')
      await closed
    }
  })
})

describe('single preview evidence record', () => {
  async function tree() { return fingerprintTree(lead, ['.gitignore', 'file.txt']) }
  const passed = { complete: true, exitCode: 0, passed: true }
  it('replaces the one record for each new attempt', async () => {
    const fingerprint = await tree()
    for (let i = 0; i < 3; i++) await recordPreviewEvidence(lead, fingerprint, `check ${i}`, passed, new Date().toISOString())
    const folder = path.join(await realGitCommonDir(lead), 'room', 'preview-evidence')
    expect(fs.readdirSync(folder).filter(name => name.endsWith('.json'))).toHaveLength(1)
    expect(await collectedTreeEvidence(lead)).toContain('tree that passed')
  })
  it('cannot resurrect an expired attempt or overwrite its successor', async () => {
    const fingerprint = await tree(), finishOld = await beginPreviewAttempt(lead, 'old check')
    const common = await realGitCommonDir(lead), folder = path.join(common, 'room', 'preview-evidence')
    const file = path.join(folder, fs.readdirSync(folder).find(name => name.endsWith('.json'))!)
    fs.utimesSync(file, 1, 1)
    collectLocalState(common)
    expect(await finishOld(fingerprint, passed, base)).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    await beginPreviewAttempt(lead, 'new check')
    expect(await finishOld(fingerprint, passed, base)).toBe(false)
    expect(await collectedTreeEvidence(lead)).toContain('preview was incomplete "new check"')
  })
  it('reads without guarding or fsync, survives a crash after rename, and recovers the dead publisher', async () => {
    await recordPreviewEvidence(lead, await tree(), 'old pass', passed, new Date().toISOString())
    const folder = path.join(await realGitCommonDir(lead), 'room', 'preview-evidence')
    const ready = path.join(root, 'renamed'), script = path.join(root, 'crash-publisher.mjs')
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      import { beginPreviewAttempt } from ${JSON.stringify(new URL('../src/preview-evidence.ts', import.meta.url).href)};
      const rename = fs.renameSync.bind(fs);
      fs.renameSync = (...args) => {
        rename(...args);
        if (String(args[1]).endsWith('latest.json')) {
          fs.writeFileSync(${JSON.stringify(ready)}, 'renamed');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      };
      await beginPreviewAttempt(${JSON.stringify(lead)}, 'crashed pending');
    `)
    const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'ignore', cwd: path.dirname(fileURLToPath(import.meta.url)) })
    const closed = new Promise(resolve => child.once('close', resolve))
    try {
      const deadline = performance.now() + 10_000
      while (!fs.existsSync(ready) && child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      expect(fs.existsSync(ready), 'publisher did not reach its atomic rename').toBe(true)
      const guard = path.join(folder, fs.readdirSync(folder).find(name => name.endsWith('publication.guard'))!)
      const token = fs.readFileSync(guard, 'utf8'), sync = vi.spyOn(fs, 'fsyncSync'), link = vi.spyOn(fs, 'linkSync')
      expect(await collectedTreeEvidence(lead)).toContain('preview was incomplete "crashed pending"')
      expect(sync).not.toHaveBeenCalled(); expect(link).not.toHaveBeenCalled()
      expect(fs.readFileSync(guard, 'utf8')).toBe(token)
      sync.mockRestore(); link.mockRestore()
      child.kill('SIGKILL'); await closed
      expect(await collectedTreeEvidence(lead)).not.toContain('tree that passed')
      await recordPreviewEvidence(lead, await tree(), 'recovered', passed, new Date().toISOString())
      expect(await collectedTreeEvidence(lead)).toContain('tree that passed "recovered"')
      expect(fs.existsSync(guard)).toBe(false)
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await closed }
  })
  it('keeps evidence separate for linked checkouts sharing a Git directory', async () => {
    await recordPreviewEvidence(worker, await tree(), 'worker check', passed, new Date().toISOString())
    expect(await collectedTreeEvidence(lead)).toContain('no preview ran a command on this tree; validate it')
    expect(await collectedTreeEvidence(worker)).toContain('tree that passed "worker check"')
  })
  it('fails closed on corrupt evidence', async () => {
    await recordPreviewEvidence(lead, await tree(), 'check', passed, new Date().toISOString())
    const folder = path.join(await realGitCommonDir(lead), 'room', 'preview-evidence')
    const file = path.join(folder, fs.readdirSync(folder)[0]!)
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.tree.files[0][2] = 'changed'
    fs.writeFileSync(file, JSON.stringify(record))
    expect(await collectedTreeEvidence(lead)).toContain('equivalence unavailable: invalid preview fingerprint; validate it')
  })
  it.skipIf(process.platform === 'win32')('fails closed on linked directory ancestors, including links within the tree', async () => {
    put(lead, 'original/file.txt', 'bytes\n')
    fs.symlinkSync('original', path.join(lead, 'alias'))
    await expect(fingerprintTree(lead, ['alias/file.txt'])).rejects.toThrow('linked ancestor')
  })
  it.skipIf(process.platform === 'win32')('rechecks parent identity on each synchronous gate even when file identities are unchanged', async () => {
    const paths = ['parent/a.txt', 'parent/b.txt']
    for (const name of paths) put(lead, name, 'bytes\n')
    const tree = await fingerprintTree(lead, paths)
    validateFingerprintSync(tree, paths)
    const before = paths.map(name => fs.lstatSync(path.join(lead, name)).ino)
    fs.renameSync(path.join(lead, 'parent'), path.join(lead, 'original-parent'))
    fs.symlinkSync('original-parent', path.join(lead, 'parent'))
    expect(paths.map(name => fs.lstatSync(path.join(lead, name)).ino)).toEqual(before)
    expect(() => validateFingerprintSync(tree, paths)).toThrow('linked ancestor')
  })
  it('still checks every sibling file in the synchronous gate', async () => {
    const paths = ['parent/a.txt', 'parent/b.txt']
    for (const name of paths) put(lead, name, 'bytes\n')
    const tree = await fingerprintTree(lead, paths)
    put(lead, paths[1]!, 'changed\n')
    expect(() => validateFingerprintSync(tree, paths)).toThrow('file changed during fingerprint: parent/b.txt')
  })
  it.skipIf(process.platform === 'win32')('hashes symlink targets without following them', async () => {
    fs.symlinkSync('first-missing-target', path.join(lead, 'link'))
    const before = await fingerprintTree(lead, ['link'])
    fs.unlinkSync(path.join(lead, 'link'))
    fs.symlinkSync('other-missing-target', path.join(lead, 'link'))
    expect((await fingerprintTree(lead, ['link'])).hash).not.toBe(before.hash)
  })
  it('rejects a file changed after it was hashed while other files are still being read', async () => {
    const names = ['first', 'second', 'third', 'fourth', 'fifth']
    for (const name of names) put(lead, name, 'original\n')
    const afterRead = Promise.withResolvers<void>()
    const lstat = fs.promises.lstat.bind(fs.promises), open = fs.promises.open.bind(fs.promises)
    let firstStats = 0
    const statSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const result = await lstat(...args)
      if (String(args[0]) === path.join(lead, 'first') && ++firstStats === 2) afterRead.resolve()
      return result
    })
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(lead, 'fifth')) {
        await afterRead.promise
        put(lead, 'first', 'changed after hashing\n')
      }
      return open(...args)
    })
    try { await expect(fingerprintTree(lead, names)).rejects.toThrow('changed during fingerprint') }
    finally { statSpy.mockRestore(); openSpy.mockRestore() }
  })
  it('persists an incomplete record before the command, then atomically records completion', async () => {
    const finish = await recordPreviewEvidence(lead, await tree(), 'pending check', { complete: false, exitCode: null, passed: false }, new Date().toISOString())
    expect(await collectedTreeEvidence(lead)).toContain('preview was incomplete "pending check"')
    expect(typeof finish).toBe('function')
    await finish(passed)
    expect(await collectedTreeEvidence(lead)).toContain('tree that passed "pending check"')
    const folder = path.join(await realGitCommonDir(lead), 'room', 'preview-evidence')
    expect(fs.readdirSync(folder).filter(name => name.endsWith('.json'))).toHaveLength(1)
  })
})
