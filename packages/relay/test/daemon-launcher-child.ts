import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ensureLocalDaemon } from '../src/daemon.js'
const require = createRequire(import.meta.url)
const relay = await ensureLocalDaemon(process.argv[2], 'local/daemon-lifetime', {
  admitStart: async () => {},
  entryPath: fileURLToPath(new URL('../src/daemon-bin.ts', import.meta.url)),
  execArgv: ['--import', require.resolve('tsx')],
})
process.send?.({ ready: { pid: relay.pid, port: relay.port, key: relay.key } })
process.disconnect?.()
