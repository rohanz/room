import { expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ParsedFile } from '@room/shared'
import { acquireParseWorker, parseInWorker, ParseWorker } from '../src/parse/client.js'

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
    // Cold-load every shipped grammar in one child; allow for full-suite CPU contention.
    const { stdout } = await promisify(execFile)(process.execPath, [runner], { cwd, env, timeout: 30_000 })
    const parsed = JSON.parse(stdout) as Record<string, (ParsedFile | undefined)[]>
    for (const path of Object.keys(samples)) {
      expect(parsed[path]?.[0]?.defs.map(def => def.name) ?? [], path).toContain('sample')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 45_000)

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= end) throw new Error('worker lifecycle condition timed out')
    await delay(5)
  }
}

it('disposes an idle thread and lazily parses again after its exit', async () => {
  const exits: number[] = []
  const worker = new ParseWorker({ idleMs: 20, onExit: id => exits.push(id) })
  try {
    expect((await worker.parse('sample.js', ['function sample() {}']))[0]?.defs[0]?.name).toBe('sample')
    const first = worker.threadIdForTest
    expect(first).toBeGreaterThan(0)
    await until(() => exits.includes(first!))
    expect(worker.threadIdForTest).toBeUndefined()
    expect((await worker.parse('sample.js', ['function later() {}']))[0]?.defs[0]?.name).toBe('later')
    expect(worker.threadIdForTest).not.toBe(first)
  } finally { worker.stop() }
})

it('rejects only dead-thread requests once, then recovers within the bounded restart budget', async () => {
  const workers: Worker[] = [], exits: number[] = [], log = vi.fn()
  const worker = new ParseWorker({ idleMs: 1000, maxRestarts: 2, restartCooldownMs: 30, restartWindowMs: 60_000, log,
    onExit: id => exits.push(id), createWorker: () => {
      const thread = new Worker(`const {parentPort} = require('node:worker_threads'); parentPort.on('message', ({id, texts}) => {
        if (texts[0] === 'crash') throw new Error('synthetic parser crash');
        parentPort.postMessage({id, parsed: texts.map(() => ({defs:[{name:'sample'}], refs:[], ownRefs:[], imports:[]}))});
      });`, { eval: true })
      workers.push(thread); return thread
    } })
  try {
    for (let i = 0; i < 3; i++) {
      const rejection = vi.fn()
      const dead = worker.parse('sample.js', ['crash']).catch(rejection)
      const sibling = worker.parse('sample.js', ['pending']).catch(rejection)
      await Promise.all([dead, sibling])
      await until(() => exits.length === i + 1)
      expect(rejection).toHaveBeenCalledTimes(2)
      if (i < 2) {
        await expect(worker.parse('sample.js', ['later'])).rejects.toThrow('cooling down')
        await delay(40)
        expect((await worker.parse('sample.js', ['later']))[0]?.defs[0]?.name).toBe('sample')
      }
    }
    await delay(40)
    for (let i = 0; i < 5; i++) await expect(worker.parse('sample.js', ['later'])).rejects.toThrow('restart budget exhausted')
    expect(workers).toHaveLength(3)
    expect(log).toHaveBeenCalledTimes(1)
  } finally { worker.stop(); await Promise.all(workers.map(thread => thread.terminate())) }
})

it('recovers from unexpected successful exit or external termination without replaying requests', async () => {
  for (const mode of ['exit', 'terminate']) {
    const threads: Worker[] = [], exits: number[] = []
    const worker = new ParseWorker({ restartCooldownMs: 0, onExit: id => exits.push(id), createWorker: () => {
      const thread = new Worker(`const {parentPort} = require('node:worker_threads'); parentPort.on('message', ({id, texts}) => {
        if (texts[0] === 'exit') process.exit(0);
        if (texts[0] !== 'hang') parentPort.postMessage({id, parsed: [{defs:[{name:'sample'}]}]});
      });`, { eval: true })
      threads.push(thread); return thread
    } })
    try {
      const pending = worker.parse('sample.js', [mode === 'exit' ? 'exit' : 'hang'])
      const rejected = expect(pending).rejects.toThrow('parser worker exited')
      if (mode === 'terminate') await threads[0]!.terminate()
      await rejected
      await until(() => exits.length === 1)
      expect((await worker.parse('sample.js', ['later']))[0]?.defs[0]?.name).toBe('sample')
      expect(threads).toHaveLength(2)
    } finally { worker.stop(); await Promise.all(threads.map(thread => thread.terminate())) }
  }
})

it('ignores late messages and exits from an idle-disposed instance during a new request', async () => {
  const threads: (EventEmitter & { threadId: number; postMessage: ReturnType<typeof vi.fn>; ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> })[] = []
  const worker = new ParseWorker({ idleMs: 10, createWorker: () => {
    const thread = Object.assign(new EventEmitter(), { threadId: threads.length + 1, postMessage: vi.fn(), ref: vi.fn(), unref: vi.fn(), terminate: vi.fn(async () => 1) })
    threads.push(thread); return thread as unknown as Worker
  } })
  try {
    const first = worker.parse('sample.js', ['first'])
    threads[0]!.emit('message', { id: 1, parsed: [] }); await first
    await until(() => threads[0]!.terminate.mock.calls.length === 1)
    const second = worker.parse('sample.js', ['second'])
    threads[0]!.emit('error', new Error('late error'))
    threads[0]!.emit('exit', 1)
    threads[0]!.emit('message', { id: 2, error: 'late response' })
    threads[1]!.emit('message', { id: 2, parsed: [{ defs: [{ name: 'later' }] }] })
    expect((await second)[0]?.defs[0]?.name).toBe('later')
  } finally { worker.stop() }
})

