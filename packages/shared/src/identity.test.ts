import { describe, it, expect } from 'vitest'
import { displayName, describeIdentity, isAgentic } from './identity.js'

describe('identity', () => {
  it('displayName renders each kind, with owner and label when present', () => {
    expect(displayName({ name: 'rohanz', kind: 'human' })).toBe('rohanz')
    expect(displayName({ name: 'rohanz', kind: 'agent' })).toBe("rohanz's agent")
    expect(displayName({ name: 'rohanz+codex', kind: 'agent', owner: 'rohanz', label: 'codex' })).toBe('rohanz+codex')
    expect(displayName({ name: 'rohanz+codex', kind: 'agent' })).toBe('rohanz+codex')
    expect(displayName({ name: 'deploy-bot', kind: 'bot', owner: 'rohanz', label: 'deploy' })).toBe('deploy [bot]')
    expect(displayName({ name: 'gh-actions', kind: 'ci' })).toBe('gh-actions [ci]')
  })
  it('older identities without owner/kind extras render as before', () => {
    expect(displayName({ name: 'Kieran', kind: 'agent' })).toBe("Kieran's agent")
    expect(describeIdentity({ name: 'Kieran', kind: 'human' })).toBe('Kieran')
  })
  it('describeIdentity is the participant-list line', () => {
    expect(describeIdentity({ name: 'rohanz+codex', kind: 'agent', owner: 'rohanz', label: 'codex' })).toBe('rohanz+codex · agent of rohanz · codex')
    expect(describeIdentity({ name: 'rohanz', kind: 'agent', owner: 'rohanz' })).toBe('rohanz · agent')
    expect(describeIdentity({ name: 'deploy', kind: 'bot', owner: 'rohanz' })).toBe('deploy · bot of rohanz')
  })
  it('bot and ci are agentic, human is not', () => {
    expect(isAgentic('agent')).toBe(true); expect(isAgentic('bot')).toBe(true); expect(isAgentic('ci')).toBe(true)
    expect(isAgentic('human')).toBe(false); expect(isAgentic(undefined)).toBe(false)
  })
})
