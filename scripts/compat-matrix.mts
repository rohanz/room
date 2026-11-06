// Real process fixtures, no models. --list is socket/network/build-free.
// --concurrency N bounds pairs within each release; --concurrency 1 measures serial execution.
// COMPAT_CACHE_DIR opts into persistent immutable preparations; use a dedicated, single-writer
// directory outside the checkout. Without it only candidate + one pinned installation live at once.
// Invoke through tsx: its dynamic-import transform cannot handle a shebang here.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validatePins, validatePinCommit } from './compat-pins.mjs'
import { run, capture, timed, boundedMap } from './compat-process.mts'

type Pin = { tag: string; commit?: string; unsupported?: Partial<Record<NodeJS.Platform, string>> }
export type Pair = { tag: string; transport: 'server' | 'relay' | 'daemon'; authority: 'old' | 'new'; client: 'old' | 'new'; skip?: string }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The pairs for every pin; an old authority that cannot start on this platform is planned as a skip with its reason. */
export function pairPlan(pins: Pin[], platform: NodeJS.Platform = process.platform): Pair[] {
  validatePins(pins)
  return pins.flatMap(pin => [...(['server', 'relay'] as const).flatMap(transport => {
    const unsupported = pin.unsupported?.[platform]
    return [
      { tag: pin.tag, transport, authority: 'old' as const, client: 'new' as const, ...(unsupported ? { skip: unsupported } : {}) },
      { tag: pin.tag, transport, authority: 'new' as const, client: 'old' as const },
    ]
  }), { tag: pin.tag, transport: 'daemon' as const, authority: 'new' as const, client: 'old' as const }])
}
export function pendingCandidate(pin: Pin, version: string, error: unknown): boolean {
  return !pin.commit && pin.tag === `v${version}` && /couldn't find remote ref|not our ref/.test(String(error))
}
export function selectPairs(pins: Pin[], only?: string, platform: NodeJS.Platform = process.platform): Pair[] {
  const pairs: Pair[] = [...pairPlan(pins, platform), ...(['server', 'relay', 'daemon'] as const).map(transport => ({ tag: 'candidate', transport, authority: 'new' as const, client: 'new' as const }))]
  if (!only) return pairs
  const [tag, transport, extra] = only.split(':')
  if (extra !== undefined || !pairs.some(pair => pair.tag === tag) || (transport !== undefined && !['server', 'relay', 'daemon'].includes(transport))) {
    throw new Error(`invalid --only ${only}; expected <pinned-tag|candidate>[:server|relay|daemon]`)
  }
  return pairs.filter(pair => pair.tag === tag && (!transport || pair.transport === transport))
}

/** Socket-free preflight shared by every built implementation before its first pair. */
export async function validateDescriptor(dir: string, pin?: Pin) {
  const version = JSON.parse(await fs.readFile(path.join(dir, 'plugins/room/.claude-plugin/plugin.json'), 'utf8')).version
  const implementation = await import(pathToFileURL(path.join(dir, '.compat-exports.bundle.mjs')).href)
  let raw: string
  try { raw = await fs.readFile(path.join(dir, 'plugins/room/server/compat.json'), 'utf8') }
  catch (error) {
    // The frozen pre-descriptor releases export neither of these contracts.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pin?.commit
      && ['v0.17.0', 'v0.17.32'].includes(pin.tag) && pin.tag === `v${version}`
      && implementation.contracts.CURRENT_COMPAT === undefined && implementation.workerRecords.WORKER_RECORD_SCHEMA === undefined) return
    throw new Error(`missing or unreadable compat.json for ${pin?.tag ?? 'candidate'}: ${error}`)
  }
  let descriptor: any
  try { descriptor = JSON.parse(raw) } catch { throw new Error('corrupt compat.json: invalid JSON') }
  if (!descriptor || descriptor.v !== 1) throw new Error('corrupt compat.json: expected descriptor version 1')
  if (descriptor.release !== version) throw new Error(`compat.json release mismatch: expected ${version}`)
  if (descriptor.bundleSha256 !== await digest(path.join(dir, 'plugins/room/server/room-mcp.mjs'))) throw new Error('compat.json bundle digest mismatch')
  if (!implementation.contracts.CURRENT_COMPAT || !isDeepStrictEqual(descriptor.compat, implementation.contracts.CURRENT_COMPAT)) throw new Error('compat.json advertisement mismatch with exercised implementation')
  if (!Number.isSafeInteger(descriptor.workerRecordSchema) || descriptor.workerRecordSchema < 1
    || descriptor.workerRecordSchema !== implementation.workerRecords.WORKER_RECORD_SCHEMA) throw new Error('compat.json worker-record schema mismatch with exercised implementation')
}
const digest = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex')

