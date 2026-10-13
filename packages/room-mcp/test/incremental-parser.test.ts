import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { ParseWorker } from '../src/parse/client.js'

afterEach(() => vi.useRealTimers())
function thread(id = 1) {
  return Object.assign(new EventEmitter(), { threadId: id, ref: vi.fn(), unref: vi.fn(), postMessage: vi.fn(), terminate: vi.fn(async () => 1) })
}

it('settles siblings on synchronous postMessage failure and counts duplicate error/exit once', async () => {
  const first = thread(), second = thread(2), created = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
  const client = new ParseWorker({ createWorker: created, restartCooldownMs: 0, maxRestarts: 1 })
  try {
    const sibling = client.parse('synthetic.js', ['pending'])
    const siblingRejected = expect(sibling).rejects.toThrow('synthetic send failure')
    first.postMessage.mockImplementationOnce(() => { throw new Error('synthetic send failure') })
    await expect(client.parse('synthetic.js', ['crash'])).rejects.toThrow('synthetic send failure')
    await siblingRejected
    first.emit('error', new Error('duplicate'))
    first.emit('exit', 1)
    const recovered = client.parse('synthetic.js', ['recovered'])
    second.emit('message', { id: 3, parsed: [] })
    await expect(recovered).resolves.toEqual([])
    expect(created).toHaveBeenCalledTimes(2)
  } finally { client.stop() }
})

it('keeps a request just before the idle deadline alive until it receives its own reply', async () => {
  vi.useFakeTimers()
  const mock = thread()
  const client = new ParseWorker({ createWorker: () => mock as unknown as Worker, idleMs: 10 })
  try {
    const first = client.parse('synthetic.js', ['first'])
    mock.emit('message', {id:1,parsed:[]}); await first
    await vi.advanceTimersByTimeAsync(9)
    const second = client.parse('synthetic.js', ['second'])
    await vi.advanceTimersByTimeAsync(100)
    expect(mock.terminate).not.toHaveBeenCalled()
    mock.emit('message', {id:2,parsed:[]}); await second
    await vi.advanceTimersByTimeAsync(10)
    expect(mock.terminate).toHaveBeenCalledTimes(1)
  } finally { client.stop() }
})

it('stops all pending requests exactly once and ignores later worker responses', async () => {
  const mock = thread(), log = vi.fn()
  const client = new ParseWorker({ createWorker: () => mock as unknown as Worker, log })
  try {
    const rejections = vi.fn()
    const pending = [client.parse('synthetic.js',['one']).catch(rejections), client.parse('synthetic.js',['two']).catch(rejections)]
    client.stop(); await Promise.all(pending)
    mock.emit('message',{id:1,parsed:[]}); mock.emit('error',new Error('late error')); mock.emit('exit',1)
    expect(rejections).toHaveBeenCalledTimes(2)
    await expect(client.parse('synthetic.js',['later'])).rejects.toThrow('closed')
    expect(mock.terminate).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  } finally { client.stop() }
})
