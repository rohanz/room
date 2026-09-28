import { expect, it, vi } from 'vitest'

const build = vi.hoisted(() => vi.fn())
vi.mock('../src/tools/combined-tree.js', () => ({ buildCombinedTree: build, supersetSide: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (_file: string, _args: string[], options: { timeout: number }, done: (error: Error | null, stdout: string, stderr: string) => void) => {
      const timedOut = options.timeout < 310_000
      done(timedOut ? Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) : null, timedOut ? '' : 'ok', '')
    },
  }
})

import { handlers } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import { gitWholeTree } from '@room/roomd/git'

it('says which git step timed out and that combined code was not checked', async () => {
  build.mockImplementationOnce(() => gitWholeTree('/repo', ['ls-files', '-z'], 50_000))
  const caller = { dir: '/repo', me: { name: 'lead' }, room: { workers: new Map() } }
  const peer = { dir: '/other', me: { name: 'peer' }, room: { workers: new Map() } }
  const state = {
    S: () => caller,
    rooms: { all: () => [caller, peer], holding: () => peer },
    presences: (s: unknown) => s === peer ? [{ user: { name: 'peer' } }] : [],
    others: () => ['peer'], withheld: () => '',
  } as unknown as HandlerState
  const reply = await handlers(state).room_preview_merge({ people: ['peer'] })
  expect(reply).toContain('git ls-files -z timed out after 300000ms')
  expect(reply).toContain('combined code was NOT checked')
  expect(reply).not.toContain('final combined tree')
})
