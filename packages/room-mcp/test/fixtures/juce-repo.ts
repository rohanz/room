/** Tests: a C++/JUCE-shaped lead clone with worker worktrees, a vendored gitignored tree and build output. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc } from '@room/shared'
import * as Y from 'yjs'
import { prepareWorktree } from '../../src/worker-git.js'
import type { HandlerState } from '../../src/tools/context.js'
import type { Session } from '../../src/session.js'
import { localWorkers } from '../../src/worker-registry.js'
import { registerWorkers } from '../registry-fixture.js'
import { hubSeam } from './hub.js'
import { testPolicyStore } from '../policy-fixture.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
export const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }

const source = (name: string, lines = 40) => Array.from({ length: lines }, (_, i) => `// ${name} line ${i}\nint ${name.replace(/\W/g, '_')}_${i}() { return ${i}; }`).join('\n') + '\n'

/** `count` files under `dir`, ten per directory, three levels deep (a vendored library's shape). */
function vendoredTree(root: string, dir: string, count: number): void {
  for (let i = 0; i < count; i++) put(root, `${dir}/modules/m${Math.floor(i / 100)}/sub${Math.floor(i / 10) % 10}/f${i}.cpp`, `// vendored ${i}\n`)
}

interface JuceWorker { tag: string; dir: string; base: string; carriedUntracked: { path: string; sha: string; mode?: number }[] }
export interface JuceRepo { root: string; lead: string; base: string; workers: JuceWorker[] }

/**
 * A lead with `tracked` committed sources, `ignored` vendored files and a build dir, `untracked` (not ignored)
 * generated sources that spawn carries into every worker, plus worker worktrees under .room/workers.
 * `committed` files join the base commit; `leadFiles` are the lead's untracked files at spawn, carried too.
 */
export async function juceRepo({ tracked = 300, ignored = 5000, built = 500, untracked = 0, workers = ['w1', 'w2'], ignoredInWorkers = true, committed = {}, leadFiles = {} }: { tracked?: number; ignored?: number; built?: number; untracked?: number; workers?: string[]; ignoredInWorkers?: boolean; committed?: Record<string, string>; leadFiles?: Record<string, string> } = {}): Promise<JuceRepo> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-juce-'))
  const lead = path.join(root, 'lead')
  fs.mkdirSync(lead)
  git(lead, 'init', '-q'); git(lead, 'config', 'user.name', 'Lead'); git(lead, 'config', 'user.email', 'lead@example.test')
  fs.appendFileSync(path.join(lead, '.git', 'info', 'exclude'), '.room/\n')
  put(lead, '.gitignore', 'JUCE/\nbuild/\ncmake-build-*/\n')
  put(lead, 'CMakeLists.txt', 'cmake_minimum_required(VERSION 3.22)\n')
  for (let i = 0; i < tracked; i++) put(lead, `Source/part${Math.floor(i / 20)}/Unit${i}.cpp`, source(`Unit${i}`))
  for (const [p, text] of Object.entries(committed)) put(lead, p, text)
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base')
  const base = git(lead, 'rev-parse', 'HEAD')
  const fill = (dir: string) => {
    vendoredTree(dir, 'JUCE', ignored)
    for (let i = 0; i < built; i++) put(dir, `build/obj/o${Math.floor(i / 50)}/u${i}.o`, `object ${i}\n`)
  }
  fill(lead)
  for (const [p, text] of Object.entries(leadFiles)) put(lead, p, text)
  for (let i = 0; i < untracked; i++) put(lead, `JuceLibraryCode/gen${Math.floor(i / 50)}/BinaryData${i}.cpp`, source(`BinaryData${i}`, 4))
  const made: JuceWorker[] = []
  for (const tag of workers) {
    const prepared = await prepareWorktree(lead, tag, 'lead')
    if (prepared.carryFailed) throw new Error('fixture carry failed: ' + prepared.carryError)
    if (ignoredInWorkers) fill(prepared.dir)
    made.push({ tag, dir: prepared.dir, base: prepared.base ?? base, carriedUntracked: prepared.carriedUntracked ?? [] })
  }
  return { root, lead, base, workers: made }
}

/** Replace one line of a committed source so a change is a real, mergeable edit. */
export function editLine(dir: string, rel: string, line: number, text: string): void {
  const file = path.join(dir, rel)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines[line] = text
  fs.writeFileSync(file, lines.join('\n'))
}

/** A local lead session over `repo` with its workers registered as finished, and the handler state the file tools need. */
export async function juceSession(repo: JuceRepo): Promise<{ session: Session; state: HandlerState }> {
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base: repo.base, branch: 'main', repo: 'test' })
  const s = { ...hubSeam(room), policyStore: testPolicyStore(), dir: repo.lead, local: {}, me: { name: 'lead', kind: 'agent' }, roomName: 'local/test/main', room, awareness: { getStates: () => new Map() }, daemon: {} }
  const session = s as unknown as Session
  await registerWorkers(session, repo.workers.map(w => ({ tag: w.tag, name: `lead+${w.tag}`, lead: 'lead', dir: w.dir, branch: `room/${w.tag}`,
    status: 'done' as const, exitCode: 0, summary: 'finished', base: w.base, carriedUntracked: w.carriedUntracked, host: 'codex' as const, task: 'task', pid: 0, startedAt: 1 })))
  const state = {
    S: () => s, rooms: { all: () => [s], holding: () => s, holdingWorker: () => s, reserve: () => true, unreserve() {}, autoRetire: async () => {}, project: async () => {} },
    myWorkers: () => localWorkers(repo.lead), workerAlive: () => false, others: () => repo.workers.map(w => `lead+${w.tag}`), presences: () => [],
    withheld: () => undefined, baseFor: () => repo.base, shareOf: () => 'full', liveText: async () => undefined,
  } as unknown as HandlerState
  return { session, state }
}
