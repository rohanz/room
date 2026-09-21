import { beforeAll, describe, expect, it } from 'vitest'
import type { ParsedDef, ParsedFile } from '@room/shared'
import { ensureLanguages, parseFile } from '../src/parse/engine.js'

const paths = ['sample.rs', 'sample.go', 'sample.c', 'sample.cpp']

beforeAll(async () => {
  await ensureLanguages(paths)
})

function parsed(path: string, text: string): ParsedFile {
  const result = parseFile(path, text)
  expect(result).toBeDefined()
  return result!
}

function definition(result: ParsedFile, name: string, container?: string): ParsedDef {
  const found = result.defs.find(def => def.name === name && def.container === container)
  expect(found, `missing ${container ? `${container}::` : ''}${name}`).toBeDefined()
  return found!
}

describe('Rust tree-sitter spec', () => {
  const source = [
    'use std::fmt::Debug;',
    'const LIMIT: i32 = 3;',
    'static COUNT: i32 = 0;',
    'type Name = String;',
    'struct Alpha { value: i32 }',
    'enum Choice { One }',
    'union Bits { raw: u32 }',
    'trait Named { fn same(&self); }',
    'impl Alpha { fn same(&self) { helper(self.value); } }',
    'struct Beta {}',
    'impl Beta { fn same(&self) { self.run(); } }',
    'fn free(value: Alpha) { helper(value.value); }',
    'macro_rules! make { () => {} }',
    '// fn commented() {}',
    'const TEXT: &str = "fn stringy() {}";',
  ].join('\n')

  it('finds definitions with lines and distinct method containers, refs, and imports', () => {
    const result = parsed('sample.rs', source)
    expect(definition(result, 'LIMIT')).toMatchObject({ kind: 'const_item', from: 2, to: 2 })
    expect(definition(result, 'COUNT')).toMatchObject({ kind: 'static_item', from: 3, to: 3 })
    expect(definition(result, 'Name')).toMatchObject({ kind: 'type_item', from: 4, to: 4 })
    expect(definition(result, 'Alpha')).toMatchObject({ kind: 'struct_item', from: 5, to: 5 })
    expect(definition(result, 'Choice')).toMatchObject({ kind: 'enum_item', from: 6, to: 6 })
    expect(definition(result, 'Bits')).toMatchObject({ kind: 'union_item', from: 7, to: 7 })
    expect(definition(result, 'Named')).toMatchObject({ kind: 'trait_item', from: 8, to: 8 })
    expect(definition(result, 'same', 'Named')).toMatchObject({ kind: 'function_signature_item', from: 8, to: 8 })
    expect(definition(result, 'same', 'Alpha')).toMatchObject({ kind: 'function_item', from: 9, to: 9 })
    expect(definition(result, 'same', 'Beta')).toMatchObject({ kind: 'function_item', from: 11, to: 11 })
    expect(definition(result, 'free')).toMatchObject({ kind: 'function_item', from: 12, to: 12 })
    expect(definition(result, 'make')).toMatchObject({ kind: 'macro_definition', from: 13, to: 13 })
    expect(result.defs.map(def => def.name)).not.toContain('commented')
    expect(result.defs.map(def => def.name)).not.toContain('stringy')
    expect(result.refs).toEqual(expect.arrayContaining(['helper', 'run']))
    expect(result.imports).toContain('std::fmt::Debug')
  })

  it('changes signatures for parameters but not bodies', () => {
    const original = definition(parsed('x.rs', 'fn work(x: i32) -> i32 { x + 1 }'), 'work').signature
    const body = definition(parsed('x.rs', 'fn work(x: i32) -> i32 { x + 200 }'), 'work').signature
    const contract = definition(parsed('x.rs', 'fn work(x: i32, y: i32) -> i64 { x + y }'), 'work').signature
    expect(body).toBe(original)
    expect(contract).not.toBe(original)
  })

  it('references path calls, grouped use names and macros; finds functions inside mod blocks', () => {
    const result = parsed('x.rs', 'use crate::cfg::{load, Config as C};\nmod inner { pub fn helper() {} }\nfn main() { crate::messages::set_messages(true); Config::new(); my_macro!(1); }')
    expect(result.refs).toEqual(expect.arrayContaining(['set_messages', 'new', 'load', 'my_macro']))
    expect(definition(result, 'helper', 'inner')).toMatchObject({ from: 2, to: 2 })
  })

  it('recovers definitions before a syntax error', () => {
    expect(definition(parsed('broken.rs', 'fn intact() {}\nfn broken( {'), 'intact')).toMatchObject({ from: 1, to: 1 })
  })
})

