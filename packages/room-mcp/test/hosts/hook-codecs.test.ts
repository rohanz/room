import { nativeExecutableName } from '../../src/hosts/claude-hook-codec.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { claudeHookCodec } from '../../src/hosts/claude-hook-codec.js'
import { codexHookCodec, compatibilityHookCodec } from '../../src/hosts/codex-hook-codec.js'
import { hookEnvelopes, toolEnvelopes } from './fixtures.js'
// @ts-expect-error Shipped dependency-free ESM has no TS declaration.
import { hookCodecFor, startupHookCodec } from '../../../../plugins/room/hooks/codecs.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const codecs = { claude: claudeHookCodec, codex: codexHookCodec }

it.each(['claude', 'codex'] as const)('%s standalone hook bundle is fresh and imports only builtins', async host => {
  const entry = `packages/room-mcp/src/hosts/${host}-hook-codec.ts`
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, metafile: true })
  expect(result.outputFiles[0].text).toBe(fs.readFileSync(new URL(`../../../../plugins/room/hooks/${host}-hook-codec.mjs`, import.meta.url), 'utf8'))
  // A new source dependency cannot accidentally pull MCP initialization or a package into hooks.
  expect(Object.keys(result.metafile!.inputs).every(file => file.startsWith('packages/room-mcp/src/hosts/'))).toBe(true)
  for (const output of Object.values(result.metafile!.outputs)) for (const imported of output.imports) {
    expect(imported.external && builtinModules.includes(imported.path.replace(/^node:/, ''))).toBe(true)
  }
})

it('host selection hook bundle is fresh and imports only builtins', async () => {
  // Same options as scripts/build-plugin.mjs.
  const result = await build({ absWorkingDir: root, entryPoints: ['packages/room-mcp/src/hosts/session-host.ts'], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true })
  expect(result.outputFiles[0].text).toBe(fs.readFileSync(new URL('../../../../plugins/room/hooks/session-host.mjs', import.meta.url), 'utf8'))
  expect(Object.keys(result.metafile!.inputs).every(file => file.startsWith('packages/room-mcp/src/hosts/'))).toBe(true)
  for (const output of Object.values(result.metafile!.outputs)) for (const imported of output.imports) {
    expect(imported.external && builtinModules.includes(imported.path.replace(/^node:/, ''))).toBe(true)
  }
})

