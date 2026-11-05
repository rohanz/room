import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('refuses a second tool-call thread in one MCP process and keeps serving the first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-codex-pooling-'))
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
    cwd: dir, env: { ...process.env, ROOM_HOST: 'codex', ROOM_DIR: dir, ROOM_URL: 'invalid-url',
      CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), XDG_CONFIG_HOME: join(dir, 'config') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exit = once(child, 'exit')
  let stderr = '', stdout = '', nextId = 0
  const pending = new Map<number, (message: any) => void>()
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk
    const lines = stdout.split('\n')
    stdout = lines.pop()!
    for (const line of lines) {
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timed out: ${stderr}`)) }, 10_000)
    pending.set(id, message => { clearTimeout(timeout); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = (thread: string) => request('tools/call', { name: 'room_state', arguments: { check: true },
    _meta: { 'x-codex-turn-metadata': { thread_id: thread } } })
  try {
    expect(await request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'codex', version: '0.166.0' } }))
      .toMatchObject({ result: { protocolVersion: '2025-11-25' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const first = await call('first-thread')
    expect(first.error).toBeUndefined()
    expect(first.result.content[0].text).toContain('Room config')
    for (let i = 0; i < 2; i++) {
      const second = await call('second-thread')
      expect(second.error?.message).toMatch(/mcp_connection_sharing.*mcp_2026_07_28/)
      expect(second.error?.message).toMatch(/disable.*mcp_connection_sharing.*Room release/)
      expect(second.result).toBeUndefined()
    }
    const again = await call('first-thread')
    expect(again.error).toBeUndefined()
    expect(again.result.content[0].text).toContain('Room config')
    expect(stderr).not.toContain('ignoring Codex thread')
  } finally {
    child.kill('SIGTERM')
    await exit
    rmSync(dir, { recursive: true, force: true })
  }
})
