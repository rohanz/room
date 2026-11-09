/** Foreground subprocess fixture; only the test runner owns/kills this exact pid. */
import fs from 'node:fs'
import { startLocalDaemon } from '../src/daemon.js'
let now = 0, full = false
const rename = fs.renameSync
fs.renameSync = ((from, to) => {
  if (full && String(to).endsWith('.ydoc')) throw Object.assign(new Error('ENOSPC fixture disk full'), { code: 'ENOSPC' })
  const result = rename(from, to)
  if (String(to).endsWith('relay.json')) process.send?.({ published: true })
  return result
}) as typeof fs.renameSync
const [commonDir, room, idle = '300000', clock = 'fake', barrier] = process.argv.slice(2)
if (barrier) { process.send?.({ waiting: true }); while (!fs.existsSync(barrier)) await new Promise(resolve => setTimeout(resolve, 5)) }
const daemon = await startLocalDaemon({ commonDir, room, idleMs: Number(idle), idleCheckMs: 10, ...(clock === 'fake' ? { now: () => now } : {}), finalSaveRetryMs: [5, 10], retryMs: 20 })
if (!daemon) { process.send?.({ loser: true }); process.disconnect?.() }
else {
  process.on('message', async (value: { command: string; now?: number; full?: boolean }) => {
    if (value.command === 'clock') now = value.now!
    if (value.command === 'shed') daemon.relay.hubRoom(room)!.doc.bus.push([{ id: 'large', type: 'note', text: 'x'.repeat(6 * 1024 * 1024) } as never])
    if (value.command === 'full') full = value.full!
    if (value.command === 'save') {
      try { await daemon.close(); process.send?.({ saved: true }) }
      catch (error) { process.send?.({ failed: String(error) }) }
    }
    if (value.command === 'flush') daemon.relay.hubRoom(room)?.doc.doc.getMap('meta').set('flush', Date.now())
    process.send?.({ ack: value.command })
  })
  process.send?.({ ready: daemon.info })
  await daemon.closed
  process.disconnect?.()
}
