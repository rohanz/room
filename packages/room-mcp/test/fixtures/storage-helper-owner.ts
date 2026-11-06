/** Child MCP for storage-admission.test.ts: admits a real preview helper through production code, then is killed. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { admitStorageHelper, withAdmission } from '../../src/storage-admission.js'
import { previewProcessGate } from '../../src/tools/files.js'

const [common] = process.argv.slice(2)
// The supervisor shell waits for GO, then runs a long-lived command; detached so it survives this process.
const helper = spawn('sh', ['-c', previewProcessGate, 'sh', process.execPath, '-e', 'process.stdout.write("effect\\n"); setInterval(() => {}, 1000)'],
  { detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
await once(helper, 'spawn')
await withAdmission(common, 'preview', async () => { await admitStorageHelper(helper.pid!) })
const started = once(helper.stdout!, 'data')
helper.stdin!.end('GO\n')
await started
process.send!({ helperPid: helper.pid, mcpPid: process.pid })
setInterval(() => {}, 1000) // killed by the test while the helper keeps running
