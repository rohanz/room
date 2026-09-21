import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs, { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeTranscriptModelRefresh, resolveSessionRuntime, sessionMetadataPath, resolveConfig, DEFAULT_SERVER, LOCAL } from '../src/config.js'
import { writeChoice } from '../src/choice.js'

const repo = () => { const dir = mkdtempSync(join(tmpdir(), 'room-config-')); execFileSync('git', ['-C', dir, 'init', '-q']); return dir }

describe('resolveConfig', () => {
  it('uses documented argument > environment > remembered > default precedence', async () => {
    const dir = repo()
    expect((await resolveConfig({ dir, env: {} })).server).toBe(LOCAL)
    await writeChoice(dir, 'team')
    expect((await resolveConfig({ dir, env: {} })).server).toBe(DEFAULT_SERVER)
    expect((await resolveConfig({ dir, env: { ROOM_SERVER: 'ws://env' } })).server).toBe('ws://env')
    const c = await resolveConfig({ dir, env: { ROOM_SERVER: 'ws://env', ROOM_SHARE: 'declared', ROOM_MAX_WORKERS: '3' }, args: { where: 'local', share: 'intent', maxWorkers: 2 } })
    expect(c).toMatchObject({ server: LOCAL, whereRule: 'argument', share: 'intent', maxWorkers: 2 })
  })

  it('treats runner URLs as explicit environment destinations', async () => {
    const dir = repo(), url = 'ws://runner/room'
    expect((await resolveConfig({ dir, env: { ROOM_URL: url } })).roomUrl).toBe(url)
    expect((await resolveConfig({ dir, env: { ROOM_URL: url, ROOM_SERVER: 'local' } })).roomUrl).toBeUndefined()
    expect((await resolveConfig({ dir, env: { ROOM_URL: url }, args: { where: 'local' } })).roomUrl).toBeUndefined()
    await writeChoice(dir, 'team')
    expect(await resolveConfig({ dir, env: { ROOM_URL: url } })).toMatchObject({ server: 'ws://runner', room: 'room', whereRule: 'env', whereEnv: 'ROOM_URL' })
    expect((await resolveConfig({ dir, env: { ROOM_URL: url }, args: { roomUrl: 'ws://argument/room' } })).roomUrl).toBe('ws://argument/room')
  })

  it('resolves Claude channels, preserving empty overrides', async () => {
    const dir = repo()
    expect((await resolveConfig({ dir, env: {} })).claudeChannel).toBe('plugin:room@room')
    expect((await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: ' plugin:custom@market ' } })).claudeChannel).toBe('plugin:custom@market')
    expect((await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: '' } })).claudeChannel).toBe('')
    expect((await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: 'custom' }, args: { claudeChannel: '' } })).claudeChannel).toBe('')
  })

  it('resolves worker identity and generation from the environment', async () => {
    const config = await resolveConfig({ dir: repo(), env: { ROOM_WORKER_ID: ' spawn-id ', ROOM_GEN: ' 2 ' } })
    expect(config).toMatchObject({ workerId: 'spawn-id', gen: '2' })
  })

  it('resolves identity, paths, secrets and numeric defaults without mutating env', async () => {
    const dir = repo()
    const env = { ROOM_NAME: 'env-name', ROOM_OWNER: 'env-owner', ROOM_TAG: 'env-tag', ROOM_KIND: 'bot', ROOM_TOKEN: 'env-token', ROOM_LOG_FILE: '/env/log', ROOM_CREDENTIALS: '/env/creds', ROOM_STALE_DAYS: '11' }
    const c = await resolveConfig({ dir, env, args: { name: 'arg-name', tag: 'arg-tag', kind: 'ci', token: 'arg-token', logFile: '/arg/log', credentialsPath: '/arg/creds', staleDays: 4 } })
    expect(c).toMatchObject({ name: 'arg-name', owner: 'env-owner', tag: 'arg-tag', kind: 'ci', token: 'arg-token', logFile: '/arg/log', credentialsPath: '/arg/creds', staleDays: 4, maxWorkers: 8 })
    expect(env.ROOM_TOKEN).toBe('env-token')
  })
})

it('reads only hook and explicit worker runtime metadata, and clears absent values', () => {
  const dir = repo()
  const env = { CLAUDE_MODEL: 'wrong', CLAUDE_EFFORT: 'high', CODEX_MODEL: 'wrong', CODEX_EFFORT: 'high' }
  expect(resolveSessionRuntime(dir, env)).toEqual({ model: undefined, effort: undefined })
  const worker = { ...env, ROOM_WORKER_MODEL: ' gpt-6-astra ', ROOM_WORKER_EFFORT: ' medium ' }
  expect(resolveSessionRuntime(dir, worker)).toEqual({ model: 'gpt-6-astra', effort: 'medium' })
  fs.writeFileSync(sessionMetadataPath(dir), JSON.stringify({ model: ' actual ', effort: 'wrong' }))
  expect(resolveSessionRuntime(dir, worker)).toEqual({ model: 'actual', effort: 'medium' })
  fs.writeFileSync(sessionMetadataPath(dir), JSON.stringify({ model: 42 }))
  expect(resolveSessionRuntime(dir, env)).toEqual({ model: undefined, effort: undefined })
})

