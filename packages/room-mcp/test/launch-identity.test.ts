// rc12 review round 4: a launch recorded the new worker's start time and its executable from two separate probe
// reads, through the shared cache. One fresh snapshot now gives both, so the registry never stores a mix.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/port-reservations.js', () => ({
  reserveWorkerPort: () => ({ port: 4409, release: () => {} }),
  bindWorkerPortReservation: () => {},
}))
import { launchWorkerProcess } from '../src/worker-launch.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('takes the launched worker\'s start time and executable from one probe read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-identity-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const answers = [{ startTime: 'darwin:1:5', executable: 'codex' }, { startTime: 'darwin:1:6', executable: 'nice' }]
  let reads = 0
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, killForce: () => false }
  const result = await launchWorkerProcess({ session: { dir: root, roomName: 'local/repo' } as Session, id: 'w_launch', tag: 'tests', dir: root,
    lead: 'lead', owner: 'lead', host: 'claude', share: 'intent', run: 1, nonce: 'nonce', registry: root,
    budget: { threads: 1, memGb: 1, nice: 10 }, server: 'local', isWorker: false,
    spawner: () => proc, probe: () => answers[Math.min(reads++, 1)], log: () => {} },
  { mode: 'fresh', task: 'test', links: [] },
  { setHandle: () => {}, watch: () => {}, aborted: () => false }, async () => {}, async () => {}, async () => {})
  expect(result).toMatchObject({ processStartTime: 'darwin:1:5', processExecutable: 'codex' })
  expect(reads).toBe(1)
})
