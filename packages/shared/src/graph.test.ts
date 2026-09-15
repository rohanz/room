import { describe, it, expect } from 'vitest'
import { observedContractChanges, SymbolGraph, regexExtractor, symbolRange } from './graph.js'

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

describe('observedContractChanges', () => {
  it('finds Python signature, deletion and addition while ignoring bodies and whitespace', () => {
    const base = 'def total(price: int) -> int:\n    return price\n\ndef removed(x):\n    return x\n'
    expect(observedContractChanges(base, base.replace('return price', 'return price + 1'), 'pricing.py')).toEqual([])
    expect(observedContractChanges(base, base.replace('price: int', 'price: float'), 'pricing.py')).toContainEqual({
      symbol: 'total', kind: 'signature', detail: 'was `def total(price: int) -> int:` now `def total(price: float) -> int:`',
    })
    expect(observedContractChanges(base, 'def total( price: int )->int:\n    return price\n\ndef added(y):\n    return y\n', 'pricing.py')).toEqual([
      { symbol: 'added', kind: 'add', detail: 'now `def added(y):`' },
      { symbol: 'removed', kind: 'delete', detail: 'was `def removed(x):`' },
    ])
  })

  it('finds JavaScript function and arrow signatures without treating their bodies as contracts', () => {
    const base = 'export function total(price: number): number {\n  return price\n}\nconst tax = (price: number): number => price * .1\n'
    expect(observedContractChanges(base, base.replace('return price', 'return price + 1').replace('price * .1', 'price * .2'), 'pricing.ts')).toEqual([])
    const changed = base.replace('price: number): number {', 'price: number, coupon?: string): number {')
      .replace('(price: number): number =>', '(price: number, rate = .1): number =>')
    expect(observedContractChanges(base, changed, 'pricing.ts').map(change => [change.symbol, change.kind])).toEqual([
      ['tax', 'signature'], ['total', 'signature'],
    ])
  })
})

describe('symbolRange', () => {
  it('finds python def/class blocks and js brace blocks', () => {
    const py = 'import x\n\ndef a():\n    return 1\n\n\nclass B:\n    def m(self):\n        pass\n\nC = 3\n'
    expect(symbolRange('f.py', py, 'a')).toEqual({ from: 3, to: 4 })
    expect(symbolRange('f.py', py, 'B')).toEqual({ from: 7, to: 9 })
    expect(symbolRange('f.py', py, 'm')).toEqual({ from: 8, to: 9 })
    expect(symbolRange('f.py', py, 'C')).toEqual({ from: 11, to: 11 })
    expect(symbolRange('f.py', py, 'nope')).toBeUndefined()
    const js = 'const x = 1\nexport function f(a) {\n  if (a) {\n    return 1\n  }\n}\nconst g = () => 2\n'
    expect(symbolRange('f.ts', js, 'f')).toEqual({ from: 2, to: 6 })
    expect(symbolRange('f.ts', js, 'g')).toEqual({ from: 7, to: 7 })
  })
})