it('resolves hook metadata from the worktree gitdir, not the main clone', () => {
  const main = repo(), worktree = fs.mkdtempSync(join(tmpdir(), 'room-model-worktree-'))
  const gitdir = join(main, '.git', 'worktrees', 'worker')
  fs.mkdirSync(gitdir, { recursive: true })
  fs.writeFileSync(join(worktree, '.git'), 'gitdir: ' + gitdir + '\n')
  fs.writeFileSync(sessionMetadataPath(main), JSON.stringify({ model: 'main-model' }))
  fs.writeFileSync(join(gitdir, 'room-session.json'), JSON.stringify({ model: 'worker-model' }))
  expect(resolveSessionRuntime(worktree, {})).toEqual({ model: 'worker-model', effort: undefined })
  fs.rmSync(main, { recursive: true, force: true })
  fs.rmSync(worktree, { recursive: true, force: true })
})

const modelLine = (model: unknown) => JSON.stringify({ type: 'assistant', message: { model } }) + '\n'

it('reads changed Claude transcript tails once, skips placeholders, and picks up model switches', () => {
  const dir = repo(), transcript = join(dir, 'transcript.jsonl'), file = sessionMetadataPath(dir)
  fs.writeFileSync(file, JSON.stringify({ host: 'claude', transcript_path: transcript }))
  fs.writeFileSync(transcript, modelLine('claude-old') + modelLine('<synthetic>') + modelLine(42) + '{partial')
  const io = { ...fs, statSync: vi.fn(fs.statSync), openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync) }
  const refresh = createClaudeTranscriptModelRefresh(io)
  expect(refresh(dir)).toBe('claude-old')
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).model).toBe('claude-old')
  expect(io.openSync).toHaveBeenCalledTimes(1)
  expect(io.readSync.mock.calls[0][3]).toBeLessThanOrEqual(64 * 1024)
  expect(refresh(dir)).toBe('claude-old')
  expect(io.openSync).toHaveBeenCalledTimes(1)
  fs.appendFileSync(transcript, '\n' + modelLine('claude-new'))
  expect(refresh(dir)).toBe('claude-new')
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).model).toBe('claude-new')
  expect(io.openSync).toHaveBeenCalledTimes(2)
  fs.rmSync(dir, { recursive: true, force: true })
})

it('silently ignores missing or unreadable transcripts and never opens one for Codex', () => {
  const dir = repo(), transcript = join(dir, 'transcript.jsonl'), file = sessionMetadataPath(dir)
  const openSync = vi.fn(fs.openSync)
  const refresh = createClaudeTranscriptModelRefresh({ ...fs, openSync })
  fs.writeFileSync(file, JSON.stringify({ host: 'claude', transcript_path: transcript }))
  expect(refresh(dir)).toBeUndefined()
  fs.writeFileSync(transcript, modelLine('claude-wrong'))
  fs.writeFileSync(file, JSON.stringify({ host: 'codex', transcript_path: transcript }))
  expect(refresh(dir)).toBeUndefined()
  expect(openSync).not.toHaveBeenCalled()
  fs.writeFileSync(file, JSON.stringify({ host: 'claude', transcript_path: transcript }))
  const unreadable = createClaudeTranscriptModelRefresh({ ...fs, openSync: (() => { throw new Error('denied') }) as typeof fs.openSync })
  expect(unreadable(dir)).toBeUndefined()
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).model).toBeUndefined()
  fs.rmSync(dir, { recursive: true, force: true })
})

it.each(['decalred', '', 'ful'])('never widens invalid sharing %j from arguments or environment', async raw => {
  const dir = repo()
  expect(await resolveConfig({ dir, env: { ROOM_SHARE: raw } })).toMatchObject({ share: 'intent', shareWarning: `ROOM_SHARE='${raw}' is not a level; sharing plans only` })
  expect(await resolveConfig({ dir, env: { ROOM_SHARE: 'full' }, args: { share: raw } })).toMatchObject({ share: 'intent', shareWarning: `share='${raw}' is not a level; sharing plans only` })
})
it.each(['full', 'declared', 'intent'])('accepts level %s through either config source', async share => {
  const dir = repo()
  expect(await resolveConfig({ dir, env: { ROOM_SHARE: share } })).toMatchObject({ share, shareWarning: undefined })
  expect(await resolveConfig({ dir, env: {}, args: { share } })).toMatchObject({ share, shareWarning: undefined })
})
