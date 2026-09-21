import { beforeAll, describe, expect, it } from 'vitest'
import { ensureLanguages, parseFile } from '../src/parse/engine.js'

const cases = [
  {
    language: 'Python', path: 'sample.py',
    source: `from pkg.mod import Thing as T, helper
MAX: int = 3
@decorator
def top(x: T) -> Thing:
    return helper(x).field
class A:
    def same(self, x: T) -> int:
        return self.run(x)
class B:
    def same(self, x):
        return helper(x)
`,
    expectedDefs: ['MAX:2-2', 'top:4-5', 'A:6-8', 'A.same:7-8', 'B:9-11', 'B.same:10-11'],
    refs: ['Thing', 'T', 'helper', 'field', 'run'], imports: ['pkg.mod', 'Thing', 'T', 'helper'],
  },
  {
    language: 'JavaScript', path: 'sample.js',
    source: `import main, { source as local } from "pkg"
const REQUIRED = require("dep")
export const arrow = (x) => {
  return helper(x).field
}
export let expression = function (x) { return other(x) }
function top(x) { return call(x) }
class A {
  same(x) { return this.run(x) }
}
class B {
  same(x) { return helper(x) }
}
`,
    expectedDefs: ['REQUIRED:2-2', 'arrow:3-5', 'expression:6-6', 'top:7-7', 'A:8-10', 'A.same:9-9', 'B:11-13', 'B.same:12-12'],
    refs: ['main', 'source', 'local', 'helper', 'field', 'other', 'call', 'run'], imports: ['main', 'source', 'local', 'pkg', 'dep'],
  },
  {
    language: 'TypeScript', path: 'sample.ts',
    source: `import type { Input as In } from "types"
export interface Contract { same(x: In): Output }
export type Alias = In | Output
export enum State { Ready }
export const arrow = (x: In): Output => { return make(x) }
abstract class Base { abstract same(x: In): Output }
class Impl extends Base {
  same(x: In): Output { return this.run(x) }
}
`,
    expectedDefs: ['Contract:2-2', 'Contract.same:2-2', 'Alias:3-3', 'State:4-4', 'arrow:5-5', 'Base:6-6', 'Base.same:6-6', 'Impl:7-9', 'Impl.same:8-8'],
    refs: ['Input', 'In', 'Output', 'make', 'run'], imports: ['Input', 'In', 'types'],
  },
  {
    language: 'TSX', path: 'sample.tsx',
    source: `import React from "react"
export interface Props { same(x: Input): Output }
export type Alias = Input | Output
export enum State { Ready }
export const View = (p: Props): JSX.Element => {
  return <button onClick={() => p.same(p.input)}>{render(p.input)}</button>
}
class A { same(p: Props): Output { return p.same(p.input) } }
class B { same(p: Props): Output { return render(p.input) } }
`,
    expectedDefs: ['Props:2-2', 'Props.same:2-2', 'Alias:3-3', 'State:4-4', 'View:5-7', 'A:8-8', 'A.same:8-8', 'B:9-9', 'B.same:9-9'],
    refs: ['React', 'Input', 'Output', 'Element', 'input', 'render'], imports: ['React', 'react'],
  },
  {
    language: 'Ruby', path: 'sample.rb',
    source: `require "set"
require_relative "./support"
TOP = 1
module M
  INNER = 2
  def helper_method(x) = helper(x)
end
class A < Base
  def same(x)
    helper(x).field
  end
  def self.build(x) = new(x)
end
class B
  def same(x) = helper(x)
end
`,
    expectedDefs: ['TOP:3-3', 'M:4-7', 'M.INNER:5-5', 'M.helper_method:6-6', 'A:8-13', 'A.same:9-11', 'A.build:12-12', 'B:14-16', 'B.same:15-15'],
    refs: ['Base', 'helper', 'field'], imports: ['set', './support'],
  },
  {
    language: 'PHP', path: 'sample.php',
    source: `<?php
use Vendor\\Thing as T;
require_once "boot.php";
const TOP = 1;
function top(T $x): Output { return helper($x)->field; }
interface Contract { public function same(T $x): Output; }
trait Shared { public function helperMethod(): void {} }
enum State { case Ready; public function label(): string { return "ready"; } }
class A implements Contract { const INNER = 2; public function same(T $x): Output { return $this->run($x); } }
class B implements Contract { public function same(T $x): Output { return helper($x); } }
`,
    expectedDefs: ['TOP:4-4', 'top:5-5', 'Contract:6-6', 'Contract.same:6-6', 'Shared:7-7', 'Shared.helperMethod:7-7', 'State:8-8', 'State.label:8-8', 'A:9-9', 'A.INNER:9-9', 'A.same:9-9', 'B:10-10', 'B.same:10-10'],
    refs: ['Thing', 'T', 'Output', 'helper', 'field', 'run'], imports: ['Vendor\\Thing', 'T', 'boot.php'],
  },
] as const

