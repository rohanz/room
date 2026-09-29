import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { watchLegacyIdentity } from '../src/session.js'

it('reclaims late imported unresolved facts under the current name fence', async () => {
  const room = new RoomDoc(new Y.Doc())
  let fence: string | undefined = '22'
  const validate = vi.fn().mockResolvedValue(undefined)
  const stop = watchLegacyIdentity(room, { room: 'ws://127.0.0.1:9/local%2Frepo%2Fmain', name: 'ben' }, 'ben', () => fence, validate)
  try {
    room.doc.getMap('unresolved').set('local/repo/main\0ben', {
      placeholder: '?old', claims: [{ id: 'c1', by: '?old', byKind: 'agent', path: 'a.py', from: 1, to: 1, intent: 'edit', at: 1 }],
      scope: { by: '?old', byKind: 'agent', area: 'a', summary: 'a', paths: ['a.py'], at: 1 },
    })
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce())
    expect(room.claims.get('c1')?.by).toBe('ben')
    expect(room.scopes.get('ben')?.area).toBe('a')
    fence = undefined
    room.doc.getMap('unresolved').set('local/repo/main\0ben', { placeholder: '?later', claims: [] })
    expect(room.doc.getMap('unresolved').has('local/repo/main\0ben')).toBe(true)
  } finally { stop() }
})