describe('Go tree-sitter spec', () => {
  const source = [
    'package demo',
    'import ("fmt"; alias "net/http")',
    'const Limit = 3',
    'var Count int',
    'type Alpha struct { Value int }',
    'type Named interface { Name() string }',
    'type Alias = Alpha',
    'func (a *Alpha) Same() string { return fmt.Sprint(a.Value) }',
    'type Beta struct {}',
    'func (b Beta) Same() string { return b.String() }',
    'func Free(value Alpha) { helper(value) }',
    '// func Commented() {}',
    'const Text = "func Stringy() {}"',
  ].join('\n')

  it('finds declarations with lines and receiver containers, refs, and imports', () => {
    const result = parsed('sample.go', source)
    expect(definition(result, 'Limit')).toMatchObject({ kind: 'const_spec', from: 3, to: 3 })
    expect(definition(result, 'Count')).toMatchObject({ kind: 'var_spec', from: 4, to: 4 })
    expect(definition(result, 'Alpha')).toMatchObject({ kind: 'type_spec', from: 5, to: 5 })
    expect(definition(result, 'Named')).toMatchObject({ kind: 'type_spec', from: 6, to: 6 })
    expect(definition(result, 'Alias')).toMatchObject({ kind: 'type_alias', from: 7, to: 7 })
    expect(definition(result, 'Same', 'Alpha')).toMatchObject({ kind: 'method_declaration', from: 8, to: 8 })
    expect(definition(result, 'Same', 'Beta')).toMatchObject({ kind: 'method_declaration', from: 10, to: 10 })
    expect(definition(result, 'Free')).toMatchObject({ kind: 'function_declaration', from: 11, to: 11 })
    expect(result.defs.map(def => def.name)).not.toContain('Commented')
    expect(result.defs.map(def => def.name)).not.toContain('Stringy')
    expect(result.refs).toEqual(expect.arrayContaining(['Sprint', 'Value', 'String', 'helper']))
    expect(result.imports).toEqual(expect.arrayContaining(['"fmt"', '"net/http"']))
  })

  it('changes signatures for results but not bodies', () => {
    const original = definition(parsed('x.go', 'func Work(x int) int { return x + 1 }'), 'Work').signature
    const body = definition(parsed('x.go', 'func Work(x int) int { return x + 200 }'), 'Work').signature
    const contract = definition(parsed('x.go', 'func Work(x int) string { return "x" }'), 'Work').signature
    expect(body).toBe(original)
    expect(contract).not.toBe(original)
  })

  it('recovers definitions before a syntax error', () => {
    expect(definition(parsed('broken.go', 'package p\nfunc Intact() {}\nfunc Broken( {'), 'Intact')).toMatchObject({ from: 2, to: 2 })
  })
})

describe('C tree-sitter spec', () => {
  const source = [
    '#include <stdio.h>',
    '#define LIMIT 3',
    '#define ADD(a, b) ((a) + (b))',
    'typedef struct Alpha { int value; } Alpha;',
    'typedef int Alias;',
    'enum Choice { ONE };',
    'union Bits { unsigned raw; };',
    'static int count = 0;',
    'const int answer = 42;',
    'int same(Alpha *a) { return helper(a->value); }',
    'int free_fn(Alias x) { return same(0) + x; }',
    '// int commented(void) { return 0; }',
    'const char *text = "int stringy(void) {}";',
  ].join('\n')

  it('finds functions, types, constants/statics and macros with lines, refs, and includes', () => {
    const result = parsed('sample.c', source)
    expect(definition(result, 'LIMIT')).toMatchObject({ kind: 'preproc_def', from: 2, to: 2 })
    expect(definition(result, 'ADD')).toMatchObject({ kind: 'preproc_function_def', from: 3, to: 3 })
    expect(definition(result, 'Alpha')).toBeDefined()
    expect(definition(result, 'Alias')).toMatchObject({ kind: 'type_definition', from: 5, to: 5 })
    expect(definition(result, 'Choice')).toMatchObject({ kind: 'enum_specifier', from: 6, to: 6 })
    expect(definition(result, 'Bits')).toMatchObject({ kind: 'union_specifier', from: 7, to: 7 })
    expect(definition(result, 'count')).toMatchObject({ kind: 'declaration', from: 8, to: 8 })
    expect(definition(result, 'answer')).toMatchObject({ kind: 'declaration', from: 9, to: 9 })
    expect(definition(result, 'same')).toMatchObject({ kind: 'function_definition', from: 10, to: 10 })
    expect(definition(result, 'free_fn')).toMatchObject({ kind: 'function_definition', from: 11, to: 11 })
    expect(result.defs.map(def => def.name)).not.toContain('commented')
    expect(result.defs.map(def => def.name)).not.toContain('stringy')
    expect(result.refs).toEqual(expect.arrayContaining(['helper', 'value']))
    expect(result.imports).toContain('<stdio.h>')
  })

  it('changes signatures for return types but not bodies', () => {
    const original = definition(parsed('x.c', 'int work(int x) { return x + 1; }'), 'work').signature
    const body = definition(parsed('x.c', 'int work(int x) { return x + 200; }'), 'work').signature
    const contract = definition(parsed('x.c', 'long work(int x) { return x + 1; }'), 'work').signature
    expect(body).toBe(original)
    expect(contract).not.toBe(original)
  })

  it('recovers definitions before a syntax error', () => {
    expect(definition(parsed('broken.c', 'int intact(void) {}\nint broken( {'), 'intact')).toMatchObject({ from: 1, to: 1 })
  })
})

