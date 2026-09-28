/**
 * A contender for a clone's relay authority, in its own process (relay/test/hub.test.ts): it waits for
 * the barrier file, joins or starts the relay, then reports `{pid, owned, port, key}` on stdout every 100 ms.
 * Usage: tsx authority-child.ts <commonDir> <room> <barrier>
 */
import fs from 'node:fs'
import { ensureLocalRelay } from '../src/index.js'

const [commonDir, room, barrier] = process.argv.slice(2)
while (!fs.existsSync(barrier)) await new Promise(r => setTimeout(r, 5))
const relay = await ensureLocalRelay(commonDir, room, { watchMs: 100, log: () => {} })
const report = () => process.stdout.write(JSON.stringify({ pid: process.pid, owned: relay.owned, port: relay.port, key: relay.key }) + '\n')
report()
setInterval(report, 100)