export function parseConcurrency(value?: string, cores = os.availableParallelism()): number {
  if (value === undefined) return Math.min(cores, 4)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--concurrency must be a positive integer')
  return Number(value)
}

async function build(dir: string, pin?: Pin) {
  const label = pin?.tag ?? 'candidate'
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run with npx tsx scripts/compat-matrix.mts (npm_execpath is required)')
  await timed(`${label} install`, () => run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], dir, 240_000))
  return timed(`${label} build`, async () => {
    // Released scripts, unchanged. The plugin bundle contains that release's relay.
    await run(process.execPath, ['scripts/build-server.mjs'], dir)
    await run(process.execPath, ['scripts/build-plugin.mjs', '--skip-web'], dir)
    // Export the genuine released APIs for process fixtures, without editing old source.
    const entry = path.join(dir, '.compat-exports.mjs')
    const daemonSource = path.join(dir, 'packages/relay/src/daemon.ts')
    const hasDaemon = await fs.access(daemonSource).then(() => true, () => false)
    const hasClientCompat = await fs.access(path.join(dir, 'packages/room-mcp/src/client-compat.ts')).then(() => true, () => false)
    // Process identity moved from relay to local-state after 0.17.39.
    const processSource = await fs.access(path.join(dir, 'packages/local-state/src/process.ts')).then(() => './packages/local-state/src/process.ts', () => './packages/relay/src/process.ts')
    await fs.writeFile(entry, [
      ...(hasClientCompat ? ["export * as clientCompat from './packages/room-mcp/src/client-compat.ts'"] : []),
      ...(hasDaemon ? ["export * as daemon from './packages/relay/src/daemon.ts'"] : []),
      "export * as contracts from './packages/hub-core/src/protocol.ts'",
      "export * as workerRecords from './packages/shared/src/index.ts'",
      `export * as processes from '${processSource}'`,
      "export { WebSocket } from 'ws'",
      "export { startRelay, AuthorityLock, SecureSession } from './packages/relay/src/index.ts'",
      "export { HubClient, hubTransport } from './packages/room-mcp/src/hub-client.ts'",
      "export { authorizedWebSocket } from './packages/roomd/src/ws-auth.ts'",
      "export { RoomDoc, roomConnection } from './packages/shared/src/index.ts'",
      "export { WebsocketProvider } from 'y-websocket'",
      "export { Doc } from 'yjs'",
    ].join('\n'))
    const buildScript = "import {build} from 'esbuild'; await build({entryPoints:['.compat-exports.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',external:['yjs','ws'],outfile:'.compat-exports.bundle.mjs',banner:{js:\"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);\"}})"
    await run(process.execPath, ['--input-type=module', '-e', buildScript], dir)
    await validateDescriptor(dir, pin)
    return {
      node: process.version,
      npm: (await run(process.execPath, [npmCli, '--version'], dir)).trim(),
      lockSha256: await digest(path.join(dir, 'package-lock.json')),
      serverSha256: await digest(path.join(dir, 'packages/server/dist/server.mjs')),
      pluginSha256: await digest(path.join(dir, 'plugins/room/server/room-mcp.mjs')),
      fixtureSha256: await digest(path.join(dir, '.compat-exports.bundle.mjs')),
    }
  })
}

