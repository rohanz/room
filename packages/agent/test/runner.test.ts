import { describe, it, expect, beforeEach } from 'vitest'
import { RoomDoc, type QuestionMsg, type NoteMsg, type ChangedMsg } from '@room/shared'
import { Runner } from '../src/runner.js'
import { FakeBackend } from '../src/backend.js'

const tick = () => new Promise(r => setTimeout(r, 0))

function setup() {
  const room = new RoomDoc()
  const statuses: string[] = []
  const awareness = { setLocalStateField: (_f: string, v: unknown) => { statuses.push(String(v)) } }
  const backend = new FakeBackend()
  // pre-existing human message that must be ignored
  room.say('Rohan', { role: 'human', text: 'old message' })
  const runner = new Runner({ name: 'Rohan', room, awareness, backend, preamble: 'PREAMBLE' })
  runner.start()
  return { room, backend, runner, statuses }
}

describe('Runner', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })

  it('forwards human messages with the preamble on the first turn only', async () => {
    s.room.say('Rohan', { role: 'human', text: 'refactor validation' })
    await s.runner.idle()
    s.room.say('Rohan', { role: 'human', text: 'now add tests' })
    await s.runner.idle()
    expect(s.backend.inputs).toHaveLength(2)
    expect(s.backend.inputs[0]).toBe('PREAMBLE\n\n---\n\nrefactor validation')
    expect(s.backend.inputs[1]).toBe('now add tests')
    // our own non-human chat items never trigger a turn
    s.room.say('Rohan', { role: 'agent', text: 'done' })
    await s.runner.idle()
    expect(s.backend.inputs).toHaveLength(2)
  })

  it("does not wake on the agent's own bus messages", async () => {
    s.room.post<ChangedMsg>({ name: 'Rohan', kind: 'agent' }, { type: 'changed', paths: ['a.py'], summary: 'x' })
    s.room.post<NoteMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'note', text: 'fyi' })
    s.room.post<QuestionMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Sam', text: 'not for us' })
    await s.runner.idle(); await tick()
    expect(s.backend.inputs).toHaveLength(0)
  })

  it('wakes on a question addressed to us with a <room-event input and an event chat line', async () => {
    s.room.post<QuestionMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'changing payload?' })
    await tick(); await s.runner.idle()
    expect(s.backend.inputs).toHaveLength(1)
    const inp = s.backend.inputs[0]
    expect(inp).toContain('PREAMBLE')
    expect(inp).toContain('<room-event type="question" from="Kieran" from_kind="agent" path="">')
    expect(inp).toContain("Kieran's agent → Rohan's agent asks: changing payload?")
    expect(inp).toContain('"type":"question"')
    const roles = s.room.chat('Rohan').toArray().map(i => i.role)
    expect(roles).toContain('event')
  })

  it('coalesces events that arrive during a running turn into one follow-up input', async () => {
    s.backend.hold = true
    s.room.say('Rohan', { role: 'human', text: 'go' })
    await tick()
    expect(s.backend.inputs).toHaveLength(1)
    s.room.post<ChangedMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'changed', paths: ['a.py'], summary: 'renamed f' })
    s.room.post<QuestionMsg>({ name: 'Kieran', kind: 'human' }, { type: 'question', text: 'anyone touching b.py?' })
    s.backend.hold = false
    s.backend.finish()
    await s.runner.idle()
    expect(s.backend.inputs).toHaveLength(2)
    const follow = s.backend.inputs[1]
    expect(follow).not.toContain('PREAMBLE')
    expect(follow.match(/<room-event /g)).toHaveLength(2)
    expect(follow).toContain('type="changed"')
    expect(follow).toContain('type="question"')
  })

  it('wakes on another party claim overlapping one of our open claims', async () => {
    s.room.addClaim({ path: 'a.py', from: 10, to: 20, by: 'Rohan', byKind: 'agent', intent: 'refactor' })
    s.room.addClaim({ path: 'a.py', from: 30, to: 40, by: 'Kieran', byKind: 'agent', intent: 'no overlap' })
    await tick(); await s.runner.idle()
    expect(s.backend.inputs).toHaveLength(0)
    s.room.addClaim({ path: 'a.py', from: 15, to: 25, by: 'Kieran', byKind: 'human', intent: 'overlap' })
    await tick(); await s.runner.idle()
    expect(s.backend.inputs).toHaveLength(1)
    expect(s.backend.inputs[0]).toContain('type="claim" from="Kieran" from_kind="human" path="a.py"')
  })

  it('mirrors backend items into the chat with the right roles', async () => {
    s.backend.scripts.push([
      { id: '1', type: 'reasoning', text: 'hmm' },
      { id: '2', type: 'mcp_tool_call', server: 'room', tool: 'room_claim', arguments: { path: 'a.py' }, status: 'completed', result: { content: [{ type: 'text', text: 'claim c_1 ok\nmore' }], structured_content: null } },
      { id: '3', type: 'command_execution', command: 'pytest -q', aggregated_output: 'x'.repeat(500) + '\n3 passed\n', exit_code: 0, status: 'completed' },
      { id: '4', type: 'file_change', changes: [{ path: 'a.py', kind: 'update' }, { path: 'b.py', kind: 'add' }], status: 'completed' },
      { id: '5', type: 'error', message: 'oops' },
      { id: '6', type: 'agent_message', text: 'Done.' },
    ])
    s.room.say('Rohan', { role: 'human', text: 'go' })
    await s.runner.idle()
    const items = s.room.chat('Rohan').toArray().slice(2) // skip old + human
    expect(items.map(i => i.role)).toEqual(['tool', 'tool', 'tool', 'status', 'agent'])
    expect(items[0].text).toBe('room_claim({"path":"a.py"}) → claim c_1 ok')
    expect(items[1].text.startsWith('$ pytest -q\n…')).toBe(true)
    expect(items[1].text.endsWith('3 passed\n[exit 0]')).toBe(true)
    expect(items[1].text.length).toBeLessThan(450)
    expect(items[2].text).toBe('edited a.py, b.py')
    expect(items[3].text).toBe('oops')
    expect(items[4].text).toBe('Done.')
    expect(s.statuses.at(-1)).toBe('idle')
    expect(s.statuses).toContain('thinking')
  })

  it('survives a failed turn', async () => {
    s.backend.run = async () => { throw new Error('boom') }
    s.room.say('Rohan', { role: 'human', text: 'go' })
    await s.runner.idle()
    const last = s.room.chat('Rohan').toArray().at(-1)!
    expect(last).toMatchObject({ role: 'status', text: 'turn failed: boom' })
    s.backend.run = async () => ({ finalResponse: '' })
    s.room.say('Rohan', { role: 'human', text: 'again' })
    await s.runner.idle()
    expect(s.statuses.at(-1)).toBe('idle')
  })
})

