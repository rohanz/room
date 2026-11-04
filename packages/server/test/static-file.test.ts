/** Static files: a file that disappears or cannot be read after the route checked it must end that
 *  response and log once, never raise an unhandled stream error that would stop the process. */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendFile } from '../src/http.js'

const dirs: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise(resolve => s.close(resolve))
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function serve(file: string, lines: string[]): Promise<string> {
  const server = http.createServer((_req, res) => { void sendFile(res, file, { 'content-type': 'text/plain' }, line => lines.push(line)) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`
}
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'room-static-')); dirs.push(d); return d }

describe('sendFile', () => {
  it('streams a readable file with the given headers', async () => {
    const file = path.join(tmp(), 'a.txt'); fs.writeFileSync(file, 'hello')
    const res = await fetch(await serve(file, []))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(await res.text()).toBe('hello')
  })

  it('answers 404 when the file was deleted after the route checked it', async () => {
    const file = path.join(tmp(), 'gone.txt'), lines: string[] = []
    const res = await fetch(await serve(file, lines))
    expect(res.status).toBe(404)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^static file failed: ENOENT/)
  })

  it('ends the response when reading fails after it opened, logging one bounded line', async () => {
    // A directory opens on POSIX and then fails its first read with EISDIR.
    const dir = path.join(tmp(), 'x'.repeat(200)); fs.mkdirSync(dir)
    const lines: string[] = []
    const url = await serve(dir, lines)
    // Headers were sent, so the body is cut rather than presented as a complete empty file.
    await expect(fetch(url).then(r => r.text())).rejects.toThrow()
    for (let i = 0; i < 50 && !lines.length; i++) await new Promise(r => setTimeout(r, 10))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^static file failed: EISDIR/)
    expect(lines[0]!.length).toBeLessThanOrEqual(300)
  })
})
