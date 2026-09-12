/** Generate an illustrative commerce repository and publish its actual symbol graph.
 * Usage: npm run seed:scale -w @room/web -- --dir /absolute/output/path [--server ws://localhost:1234]
 * The destination must not exist. All participant activity is labeled sample data.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc, type ScopeMsg } from '@room/shared'
import { startRoomd } from '../../roomd/src/index.js'
import { GraphIndex } from '../../room-mcp/src/graph-index.js'

const args = process.argv.slice(2)
const option = (name: string, fallback = '') => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? fallback }
const dir = resolve(option('--dir', `/tmp/room-scale-${Date.now()}`))
if (existsSync(dir)) throw new Error(`Destination already exists: ${dir}. Choose a new directory.`)
const server = option('--server', 'ws://localhost:1234').replace(/\/$/, '')
const roomName = option('--room', `sample/atlas-commerce/preview-${Date.now()}`)
const roomUrl = `${server}/${encodeURIComponent(roomName)}`
const sources = new Map<string, { symbol: string; deps: string[]; text: string }>()
const camel = (name: string) => name.replace(/[-/]([a-z])/g, (_, c: string) => c.toUpperCase())
function add(path: string, deps: string[]) {
  const symbol = camel(path.replace(/\.ts$/, '').replace(/[^a-zA-Z0-9]/g, '-'))
  const imports = deps.map(dep => {
    let rel = relative(dirname(path), dep).replace(/\.ts$/, '.js')
    if (!rel.startsWith('.')) rel = './' + rel
    return `import { ${sources.get(dep)!.symbol} } from '${rel}'`
  }).join('\n')
  const text = `/** Illustrative ${path}: generated sample, not a production implementation. */\n${imports}\n\nexport function ${symbol}(): string {\n  return [${[JSON.stringify(path.replace(/\.ts$/, '')), ...deps.map(d => `${sources.get(d)!.symbol}()`)].join(', ')}].join(' / ')\n}\n`
  sources.set(path, { symbol, deps, text })
  mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), text)
}
for (const name of ['config', 'logger', 'errors', 'metrics', 'database', 'cache', 'events', 'http']) {
  add(`platform/${name}.ts`, name === 'config' ? [] : ['platform/config.ts'])
}
const domains = ['identity', 'catalog', 'inventory', 'pricing', 'promotions', 'tax', 'shipping', 'payments', 'checkout', 'orders', 'fulfillment', 'returns', 'notifications', 'analytics', 'subscriptions', 'support']
const upstream: Record<string, string[]> = {
  inventory: ['catalog'], pricing: ['catalog'], promotions: ['pricing'], tax: ['pricing'],
  shipping: ['inventory'], payments: ['identity'], checkout: ['pricing', 'promotions', 'tax', 'shipping', 'payments'],
  orders: ['checkout', 'identity'], fulfillment: ['orders', 'inventory'], returns: ['orders', 'payments'],
  notifications: ['orders'], analytics: ['orders', 'payments'], subscriptions: ['payments', 'pricing'], support: ['orders', 'returns'],
}
for (const domain of domains) {
  const p = (part: string) => `services/${domain}/${part}.ts`
  add(p('schema'), ['platform/errors.ts'])
  add(p('repository'), [p('schema'), 'platform/database.ts'])
  add(p('policy'), [p('schema'), 'platform/config.ts'])
  add(p('service'), [p('repository'), p('policy'), 'platform/logger.ts', ...(upstream[domain] ?? []).map(d => `services/${d}/service.ts`)])
  add(p('controller'), [p('service'), 'platform/http.ts'])
  add(p('routes'), [p('controller'), 'platform/metrics.ts'])
  add(p('worker'), [p('service'), 'platform/events.ts'])
  add(p('service.test'), [p('service')])
  add(`apps/storefront/${domain}.ts`, [p('routes'), 'platform/cache.ts'])
  add(`apps/admin/${domain}.ts`, [p('routes')])
}
writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true }, include: ['**/*.ts'] }, null, 2))
writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'atlas-commerce-graph-sample', private: true, type: 'module' }, null, 2))
writeFileSync(resolve(dir, '.gitignore'), '.room.json\n')
writeFileSync(resolve(dir, 'README.md'), `# Atlas Commerce — graph scale sample\n\n${sources.size} generated TypeScript files across 16 domains, two apps, and shared infrastructure.\n\nThis is an illustrative dependency fixture, not a functioning commerce product. Functions deliberately expose real static imports and unique symbols so Room can index them without invented graph edges.\n\nThe Room preview contains sample scopes, claims, and overlays for four participants. Edit files in this repository to update Kieran's overlay live while the generator is running. The other participants are synthetic fixtures.\n\nRoom: ${roomName}\n`)
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Room Sample', '-c', 'user.email=sample@room.local', 'commit', '-qm', 'Generate illustrative commerce dependency fixture')
const base = git('rev-parse', 'HEAD')
const daemon = await startRoomd({ room: roomUrl, dir, name: 'Kieran', kind: 'agent' })
const room: RoomDoc = daemon.roomDoc
const participants = [
  { name: 'Kieran', domain: 'checkout', task: 'Coordinate shipping totals and checkout summary', files: ['services/checkout/service.ts', 'services/checkout/controller.ts', 'apps/storefront/checkout.ts'] },
  { name: 'Rohan', domain: 'pricing', task: 'Introduce a structured pricing quote', files: ['services/pricing/service.ts', 'services/pricing/schema.ts', 'services/promotions/policy.ts'] },
  { name: 'Maya', domain: 'inventory', task: 'Add inventory reservations for fulfillment', files: ['services/inventory/service.ts', 'services/inventory/repository.ts', 'services/fulfillment/worker.ts'] },
  { name: 'Alex', domain: 'payments', task: 'Add idempotent payment retries', files: ['services/payments/service.ts', 'services/payments/policy.ts', 'services/orders/worker.ts'] },
]
for (const person of participants) {
  room.setBaseOf(person.name, base)
  room.setScope({ by: person.name, byKind: 'agent', area: person.domain, summary: `[SAMPLE] ${person.task}`, paths: person.files, at: Date.now() })
  room.post<ScopeMsg>({ name: person.name, kind: 'agent' }, { type: 'scope', area: person.domain, summary: `[SAMPLE] ${person.task}`, paths: person.files })
  for (const file of person.files) {
    const text = sources.get(file)!.text + `\n// SAMPLE in-progress change: ${person.task}.\n`
    if (person.name === 'Kieran') writeFileSync(resolve(dir, file), text)
    else room.setOverlay(person.name, file, text)
    // Service interfaces have contract plans; supporting changes are ordinary edits.
    room.addClaim({ by: person.name, byKind: 'agent', path: file, from: 1, to: 8, intent: `[SAMPLE] ${person.task}`, plans: file.endsWith('/service.ts') ? [{ kind: 'signature', symbol: sources.get(file)!.symbol, detail: person.task }] : [] })
  }
}
const indexes = participants.map(p => new GraphIndex(room, p.name, dir, console.log))
for (const index of indexes) { index.start(); await index.whenIdle() }
const snapshot = room.graphs.get('Kieran')!
if (snapshot.paths.length !== sources.size) throw new Error(`Expected ${sources.size} indexed paths, got ${snapshot.paths.length}`)
const expectedEdges = new Set([...sources].flatMap(([target, source]) => source.deps.map(provider => JSON.stringify([provider, target]))))
const indexedEdges = new Set(snapshot.edges.map(edge => JSON.stringify([edge.source, edge.target])))
if (expectedEdges.size !== indexedEdges.size || [...expectedEdges].some(edge => !indexedEdges.has(edge))) {
  throw new Error('The indexed graph does not match the generated imports')
}
console.log(JSON.stringify({ dir, roomUrl, files: snapshot.paths.length, edges: snapshot.edges.length, participants: participants.length,
  browser: `${option('--web', 'http://localhost:5173')}/?room=${encodeURIComponent(roomUrl)}&participant=Kieran&network=all` }, null, 2))
console.log('Sample is live. Edit the generated repository to update Kieran’s changes. Ctrl-C stops the publisher.')
process.on('SIGINT', async () => { indexes.forEach(i => i.stop()); await daemon.stop(); process.exit(0) })
