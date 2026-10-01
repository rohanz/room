/** Runs real startup with only listen stubbed: inventory must never iterate stored values. */
import { expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LeveldbPersistence } from 'y-leveldb'
import * as Y from 'yjs'

it('performs zero value reads during startup inventory of several persisted documents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'room-startup-inventory-'))
  const preload = path.join(dir, 'probe.cjs')
  const provider = new LeveldbPersistence(dir)
  try {
    for (const name of ['local/first/main', 'local/second/main', 'local/third/main']) {
      const doc = new Y.Doc(); doc.getMap('fixture').set('data', new Uint8Array(65536))
      await provider.storeUpdate(name, Y.encodeStateAsUpdate(doc)); doc.destroy()
    }
    await provider.destroy()
    await fs.writeFile(path.join(dir, 'rooms.json'), JSON.stringify(Object.fromEntries(
      ['first', 'second', 'third'].map(name => [`local/${name}`, { at: Date.now(), branches: [`local/${name}/main`] }]))))
    // Resolve levelup from this checkout, not the temporary fixture directory.
    await fs.writeFile(preload, `
const { createRequire } = require('node:module');
const localRequire = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});
const LevelUP = localRequire('levelup');
const original = LevelUP.prototype.createReadStream;
let valueReads = 0, keyReads = 0, completed = false;
LevelUP.prototype.createReadStream = function (opts) {
  if (opts?.values !== false) valueReads++; else keyReads++;
  return original.call(this, opts);
};
require('node:net').Server.prototype.listen = function () { return this; };
const log = console.log;
const finish = () => { log('PROBE ' + JSON.stringify({ valueReads, keyReads, completed })); process.exit(0); };
const timer = setTimeout(finish, 10000);
console.log = (...args) => {
  log(...args);
  if (String(args[0]).startsWith('stored inventory complete:')) {
    completed = true; clearTimeout(timer); setImmediate(finish);
  }
};
`)
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--require', preload, '--import', 'tsx', 'packages/server/src/index.ts'], {
        cwd: process.cwd(), timeout: 15_000,
        env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: 'fake',
          YPERSISTENCE: dir, DATABASE_URL: '', PORT: '4401' },
      })
    const probe = JSON.parse(stdout.split('\n').find(line => line.startsWith('PROBE '))!.slice(6))
    expect(probe.keyReads).toBeGreaterThan(0)
    expect(probe.valueReads).toBe(0)
    expect(probe.completed).toBe(true)
    expect(stdout).not.toContain('stored inventory:') // no small document is flagged
    expect(stdout).not.toContain('stored inventory failed:')
  } finally { await provider.destroy(); await fs.rm(dir, { recursive: true, force: true }) }
})
