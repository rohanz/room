// A server process's load path over LevelDB (as index.ts wires it), whose compaction stops inside its write
// window: the parent kills it there. Arguments: <YPERSISTENCE dir> <room>.
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { ServerHubs, type PersistenceProvider } from '../../src/hub.js'
import { isLevelProvider, levelLoad, levelReplace } from '../../src/stored.js'

const [dir, room] = process.argv.slice(2) as [string, string]
const level = new LeveldbPersistence(dir) as unknown as PersistenceProvider
if (!isLevelProvider(level)) throw new Error('not a LevelDB provider')
level.replace = (name, snapshot) => levelReplace(level, name, snapshot)
level.getYDoc = name => levelLoad(level, name)
const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: line => console.log(line), full: () => false,
  compaction: { minDeleted: 150, generation: () => 'never-stored', beforeReplace: () => { console.log('inside the compaction window'); setInterval(() => {}, 1000); return new Promise<void>(() => {}) } } })
await hubs.persistence(level).bindState(room, new Y.Doc())
