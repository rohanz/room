import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ParsedFile } from '@room/shared'
import { ParseWorker } from '../src/parse/client.js'

it('loads grammars in its own thread and deduplicates equal versions', async () => {
  const worker = new ParseWorker()
  try {
    const text = 'pub fn sample(x: usize) -> usize { x }'
    const parsed = await worker.parse('sample.rs', [text, text, undefined])
    expect(parsed[0]?.defs).toMatchObject([{ name: 'sample', signature: 'pub fn sample(x: usize) -> usize' }])
    expect(parsed[1]).toEqual(parsed[0])
    expect(parsed[2]).toBeUndefined()
    const [python] = await worker.parse('sample.py', ['def sample(x):\n    return x\n'])
    expect(python?.defs[0]?.name).toBe('sample')
  } finally { worker.stop() }
})

it('rejects pending and subsequent requests on stop', async () => {
  const worker = new ParseWorker()
  const pending = worker.parse('sample.rs', ['pub fn sample() {}'])
  worker.stop()
  await expect(pending).rejects.toThrow('parser worker is closed')
  await expect(worker.parse('sample.rs', [''])).rejects.toThrow('parser worker is closed')
})

it('parses with the relocated committed worker without node_modules and from another cwd', async context => {
  const source = fileURLToPath(new URL('../../../plugins/room/server/', import.meta.url))
  if (!existsSync(join(source, 'room-mcp.mjs')) || !existsSync(join(source, 'parse-worker.mjs'))) {
    context.skip('Committed plugin bundle is missing; relocated parser packaging smoke test requires plugins/room/server/*.mjs')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'room-relocated-worker-'))
  const server = join(dir, 'server'), cwd = join(dir, 'elsewhere')
  const samples: Record<string, string> = {
    'sample.rs': 'pub fn sample(x: usize) -> usize { x }',
    'sample.go': 'package main\nfunc sample(x int) int { return x }',
    'sample.c': 'int sample(int x) { return x; }',
    'sample.cpp': 'int sample(int x) { return x; }',
    'Sample.java': 'class Sample { int sample(int x) { return x; } }',
    'sample.kt': 'fun sample(x: Int): Int = x',
    'Sample.cs': 'class Sample { public int sample(int x) { return x; } }',
    'sample.swift': 'func sample(_ x: Int) -> Int { return x }',
    'Sample.scala': 'object Sample { def sample(x: Int): Int = x }',
    'sample.py': 'def sample(x):\n    return x\n',
    'sample.js': 'export function sample(x) { return x; }',
    'sample.ts': 'export function sample(x: number): number { return x; }',
    'sample.tsx': 'export function sample() { return <div />; }',
    'sample.rb': 'def sample(x)\n  x\nend\n',
    'sample.php': '<?php function sample($x) { return $x; }',
  }
  try {
    // Copy exactly the installed server assets, with no build or dependency tree.
    await cp(source, server, { recursive: true })
    await mkdir(cwd)
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
    expect(existsSync(join(server, 'node_modules'))).toBe(false)
    await Promise.all(Object.entries(samples).map(([path, text]) => writeFile(join(cwd, path), text)))
    const runner = join(cwd, 'smoke.mjs')
    await writeFile(runner, `
      import { Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      import { readFile } from 'node:fs/promises';
      const worker = new Worker(${JSON.stringify(join(server, 'parse-worker.mjs'))});
      const results = {};
      try {
        let id = 0;
        for (const path of ${JSON.stringify(Object.keys(samples))}) {
          const text = await readFile(path, 'utf8');
          const response = once(worker, 'message');
          worker.postMessage({ id: ++id, path, texts: [text] });
          const [message] = await response;
          if (message.id !== id) throw new Error('Unexpected parser response id');
          if (message.error) throw new Error(message.error);
          results[path] = message.parsed;
        }
        process.stdout.write(JSON.stringify(results));
      } finally { await worker.terminate(); }
    `)
    const env = { ...process.env }
    delete env.NODE_PATH
    delete env.NODE_OPTIONS
    delete env.ROOM_TREE_SITTER_WASM_DIR
    const { stdout } = await promisify(execFile)(process.execPath, [runner], { cwd, env, timeout: 10_000 })
    const parsed = JSON.parse(stdout) as Record<string, (ParsedFile | undefined)[]>
    for (const path of Object.keys(samples)) {
      expect(parsed[path]?.[0]?.defs.map(def => def.name) ?? [], path).toContain('sample')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
