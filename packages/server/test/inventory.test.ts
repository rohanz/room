import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LeveldbPersistence } from 'y-leveldb'
import * as Y from 'yjs'
import { classifyDoc, servedBy016, type Inventory, type InventoryDoc } from '../src/inventory.js'
import type { OpenRepo } from '../src/store.js'
import { levelDbOf } from '../src/stored.js'

const repo = 'github.com/o/r'
const registry: Record<string, OpenRepo> = { [repo]: { at: 1, branches: [`${repo}/main`] } }
const root = fileURLToPath(new URL('../../..', import.meta.url))
const exec = promisify(execFile)
async function run(dir: string, ...args: string[]) {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/room-inventory.mts', dir, ...args], { cwd: root })
    return { ...result, code: 0 }
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
}
async function snapshot(dir: string) {
  return Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))] as const))
}
async function expectUnchanged(dir: string, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(dir)
  expect(after.map(([name]) => name)).toEqual(before.map(([name]) => name))
  for (const [index, [name, bytes]] of before.entries()) expect(after[index]![1].equals(bytes), name).toBe(true)
}

describe('inventory classification', () => {
  it('matches the literal repository prefixes 0.16.40 admitted', () => {
    for (const name of [`${repo}/main`, 'local/demo/main', 'git/example.com/o/r/main']) expect(servedBy016(name)).toBe(true)
    for (const name of ['github.com%2Fo%2Fr%2Fmain', 'github.com%252Fo%252Fr%252Fmain', 'local%2Fdemo%2Fmain', '/local/demo', 'x', 'archive:invalid']) expect(servedBy016(name)).toBe(false)
    expect(classifyDoc('github.com%252Fo%252Fr%252Fmain', registry).kind).toBe('never-served')
    expect(classifyDoc(repo, registry).kind).toBe('canonical')
  })
  it('serves percent-containing suffixes and case aliases but never encoded repository prefixes', () => {
    for (const name of [`${repo}/feature%2Fx`, `${repo}/a%252Fb`, 'github.com/O/R/main']) {
      expect(servedBy016(name), name).toBe(true)
      expect(classifyDoc(name, registry)).toEqual({ repo, kind: 'served' })
    }
    for (const name of ['github.com%2Fo%2Fr%2Fmain', 'github.com%252Fo%252Fr%252Fmain']) {
      expect(servedBy016(name), name).toBe(false)
      expect(classifyDoc(name, registry).kind).toBe('never-served')
    }
    for (const name of ['/github.com/o/r/main', `${repo}/`, 'github.com/o!/r/main']) expect(servedBy016(name)).toBe(false)
  })
  it('only recognizes archives recorded by their owner', () => {
    const archive = `archive:${repo}:12345678-1234-1234-1234-123456789abc`
    expect(classifyDoc(archive, registry).kind).toBe('unregistered')
    expect(classifyDoc(archive, { [repo]: { ...registry[repo]!, legacy: [archive] } }).kind).toBe('archive')
    expect(classifyDoc(archive, { [repo]: { ...registry[repo]!, plan: { id: 'p', sources: [], moved: archive } } }).kind).toBe('archive')
    expect(classifyDoc('archive:invalid', registry).kind).toBe('unregistered')
  })
  it('requires recorded branches for local and non-GitHub repositories', () => {
    for (const key of ['local/demo', 'git/example.com/o/r']) {
      const name = `${key}/main`, rooms = { [key]: { at: 1, branches: [name] } }
      expect(classifyDoc(key, rooms).kind).toBe('canonical')
      expect(classifyDoc(name, rooms).kind).toBe('served')
      expect(classifyDoc(`${key}/other`, rooms).kind).toBe('unregistered')
      expect(classifyDoc(name.replaceAll('/', '%2F'), rooms).kind).toBe('unregistered')
      const percent = `${key}/feature%2Fx`
      expect(classifyDoc(percent, { [key]: { at: 1, branches: [percent] } }).kind).toBe('served')
    }
  })
})

