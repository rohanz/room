import fs from 'node:fs'
import { LeveldbPersistence } from 'y-leveldb'
import { migrateRepo, type MigrationIO } from '../../src/migrate.js'
import * as stored from '../../src/stored.js'
import type { OpenRepo } from '../../src/store.js'

const [dir, result] = process.argv.slice(2)
const repo = 'github.com/o/r'
const entry: OpenRepo = JSON.parse(fs.readFileSync(`${dir}/rooms.json`, 'utf8'))[repo]
const provider = new LeveldbPersistence(dir), db = await stored.levelDbOf(provider)
const cleared: string[] = [], loaded: string[] = []
try {
  const io: MigrationIO = {
    list: () => provider.getAllDocNames(),
    stored: (name, limit) => stored.levelStoredSize(db, name, limit),
    copyRaw: (from, to) => stored.levelCopyRaw(db, from, to),
    load: name => { loaded.push(name); return provider.getYDoc(name) },
    write: (name, update) => provider.storeUpdate(name, update),
    clear: async name => { cleared.push(name); await provider.clearDocument(name) },
    freeze: async () => {}, revoke: async () => {}, save: async () => {},
  }
  await migrateRepo(repo, entry, io)
  fs.writeFileSync(result, JSON.stringify({ entry, cleared, loaded, names: await provider.getAllDocNames() }))
} finally { await provider.destroy() }
