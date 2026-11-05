// Real process fixtures, no models. --list is socket/network/build-free.
// Invoke through tsx: its dynamic-import transform cannot handle a shebang here.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validatePins, validatePinCommit } from './compat-pins.mjs'
import { run } from './compat-process.mts'

type Pin = { tag: string; commit?: string }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function pairPlan(pins: Pin[]) {
  validatePins(pins)
  return pins.flatMap(pin => (['server', 'relay'] as const).flatMap(transport => [
    { tag: pin.tag, transport, authority: 'old', client: 'new' },
    { tag: pin.tag, transport, authority: 'new', client: 'old' },
  ]))
}
export function pendingCandidate(pin: Pin, version: string, error: unknown): boolean {
  return !pin.commit && pin.tag === `v${version}` && /couldn't find remote ref|not our ref/.test(String(error))
}
export function selectPairs(pins: Pin[], only?: string) {
  const pairs = [...pairPlan(pins), ...(['server', 'relay'] as const).map(transport => ({ tag: 'candidate', transport, authority: 'new', client: 'new' }))]
  if (!only) return pairs
  const [tag, transport, extra] = only.split(':')
  if (extra !== undefined || !pairs.some(pair => pair.tag === tag) || (transport !== undefined && !['server', 'relay'].includes(transport))) {
    throw new Error(`invalid --only ${only}; expected <pinned-tag|candidate>[:server|relay]`)
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

async function build(dir: string, pin?: Pin) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run with npx tsx scripts/compat-matrix.mts (npm_execpath is required)')
  await run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], dir, 240_000)
  // Released scripts, unchanged. The plugin bundle contains that release's relay.
  await run(process.execPath, ['scripts/build-server.mjs'], dir)
  await run(process.execPath, ['scripts/build-plugin.mjs', '--skip-web'], dir)
  // Export the genuine released APIs for process fixtures, without editing old source.
  const entry = path.join(dir, '.compat-exports.mjs')
  await fs.writeFile(entry, [
    "export * as contracts from './packages/hub-core/src/protocol.ts'",
    "export * as workerRecords from './packages/shared/src/index.ts'",
    "export * as processes from './packages/relay/src/process.ts'",
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
}

async function main() {
  const args = process.argv.slice(2)
  let list = false, only: string | undefined
  while (args.length) {
    const flag = args.shift()
    if (flag === '--list') list = true
    else if (flag === '--only' && args.length && !only) only = args.shift()
    else throw new Error('usage: npx tsx scripts/compat-matrix.mts [--list] [--only <tag|candidate>[:server|relay]]')
  }
  const pins: Pin[] = validatePins(JSON.parse(await fs.readFile(path.join(root, 'scripts/compat-pins.json'), 'utf8')))
  const plan = selectPairs(pins, only)
  const version = JSON.parse(await fs.readFile(path.join(root, 'plugins/room/.claude-plugin/plugin.json'), 'utf8')).version
  const localTags = new Set((await run('git', ['for-each-ref', '--format=%(refname)', 'refs/tags'], root)).trim().split('\n'))
  for (const pin of pins) {
    const commit = localTags.has(`refs/tags/${pin.tag}`)
      ? (await run('git', ['rev-parse', '--verify', `refs/tags/${pin.tag}^{commit}`], root)).trim() : undefined
    validatePinCommit(pin, version, commit)
  }
  if (list) { console.table(plan); return }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'room-compat-'))
  const repo = path.join(scratch, 'repo.git')
  const rows: Array<Record<string, unknown>> = []
  try {
    // All Git mutations stay in scratch, including fetches and worktree metadata.
    await run('git', ['clone', '--bare', '--no-hardlinks', root, repo], scratch)
    const remote = (await run('git', ['remote', 'get-url', 'origin'], root)).trim()
    const commits = new Map<string, string>()
    for (const pin of pins) {
      const ref = `refs/compat/${pin.tag}`
      try { await run('git', ['--git-dir', repo, 'fetch', '--no-tags', remote, `refs/tags/${pin.tag}:${ref}`], scratch) }
      catch (error) {
        if (pendingCandidate(pin, version, error)) { rows.push({ tag: pin.tag, status: 'PENDING' }); continue }
        throw error
      }
      const commit = (await run('git', ['--git-dir', repo, 'rev-parse', `${ref}^{commit}`], scratch)).trim()
      validatePinCommit(pin, version, commit)
      commits.set(pin.tag, commit)
    }
    const current = path.join(scratch, 'current')
    await run('git', ['--git-dir', repo, 'worktree', 'add', '--detach', current, 'HEAD'], scratch)
    const patch = await run('git', ['diff', '--binary', 'HEAD'], root)
    if (patch) await run('git', ['apply', '--binary', '-'], current, 30_000, patch)
    const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter(Boolean)
    for (const file of untracked) {
      const target = path.join(current, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(path.join(root, file), target)
    }
    console.log('candidate', JSON.stringify({ commit: (await run('git', ['rev-parse', 'HEAD'], root)).trim(), dirty: !!patch || !!untracked.length, ...await build(current) }))
    for (const pair of plan.filter(pair => pair.tag === 'candidate')) {
      const { transport } = pair
      const started = Date.now()
      try {
        console.log((await run(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/compat-pair.mts'), transport, current, current], root, 30_000)).trim())
        rows.push({ ...pair, status: 'PASS', ms: Date.now() - started })
      } catch (error) { if (process.exitCode === 130 || process.exitCode === 143) throw error; rows.push({ ...pair, status: 'FAIL', ms: Date.now() - started }); console.error(String(error)) }
    }
    for (const pin of pins) {
      const commit = commits.get(pin.tag)
      if (!commit || !plan.some(pair => pair.tag === pin.tag)) continue
      const old = path.join(scratch, pin.tag)
      await run('git', ['--git-dir', repo, 'worktree', 'add', '--detach', old, commit], scratch)
      console.log(pin.tag, JSON.stringify({ commit, ...await build(old, pin) }))
      for (const pair of plan.filter(row => row.tag === pin.tag)) {
        const started = Date.now()
        try {
          const output = await run(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/compat-pair.mts'), pair.transport,
            pair.authority === 'old' ? old : current, pair.client === 'old' ? old : current], root, 30_000)
          console.log(output.trim())
          rows.push({ ...pair, status: 'PASS', ms: Date.now() - started })
        } catch (error) { if (process.exitCode === 130 || process.exitCode === 143) throw error; rows.push({ ...pair, status: 'FAIL', ms: Date.now() - started }); console.error(String(error)) }
      }
      // Bound installed dependency disk/heap use: only one archived tag at a time.
      await run('git', ['--git-dir', repo, 'worktree', 'remove', '--force', old], scratch)
    }
    if (rows.some(row => row.status === 'FAIL')) process.exitCode = 1
  } finally {
    console.table(rows)
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode ||= 1 })
}
