#!/usr/bin/env node
/** Self-contained packaged entry. Detached stdio must never retain the launching host's pipes. */
import fs from 'node:fs'
import path from 'node:path'
import { startLocalDaemon, stopLocalDaemon } from './daemon.js'
import { primePrivateState, privateStateDirectory, verifyPrivatePath } from './private-state.js'

const args = process.argv.slice(2)
const value = (flag: string): string => {
  const index = args.indexOf(flag)
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`)
  return args[index + 1]
}
let log: (line: string) => void = () => {}
try {
  const commonDir = fs.realpathSync.native(value('--common-dir'))
  if (!path.isAbsolute(commonDir)) throw new Error('daemon common directory must be absolute')
  if (args[0] === 'stop') {
    await stopLocalDaemon(commonDir)
    process.stdout.write('Daemon saved and process exit verified.\n')
  } else {
  if (args[0] && !args[0].startsWith('--') && args[0] !== 'start') throw new Error('usage: room-daemon.mjs [start|stop] --common-dir <absolute git common directory> [--room <room>]')
  await primePrivateState(commonDir)
  privateStateDirectory(path.join(commonDir, 'room'))
  const file = path.join(commonDir, 'room', 'daemon.log')
  // Validate every retained log before publishing discovery. Do not append through a symlink
  // or run without the native Windows ACL check merely because no warning has been emitted yet.
  let created = false
  try { const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); created = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  verifyPrivatePath(file, created)
  for (const retained of [`${file}.1`, `${file}.2`]) if (fs.existsSync(retained)) verifyPrivatePath(retained)
  log = line => {
    try {
      const record = `${new Date().toISOString()} ${line.slice(0, 2048).replace(/[\r\n]/g, ' ')}\n`
      if (fs.existsSync(file)) verifyPrivatePath(file)
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(record) > 1024 * 1024) {
        if (fs.existsSync(`${file}.1`)) verifyPrivatePath(`${file}.1`)
        if (fs.existsSync(`${file}.2`)) verifyPrivatePath(`${file}.2`)
        fs.rmSync(`${file}.2`, { force: true })
        if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`)
        fs.renameSync(file, `${file}.1`)
      }
      const created = !fs.existsSync(file)
      fs.appendFileSync(file, record, { mode: 0o600 })
      verifyPrivatePath(file, created)
    } catch { /* no recursive logging on full disk */ }
  }
  log(`startup pid ${process.pid}: state verified`)
  const daemon = await startLocalDaemon({ commonDir, room: value('--room'), log })
  if (daemon) await daemon.closed
  }
} catch (error) {
  const cause = error instanceof Error ? error.message : String(error)
  log(`daemon failed: ${cause}`)
  process.stderr.write(`Room daemon: ${cause}\n`)
  // A failure before daemon.log exists (or before its privacy is verified) is otherwise invisible to the
  // launcher. It passes a fresh path in its own private temp directory; write once, then exit.
  const report = args.indexOf('--startup-report')
  if (report >= 0 && args[report + 1]) {
    try { fs.writeFileSync(args[report + 1], cause.slice(0, 2048), { flag: 'wx', mode: 0o600 }) } catch { /* the launcher still reports the exit */ }
  }
  process.exitCode = 1
}
