import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installFailureHandlers } from '../src/index.js'

describe('MCP fatal diagnostics', () => {
  it.each(['uncaughtException', 'unhandledRejection'])('records %s before exit', event => {
    const events = new EventEmitter()
    const calls: string[] = []
    const target = Object.assign(events, { exit: (code: number): never => { calls.push('exit ' + code); throw new Error('exited') } })
    installFailureHandlers(message => calls.push(message), target as unknown as Pick<NodeJS.Process, 'on' | 'exit'>)
    const error = new Error('lost transport')
    expect(() => events.emit(event, error)).toThrow('exited')
    expect(calls).toEqual(['stopping: ' + event + ': ' + error.stack, 'exit 1'])
  })

  it('records a non-Error rejection and startup failure', () => {
    const events = new EventEmitter()
    const report = vi.fn()
    const target = Object.assign(events, { exit: (): never => { throw new Error('exited') } })
    const fatal = installFailureHandlers(report, target as unknown as Pick<NodeJS.Process, 'on' | 'exit'>)
    expect(() => events.emit('unhandledRejection', 'capacity')).toThrow('exited')
    expect(report).toHaveBeenLastCalledWith('stopping: unhandledRejection: capacity')
    expect(() => fatal('startup failed', 'bad config')).toThrow('exited')
    expect(report).toHaveBeenLastCalledWith('stopping: startup failed: bad config')
  })
})