it('releases at least 50 MiB after recycling a 255 KiB parse in a bounded child process', async () => {
  const lock = '/tmp/room-memory-batch/probe.lock'
  await mkdir('/tmp/room-memory-batch', { recursive: true })
  while (true) {
    try { await mkdir(lock); break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await delay(5000) }
  }
  const source = new URL('../src/parse/client.ts', import.meta.url).href
  const script = `
    import { ParseWorker } from ${JSON.stringify(source)};
    const exits = [];
    const worker = new ParseWorker({idleMs: 50, onExit: id => exits.push(id)});
    const text = ('export function sample(x){return x;}\\n' + 'x();'.repeat(65536)).slice(0, 255*1024);
    const before = process.memoryUsage().rss;
    try {
      await worker.parse('large.js', [text]);
      const after = process.memoryUsage().rss;
      const end = Date.now() + 10000;
      while (!exits.length) { if (Date.now() > end) throw new Error('idle exit timed out'); await new Promise(r => setTimeout(r, 10)); }
      const recycled = process.memoryUsage().rss;
      const [parsed] = await worker.parse('small.js', ['function later() {}']);
      console.log(JSON.stringify({bytes: text.length, before, after, recycled, name: parsed?.defs[0]?.name}));
    } finally { worker.stop(); }
  `
  try {
    const { stdout } = await promisify(execFile)('nice', ['-n', '10', process.execPath, '--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', script],
      { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000, maxBuffer: 128*1024 })
    const result = JSON.parse(stdout.trim())
    console.info('parser idle RSS regression:', result)
    expect(result.bytes).toBe(255*1024)
    expect(result.after - result.recycled).toBeGreaterThanOrEqual(50*1024*1024)
    expect(result.name).toBe('later')
  } finally { await rmdir(lock) }
}, 180_000)

it('shares graph leases and auxiliary parsing while keeping stopped leases terminal', async () => {
  const first = acquireParseWorker(), second = acquireParseWorker()
  const clients = new Set<ParseWorker>()
  const original = ParseWorker.prototype.parse
  const parse = vi.spyOn(ParseWorker.prototype, 'parse').mockImplementation(function(path, texts) {
    clients.add(this); return original.call(this, path, texts)
  })
  try {
    const cancelled = first.parse('sample.js', ['function first() {}'])
    const alive = second.parse('sample.js', ['function second() {}'])
    first.stop()
    await expect(cancelled).rejects.toThrow('parser worker is closed')
    expect((await alive)[0]?.defs[0]?.name).toBe('second')
    await expect(first.parse('sample.js', ['function later() {}'])).rejects.toThrow('parser worker is closed')
    second.stop()
    expect((await parseInWorker('sample.js', ['function auxiliary() {}']))[0]?.defs[0]?.name).toBe('auxiliary')
    expect(clients.size).toBe(1)
  } finally { first.stop(); second.stop(); parse.mockRestore() }
})

it('cancels idle disposal while concurrent requests remain in flight', async () => {
  const thread = Object.assign(new EventEmitter(), { threadId: 1, postMessage: vi.fn(), ref: vi.fn(), unref: vi.fn(), terminate: vi.fn(async () => 1) })
  const worker = new ParseWorker({ idleMs: 20, createWorker: () => thread as unknown as Worker })
  try {
    const first = worker.parse('sample.js', ['first'])
    thread.emit('message', { id: 1, parsed: [] }); await first
    const second = worker.parse('sample.js', ['second']), third = worker.parse('sample.js', ['third'])
    await delay(30)
    expect(thread.terminate).not.toHaveBeenCalled()
    thread.emit('message', { id: 3, parsed: [] }); await third
    await delay(30)
    expect(thread.terminate).not.toHaveBeenCalled()
    thread.emit('message', { id: 2, parsed: [] }); await second
    await until(() => thread.terminate.mock.calls.length === 1)
    expect(thread.ref).toHaveBeenCalledTimes(3)
  } finally { worker.stop() }
})

it('expires old crashes from the restart window and bounds failed thread creation', async () => {
  let now = 1000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const log = vi.fn()
  const createWorker = vi.fn(() => { throw new Error('synthetic startup failure') })
  const worker = new ParseWorker({ maxRestarts: 1, restartWindowMs: 1000, restartCooldownMs: 0, createWorker, log })
  try {
    await expect(worker.parse('sample.js', [''])).rejects.toThrow('synthetic startup failure')
    now = 2500
    await expect(worker.parse('sample.js', [''])).rejects.toThrow('synthetic startup failure')
    now++
    await expect(worker.parse('sample.js', [''])).rejects.toThrow('synthetic startup failure')
    await expect(worker.parse('sample.js', [''])).rejects.toThrow('restart budget exhausted')
    expect(createWorker).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledTimes(1)
  } finally { worker.stop(); clock.mockRestore() }
})
