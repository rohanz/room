import { expect, it } from 'vitest'
import { safeRoomRegistry } from '../src/registry.js'

it.each([
  { at: 1, branches: ['local/repo/main'] },
  { at: 1, branches: [], mode: 'repo' as const, plan: { id: 'pending', sources: [] }, step: 'written' as const },
])('refuses an unfinished 0.16 registry before any document can be loaded', entry => {
  const all = { 'local/repo': entry }, before = JSON.stringify(all)
  expect(() => safeRoomRegistry(all)).toThrow(/0\.16.*v0\.17\.47/)
  expect(JSON.stringify(all)).toBe(before)
})
it('keeps a completed schema-2 registry and its existing archives', () => {
  const all = { 'local/repo': { at: 1, branches: ['local/repo/main'], legacy: ['local/repo/main'], mode: 'repo' as const, migratedAt: 1 } }
  expect(safeRoomRegistry(all)).toEqual(all)
})

it('rejects legacy registry startup before reading even an oversized stored document', async () => {
  const [{ default: fs }, { default: os }, { default: path }, { execFile }, { promisify }, { LeveldbPersistence }, Y] = await Promise.all([
    import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process'), import('node:util'), import('y-leveldb'), import('yjs'),
  ])
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retired-server-'))
  const repo = 'local/legacy', before = JSON.stringify({ [repo]: { at: Date.now(), branches: [`${repo}/main`] } }) + '\n'
  const db = new LeveldbPersistence(dir)
  try {
    const doc = new Y.Doc(); doc.getMap('old').set('oversized', new Uint8Array(2 * 1048576))
    await db.storeUpdate(`${repo}/main`, Y.encodeStateAsUpdate(doc)); doc.destroy(); await db.destroy()
    await fs.writeFile(path.join(dir, 'rooms.json'), before)
    const cwd = new URL('../../../', import.meta.url).pathname
    const probe = path.join(dir, 'probe.cjs')
    await fs.writeFile(probe, `
const { createRequire } = require('node:module');
const localRequire = createRequire(${JSON.stringify(path.join(cwd, 'package.json'))});
const LevelUP = localRequire('levelup'), original = LevelUP.prototype.createReadStream;
let valueReads = 0, listens = 0;
LevelUP.prototype.createReadStream = function (opts) { if (opts?.values !== false) valueReads++; return original.call(this, opts); };
require('node:net').Server.prototype.listen = function () { listens++; return this; };
process.on('exit', () => console.log('PROBE ' + JSON.stringify({valueReads, listens})));
`)
    let failure: { code?: number; stdout?: string; stderr?: string } | undefined
    try {
      await promisify(execFile)(process.execPath, ['--require', probe, '--import', 'tsx', 'packages/server/src/index.ts'], {
        cwd, timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: 'fake', YPERSISTENCE: dir, ROOM_LOAD_MAX_MB: '1' },
      })
    } catch (error) { failure = error as typeof failure }
    expect(failure?.code).toBe(1)
    expect(failure?.stderr).toMatch(/0\.16.*v0\.17\.47/)
    const observed = JSON.parse(failure!.stdout!.split('\n').find(line => line.startsWith('PROBE '))!.slice(6))
    expect(observed).toEqual({ valueReads: 0, listens: 0 })
    expect(await fs.readFile(path.join(dir, 'rooms.json'), 'utf8')).toBe(before)
    const reopened = new LeveldbPersistence(dir)
    try {
      const old = await reopened.getYDoc(`${repo}/main`)
      expect((old.getMap('old').get('oversized') as Uint8Array).byteLength).toBe(2 * 1048576)
      expect(old.getMap('meta').get('schemaVersion')).toBeUndefined(); old.destroy()
      expect(await reopened.getAllDocNames()).toEqual([`${repo}/main`])
    } finally { await reopened.destroy() }
  } finally { await db.destroy(); await fs.rm(dir, { recursive: true, force: true }) }
})