const parse = (path: string, source: string) => {
  const parsed = parseFile(path, source)
  expect(parsed, `parser unavailable for ${path}`).toBeDefined()
  return parsed!
}

const defKeys = (path: string, source: string) => parse(path, source).defs.map(definition =>
  `${definition.container ? `${definition.container}.` : ''}${definition.name}:${definition.from}-${definition.to}`)

beforeAll(async () => ensureLanguages(cases.map(testCase => testCase.path)))

describe.each(cases)('$language tree-sitter spec', testCase => {
  it('finds definitions, exact inclusive ranges, containers, references, and imports', () => {
    const parsed = parse(testCase.path, testCase.source)
    expect(defKeys(testCase.path, testCase.source).sort()).toEqual([...testCase.expectedDefs].sort())
    expect(parsed.refs).toEqual(expect.arrayContaining([...testCase.refs]))
    expect(parsed.imports).toEqual(expect.arrayContaining([...testCase.imports]))
  })

  it('does not match definition-like text in comments or strings', () => {
    const snippets: Record<string, string> = {
      Python: '# def Fake(): pass\nTEXT = "class Ghost: pass"\ndef real():\n    return 1\n',
      JavaScript: '// function Fake() {}\nconst text = "class Ghost {}"\nfunction real() {}\n',
      TypeScript: '// interface Fake {}\nconst text = "class Ghost {}"\nfunction real(): void {}\n',
      TSX: '// const Fake = () => null\nconst text = "interface Ghost {}"\nfunction real(): JSX.Element { return <div /> }\n',
      Ruby: '# class Fake; end\ntext = "def ghost; end"\ndef real = 1\n',
      PHP: '<?php\n// function fake() {}\n$text = "class Ghost {}";\nfunction real(): void {}\n',
    }
    const names = parse(testCase.path, snippets[testCase.language]).defs.map(definition => definition.name)
    expect(names).toContain('real')
    expect(names).not.toEqual(expect.arrayContaining(['Fake', 'fake', 'Ghost', 'ghost']))
  })

  it('changes signatures for parameters or return types but not body-only edits', () => {
    const samples: Record<string, [string, string, string, string]> = {
      Python: ['def target(x: int) -> int:\n    return x\n', 'def target(x: int, y: int) -> int:\n    return x\n', 'def target(x: int) -> int:\n    return x + 1\n', 'target'],
      JavaScript: ['export const target = (x) => x + 1\n', 'export const target = (x, y) => x + y\n', 'export const target = (x) => x + 2\n', 'target'],
      TypeScript: ['export function target(x: Input): Output { return make(x) }\n', 'export function target(x: Input): Other { return make(x) }\n', 'export function target(x: Input): Output { return other(x) }\n', 'target'],
      TSX: ['export const Target = (p: Props): JSX.Element => <div>{p.x}</div>\n', 'export const Target = (p: Props, n = 1): JSX.Element => <div>{p.x}</div>\n', 'export const Target = (p: Props): JSX.Element => <span>{p.y}</span>\n', 'Target'],
      Ruby: ['def target(x)\n  x + 1\nend\n', 'def target(x, y)\n  x + y\nend\n', 'def target(x)\n  x + 2\nend\n', 'target'],
      PHP: ['<?php function target(Input $x): Output { return make($x); }\n', '<?php function target(Input $x, int $n): Output { return make($x); }\n', '<?php function target(Input $x): Output { return other($x); }\n', 'target'],
    }
    const [base, changed, bodyOnly, name] = samples[testCase.language]
    const signature = (source: string) => parse(testCase.path, source).defs.find(definition => definition.name === name)!.signature
    expect(signature(changed)).not.toBe(signature(base))
    expect(signature(bodyOnly)).toBe(signature(base))
  })

  it('keeps same-named methods distinct by container', () => {
    const methods = parse(testCase.path, testCase.source).defs.filter(definition => definition.name === 'same')
    expect(new Set(methods.map(definition => definition.container)).size).toBeGreaterThanOrEqual(2)
  })

  it('keeps definitions before a syntax error', () => {
    const broken: Record<string, string> = {
      Python: 'def before():\n    return 1\ndef broken(\n',
      JavaScript: 'function before() {}\nfunction broken( {\n',
      TypeScript: 'function before(): void {}\ninterface Broken { value:\n',
      TSX: 'function before(): JSX.Element { return <div /> }\nconst broken = <\n',
      Ruby: 'def before = 1\ndef broken(\n',
      PHP: '<?php function before(): void {}\nfunction broken( {\n',
    }
    expect(parse(testCase.path, broken[testCase.language]).defs.map(definition => definition.name)).toContain('before')
  })
})
