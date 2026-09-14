import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { ensureLocalRelay, gitCommonDir, localRoomName, portAnswers, readRelayInfo } from '../src/local.js'

const sh = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-local-'))
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.email', 't@t']); sh(dir, ['config', 'user.name', 'Test'])
  await fsp.writeFile(path.join(dir, 'a.txt'), 'a\n')
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(50) } }

describe('local rooms', () => {
  it('names the room after the main worktree so every worktree of a clone shares it', async () => {
    const dir = await makeRepo()
    const wt = path.join(dir, '.room', 'workers', 'x')
    sh(dir, ['worktree', 'add', '-q', '-b', 'room/x', wt, 'HEAD'])
    expect(await localRoomName(dir)).toBe(`local/${path.basename(dir)}/main`)
    expect(await localRoomName(wt)).toBe(`local/${path.basename(dir)}/main`)
    expect(await localRoomName(wt, 'feature')).toBe(`local/${path.basename(dir)}/feature`)
    expect(fs.realpathSync(await gitCommonDir(wt))).toBe(fs.realpathSync(path.join(dir, '.git')))
  })

  it('first joiner starts the relay, later joiners reuse it, and a survivor takes over the same port when the owner leaves', async () => {
    const dir = await makeRepo()
    const common = await gitCommonDir(dir)
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    expect(a.owned).toBe(true)
    expect(readRelayInfo(common)?.port).toBe(a.port)
    const b = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    expect(b.owned).toBe(false)
    expect(b.port).toBe(a.port)
    // Two providers through the relay converge.
    const d1 = new Y.Doc(), d2 = new Y.Doc()
    const p1 = new WebsocketProvider(a.url, 'local%2Fx%2Fmain', d1, { WebSocketPolyfill: WebSocket as never })
    const p2 = new WebsocketProvider(b.url, 'local%2Fx%2Fmain', d2, { WebSocketPolyfill: WebSocket as never })
    await until(() => p1.synced && p2.synced)
    d1.getText('t').insert(0, 'hello')
    await until(() => d2.getText('t').toString() === 'hello')
    // Owner leaves: b notices the dead port and takes it over; providers reconnect and still converge.
    await a.stop()
    await until(() => b.owned, 8000)
    expect(readRelayInfo(common)?.port).toBe(a.port)
    await until(async () => portAnswers(b.port))
    await until(() => p1.wsconnected && p2.wsconnected, 15000)
    d2.getText('t').insert(5, ' world')
    await until(() => d1.getText('t').toString() === 'hello world', 15000)
    p1.destroy(); p2.destroy()
    await b.stop()
    expect(fs.existsSync(path.join(common, 'room-local.json'))).toBe(true)
  })
})
