import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import { RelayAwarenessBudget } from '../src/awareness.js'

function frame(entries: [number, number, unknown][]) {
  const outer = encoding.createEncoder(), inner = encoding.createEncoder()
  encoding.writeVarUint(inner, entries.length)
  for(const [id,clock,state] of entries) {
    encoding.writeVarUint(inner,id); encoding.writeVarUint(inner,clock); encoding.writeVarString(inner,JSON.stringify(state))
  }
  encoding.writeVarUint(outer,1); encoding.writeVarUint8Array(outer,encoding.toUint8Array(inner))
  return encoding.toUint8Array(outer)
}

it('accepts an exact UTF-8 state-byte boundary and cuts one extra ASCII byte exactly once', () => {
  const doc = new Y.Doc(), awareness = new Awareness(doc), close = vi.fn()
  awareness.setLocalState(null)
  const state = { v: 'é'.repeat(4) }
  const bytes = Buffer.byteLength(JSON.stringify(state))
  const allow = new RelayAwarenessBudget(awareness,{maxStateBytes:bytes}).connection(close)
  try {
    expect(allow(frame([[1,1,state]]))).toBe(true)
    expect(allow(frame([[1,2,{v:state.v+'x'}]]))).toBe(false)
    expect(allow(frame([[1,3,state]]))).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  } finally { awareness.destroy(); doc.destroy() }
})

it('rejects a two-ID batch atomically while another connection retains its full one-ID allowance', () => {
  const doc = new Y.Doc(), awareness = new Awareness(doc), close = vi.fn()
  awareness.setLocalState(null)
  const budget = new RelayAwarenessBudget(awareness,{maxIdsPerConnection:1})
  const first = budget.connection(close), secondClose=vi.fn(), second=budget.connection(secondClose)
  try {
    expect(first(frame([[1,1,{}],[2,1,{}]]))).toBe(false)
    expect(awareness.getStates().size).toBe(0)
    expect(awareness.meta.size).toBe(1)
    expect(second(frame([[3,1,{}]]))).toBe(true)
    expect(secondClose).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  } finally { awareness.destroy(); doc.destroy() }
})
