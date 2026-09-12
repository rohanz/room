import { describe, expect, it } from 'vitest'
import type { Msg } from '@room/shared'
import { groupEpisodes } from './timeline.ts'

describe('timeline episodes', () => {
  it('groups scopes, folds addressed upgrade copies, and threads answers with the asker', () => {
    const messages: Msg[] = [
      { id: 's1', type: 'scope', priority: 'notify', from: 'Ada', fromKind: 'agent', at: 1_000, area: 'api', summary: 'rename parser', paths: ['src'] },
      { id: 'c1', type: 'claim', priority: 'fyi', from: 'Ada', fromKind: 'agent', at: 1_100, claimId: 'claim', path: 'src/parser.ts', from_line: 1, to_line: 3, intent: 'rename', plans: [{ kind: 'rename', symbol: 'parse', detail: 'parse_payload' }] },
      { id: 'c-copy', type: 'claim', priority: 'notify', from: 'Ada', fromKind: 'agent', to: 'Rohan', copyOf: 'c1', at: 2_900, claimId: 'claim', path: 'src/parser.ts', from_line: 1, to_line: 3, intent: 'rename', plans: [{ kind: 'rename', symbol: 'parse', detail: 'parse_payload' }] },
      { id: 'q1', type: 'question', priority: 'notify', from: 'Ada', fromKind: 'agent', to: 'Rohan', at: 3_000, text: 'Can I land this?' },
      { id: 's2', type: 'scope', priority: 'notify', from: 'Rohan', fromKind: 'agent', at: 3_100, area: 'ui', summary: 'update caller', paths: ['web'] },
      { id: 'a1', type: 'answer', priority: 'notify', from: 'Rohan', fromKind: 'agent', to: 'Ada', at: 3_200, inReplyTo: 'q1', text: 'Yes' },
      { id: 'r1', type: 'release', priority: 'fyi', from: 'Ada', fromKind: 'agent', at: 4_000, claimId: 'claim', path: 'src/parser.ts', summary: 'renamed' },
      { id: 'm1', type: 'changed', priority: 'notify', from: 'Ada', fromKind: 'agent', at: 4_100, paths: ['src/parser.ts'], summary: 'landed', symbols: ['parse_payload'] },
      { id: 's3', type: 'scope', priority: 'notify', from: 'Ada', fromKind: 'agent', at: 5_000, area: 'tests', summary: 'cover parser', paths: ['test'] },
    ]
    const episodes = groupEpisodes(messages)
    expect(episodes.map(episode => `${episode.person}:${episode.area}`)).toEqual(['Ada:api', 'Rohan:ui', 'Ada:tests'])
    expect(episodes[0].items.map(item => item.message.id)).toEqual(['c1', 'q1', 'r1', 'm1'])
    expect(episodes[0].items[0].alsoSentTo).toEqual(['Rohan'])
    expect(episodes[0].items[1].replies.map(reply => reply.message.id)).toEqual(['a1'])
    expect(episodes[0].status).toBe('done')
    expect(episodes[1].items).toEqual([])
  })
})
