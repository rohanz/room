import fs from 'node:fs'
import { createExclusive, withGuard } from '../../src/leases.js'

const [mode, file, ready, signal] = process.argv.slice(2)
if (mode === 'create') {
  fs.writeFileSync(ready, '')
  while (!fs.existsSync(signal)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  process.stdout.write(createExclusive(file, { child: process.pid }) ? 'won' : 'lost')
} else if (mode === 'guard') {
  withGuard(file, () => {
    fs.writeFileSync(ready, '')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  })
} else if (mode === 'temp') {
  const link = fs.linkSync
  fs.linkSync = ((temp: string, target: string) => {
    // Renamed into place: the test reads the path as soon as the ready file exists.
    fs.writeFileSync(`${ready}.part`, temp)
    fs.renameSync(`${ready}.part`, ready)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
    return link(temp, target)
  }) as typeof fs.linkSync
  createExclusive(file, { child: process.pid })
}
