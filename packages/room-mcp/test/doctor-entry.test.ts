import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const sessionEntry = fileURLToPath(new URL('../src/session.ts', import.meta.url))
const tsx = import.meta.resolve('tsx')

async function callDoctor(roomUrl?: string, failRuntime = false, threadId?: string): Promise<{ reply: any; stderr: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'room-doctor-entry-'))
  const repo = path.join(root, 'checkout')
  const bin = path.join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'README'), 'fixture\n')
  execFileSync('git', ['-C', repo, 'add', 'README'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial'])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/room-doctor-fixture.git'])
  for (const name of ['claude', 'codex']) writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const preload = path.join(root, 'probe.mjs')
  writeFileSync(preload, `import net from 'node:net'
import { boundSession } from ${JSON.stringify(sessionEntry)}
net.createServer = () => { process.stderr.write('PROBE_BOUND ' + JSON.stringify(boundSession({ commonDir: ${JSON.stringify(path.join(repo, '.git'))}, host: 'codex', appServer: true, env: {} })) + '\\n'); process.stderr.write('PROBE_LISTEN\\n'); throw new Error('listener started') }
globalThis.fetch = async url => { process.stderr.write('PROBE_FETCH ' + url + '\\n'); return new Response('{\"ok\":true,\"schema\":2,\"hub\":1}', { status: 200 }) }
`)
  // The wrapper names the parent like Codex's shared app-server, so startup stays deferred.
  const wrapper = path.join(root, 'fixture-app-server.mjs')
  writeFileSync(wrapper, `import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['--import', ${JSON.stringify(tsx)}, '--import', ${JSON.stringify(preload)}, ${JSON.stringify(entry)}], { cwd: ${JSON.stringify(repo)}, env: process.env })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', code => process.exit(code ?? 0))
`)
  const env = { ...process.env, ROOM_HOST: 'codex', ROOM_SERVER: 'wss://fixture.invalid',
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    XDG_CONFIG_HOME: path.join(root, 'config'), PATH: `${bin}:${process.env.PATH ?? ''}` }
  for (const key of Object.keys(env)) if (key.startsWith('ROOM_') && key !== 'ROOM_HOST' && key !== 'ROOM_SERVER') delete env[key]
  if (roomUrl !== undefined) env.ROOM_URL = roomUrl
  const child = spawn(process.execPath, [wrapper], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  let stdout = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const reply = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP doctor timed out: ${stderr}`)), 15_000)
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
      for (const line of stdout.split('\n').slice(0, -1)) {
        try {
          const message = JSON.parse(line)
          if (message.id === (failRuntime ? 3 : 2)) { clearTimeout(timeout); resolve(message) }
        } catch { /* incomplete or unrelated MCP line */ }
      }
      stdout = stdout.slice(stdout.lastIndexOf('\n') + 1)
    })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`MCP exited ${code}: ${stderr}`)) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doctor-test', version: '1' },
    } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    if (failRuntime) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'room_state', arguments: {}, _meta: { 'x-codex-turn-metadata': { workspaces: { [repo]: {} }, ...(threadId ? { thread_id: threadId } : {}) } },
    } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: failRuntime ? 3 : 2, method: 'tools/call', params: {
      name: 'room_state', arguments: { check: true }, _meta: { 'x-codex-turn-metadata': { workspaces: { [repo]: {} }, ...(threadId ? { thread_id: threadId } : {}) } },
    } }) + '\n')
  }).finally(() => child.kill('SIGTERM'))
  return { reply, stderr }
}

describe('MCP entry doctor route', () => {
  it('answers the first call without starting arbitration or fetching admission config', async () => {
    const { reply, stderr } = await callDoctor()
    expect(reply.result.content[0].text).toContain('team server: schema 2, hub 1; storage healthy')
    expect(stderr).not.toContain('PROBE_LISTEN')
    expect(stderr.match(/PROBE_FETCH [^\n]+/g)).toEqual(['PROBE_FETCH https://fixture.invalid/health'])
  })

  it('reports invalid legacy ROOM_URL instead of failing runtime initialization', async () => {
    const { reply, stderr } = await callDoctor('not-a-websocket-url')
    expect(reply.result.content[0].text).toMatch(/FAIL  Room config: Invalid URL/)
    expect(stderr).not.toContain('PROBE_LISTEN')
  })

  it('admits a tool call thread before deferred runtime initialization', async () => {
    const id = '01a119cb-010e-7883-a11e-04bf44b77f04'
    const { stderr } = await callDoctor(undefined, true, id)
    expect(stderr).toContain(`PROBE_BOUND ${JSON.stringify({ id, host: 'codex' })}`)
  })

  it('still answers after runtime initialization fails at the arbitration listener', async () => {
    const { reply, stderr } = await callDoctor(undefined, true)
    expect(stderr).toContain('PROBE_LISTEN')
    expect(reply.result.content[0].text).toContain('team server: schema 2, hub 1; storage healthy')
    expect(stderr.match(/PROBE_FETCH [^\n]+/g)).toEqual(['PROBE_FETCH https://fixture.invalid/health'])
  })
})
