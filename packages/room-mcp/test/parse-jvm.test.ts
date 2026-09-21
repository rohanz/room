import { beforeAll, describe, expect, it } from 'vitest'
import { observedContractChanges } from '@room/shared'
import { ensureLanguages, parseFile } from '../src/parse/engine.js'

interface ExpectedDef {
  name: string
  container?: string
  kind: string
  from: number
  to: number
}

interface LanguageCase {
  language: string
  path: string
  source: string
  definitions: ExpectedDef[]
  imports: string[]
  refs: string[]
  signature: [string, string, string]
}

const lines = (...source: string[]): string => source.join('\n')

const cases: LanguageCase[] = [
  {
    language: 'Java',
    path: 'Sample.java',
    source: lines(
      'import java.util.List;',
      'class Alpha {',
      '  static final int LIMIT = 3;',
      '  static final String TEXT = "class Ghost { void fake() {} }";',
      '  Alpha(int value) {}',
      '  Widget ping(Widget input) {',
      '    return helper(input.member());',
      '  }',
      '}',
      'class Beta {',
      '  Widget ping(Widget input) {',
      '    return input;',
      '  }',
      '}',
      'interface Shape {',
      '  double area();',
      '}',
      'enum Tone { HIGH }',
      'record Pair(int left, int right) {}',
      '// class CommentGhost { void fakeComment() {} }',
      'class Broken { void nope( {',
    ),
    definitions: [
      { name: 'Alpha', kind: 'class_declaration', from: 2, to: 9 },
      { name: 'LIMIT', container: 'Alpha', kind: 'field_declaration', from: 3, to: 3 },
      { name: 'Alpha', container: 'Alpha', kind: 'constructor_declaration', from: 5, to: 5 },
      { name: 'ping', container: 'Alpha', kind: 'method_declaration', from: 6, to: 8 },
      { name: 'ping', container: 'Beta', kind: 'method_declaration', from: 11, to: 13 },
      { name: 'Shape', kind: 'interface_declaration', from: 15, to: 17 },
      { name: 'area', container: 'Shape', kind: 'method_declaration', from: 16, to: 16 },
      { name: 'Tone', kind: 'enum_declaration', from: 18, to: 18 },
      { name: 'Pair', kind: 'record_declaration', from: 19, to: 19 },
    ],
    imports: ['java.util.List'],
    refs: ['Widget', 'helper', 'member'],
    signature: [
      'class Sig { int target(int x) { return x + 1; } }',
      'class Sig { int target(int x) { return x + 99; } }',
      'class Sig { String target(int x, int y) { return "x"; } }',
    ],
  },
  {
    language: 'Kotlin',
    path: 'Sample.kt',
    source: lines(
      'import foo.bar.Baz',
      'const val TOP = 1',
      'val cache = build()',
      'class Alpha(val n: Int) {',
      '  constructor(text: String) : this(text.length)',
      '  fun ping(input: Widget): Widget {',
      '    return helper(input.member)',
      '  }',
      '  companion object {',
      '    const val LIMIT = 3',
      '  }',
      '}',
      'object Maker {',
      '  const val FLAG = 1',
      '  fun build(): Alpha = Alpha(1)',
      '}',
      'interface Shape {',
      '  fun area(): Double',
      '}',
      'enum class Tone { HIGH }',
      'typealias Alias = Widget',
      'class Beta {',
      '  fun ping(input: Widget): Widget {',
      '    return input',
      '  }',
      '}',
      'val text = "class Ghost { fun fake() {} }"',
      '// fun fakeComment() {}',
      'fun broken(',
    ),
    definitions: [
      { name: 'TOP', kind: 'property_declaration', from: 2, to: 2 },
      { name: 'cache', kind: 'property_declaration', from: 3, to: 3 },
      { name: 'Alpha', kind: 'class_declaration', from: 4, to: 12 },
      { name: 'constructor', container: 'Alpha', kind: 'secondary_constructor', from: 5, to: 5 },
      { name: 'ping', container: 'Alpha', kind: 'function_declaration', from: 6, to: 8 },
      { name: 'LIMIT', container: 'Alpha', kind: 'property_declaration', from: 10, to: 10 },
      { name: 'Maker', kind: 'object_declaration', from: 13, to: 16 },
      { name: 'FLAG', container: 'Maker', kind: 'property_declaration', from: 14, to: 14 },
      { name: 'build', container: 'Maker', kind: 'function_declaration', from: 15, to: 15 },
      { name: 'Shape', kind: 'class_declaration', from: 17, to: 19 },
      { name: 'area', container: 'Shape', kind: 'function_declaration', from: 18, to: 18 },
      { name: 'Tone', kind: 'class_declaration', from: 20, to: 20 },
      { name: 'Alias', kind: 'type_alias', from: 21, to: 21 },
      { name: 'ping', container: 'Beta', kind: 'function_declaration', from: 23, to: 25 },
    ],
    imports: ['foo.bar.Baz'],
    refs: ['Widget', 'helper', 'member'],
    signature: [
      'class Sig { fun target(x: Int): Int { return x + 1 } }',
      'class Sig { fun target(x: Int): Int { return x + 99 } }',
      'class Sig { fun target(x: Int, y: Int): String { return "x" } }',
    ],
  },
  {
    language: 'C#',
    path: 'Sample.cs',
    source: lines(
      'using System.Collections.Generic;',
      'class Alpha {',
      '  public const int Limit = 3;',
      '  public const string Text = "class Ghost { void Fake() {} }";',
      '  public Alpha(int value) {}',
      '  public Widget Ping(Widget input) {',
      '    return Helper(input.Member);',
      '  }',
      '}',
      'class Beta {',
      '  public Widget Ping(Widget input) {',
      '    return input;',
      '  }',
      '}',
      'interface IShape {',
      '  double Area();',
      '}',
      'enum Tone { High }',
      'record Pair(int Left, int Right);',
      'struct Point { public int X; }',
      '// class CommentGhost { void FakeComment() {} }',
      'class Broken { void Nope( {',
    ),
    definitions: [
      { name: 'Alpha', kind: 'class_declaration', from: 2, to: 9 },
      { name: 'Limit', container: 'Alpha', kind: 'field_declaration', from: 3, to: 3 },
      { name: 'Alpha', container: 'Alpha', kind: 'constructor_declaration', from: 5, to: 5 },
      { name: 'Ping', container: 'Alpha', kind: 'method_declaration', from: 6, to: 8 },
      { name: 'Ping', container: 'Beta', kind: 'method_declaration', from: 11, to: 13 },
      { name: 'IShape', kind: 'interface_declaration', from: 15, to: 17 },
      { name: 'Area', container: 'IShape', kind: 'method_declaration', from: 16, to: 16 },
      { name: 'Tone', kind: 'enum_declaration', from: 18, to: 18 },
      { name: 'Pair', kind: 'record_declaration', from: 19, to: 19 },
      { name: 'Point', kind: 'struct_declaration', from: 20, to: 20 },
    ],
    imports: ['System.Collections.Generic'],
    refs: ['Helper', 'Member', 'Widget'],
    signature: [
      'class Sig { int Target(int x) { return x + 1; } }',
      'class Sig { int Target(int x) { return x + 99; } }',
      'class Sig { string Target(int x, int y) { return "x"; } }',
    ],
  },
  {
    language: 'Swift',
    path: 'Sample.swift',
    source: lines(
      'import Foundation',
      'let top = make()',
      'class Alpha {',
      '  static let limit = 3',
      '  static let text = "class Ghost { func fake() {} }"',
      '  init(value: Int) {}',
      '  func ping(_ input: Widget) -> Widget {',
      '    return helper(input.member)',
      '  }',
      '}',
      'class Beta {',
      '  func ping(_ input: Widget) -> Widget {',
      '    return input',
      '  }',
      '}',
      'protocol Shape {',
      '  func area() -> Double',
      '}',
      'struct Pair { let left: Int }',
      'enum Tone { case high }',
      'extension Alpha { func extra() {} }',
      'typealias Alias = Widget',
      '// func fakeComment() {}',
      'func broken(',
    ),
    definitions: [
      { name: 'top', kind: 'property_declaration', from: 2, to: 2 },
      { name: 'Alpha', kind: 'class_declaration', from: 3, to: 10 },
      { name: 'limit', container: 'Alpha', kind: 'property_declaration', from: 4, to: 4 },
      { name: 'init', container: 'Alpha', kind: 'init_declaration', from: 6, to: 6 },
      { name: 'ping', container: 'Alpha', kind: 'function_declaration', from: 7, to: 9 },
      { name: 'ping', container: 'Beta', kind: 'function_declaration', from: 12, to: 14 },
      { name: 'Shape', kind: 'protocol_declaration', from: 16, to: 18 },
      { name: 'area', container: 'Shape', kind: 'protocol_function_declaration', from: 17, to: 17 },
      { name: 'Pair', kind: 'class_declaration', from: 19, to: 19 },
      { name: 'Tone', kind: 'class_declaration', from: 20, to: 20 },
      { name: 'Alpha', kind: 'class_declaration', from: 21, to: 21 },
      { name: 'extra', container: 'Alpha', kind: 'function_declaration', from: 21, to: 21 },
      { name: 'Alias', kind: 'typealias_declaration', from: 22, to: 22 },
    ],
    imports: ['Foundation'],
    refs: ['Widget', 'helper', 'member'],
    signature: [
      'class Sig { func target(_ x: Int) -> Int { return x + 1 } }',
      'class Sig { func target(_ x: Int) -> Int { return x + 99 } }',
      'class Sig { func target(_ x: Int, _ y: Int) -> String { return "x" } }',
    ],
  },
  {
    language: 'Scala',
    path: 'Sample.scala',
    source: lines(
      'import foo.bar.Baz',
      'object Factory {',
      '  val limit = 3',
      '  val text = "class Ghost { def fake() = 1 }"',
      '  def build(value: Int): Alpha = new Alpha(value)',
      '}',
      'class Alpha(val n: Int) {',
      '  def this() = this(0)',
      '  def ping(input: Widget): Widget = {',
      '    helper(input.member)',
      '  }',
      '}',
      'class Beta {',
      '  def ping(input: Widget): Widget = {',
      '    input',
      '  }',
      '}',
      'case class Pair(left: Int, right: Int)',
      'trait Shape {',
      '  def area(): Double',
      '}',
      'enum Tone { case High }',
      'type Alias = Widget',
      '// class CommentGhost { def fakeComment() = 1 }',
      'def broken(',
    ),
    definitions: [
      { name: 'Factory', kind: 'object_definition', from: 2, to: 6 },
      { name: 'limit', container: 'Factory', kind: 'val_definition', from: 3, to: 3 },
      { name: 'build', container: 'Factory', kind: 'function_definition', from: 5, to: 5 },
      { name: 'Alpha', kind: 'class_definition', from: 7, to: 12 },
      { name: 'this', container: 'Alpha', kind: 'function_definition', from: 8, to: 8 },
      { name: 'ping', container: 'Alpha', kind: 'function_definition', from: 9, to: 11 },
      { name: 'ping', container: 'Beta', kind: 'function_definition', from: 14, to: 16 },
      { name: 'Pair', kind: 'class_definition', from: 18, to: 18 },
      { name: 'Shape', kind: 'trait_definition', from: 19, to: 21 },
      { name: 'area', container: 'Shape', kind: 'function_declaration', from: 20, to: 20 },
      { name: 'Tone', kind: 'ERROR', from: 22, to: 22 },
      { name: 'Alias', kind: 'type_definition', from: 23, to: 23 },
    ],
    imports: ['foo.bar.Baz'],
    refs: ['Widget', 'helper', 'member'],
    signature: [
      'class Sig { def target(x: Int): Int = { x + 1 } }',
      'class Sig { def target(x: Int): Int = { x + 99 } }',
      'class Sig { def target(x: Int, y: Int): String = { "x" } }',
    ],
  },
]

