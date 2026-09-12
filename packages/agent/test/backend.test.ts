import { describe, expect, it } from 'vitest'
import { CodexBackend } from '../src/backend.js'

describe('CodexBackend timeout', () => {
  it('aborts a turn at the configured deadline and reports the timeout', async () => {
    const backend = new CodexBackend({
      workingDirectory: process.cwd(),
      turnTimeoutMs: 10,
      mcp: { command: 'true', args: [], env: {} },
    })
    ;(backend as any).thread = {
      id: null,
      async runStreamed(_input: string, options: { signal: AbortSignal }) {
        return {
          events: (async function* () {
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          })(),
        }
      },
    }
    const statuses: string[] = []
    await expect(backend.run('work', () => {}, s => statuses.push(s))).rejects.toThrow('turn timed out after 10ms')
    expect(statuses).toContain('turn timed out after 10ms')
  })
})