describe('operator inventory pre-flight', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'room-inventory-test-'))
    await fs.writeFile(path.join(dir, 'rooms.json'), JSON.stringify(registry))
    const db = new LeveldbPersistence(dir)
    try {
      for (const name of [`${repo}/main`, 'github.com%2Fo%2Fr%2Fenterprise', 'github.com%2Fo%2Fr%2Fmain', `${repo}/big`, 'github.com/q/quantlab/main', 'local%2Fdemo%2Fmain', 'x']) {
        const doc = new Y.Doc()
        const big = name.endsWith('enterprise') || name.endsWith('/big')
        for (let i = 0; i < (big ? 5 : 1); i++) {
          const vector = Y.encodeStateVector(doc)
          doc.getMap('fixture').set(`update-${i}`, big ? 'a'.repeat(400_000) : 'small')
          await db.storeUpdate(name, Y.encodeStateAsUpdate(doc, vector))
        }
        doc.destroy()
      }
    } finally { await db.destroy() }
  })
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('flags unsafe keys and oversized updates without changing any source bytes', async () => {
    const before = await snapshot(dir)
    const result = await run(dir, '--budget-mb', '1')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('copies LevelDB files')
    const kinds = new Map([
      [`${repo}/main`, 'served'], ['github.com%2Fo%2Fr%2Fenterprise', 'never-served'],
      ['github.com%2Fo%2Fr%2Fmain', 'never-served'], [`${repo}/big`, 'served'],
      ['github.com/q/quantlab/main', 'unregistered'], ['local%2Fdemo%2Fmain', 'unregistered'], ['x', 'unregistered'],
    ])
    for (const [name, kind] of kinds) {
      const line = result.stdout.split('\n').find(line => line.includes(JSON.stringify(name)))!
      expect(line).toContain(kind)
      expect(line.includes('!')).toBe(name !== `${repo}/main`)
    }
    expect(result.stdout).toContain('7 document(s); 6 flagged')
    await expectUnchanged(dir, before)
    console.log(`Fixture inventory:\n${result.stdout}`)

    const json = await run(dir, '--budget-mb', '1', '--json')
    expect(json.code).toBe(2)
    const inventory: Inventory = JSON.parse(json.stdout)
    expect(inventory.budgetBytes).toBe(1048576)
    expect(inventory.docs).toHaveLength(7)
    inventory.docs.forEach((doc: InventoryDoc) => {
      expect(doc.kind).toBe(kinds.get(doc.name))
      expect(doc.bytes).toBeGreaterThan(0)
      expect(doc.updates).toBe(doc.over ? 3 : 1) // early exit, not all five large updates
    })
    await expectUnchanged(dir, before)
  })

  it('refuses a held LOCK with an actionable error', async () => {
    const db = new LeveldbPersistence(dir)
    try {
      await db.getAllDocNames()
      const result = await run(dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('LOCK is held')
      expect(result.stderr).toContain('stopped server')
      expect((await fs.readdir(path.dirname(dir))).filter(name => name.startsWith(`${path.basename(dir)}.room-inventory-`))).toEqual([])
    } finally { await db.destroy() }
  })

  it('holds the source LOCK before the first file copy so a mid-copy server cannot start', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'room-inventory-lock-race-'))
    const source = path.join(fixture, 'source'), preload = path.join(fixture, 'copy-probe.mjs'), result = path.join(fixture, 'probe.txt')
    await fs.mkdir(source)
    const db = new LeveldbPersistence(source), doc = new Y.Doc(); doc.getMap('fixture').set('x', true)
    await db.storeUpdate(`${repo}/main`, Y.encodeStateAsUpdate(doc)); await db.destroy(); doc.destroy()
    await fs.writeFile(path.join(source, 'rooms.json'), JSON.stringify(registry))
    // A separate process must probe the hard-linked inode: POSIX locks are process-scoped.
    const probe = `import { LeveldbPersistence } from 'y-leveldb'; const p = new LeveldbPersistence(process.argv[1]); let db; await p._transact(async d => { db = d }); const failed = new Promise((_, reject) => db.on('error', reject)); try { await Promise.race([db.open(), failed]); await p.destroy(); process.stdout.write('opened') } catch { process.stdout.write('locked') }`
    await fs.writeFile(preload, `import fs from 'node:fs/promises'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; const copy = fs.copyFile; let first = true; fs.copyFile = async (...args) => { if (first) { first = false; const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(probe)}, ${JSON.stringify(source)}], { env: { ...process.env, NODE_OPTIONS: '' } }); await fs.writeFile(${JSON.stringify(result)}, stdout) } return copy(...args) }`)
    try {
      await exec(process.execPath, ['--import', preload, '--import', 'tsx', 'scripts/room-inventory.mts', source], { cwd: root }).catch(() => {})
      expect(await fs.readFile(result, 'utf8')).toBe('locked')
      expect((await fs.readdir(fixture)).filter(name => name.startsWith('source.room-inventory-'))).toEqual([])
    } finally { await fs.rm(fixture, { recursive: true, force: true }) }
  })
  it('reports an oversized table and exits 2 even without a discovery record', async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'room-inventory-table-'))
    try {
      await fs.writeFile(path.join(source, 'rooms.json'), JSON.stringify(registry))
      const provider = new LeveldbPersistence(source), db = await levelDbOf(provider), doc = new Y.Doc()
      doc.getMap('padding').set('random', new Uint8Array(crypto.randomBytes(10 * 1048576)))
      // Models a raw copy interrupted before publishing v1_sv discovery.
      await db.batch([{ type: 'put', key: ['v1', `${repo}/large`, 'update', 0], value: Y.encodeStateAsUpdate(doc) }])
      await provider.destroy(); doc.destroy()
      const before = await snapshot(source), result = await run(source, '--budget-mb', '1', '--json')
      expect(result.code).toBe(2)
      const inventory: Inventory = JSON.parse(result.stdout)
      expect(inventory.docs).toEqual([])
      expect(inventory.tables).toContainEqual(expect.objectContaining({ level: 0, smallest: `${repo}/large`, largest: `${repo}/large` }))
      expect(inventory.tables[0]!.bytes).toBeGreaterThan(10 * 1048576)
      expect(inventory.tables[0]!.file).toBeGreaterThan(0)
      const text = await run(source, '--budget-mb', '1')
      expect(text.code).toBe(2); expect(text.stdout).toContain('tables over budget:')
      await expectUnchanged(source, before)
    } finally { await fs.rm(source, { recursive: true, force: true }) }
  })

  it('returns zero for a clean inventory and one for operator errors', async () => {
    const clean = await fs.mkdtemp(path.join(os.tmpdir(), 'room-inventory-clean-'))
    try {
      await fs.writeFile(path.join(clean, 'rooms.json'), JSON.stringify(registry))
      const db = new LeveldbPersistence(clean), doc = new Y.Doc()
      doc.getMap('fixture').set('value', 'small')
      await db.storeUpdate(`${repo}/main`, Y.encodeStateAsUpdate(doc))
      await db.destroy(); doc.destroy()
      expect((await run(clean)).code).toBe(0)
      expect((await run(clean, '--budget-mb', '-1')).code).toBe(1)
      expect((await run(clean, '--registry', path.join(clean, 'missing.json'))).code).toBe(1)
      await fs.writeFile(path.join(clean, 'exported.json'), JSON.stringify({ ...registry, x: { at: 1, branches: [] } }))
      const result = await run(clean, '--registry', path.join(clean, 'exported.json'), '--json')
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('quarantined invalid room registry key')
      expect(JSON.parse(result.stdout).docs[0].kind).toBe('served')
      const scratch = `${clean}.scratch`
      expect((await run(clean, '--scratch', scratch)).code).toBe(0)
      await expect(fs.stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fs.rm(clean, { recursive: true, force: true }) }
  })
})
