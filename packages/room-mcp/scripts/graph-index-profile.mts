/**
 * Profile one graph build of a checkout, as a lead's session runs it (base only, no room peers).
 *
 *   npx tsx packages/room-mcp/scripts/graph-index-profile.mts [dir] [--from <rev>] [--per-file]
 *
 *   dir           checkout to index (default: the current repository), at its HEAD
 *   --from <rev>  build at <rev> first, then move the base to HEAD and profile only that rebuild
 *   --per-file    read base texts with readBoundedHistoricalText, one path at a time (for comparison)
 *   GRAPH_CPU_PROFILE=out.cpuprofile  also write a main-thread CPU profile (open in Chrome DevTools)
 *
 * Prints the build time, Git processes by subcommand, the parse worker's CPU (the same texts reparsed
 * in-process) against main-thread event-loop lag, and the 20 slowest parse round trips.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { performance } from 'node:perf_hooks'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { setGitObserver } from '@room/roomd/git'
import { GraphIndex } from '../src/graph-index.js'
import { ParseWorker } from '../src/parse/client.js'
import { ensureLanguages, parseFile } from '../src/parse/engine.js'
import { readBoundedHistoricalText } from '../src/tools/disk-text.js'

const args = process.argv.slice(2)
const flag = (name: string, value = false) => {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args.splice(at, value ? 2 : 1)[value ? 1 : 0]
}
const from = flag('--from', true), perFile = flag('--per-file') !== undefined
const dir = args[0] ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const rev = (name: string) => execFileSync('git', ['-C', dir, 'rev-parse', name], { encoding: 'utf8' }).trim()
const head = rev('HEAD')

const parses = new Map<string, { ms: number; texts: (string | undefined)[] }>()
const worker = new ParseWorker()
const parser = {
  async parse(path: string, texts: (string | undefined)[]) {
    const started = performance.now()
    try { return await worker.parse(path, texts) } finally { parses.set(path, { ms: performance.now() - started, texts }) }
  },
  stop: () => worker.stop(),
}
const gitCalls = new Map<string, number>()
setGitObserver(argv => { const key = argv.slice(0, 2).join(' '); gitCalls.set(key, (gitCalls.get(key) ?? 0) + 1) })
const room = new RoomDoc()
setParticipantBase(room, 'lead', from ? rev(from) : head)
const logs: string[] = []
const index = new GraphIndex(room, 'lead', dir, line => logs.push(line),
  { minPublishMs: 0, random: () => 0, parser, ...(perFile ? { read: readBoundedHistoricalText } : {}) })
if (from) { index.start(); await index.whenIdle(); parses.clear(); gitCalls.clear(); logs.length = 0 }

const profiler = process.env.GRAPH_CPU_PROFILE ? new Session() : undefined
if (profiler) { profiler.connect(); await profiler.post('Profiler.enable'); await profiler.post('Profiler.start') }
let lag = 0, tick = performance.now()
const ticker = setInterval(() => { const now = performance.now(); lag += Math.max(0, now - tick - 10); tick = now }, 10)
const started = performance.now()
if (from) setParticipantBase(room, 'lead', head) // the session's base moves, as on a commit or checkout
else index.start()
await index.whenIdle()
const wall = performance.now() - started
clearInterval(ticker)
if (profiler) writeFileSync(process.env.GRAPH_CPU_PROFILE!, JSON.stringify((await profiler.post('Profiler.stop')).profile))
const indexed = index.graph.size
index.stop(); setGitObserver(undefined)

await ensureLanguages([...parses.keys()])
const files = [...parses].map(([path, { ms, texts }]) => {
  const unique = [...new Set(texts.filter((text): text is string => text !== undefined))]
  const t = performance.now()
  for (const text of unique) parseFile(path, text)
  return { path, ms, cpu: performance.now() - t, chars: unique.reduce((n, text) => n + text.length, 0) }
})
const total = (key: 'ms' | 'cpu') => files.reduce((sum, file) => sum + file[key], 0).toFixed(0)
console.log(`${dir} @ ${head.slice(0, 10)}${from ? ` (base moved from ${from})` : ''}${perFile ? ', per-file reads' : ''}`)
for (const line of logs) console.log(`  log: ${line}`)
console.log(`  build ${wall.toFixed(0)} ms: ${indexed} files in the graph, ${files.length} sent to the parser`)
console.log(`  git: ${[...gitCalls].map(([cmd, n]) => `${n}x ${cmd}`).join(', ')}`)
console.log(`  parse worker CPU ${total('cpu')} ms (round trips summed ${total('ms')} ms); main-thread lag ${lag.toFixed(0)} ms`)
console.log('  slowest parse round trips (ms, in-process parse ms, chars):')
for (const file of files.sort((a, b) => b.ms - a.ms).slice(0, 20))
  console.log(`    ${file.ms.toFixed(1).padStart(7)} ${file.cpu.toFixed(1).padStart(7)} ${String(file.chars).padStart(8)}  ${file.path}`)
process.exit(0)
