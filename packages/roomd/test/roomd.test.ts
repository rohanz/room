import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from '@y/websocket-server/utils'
import { startRoomd, RoomdError, type Roomd } from '../src/index.js'
import { applyLocalEdit, positionMapper } from '../src/merge.js'
import * as Y from 'yjs'

// ---- helpers ---------------------------------------------------------------

/** In-process y-websocket server on a random port, exactly like packages/server. */
function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    const wss = new WebSocketServer({ noServer: true })
    wss.on('connection', (conn, req) => setupWSConnection(conn, req, { gc: true }))
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => server.close(() => r())) }),
      })
    })
  })
}

function sh(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'roomd-'))
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.email', 'test@example.com'])
  sh(dir, ['config', 'user.name', 'Test'])
  for (const [p, c] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, p)), { recursive: true })
    await fsp.writeFile(path.join(dir, p), c)
  }
  sh(dir, ['add', '-A'])
  sh(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

async function cloneRepo(src: string): Promise<string> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'roomd-clone-'))
  const dir = path.join(parent, 'B')
  sh(parent, ['clone', '-q', src, dir])
  sh(dir, ['config', 'user.email', 'test@example.com'])
  sh(dir, ['config', 'user.name', 'Test'])
  return dir
}

async function waitFor(pred: () => boolean, ms = 3000, step = 25): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise(r => setTimeout(r, step))
  }
  if (!pred()) throw new Error(`condition not met within ${ms}ms`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const read = (dir: string, p: string) => fs.readFileSync(path.join(dir, p), 'utf8')
const silent = () => {}

// ---- unit: merge ---------------------------------------------------------------

describe('merge', () => {
  it('maps positions through remote edits', () => {
    const map = positionMapper('abcdef', 'abXXcdf') // insert XX at 2, delete e at 4
    expect(map(0)).toBe(0)
    expect(map(2)).toBe(4) // boundary of a remote insert: local text goes after it
    expect(map(3)).toBe(5)
    expect(map(4)).toBe(6) // 'e' deleted -> collapses to position of 'f'
    expect(map(6)).toBe(7)
  })
  it('applies a local edit on top of a remote edit with minimal ops', () => {
    const doc = new Y.Doc()
    const yt = doc.getText('t')
    const shadow = 'line1\nline2\nline3\n'
    yt.insert(0, shadow)
    yt.delete(0, 5); yt.insert(0, 'A1') // remote edit
    let ops = 0
    yt.observe(e => { ops += e.delta.filter(d => d.insert !== undefined || d.delete !== undefined).length })
    applyLocalEdit(yt, shadow, 'line1\nline2\nB3\n')
    expect(yt.toString()).toBe('A1\nline2\nB3\n')
    expect(ops).toBeLessThanOrEqual(2)
  })
})

// ---- integration -------------------------------------------------------------

describe('roomd', () => {
  let server: Awaited<ReturnType<typeof startServer>>
  let A: string, B: string
  let dA: Roomd, dB: Roomd
  const room = () => `${server.url}/room-${Math.random().toString(36).slice(2, 8)}`
  let roomUrl: string

  beforeAll(async () => {
    server = await startServer()
    A = await makeRepo({ 'README.md': '# hello\n', 'src/app.py': 'line1\nline2\nline3\n' })
    roomUrl = room()
  })
  afterAll(async () => {
    await dA?.stop(); await dB?.stop()
    await server.close()
  })

  it('(1) seeds the room from a fresh clone', async () => {
    dA = await startRoomd({ room: roomUrl, dir: A, name: 'Alice', log: silent })
    expect(dA.roomDoc.paths()).toEqual(['README.md', 'src/app.py'])
    expect(dA.roomDoc.text('src/app.py')).toBe('line1\nline2\nline3\n')
    const meta = dA.roomDoc.meta
    expect(meta.base).toBe(sh(A, ['rev-parse', 'HEAD']))
    expect(meta.branch).toBe('main')
    expect(meta.seededBy).toBe('Alice')
    expect(meta.repo).toBe(path.basename(A))
    expect(fs.existsSync(path.join(A, '.room.json'))).toBe(true)
    expect(dA.provider.awareness.getLocalState()?.status).toBe('synced')
  })

  it('(2) a clone on the same base joins without error', async () => {
    B = await cloneRepo(A)
    dB = await startRoomd({ room: roomUrl, dir: B, name: 'Bob', log: silent })
    expect(dB.roomDoc.paths()).toEqual(['README.md', 'src/app.py'])
    expect(read(B, 'src/app.py')).toBe('line1\nline2\nline3\n')
  })

  it('(3) a write on A lands on B disk within 2s', async () => {
    await fsp.writeFile(path.join(A, 'README.md'), '# hello\nmore\n')
    await waitFor(() => read(B, 'README.md') === '# hello\nmore\n', 2000)
    expect(dB.roomDoc.text('README.md')).toBe('# hello\nmore\n')
  })

  it('(5) no echo: settled state produces no doc updates', async () => {
    await sleep(300)
    let updates = 0
    const count = () => updates++
    dA.roomDoc.doc.on('update', count)
    dB.roomDoc.doc.on('update', count)
    await sleep(1000)
    dA.roomDoc.doc.off('update', count)
    dB.roomDoc.doc.off('update', count)
    expect(updates).toBe(0)
  })

  it('(4) concurrent edits on different lines converge to a merged text', async () => {
    fs.writeFileSync(path.join(A, 'src/app.py'), 'A1\nline2\nline3\n')
    fs.writeFileSync(path.join(B, 'src/app.py'), 'line1\nline2\nB3\n')
    const want = 'A1\nline2\nB3\n'
    await waitFor(() => read(A, 'src/app.py') === want && read(B, 'src/app.py') === want, 4000)
    expect(dA.roomDoc.text('src/app.py')).toBe(want)
    expect(dB.roomDoc.text('src/app.py')).toBe(want)
  })

  it('deletes propagate both ways', async () => {
    await fsp.unlink(path.join(A, 'README.md'))
    await waitFor(() => !fs.existsSync(path.join(B, 'README.md')), 2000)
    expect(dB.roomDoc.hasFile('README.md')).toBe(false)
  })

  it('(6) refuses to join on a different base', async () => {
    const C = await cloneRepo(A)
    await fsp.writeFile(path.join(C, 'extra.txt'), 'x\n')
    sh(C, ['add', '-A']); sh(C, ['commit', '-q', '-m', 'extra'])
    const err = await startRoomd({ room: roomUrl, dir: C, name: 'Carol', log: silent }).then(() => null, e => e)
    expect(err).toBeInstanceOf(RoomdError)
    expect(err.code).toBe(2)
    expect(err.message).toMatch(/room is at [0-9a-f]{7} on main, you are at [0-9a-f]{7}/)
  })

  it('publishes a new local base to the room', async () => {
    // A restarts with a short base poll so the test stays quick.
    await dA.stop()
    dA = await startRoomd({ room: roomUrl, dir: A, name: 'Alice', log: silent, basePollMs: 100 })
    sh(A, ['commit', '-q', '-am', 'edits'])
    const head = sh(A, ['rev-parse', 'HEAD'])
    await waitFor(() => dB.roomDoc.meta.base === head, 2000)
  })
})