it('keeps Codex hooks.json byte-identical, including its frozen executable paths and matchers', () => {
  const bytes = fs.readFileSync(new URL('../../../../plugins/room/hooks.json', import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('336c0b90c935ff627f9988ceb92e21c887b44c9b6e904b2c2ddd9a188db4b777')
})

it.each(hookEnvelopes)('$host shipped startup decoding matches source and retains accepted fields', fixture => {
  const selection = startupHookCodec(fixture.argv)
  expect(selection.host).toBe(fixture.host)
  const decoded = codecs[fixture.host].decode('start', fixture.raw, fixture.argv)
  expect(selection.codec.decode('start', fixture.raw, fixture.argv)).toEqual(decoded)
  expect(decoded).toMatchObject({ sessionId: fixture.raw.session_id, cwd: fixture.raw.cwd, source: 'startup', runtime: { model: 'fixture-model' } })
  expect(decoded.transcriptPath).toBe(fixture.host === 'claude' ? hookEnvelopes[0].raw.transcript_path : undefined)
})

it.each(toolEnvelopes)('$host $raw.tool_name keeps the native discriminator, payload and shell dialect', fixture => {
  const decoded = codecs[fixture.host].decode('before-tool', fixture.raw, [])
  expect(hookCodecFor(fixture.host).decode('before-tool', fixture.raw, [])).toEqual(decoded)
  expect(decoded.tool).toMatchObject({ originalName: fixture.raw.tool_name, input: fixture.raw.tool_input })
  expect(decoded.tool!.input).toBe(fixture.raw.tool_input)
  expect(decoded.tool!.shellDialect).toBe(fixture.dialect)
})

it.each(Object.keys(codecs) as (keyof typeof codecs)[])('%s retains startup-only id aliases and conservative incomplete identity', host => {
  const codec = hookCodecFor(host)
  for (const alias of ['thread_id', 'sessionId']) {
    expect(codec.decode('start', { [alias]: 'id' }, []).sessionId).toBe('id')
    expect(codec.decode('before-tool', { [alias]: 'id' }, []).sessionId).toBeUndefined()
  }
  expect(codec.decode('start', { session_id: '', thread_id: 'id' }, []).sessionId).toBe('')
  expect(codec.decode('start', { session_id: 42, thread_id: 'id' }, []).sessionId).toBeUndefined()
  expect(codec.decode('before-tool', {}, [], true)).toMatchObject({ incomplete: true, subagent: true })
  expect(codec.decode('before-tool', { agent_id: 'subagent' }, []).subagent).toBe(true)
  expect(codec.decode('before-tool', { agent_id: '' }, []).subagent).toBe(false)
  for (const [event, native] of [['start', 'SessionStart'], ['before-tool', 'PreToolUse']]) {
    expect(JSON.stringify(codec.context(event, 'text'))).toBe(`{"hookSpecificOutput":{"hookEventName":"${native}","additionalContext":"text"}}`)
  }
})

it('preserves unknown explicit hosts and no-record runtime interpretation', () => {
  expect(startupHookCodec(['--host']).host).toBe('codex')
  const custom = startupHookCodec(['--host', 'custom'])
  expect(custom.host).toBe('custom')
  const compatibility = compatibilityHookCodec()
  const event = compatibility.decode('before-tool', { model: 'ignored', transcript_path: '/ignored', effort: { level: ' high ' } }, [])
  expect(event.transcriptPath).toBeUndefined()
  expect(compatibility.reduceRuntime(event, { sessionRecord: null, previousRuntime: { model: 'kept', extra: 1 } })).toEqual({ model: 'kept', extra: 1, effort: 'high' })
})

it.each(['source', 'shipped'])('%s transcript reducer preserves lag, cache, partial lines and unbounded legacy model strings', source => {
  const codec = source === 'source' ? claudeHookCodec : hookCodecFor('claude')
  const event = codec.decode('before-tool', { model: 'ignored', effort: { level: 'high' } }, [])
  const transcript = { path: '/transcript', mtimeMs: 12, size: 34, startsMidFile: true,
    tail: JSON.stringify({ message: { model: 'partial' } }) + '\n' + JSON.stringify({ message: { model: ' switched-model ' } }) + '\n' + JSON.stringify({ message: { model: '<synthetic>' } }) + '\n{partial' }
  const evidence = { sessionRecord: { model: 'startup-model' }, previousRuntime: { extra: 1 }, transcript }
  expect(codec.reduceRuntime(event, evidence)).toEqual({ extra: 1, effort: 'high', transcript: { path: '/transcript', mtimeMs: 12, size: 34 } })
  const cached = { ...evidence, previousRuntime: { transcript: { path: '/old' } } }
  expect(codec.reduceRuntime(event, cached).model).toBe('switched-model')
  expect(codec.reduceRuntime(event, { ...cached, transcript: undefined })).toEqual({ transcript: { path: '/old' }, effort: 'high' })
  expect(codec.reduceRuntime(event, { ...cached, transcript: { ...transcript, tail: JSON.stringify({ message: { model: 'x'.repeat(100) } }), startsMidFile: false } }).model).toBe('x'.repeat(100))
  expect(evidence.previousRuntime).toEqual({ extra: 1 })
  expect(transcript.tail).toContain('switched-model')
})

it('recognizes native versioned executable paths without guessing other hosts', () => {
  expect(nativeExecutableName('/home/user/.local/share/claude/versions/2.1.286')).toBe('claude')
  expect(nativeExecutableName('/usr/bin/node')).toBeUndefined()
  expect(nativeExecutableName()).toBeUndefined()
})
