import { describe, expect, it } from 'vitest'
import type { Claim, Scope } from '@room/shared'
import { buildActivityGraph } from './activity-graph.ts'

describe('activity graph', () => {
  it('connects an open rename plan to overlay files that reference its symbol', () => {
    const claim: Claim = {
      id: 'c1', path: 'src/parser.ts', from: 1, to: 2, by: 'Ada', byKind: 'agent', intent: 'rename parser', at: 1,
      plans: [{ kind: 'rename', symbol: 'parse', detail: 'parse_payload' }],
    }
    const scope: Scope = { by: 'Rohan', byKind: 'agent', area: 'api', summary: 'update callers', paths: ['src/handler.ts'], at: 2 }
    const model = buildActivityGraph({
      overlays: [
        { person: 'Ada', path: 'src/parser.ts', text: 'export function parse(value: string) { return value }\n' },
        { person: 'Rohan', path: 'src/handler.ts', text: 'export function handle(value: string) { return parse(value) }\n' },
      ],
      claims: [claim], scopes: [scope], changesByPerson: new Map([['Rohan', ['src/handler.ts']]]), focusPerson: 'Ada',
    })
    expect(model.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plan:c1:0', kind: 'plan', label: 'rename parse → parse_payload', owner: 'Ada' }),
      expect.objectContaining({ id: 'file:src/handler.ts', kind: 'file', owner: 'Rohan' }),
    ]))
    expect(model.edges).toEqual([{ from: 'plan:c1:0', to: 'file:src/handler.ts' }])
  })
})
