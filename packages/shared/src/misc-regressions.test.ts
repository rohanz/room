import { describe, expect, it } from 'vitest'
import { isRegenerableBuildPath } from './build-output.js'
import { messageForMe } from './messages.js'
import { shouldWakeOnMsg } from './wake.js'
import type { Msg } from './types.js'

describe('small Room regressions', () => {
  it('treats tsbuildinfo files at any depth as disposable output', () => {
    expect(isRegenerableBuildPath('packages/shared/tsconfig.tsbuildinfo')).toBe(true)
    expect(isRegenerableBuildPath('tsconfig.tsbuildinfo')).toBe(true)
    expect(isRegenerableBuildPath('src/tsbuildinfo.ts')).toBe(false)
  })

  it('delivers a same-named human message to the agent inbox and wake path', () => {
    const me = { name: 'rohanz', kind: 'agent' as const }
    const message = { id: 'human-note', type: 'note', priority: 'notify', from: 'rohanz', fromKind: 'human', to: 'rohanz', text: 'Please check this', at: 1 } as Msg
    expect(messageForMe(me, message)).toBe(true)
    expect(shouldWakeOnMsg(me, message).wake).toBe(true)
    const legacy = { ...message, id: 'legacy-note', fromKind: undefined } as unknown as Msg
    expect(messageForMe(me, legacy)).toBe(false)
    expect(shouldWakeOnMsg(me, legacy).wake).toBe(false)
  })
})
