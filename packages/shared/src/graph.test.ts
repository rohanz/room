import { describe, it, expect } from 'vitest'
import { SymbolGraph, regexExtractor } from './graph.js'

describe('SymbolGraph', () => {
  it('extracts python defs and refs, ignoring keywords and self-defs', () => {
    const s = regexExtractor('a.py', 'import os\nMAX = 3\nclass Order:\n    pass\ndef create_order(x):\n    return validate(x, MAX)\n')!
    expect(s.defs.sort()).toEqual(['MAX', 'Order', 'create_order'])
    expect(s.refs).toContain('validate')
    expect(s.refs).not.toContain('return')
    expect(s.refs).not.toContain('create_order')
    expect(regexExtractor('README.md', 'x')).toBeUndefined()
  })

  it('answers users, definers, dependencies and dependents across files', () => {
    const g = new SymbolGraph()
    g.set('utils.py', 'def validate_token(t):\n    return t\n')
    g.set('session.py', 'from utils import validate_token\ndef login(t):\n    return validate_token(t)\n')
    g.set('orders.py', 'def create_order():\n    pass\n')
    expect(g.usersOf('validate_token')).toEqual(['session.py'])
    expect(g.definersOf('validate_token')).toEqual(['utils.py'])
    expect(g.dependenciesOf('session.py')).toEqual([{ symbol: 'validate_token', definedIn: ['utils.py'], usedIn: ['session.py'] }])
    expect(g.dependentsOf('utils.py')[0]).toEqual({ symbol: 'validate_token', definedIn: ['utils.py'], usedIn: ['session.py'] })
    expect(g.dependentsOf('orders.py')).toEqual([])
    g.set('session.py', 'def login(t):\n    return verify_token(t)\n')
    expect(g.usersOf('validate_token')).toEqual([])
    g.remove('utils.py')
    expect(g.definersOf('validate_token')).toEqual([])
  })
})