beforeAll(async () => {
  await ensureLanguages(cases.map(testCase => testCase.path))
})

function parse(path: string, source: string) {
  const parsed = parseFile(path, source)
  expect(parsed).toBeDefined()
  return parsed!
}

describe.each(cases)('$language tree-sitter spec', testCase => {
  it('finds supported definitions with exact ranges and containers', () => {
    const parsed = parse(testCase.path, testCase.source)
    for (const definition of testCase.definitions) {
      expect(parsed.defs).toContainEqual(expect.objectContaining(definition))
    }
    const pings = parsed.defs.filter(definition => definition.name.toLowerCase() === 'ping')
    expect(new Set(pings.map(definition => definition.container))).toEqual(new Set(['Alpha', 'Beta']))
  })

  it('extracts imports and references, ignores comment/string decoys, and recovers before an error', () => {
    const parsed = parse(testCase.path, testCase.source)
    expect(parsed.imports).toEqual(expect.arrayContaining(testCase.imports))
    expect(parsed.refs).toEqual(expect.arrayContaining(testCase.refs))
    expect(parsed.defs.some(definition => definition.name === 'Ghost')).toBe(false)
    expect(parsed.defs.some(definition => definition.name === 'fake' || definition.name === 'fakeComment')).toBe(false)
    expect(parsed.defs.some(definition => definition.name === 'Alpha')).toBe(true)
  })

  it('changes signatures for declarations but not body-only edits', () => {
    const [original, bodyEdit, declarationEdit] = testCase.signature
    const signature = (source: string) => parse(testCase.path, source).defs.find(definition => definition.name.toLowerCase() === 'target')?.signature
    expect(signature(original)).toBeTruthy()
    expect(signature(bodyEdit)).toBe(signature(original))
    expect(signature(declarationEdit)).not.toBe(signature(original))
  })
})

describe('overload contract sets', () => {
  it.each([
    ['Java', 'A.java', 'class A {\n  void run(int x) {}\n  void run(String x) {}\n}', 'String x', 'boolean x', 'A.run'],
    ['C#', 'A.cs', 'class A { public void Run(int x) {} public void Run(string x) {} }', 'string x', 'bool x', 'A.Run'],
    ['Swift', 'A.swift', 'struct A {\n  func run(_ x: Int) {}\n  func run(_ x: String) {}\n}', 'String', 'Bool', 'A.run'],
    ['Scala', 'A.scala', 'object A { def run(x: Int): Int = x\n  def run(x: String): String = x }', 'String', 'Boolean', 'A.run'],
  ])('reports a changed later %s overload', (_language, path, source, before, after, symbol) => {
    expect(observedContractChanges(source, source.replaceAll(before, after), path, parseFile))
      .toContainEqual(expect.objectContaining({ symbol, kind: 'signature' }))
  })
})