describe('wake rules: claim/release locality', () => {
  it('ignores broadcast claims in files I have no claim in, wakes for files I am working in', async () => {
    const { shouldWakeOnMsg } = await import('../src/wake.js')
    const me = { name: 'Rohan', kind: 'agent' as const }
    const claim = { id: 'm1', type: 'claim' as const, from: 'Kieran', fromKind: 'agent' as const, at: 1, claimId: 'c1', path: 'api/notify.py', from_line: 1, to_line: 1, intent: 'stub' }
    expect(shouldWakeOnMsg(me, claim, []).wake).toBe(false)
    const mine = [{ id: 'c0', path: 'api/notify.py', from: 3, to: 9, by: 'Rohan', byKind: 'agent' as const, intent: 'x', at: 1 }]
    expect(shouldWakeOnMsg(me, claim, mine).wake).toBe(true)
    const changed = { id: 'm2', type: 'changed' as const, from: 'Kieran', fromKind: 'agent' as const, at: 1, paths: ['a.py'], summary: 'renamed' }
    expect(shouldWakeOnMsg(me, changed, []).wake).toBe(true)
  })
})

describe('/stop', () => {
  it('aborts a held turn, drops the queue, and reports "stopped by you"', async () => {
    const { RoomDoc } = await import('@room/shared')
    const { Runner } = await import('../src/runner.js')
    const { FakeBackend } = await import('../src/backend.js')
    const room = new RoomDoc()
    const backend = new FakeBackend(); backend.hold = true
    const awareness = { setLocalStateField() {} }
    const r = new Runner({ name: 'Rohan', room, awareness, backend, log: () => {} })
    r.start()
    room.say('Rohan', { role: 'human', text: 'do a thing' })
    await new Promise(res => setTimeout(res, 20))
    room.say('Rohan', { role: 'human', text: 'and another' })
    room.say('Rohan', { role: 'human', text: '/stop' })
    await r.idle()
    const statuses = room.chat('Rohan').toArray().filter(i => i.role === 'status').map(i => i.text)
    expect(statuses).toContain('stopped by you')
    expect(backend.inputs).toHaveLength(1)
    r.stop()
  })
})