describe('C++ tree-sitter spec', () => {
  const source = [
    '#include <vector>',
    '#define LIMIT 3',
    '#define ADD(a, b) ((a) + (b))',
    'namespace Demo {',
    'class Alpha { public: int same() { return helper(); } };',
    'class Beta { public: int same() { return this->value; } int value; };',
    'struct Record {};',
    'enum class Choice { One };',
    'union Bits { unsigned raw; };',
    'using Alias = Alpha;',
    'typedef int Old;',
    'const int Answer = 42;',
    'int free_fn(Alpha value) { return value.same(); }',
    '}',
    'int Demo::Alpha::same() { return 1; }',
    '// int commented() {}',
    'const char *text = "int stringy() {}";',
  ].join('\n')

  it('finds namespace/class definitions and methods with lines, refs, and includes', () => {
    const result = parsed('sample.cpp', source)
    expect(definition(result, 'LIMIT')).toMatchObject({ kind: 'preproc_def', from: 2, to: 2 })
    expect(definition(result, 'ADD')).toMatchObject({ kind: 'preproc_function_def', from: 3, to: 3 })
    expect(definition(result, 'Alpha', 'Demo')).toMatchObject({ kind: 'class_specifier', from: 5, to: 5 })
    expect(definition(result, 'Beta', 'Demo')).toMatchObject({ kind: 'class_specifier', from: 6, to: 6 })
    expect(definition(result, 'same', 'Alpha')).toMatchObject({ kind: 'function_definition', from: 5, to: 5 })
    expect(definition(result, 'same', 'Beta')).toMatchObject({ kind: 'function_definition', from: 6, to: 6 })
    expect(definition(result, 'Record', 'Demo')).toMatchObject({ kind: 'struct_specifier', from: 7, to: 7 })
    expect(definition(result, 'Choice', 'Demo')).toMatchObject({ kind: 'enum_specifier', from: 8, to: 8 })
    expect(definition(result, 'Bits', 'Demo')).toMatchObject({ kind: 'union_specifier', from: 9, to: 9 })
    expect(definition(result, 'Alias', 'Demo')).toMatchObject({ kind: 'alias_declaration', from: 10, to: 10 })
    expect(definition(result, 'Old', 'Demo')).toMatchObject({ kind: 'type_definition', from: 11, to: 11 })
    expect(definition(result, 'Answer')).toMatchObject({ kind: 'declaration', from: 12, to: 12 })
    expect(definition(result, 'free_fn', 'Demo')).toMatchObject({ kind: 'function_definition', from: 13, to: 13 })
    expect(result.defs.filter(def => def.name === 'same' && def.container === 'Alpha')).toHaveLength(2)
    expect(result.defs.map(def => def.name)).not.toContain('commented')
    expect(result.defs.map(def => def.name)).not.toContain('stringy')
    expect(result.refs).toEqual(expect.arrayContaining(['helper', 'value']))
    expect(result.imports).toContain('<vector>')
  })

  it('changes signatures for parameters but not bodies', () => {
    const original = definition(parsed('x.cpp', 'int work(int x) { return x + 1; }'), 'work').signature
    const body = definition(parsed('x.cpp', 'int work(int x) { return x + 200; }'), 'work').signature
    const contract = definition(parsed('x.cpp', 'long work(int x, int y) { return x + y; }'), 'work').signature
    expect(body).toBe(original)
    expect(contract).not.toBe(original)
  })

  it('references namespace-qualified calls', () => {
    expect(parsed('x.cpp', 'int main() { return util::compute(1); }').refs).toContain('compute')
  })

  it('recovers definitions before a syntax error', () => {
    expect(definition(parsed('broken.cpp', 'int intact() {}\nclass Broken {'), 'intact')).toMatchObject({ from: 1, to: 1 })
  })
})
