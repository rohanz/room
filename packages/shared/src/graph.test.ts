import { describe, it, expect } from 'vitest'
import { observedContractChanges, observedContractAnalysis, SymbolGraph, regexExtractor, symbolRange } from './graph.js'
import type { FileParser, ParsedDef } from './parsed.js'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const parsed = (defs: ParsedDef[]): ReturnType<FileParser> => ({ defs, refs: [], ownRefs: [], imports: [] })

describe('bounded contract analysis', () => {
  it('requires a parser for nonempty text', () => {
    expect(observedContractAnalysis('function f(){}', '', 'a.ts')).toMatchObject({ status: 'unavailable', reason: 'no-parser', changes: [] })
  })

  it('never fabricates changes when either nonempty side is declined', () => {
    const defs = parsed([{ name: 'f', kind: 'function', from: 1, to: 1, signature: 'function f()' }])
    for (const available of ['before', 'after']) {
      const parser: FileParser = (_path, text) => text === available ? defs : undefined
      expect(observedContractAnalysis('before', 'after', 'a.ts', parser)).toMatchObject({ status: 'unavailable', reason: 'parser-unavailable', changes: [] })
    }
    for (const [before, after] of [['', 'declined'], ['declined', '']])
      expect(observedContractAnalysis(before, after, 'a.ts', () => undefined)).toMatchObject({ status: 'unavailable', reason: 'parser-unavailable', changes: [] })
  })

  it('certifies actual empty text without calling a parser', () => {
    const parser: FileParser = (_path, text) => {
      expect(text).not.toBe('')
      return parsed([{ name: 'f', kind: 'function', from: 1, to: 1, signature: 'function f()' }])
    }
    expect(observedContractAnalysis('', '', 'a.ts')).toEqual({ status: 'ok', method: 'parsed', changes: [] })
    expect(observedContractAnalysis('', '', 'a.ts', () => { throw new Error('empty text must not parse') })).toEqual({ status: 'ok', method: 'parsed', changes: [] })
    expect(observedContractChanges('', 'after', 'a.ts', parser)).toEqual([{ symbol: 'f', kind: 'add', detail: 'now `function f()`' }])
    expect(observedContractChanges('before', '', 'a.ts', parser)).toEqual([{ symbol: 'f', kind: 'delete', detail: 'was `function f()`' }])
  })

  it('compares full parsed signatures beyond the 240-character display cap', () => {
    const before = `function f(${Array.from({ length: 35 }, (_, i) => `arg${i}: number`).join(', ')})`
    const after = before.replace('arg34: number', 'arg34: string')
    const parser: FileParser = (_path, text) => parsed([{ name: 'f', kind: 'function', from: 1, to: 1, signature: text }])
    const changes = observedContractChanges(before, after, 'a.ts', parser)
    expect(changes).toEqual([{ symbol: 'f', kind: 'signature', detail: `was \`${before.slice(0, 240)}…\` now \`${after.slice(0, 240)}…\`` }])
  })

  it('preserves literal whitespace while comparing multiline parsed signatures', () => {
    const before = 'function f(\n value: string = "a b",\n other: number\n)'
    const parser: FileParser = (_path, text) => parsed([{ name: 'f', kind: 'function', from: 1, to: 4, signature: text }])
    expect(observedContractChanges(before, before.replace('\n', '\n  '), 'a.ts', parser)).toEqual([])
    expect(observedContractChanges(before, before.replace('"a b"', '"ab"'), 'a.ts', parser)).toMatchObject([{ symbol: 'f', kind: 'signature' }])
  })

  it('contains the single-line no-parser micro repro in a 96 MiB subprocess', () => {
    const source = new URL('./graph.ts', import.meta.url).href
    const script = `
      import * as contracts from ${JSON.stringify(source)};
      const base = Array.from({length: 3000}, (_, i) => {
        const body = 'return t+' + i + ';/*' + 'x'.repeat(28) + '*/';
        return i % 4 === 0 ? 'function N'+i+'(t){'+body+'}' :
          i % 4 === 1 ? 'var V'+i+'=function(t){'+body+'};' :
          i % 4 === 2 ? 'const C'+i+'=(t)=>{'+body+'};' : 'class K'+i+'{m(t){'+body+'}}';
      }).join('');
      const start = performance.now();
      const changes = contracts.observedContractChanges(base, base+'\\nfunction Added(x){return x}\\n', 'lib/d3.min.js');
      console.log(JSON.stringify({bytes:base.length, ms:performance.now()-start, changes}));
    `
    const started = performance.now()
    const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } })
    console.info(`contract micro repro: ${Math.round(performance.now() - started)}ms, exit=${child.status}, signal=${child.signal}`)
    expect(child.status, child.stderr.slice(-2000)).toBe(0)
    const result = JSON.parse(child.stdout.trim())
    expect(result.bytes).toBeGreaterThan(180 * 1024)
    expect(result.bytes).toBeLessThan(256 * 1024)
    expect(result.changes).toEqual([])
    expect(performance.now() - started).toBeLessThan(30_000)
  }, 35_000)

  it('rejects oversized input before calling the parser and keeps the legacy wrapper safe', () => {
    const text = 'x'.repeat(300 * 1024)
    const parser: FileParser = () => { throw new Error('size gate must run first') }
    const start = performance.now()
    expect(observedContractAnalysis('', text, 'large.js', parser)).toMatchObject({ status: 'unavailable', reason: 'over-size', changes: [] })
    expect(observedContractChanges(text, '', 'large.js')).toEqual([])
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('rejects too many definitions on either side rather than returning partial changes', () => {
    const defs = Array.from({ length: 4001 }, (_, i) => ({ name: `f${i}`, kind: 'function', from: 1, to: 1, signature: 'f()' }))
    for (const [before, after] of [['before', 'after'], ['', 'after'], ['before', '']])
      expect(observedContractAnalysis(before, after, 'a.rs', () => parsed(defs))).toMatchObject({ status: 'unavailable', reason: 'too-many-definitions', changes: [] })
    expect(observedContractAnalysis('', 'after', 'a.rs', () => parsed(defs.slice(0, 4000))).status).toBe('ok')
  })

  it('bounds long parsed signatures and caps overload prose without hiding comparison changes', () => {
    const long = `function f(${ 'x'.repeat(400) })`
    const result = observedContractAnalysis('', 'after', 'a.rs', (_path, text) => parsed(text ? [{ name: 'f', kind: 'function', from: 1, to: 1, signature: long }] : []))
    expect(result.changes[0]?.detail).toBe(`now \`${long.slice(0, 240)}…\``)
    const parser: FileParser = (_path, text) => parsed(Array.from({ length: 8 }, (_, i) => ({ name: 'f', kind: 'method', from: i + 1, to: i + 1,
      signature: `f(x: T${text === 'after' && i === 7 ? 9 : i})` })))
    const changes = observedContractChanges('before', 'after', 'a.ts', parser)
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('signature')
    expect(changes[0].detail).toBe('was `f(x: T0) | f(x: T1) | f(x: T2) | f(x: T3) | f(x: T4) | f(x: T5) … +2 more` now `f(x: T0) | f(x: T1) | f(x: T2) | f(x: T3) | f(x: T4) | f(x: T5) … +2 more`')
  })
})

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
  it('uses parser signatures and container-qualified names without treating bodies as contracts', () => {
    const parser: FileParser = (_path, text) => {
      if (text === 'base' || text === 'body') return parsed([
        { name: 'new', container: 'Foo', kind: 'function_item', from: 2, to: 4, signature: 'fn new(value: i32)' },
        { name: 'new', container: 'Bar', kind: 'function_item', from: 7, to: 9, signature: 'fn new(value: i32)' },
      ])
      return parsed([
        { name: 'new', container: 'Foo', kind: 'function_item', from: 2, to: 4, signature: 'fn new(value: i64)' },
        { name: 'new', container: 'Bar', kind: 'function_item', from: 7, to: 9, signature: 'fn new(value: i32)' },
      ])
    }
    expect(observedContractChanges('base', 'body', 'lib.rs', parser)).toEqual([])
    expect(observedContractChanges('base', 'signature', 'lib.rs', parser)).toEqual([{
      symbol: 'Foo.new', kind: 'signature', detail: 'was `fn new(value: i32)` now `fn new(value: i64)`',
    }])
  })

  it('compares the complete overload signature set for a qualified name', () => {
    const parser: FileParser = (_path, text) => parsed(text === 'before' ? [
      { name: 'run', container: 'A', kind: 'method', from: 2, to: 2, signature: 'run(x: number): void' },
      { name: 'run', container: 'A', kind: 'method', from: 3, to: 3, signature: 'run(x: string): void' },
    ] : [
      { name: 'run', container: 'A', kind: 'method', from: 2, to: 2, signature: 'run(x: number): void' },
      { name: 'run', container: 'A', kind: 'method', from: 3, to: 3, signature: 'run(x: boolean): void' },
    ])

    expect(observedContractChanges('before', 'after', 'a.ts', parser)).toEqual([{
      symbol: 'A.run', kind: 'signature',
      detail: 'was `run(x: number): void | run(x: string): void` now `run(x: boolean): void | run(x: number): void`',
    }])
  })

  it('preserves whitespace inside string literals when comparing signatures', () => {
    const parser: FileParser = (_path, text) => parsed([{
      name: 'f', kind: 'function', from: 1, to: 1,
      signature: text === 'before' ? 'function f(x = "a b")' : 'function f(x = "ab")',
    }])

    expect(observedContractChanges('before', 'after', 'a.ts', parser)).toEqual([{
      symbol: 'f', kind: 'signature', detail: 'was `function f(x = "a b")` now `function f(x = "ab")`',
    }])
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

  it('uses parser ranges when available', () => {
    const parser: FileParser = () => parsed([
      { name: 'new', container: 'Foo', kind: 'function_item', from: 3, to: 8, signature: 'fn new()' },
    ])
    expect(symbolRange('lib.rs', 'anything', 'Foo.new', parser)).toEqual({ from: 3, to: 8 })
    expect(symbolRange('lib.rs', 'anything', 'new', parser)).toEqual({ from: 3, to: 8 })
    expect(symbolRange('lib.rs', 'anything', 'comment_only', parser)).toBeUndefined()
  })
})