async function main() {
  const args = process.argv.slice(2)
  let list = false, only: string | undefined, concurrency = parseConcurrency()
  while (args.length) {
    const flag = args.shift()
    if (flag === '--list') list = true
    else if (flag === '--concurrency' && args.length) concurrency = parseConcurrency(args.shift())
    else if (flag === '--only' && args.length && !only) only = args.shift()
    else throw new Error('usage: npx tsx scripts/compat-matrix.mts [--list] [--concurrency N] [--only <tag|candidate>[:server|relay|daemon]]')
  }
  const pins: Pin[] = validatePins(JSON.parse(await fs.readFile(path.join(root, 'scripts/compat-pins.json'), 'utf8')))
  const plan = selectPairs(pins, only)
  const version = JSON.parse(await fs.readFile(path.join(root, 'plugins/room/.claude-plugin/plugin.json'), 'utf8')).version
  const localTags = new Set((await capture('git', ['for-each-ref', '--format=%(refname)', 'refs/tags'], root)).trim().split('\n'))
  for (const pin of pins) {
    const commit = localTags.has(`refs/tags/${pin.tag}`)
      ? (await capture('git', ['rev-parse', '--verify', `refs/tags/${pin.tag}^{commit}`], root)).trim() : undefined
    validatePinCommit(pin, version, commit)
  }
  if (list) { console.table(plan); return }
  console.log(`compat concurrency=${concurrency}`)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'room-compat-'))
  const repo = path.join(scratch, 'repo.git')
  const rows: Array<Record<string, unknown>> = []
  try {
    // All Git mutations stay in scratch, including fetches and worktree metadata.
    await timed('matrix clone', () => run('git', ['clone', '--bare', '--no-hardlinks', root, repo], scratch))
    const remote = (await capture('git', ['remote', 'get-url', 'origin'], root)).trim()
    const commits = new Map<string, string>()
    for (const pin of pins) {
      const ref = `refs/compat/${pin.tag}`
      try { await timed(`${pin.tag} fetch`, () => run('git', ['--git-dir', repo, 'fetch', '--no-tags', remote, `refs/tags/${pin.tag}:${ref}`], scratch)) }
      catch (error) {
        if (pendingCandidate(pin, version, error)) { rows.push({ tag: pin.tag, status: 'PENDING' }); continue }
        throw error
      }
      const commit = (await capture('git', ['--git-dir', repo, 'rev-parse', `${ref}^{commit}`], scratch)).trim()
      validatePinCommit(pin, version, commit)
      commits.set(pin.tag, commit)
    }
    const current = path.join(scratch, 'current')
    await timed('candidate checkout', () => run('git', ['--git-dir', repo, 'worktree', 'add', '--detach', current, 'HEAD'], scratch))
    const patch = await capture('git', ['diff', '--binary', 'HEAD'], root)
    if (patch) await run('git', ['apply', '--binary', '-'], current, 30_000, patch)
    const untracked = (await capture('git', ['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter(Boolean)
    for (const file of untracked) {
      const target = path.join(current, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(path.join(root, file), target)
    }
    console.log('candidate', JSON.stringify({ commit: (await capture('git', ['rev-parse', 'HEAD'], root)).trim(), dirty: !!patch || !!untracked.length, ...await build(current) }))
    async function pairs(tag: string, old: string) {
      const results = await boundedMap(plan.filter(pair => pair.tag === tag), concurrency, async pair => {
        if (pair.skip) {
          console.log(`SKIP ${pair.tag} ${pair.transport} old authority on ${process.platform}: ${pair.skip}`)
          return { ...pair, status: 'SKIP' }
        }
        const started = performance.now()
        const label = `${pair.tag} ${pair.transport} ${pair.authority}->${pair.client}`
        try {
          const output = await run(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/compat-pair.mts'), pair.transport,
            pair.authority === 'old' ? old : current, pair.client === 'old' ? old : current, scratch], root, 30_000)
          console.log(`PAIR ${label}\n${output.trim()}\nEND ${label}`)
          return { ...pair, status: 'PASS', ms: Math.round(performance.now() - started) }
        } catch (error) {
          console.error(`PAIR ${label}\n${String(error)}\nEND ${label}`)
          if (process.exitCode === 130 || process.exitCode === 143) throw error
          return { ...pair, status: 'FAIL', ms: Math.round(performance.now() - started) }
        }
      })
      rows.push(...results)
    }
    await pairs('candidate', current)
    // Cache only immutable releases, never the dirty candidate. The key also invalidates
    // installed native dependencies and fixture generation when their inputs change.
    // Use a dedicated directory owned by this run (CI restores it before invocation).
    const cacheRoot = process.env.COMPAT_CACHE_DIR
    const recipe = createHash('sha256').update(await fs.readFile(path.join(root, 'scripts/compat-matrix.mts'))).update(await fs.readFile(path.join(root, 'scripts/compat-process.mts'))).digest('hex')
    const npmVersion = (await run(process.execPath, [process.env.npm_execpath!, '--version'], root)).trim()
    for (const pin of pins) {
      const commit = commits.get(pin.tag)
      if (!commit || !plan.some(pair => pair.tag === pin.tag)) continue
      const runtimeRecipe = createHash('sha256').update(`${process.platform}-${process.arch}-${process.version}-${npmVersion}-${recipe}`).digest('hex').slice(0, 16)
      const key = `${commit}-${runtimeRecipe}`
      const old = cacheRoot ? path.resolve(cacheRoot, key) : path.join(scratch, pin.tag)
      const marker = path.join(old, '.compat-ready.json')
      let metadata: Awaited<ReturnType<typeof build>> | undefined
      if (cacheRoot) {
        try { metadata = JSON.parse(await fs.readFile(marker, 'utf8')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      if (metadata) {
        await timed(`${pin.tag} cache-check`, async () => {
          for (const [file, expected] of [
            ['package-lock.json', metadata!.lockSha256],
            ['packages/server/dist/server.mjs', metadata!.serverSha256],
            ['plugins/room/server/room-mcp.mjs', metadata!.pluginSha256],
            ['.compat-exports.bundle.mjs', metadata!.fixtureSha256],
          ]) if (await digest(path.join(old, file)) !== expected) throw new Error(`corrupt compatibility cache: ${old}/${file}`)
          await validateDescriptor(old, pin)
        })
        console.log(`${pin.tag} cache HIT`)
      } else {
        await fs.rm(old, { recursive: true, force: true })
        await fs.mkdir(path.dirname(old), { recursive: true })
        await timed(`${pin.tag} checkout`, () => run('git', ['--git-dir', repo, 'worktree', 'add', '--detach', old, commit], scratch))
        metadata = await build(old, pin)
        if (cacheRoot) {
          // Detach the cached source tree from disposable worktree metadata.
          await fs.rm(path.join(old, '.git'))
          // The marker is what makes an entry a cache hit, so it appears whole or not at all.
          const pending = `${marker}.${process.pid}.tmp`
          await fs.writeFile(pending, JSON.stringify(metadata))
          await fs.rename(pending, marker)
        }
      }
      console.log(pin.tag, JSON.stringify({ commit, ...metadata }))
      await pairs(pin.tag, old)
      if (!cacheRoot) await timed(`${pin.tag} cleanup`, () => run('git', ['--git-dir', repo, 'worktree', 'remove', '--force', old], scratch))
    }
    if (rows.some(row => row.status === 'FAIL')) process.exitCode = 1
  } finally {
    console.table(rows)
    await timed('matrix cleanup', () => fs.rm(scratch, { recursive: true, force: true }))
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode ||= 1 })
}
