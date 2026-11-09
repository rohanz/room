import { workerInput } from './fixtures/worker-input.js'
import { expect, it } from 'vitest'
import { workerAdapter } from '../src/hosts/index.js'
import { leadClaudePluginDir } from '../src/hosts/claude-install.js'
import { defs as sendDefs } from '../src/tools/messaging.js'
import { defs as workerDefs } from '../src/tools/workers.js'

it('passes a lead development plugin to Claude workers and disables installed Room', async () => {
  const args = (await workerAdapter('claude').plan(workerInput({
    pluginDir: '/tmp/room-plugin',
  }))).args
  expect(args).toContain('--plugin-dir')
  expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/tmp/room-plugin')
  expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ enabledPlugins: { 'room@room': false } })
  expect((await workerAdapter('claude').plan(workerInput({
  }))).args).not.toContain('--plugin-dir')
  expect(leadClaudePluginDir({}, '/tmp/dev/plugins/room/server/room-mcp.mjs')).toBe('/tmp/dev/plugins/room')
  expect(leadClaudePluginDir({}, '/home/user/.claude/plugins/cache/room/room/0.17.0/server/room-mcp.mjs', '/home/user/.claude/plugins/cache/room/room/0.17.0')).toBeUndefined()
  expect(leadClaudePluginDir({}, '/home/user/.claude/plugins/cache/room/room/0.17.0/server/room-mcp.mjs', '/home/user/.claude/plugins/cache/room/room/0.16.40')).toBe('/home/user/.claude/plugins/cache/room/room/0.17.0')
})

it('advertises that messaging a finished worker resumes its worktree session', () => {
  for (const description of [sendDefs[0].description, workerDefs.find(d => d.name === 'room_spawn')!.description]) {
    expect(description).toMatch(/message (?:a )?finished workers? to resume(?: it| them)? in (?:its|their) worktrees?/i)
  }
})
