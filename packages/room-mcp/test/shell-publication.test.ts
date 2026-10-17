import { expect, it, onTestFinished, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc } from '@room/shared'
import { startRoomd, policyFromLevel, type Roomd } from '@room/roomd'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

// Exercise actual shell writes and the filesystem watcher. Only transport is in-memory;
// no hook, touch(), forced reconcile, or direct-disk worker shortcut publishes these edits.
for (const mode of ['native', 'polling']) it.skipIf(process.platform === 'win32')(`publishes shell-created and renamed files to a peer reader (${mode} watch)`, async ({ task }) => {
  vi.stubEnv('CHOKIDAR_USEPOLLING', mode === 'polling' ? '1' : '0')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-shell-publication-'))
  let daemon: Roomd | undefined, tools: ReturnType<typeof createTools> | undefined
  const readerDoc = new Y.Doc(), readerRoom = new RoomDoc(readerDoc), awareness = new Awareness(readerDoc)
  let relay: ((update: Uint8Array) => void) | undefined
  onTestFinished(async () => {
    await tools?.shutdown()
    if (relay) daemon?.roomDoc.doc.off('update', relay)
    await daemon?.stop()
    awareness.destroy(); readerDoc.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  fs.mkdirSync(path.join(dir, 'src/commands/includes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/commands/includes/base.lua'), 'return 1\n')
  fs.writeFileSync(path.join(dir, 'backend.ts'), Array.from({ length: 3_100 }, (_, i) => `// backend ${i}\n`).join(''))
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const logs: string[] = []
  Object.assign(task.meta, { logs })
  daemon = await startRoomd({ dir, name: 'Owner', kind: 'agent', sessionId: '1', room: 'ws://memory/local/shell', localKey: 'test', policy: policyFromLevel('full'),
    basePollMs: 0, trackedRefreshMs: 60_000, reconcileIntervalMs: 60_000, log: line => { logs.push(line) },
    providerFactory: (_server, _name, doc) => {
      const a = new Awareness(doc)
      return { synced: true, awareness: a, on() {}, off() {}, destroy() { a.destroy() } } as unknown as WebsocketProvider
    },
  })
  Object.assign(task.meta, { initialHead: daemon.roomDoc.manifestHead.get('Owner') })
  expect(daemon.roomDoc.manifestHead.get('Owner')?.complete).toBe(true)
  daemon.roomDoc.participants.set('Owner\0holder', { sessionId: 'owner', epoch: 1 })
  Y.applyUpdate(readerDoc, Y.encodeStateAsUpdate(daemon.roomDoc.doc))
  relay = update => Y.applyUpdate(readerDoc, update)
  daemon.roomDoc.doc.on('update', relay)
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(daemon.provider.awareness, [daemon.roomDoc.doc.clientID]), 'test')
  awareness.setLocalState({ user: { name: 'Reader', kind: 'agent' }, status: 'idle' })
  readerRoom.participants.set('Reader\0git', { base, head: base, fence: '1', rev: 1 })
  const session = { room: readerRoom, awareness, provider: { synced: true, awareness }, me: { name: 'Reader', kind: 'agent' }, dir,
    daemon: { touch() {}, async stop() {} }, policyStore: testPolicyStore('full'), roomName: 'shell', roomUrl: 'ws://memory/shell', browserUrl: 'http://memory',
    ...hubSeam(readerRoom) } as unknown as Session
  tools = createTools({ cwd: dir, getSession: () => session, setSession: () => {} })
  const paths = ['src/commands/includes/moveJobToCancelled.lua', 'src/new/nested/deadline.lua', 'src/commands/includes/renamed.lua', 'backend.ts']
  const started = performance.now()
  execFileSync('sh', ['-c', `
cat > src/commands/includes/moveJobToCancelled.lua <<'LUA'
return 'shell-created cancellation'
LUA
mkdir -p src/new/nested
cat > src/new/nested/deadline.lua <<'LUA'
return 'shell-created deadline'
LUA
printf "return 'shell-created rename'\\n" > src/commands/includes/staged.tmp
mv src/commands/includes/staged.tmp src/commands/includes/renamed.lua
printf '// shell-created backend edit\\n' >> backend.ts
`], { cwd: dir })
  const publishedMs: Record<string, number> = {}
  const lastRead: Record<string, string> = {}
  Object.assign(task.meta, { publishedMs, lastRead, watcher: mode })
  await expect.poll(async () => {
    for (const p of paths) {
      if (publishedMs[p] !== undefined) continue
      const read = await tools!.call('room_read', { person: 'Owner', path: p, diff: true })
      lastRead[p] = read
      Object.assign(task.meta, { ownerHead: daemon!.roomDoc.manifestHead.get('Owner'), readerHead: readerRoom.manifestHead.get('Owner') })
      if (read.includes('+') && read.includes('shell-created')) publishedMs[p] = performance.now() - started
    }
    return Object.keys(publishedMs).length
  }, { timeout: 5_000, interval: 50 }).toBe(paths.length)
  Object.assign(task.meta, { publishedMs, watcher: mode })
  for (const p of paths) expect(await tools.call('room_read', { person: 'Owner', path: p })).toContain('shell-created')
})
