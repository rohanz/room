// Study only. Real production spawn/keep/refresh and ConflictSet at main 2152836e;
// synthetic hosts and complete publications, as in the archived review fixtures.
// Native ancestry below is EXPLICIT event bookkeeping, not a proposed production implementation.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { commit, git, put, repo, world } from '../../../../packages/room-mcp/test/worker-refresh-fixture.js'
import { workerByTag } from '../../../../packages/room-mcp/test/registry-fixture.js'
import { ConflictSet, type ConflictSlot } from '../../../../packages/room-mcp/src/conflict-set.js'
import type { Session } from '../../../../packages/room-mcp/src/session.js'

const O = 'one\ncommitted\nthree\nfour\nfive\n'
const G = O.replace('committed', 'received')
const B = G.replace('received', 'D delivered')
const C = G.replace('received', 'adopted C')
const D = G.replace('received', 'D new')
const E = G.replace('received', 'U edit')
type Actor = 'L' | 'd' | 'u'
type State = 'clean' | 'conflict'
type Spec = { id: string; source: string; kind?: 'untracked' | 'committed'; expected: State; pair?: [Actor, Actor]; run: (f: Fixture) => Promise<void> }
const rows: unknown[] = []
const specs: Spec[] = []
const add = (id: string, source: string, expected: State, run: Spec['run'], options: Partial<Spec> = {}) => specs.push({ id, source, expected, run, ...options })
const source = 'archive/given:stale-carried-conflict.test.ts'

class Fixture {
  t!: ReturnType<typeof world>
  actors = new Map<Actor, { dir: string; name: string; node: string }>()
  mapped = new Map<string, string>()
  override = new Map<Actor, string>()
  omitCarried = new Set<Actor>()
  file = 'shared.txt'
  paths = new Set(['shared.txt'])
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-native-index-'))
  serial = 0
  notes: string[] = []
  constructor(public spec: Spec) {}
  get(a: Actor) { return this.actors.get(a)! }
  text(a: Actor, value: string, file = this.file) { this.paths.add(file); put(this.get(a).dir, file, value) }
  remove(a: Actor, file = this.file) { this.paths.add(file); fs.rmSync(path.join(this.get(a).dir, file), { force: true }) }
  tree(a: Actor) {
    const dir = this.get(a).dir, index = path.join(this.scratch, `${a}-index`)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim()
    run('read-tree', 'HEAD'); run('add', '-A', '--', '.'); return run('write-tree')
  }
  node(tree: string, parents: string[]) {
    return git(repo, '-c', 'commit.gpgsign=false', 'commit-tree', tree, ...[...new Set(parents)].flatMap(p => ['-p', p]), '-m', `study-${++this.serial}`)
  }
  snap(a: Actor, naive = false) { return this.node(this.tree(a), [naive ? git(this.get(a).dir, 'rev-parse', 'HEAD') : this.get(a).node]) }
  async init() {
    this.file = this.spec.kind === 'untracked' ? 'draft.txt' : 'shared.txt'; this.paths = new Set([this.file])
    if (this.spec.kind !== 'untracked') { put(repo, this.file, O); commit(repo, 'structured committed base') }
    if (this.spec.kind === 'committed') put(repo, this.file, G), commit(repo, 'committed received base')
    else put(repo, this.file, G)
    this.t = world()
    const head = git(repo, 'rev-parse', 'HEAD')
    this.actors.set('L', { dir: repo, name: 'rohanz', node: head })
    this.get('L').node = this.snap('L')
    this.mapped.set(head, this.get('L').node)
    await this.spawn('d'); await this.spawn('u')
  }
  async spawn(a: 'd' | 'u') {
    const stamp = a === 'd' ? '01' : '02'
    vi.stubEnv('GIT_AUTHOR_DATE', `2001-01-01T00:00:${stamp}Z`)
    vi.stubEnv('GIT_COMMITTER_DATE', `2001-01-01T00:00:${stamp}Z`)
    const w = await this.t.spawn(a)
    this.actors.set(a, { dir: w.dir, name: w.name, node: this.get('L').node })
    this.mapped.set(git(w.dir, 'rev-parse', 'HEAD'), this.get('L').node)
  }
  async keep(a: 'd' | 'u') {
    const before = this.snap('L'), worker = this.snap(a)
    await this.t.finish(a)
    const reply = await this.t.call('room_collect', { tag: a, keep: true })
    expect(reply).toContain(`kept ${a}`)
    this.notes.push(reply)
    // Full-tree merge ancestry is wrong when collection deliberately skipped a
    // scratch path. We still record that proposal here so the counterexample is visible.
    this.get('L').node = this.node(this.tree('L'), [before, worker])
    this.get(a).node = worker
  }
  userCommit(a: Actor) {
    const prior = this.get(a).node
    const real = commit(this.get(a).dir, 'study user commit')
    this.get(a).node = this.node(this.tree(a), [prior]); this.mapped.set(real, this.get(a).node)
    return real
  }
  async resume(a: 'd' | 'u', refresh = false) {
    const reply = await this.t.call('room_send', { type: 'note', to: this.get(a).name, text: 'study resume', refresh })
    this.notes.push(reply)
    if (reply.includes(`rebased ${a} onto your HEAD`)) {
      const real = git(repo, 'rev-parse', 'HEAD'), parent = this.mapped.get(real)!
      this.get(a).node = this.node(this.tree(a), [parent])
    }
    return reply
  }
  adopt(a: 'd' | 'u', real: string, merge = false) {
    if (merge) {
      const prior = this.get(a).node
      git(this.get(a).dir, 'merge', '--no-ff', '--no-edit', real)
      this.get(a).node = this.node(this.tree(a), [prior, this.mapped.get(real)!])
    } else {
      git(this.get(a).dir, 'merge', '--ff-only', real)
      // Carrying an untracked draft through adoption requires a shadow tree
      // which still contains it; this is measured separately below.
      this.get(a).node = this.mapped.get(real)!
    }
  }
  async adopted(only?: 'd' | 'u', merge = false, unrelated = false, resolution = false) {
    this.text('d', B); await this.keep('d'); await this.resume('d')
    const dc = this.userCommit('d')
    git(repo, 'checkout', '--', this.file)
    git(repo, 'merge', '--no-edit', '-X', 'theirs', dc)
    git(repo, 'merge', '--no-edit', '-X', 'ours', git(this.get('u').dir, 'rev-parse', 'HEAD'))
    // The actual merge adopted D's commit; bind the native lead node to it too.
    this.get('L').node = this.node(this.tree('L'), [this.get('L').node, this.get('d').node, this.get('u').node])
    this.mapped.set(git(repo, 'rev-parse', 'HEAD'), this.get('L').node)
    if (unrelated) this.text('L','new dependency\n','common-only.txt')
    else this.text('L', C)
    let common = this.userCommit('L')
    if (resolution) {
      common=git(repo,'commit-tree',git(repo,'rev-parse','HEAD^{tree}'),'-p',dc,'-p',git(this.get('u').dir,'rev-parse','HEAD'),'-m','explicit C merge resolution')
      git(repo,'reset','--hard',common)
      this.get('L').node=this.node(this.tree('L'),[this.get('d').node,this.get('u').node])
      this.mapped.set(common,this.get('L').node)
    }
    for (const a of (only ? [only] : ['d', 'u']) as ('d' | 'u')[]) this.adopt(a, common, merge)
    return { common, dc }
  }
  native(a: Actor, b: Actor, naive = false) {
    const aa = this.snap(a, naive), bb = this.snap(b, naive)
    const base = git(repo, 'merge-base', aa, bb)
    const p = spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', aa, bb], { encoding: 'utf8' })
    if (p.status !== 0 && p.status !== 1) throw new Error(p.stderr)
    return { status: p.status ? 'conflict' : 'clean', base, baseText: (() => { try { return git(repo, 'show', `${base}:${this.file}`) } catch { return null } })(), output: p.stdout }
  }
  async main(a: Actor, b: Actor) {
    const room = this.t.leadSession().room; room.ensureRoomSalt()
    const states = new Map([...this.actors.values()].map(w => [w.name, { user: { name: w.name, kind: 'agent' }, sessionId: w.name }]))
    for (const [actor, w] of this.actors) {
      const record = actor === 'L' ? undefined : await workerByTag(repo, w.name.slice(w.name.lastIndexOf('+')+1))
      const base = this.override.get(actor) ?? record?.base ?? git(w.dir, 'rev-parse', 'HEAD')
      room.participants.delete(`${w.name}\0proj`)
      epochPublication(room, w.name, base)
      room.participants.set(`${w.name}\0id`, { name: w.name, kind: 'agent' })
      room.participants.set(`${w.name}\0git`, { ...room.participants.get(`${w.name}\0git`)!, head: git(w.dir, 'rev-parse', 'HEAD') })
      room.manifestHead.set(w.name, { ...room.manifestHead.get(w.name)!, level: 'full' })
      const entries = new Y.Map<ManifestEntry>()
      const blobs = new Map(git(w.dir, 'ls-tree', '-r', '-z', base).split('\0').filter(Boolean).map(line => {
        const match = /^\d+ blob ([a-f0-9]+)\t(.*)$/s.exec(line)
        return match ? [match[2],match[1]] as const : ['', ''] as const
      }))
      for (const file of this.paths) {
        const hash = (this.omitCarried.has(actor) ? undefined : record?.carriedUntracked?.find(p => p.path === file)?.sha) ?? blobs.get(file)
        const text = fs.existsSync(path.join(w.dir, file)) ? fs.readFileSync(path.join(w.dir, file), 'utf8') : undefined
        if ((text === undefined ? undefined : gitBlobHash(text)) !== hash) {
          entries.set(file, { change: text === undefined ? 'D' : hash ? 'M' : 'A', state: 'shared', ...(text === undefined ? {} : { hash: gitBlobHash(text) }), at: 1, fence: '1' })
          if (text !== undefined) room.setOverlay(manifestKey(w.name, '1'), file, text)
        }
      }
      room.manifest.set(manifestKey(w.name, '1'), entries)
    }
    const answer = []
    for (const [owner, other] of [[a, b], [b, a]] as [Actor, Actor][]) {
      const w = this.get(owner)
      const post = vi.fn().mockResolvedValue({ ok: true })
      const s = { ...this.t.leadSession(), graph: undefined, me: { name: w.name, kind: 'agent' }, dir: w.dir, post,
        awareness: { getStates: () => states }, provider: { synced: true }, lease: { fence: () => '1' } } as unknown as Session
      const set = new ConflictSet(s, w.name, s, () => {}, 0)
      try { await set.reconcile('git-native study') } finally { set.stop() }
      const slots = [...room.doc.getMap<ConflictSlot>('conflicts').values()].filter(s => s.owner === w.name && s.other === this.get(other).name && s.kind === 'merge')
      answer.push({ owner, other, status: slots.some(s => s.status === 'conflict') ? 'conflict' : slots.some(s => s.status === 'unknown' || s.status === 'possible') ? 'unknown/possible' : 'clean',
        slots: slots.map(s => ({ path: s.path, status: s.status })), notices: post.mock.calls.map(c => c[1]).filter(n => n.type === 'merge-conflict').length })
    }
    return answer
  }
}

for (const kind of ['tracked', 'untracked'] as const) {
  const opts = kind === 'untracked' ? { kind } : {}
  add(`${kind}: D edits, siblings untouched`, source, 'clean', async f => { f.text('d', B) }, opts)
  add(`${kind}: keep D, sibling untouched`, source, 'clean', async f => { f.text('d', B); await f.keep('d') }, opts)
  add(`${kind}: keep U unrelated output too`, source, 'clean', async f => { f.text('d', B); await f.keep('d'); f.text('u', 'U output\n', 'u-only.txt'); await f.keep('u') }, opts)
  add(`${kind}: D edits again after keep`, source, 'clean', async f => { f.text('d', B); await f.keep('d'); await f.resume('d'); f.text('d', D) }, opts)
  add(`${kind}: lead commits kept output`, source, 'clean', async f => { f.text('d', B); await f.keep('d'); f.userCommit('L') }, opts)
  add(`${kind}: both edit before keep`, source, 'conflict', async f => { f.text('d', B); f.text('u', E) }, opts)
  add(`${kind}: both edit after D keep`, source, 'conflict', async f => { f.text('d', B); await f.keep('d'); f.text('d', D); f.text('u', E) }, opts)
  add(`${kind}: two keeps, D third round/U edit`, source, 'conflict', async f => { f.text('d', B); await f.keep('d'); f.text('d', D); await f.keep('d'); f.text('d', C); f.text('u', E) }, opts)
  add(`${kind}: disjoint edits`, source, 'clean', async f => { f.text('d', G.replace('one','D first')); f.text('u', G.replace('five','U last')) }, opts)
  add(`${kind}: disjoint edits after keep`, source, 'clean', async f => { f.text('d', G.replace('one','D first')); await f.keep('d'); f.text('d', G.replace('one','D first').replace('three','D middle')); f.text('u', G.replace('five','U last')) }, opts)
}
add('lead reverts delivered text; D changes again', 'stale-carried-conflict:revert', 'conflict', async f => { f.text('d', B); await f.keep('d'); f.text('L', G); f.text('d', D) }, { pair: ['L','d'] })
add('lead reverts; unchanged D versus U edit', 'unchanged-kept:republish then lead reverts', 'conflict', async f => { f.text('d', B); await f.keep('d'); f.text('L', G); f.text('u', E) })
add('kept worker commits later edit', 'own-baseline:committed post-keep edits', 'conflict', async f => { f.text('d', B); await f.keep('d'); f.text('d', D); f.userCommit('d'); f.text('u', E); f.userCommit('u'); f.override.set('d',git(f.get('d').dir,'rev-parse','HEAD')); f.override.set('u',git(f.get('u').dir,'rev-parse','HEAD')) })
for (const merge of [false,true]) add(`both adopt C by ${merge ? 'merge':'fast-forward'}, D reverts`, 'rev32/rev33:common adoption', 'conflict', async f => { await f.adopted(undefined, merge); f.text('d', G); f.text('u', E) })
for (const who of ['d','u'] as const) add(`only ${who.toUpperCase()} adopts C`, 'rev33:only adopter', who === 'd' ? 'clean' : 'conflict', async f => { await f.adopted(who); f.text('d', G); f.text('u', E) })
add('D resets away C after both adopt', 'rev33:reset', 'conflict', async f => { const {dc} = await f.adopted(); git(f.get('d').dir,'reset','--hard',dc); f.get('d').node=f.mapped.get(dc)!; f.text('d',G); f.text('u',E) })
add('both adopt C, committed revert', 'rev33:committed revert', 'conflict', async f => { await f.adopted(); f.text('d',G); f.userCommit('d'); f.text('u',E) })
add('both adopt merge resolution C', 'rev33:merge resolution', 'conflict', async f => { await f.adopted(undefined,false,false,true); f.text('d',G); f.userCommit('d'); f.text('u',E) })
add('committed tracked deletion', 'rev22:committed deletion', 'conflict', async f => { f.text('d',B); await f.keep('d'); f.remove('d'); const head=f.userCommit('d'); f.override.set('d',head); f.text('u',E) })
add('committed rename versus sibling edit', 'roadmap:F5 rename', 'conflict', async f => { f.text('d',B); await f.keep('d'); f.remove('d'); f.text('d',B,'renamed.txt'); const head=f.userCommit('d'); f.override.set('d',head); f.text('u',E) })
add('untracked draft committed then deleted', 'own-baseline:F5 untracked deletion', 'conflict', async f => { f.userCommit('d'); f.remove('d'); const head=f.userCommit('d'); f.override.set('d',head); f.omitCarried.add('d'); f.text('u',E) }, {kind:'untracked'})
add('scratch add/add remains after keep skipped it', 'unchanged-scratch:results.log', 'conflict', async f => { f.file='results.log'; f.text('d','D log\n'); f.text('u','U log\n'); await f.keep('d') })
add('refresh accepted with disjoint worker edit', 'stale-carried-conflict:refresh', 'clean', async f => { f.text('L',G.replace('five','lead last')); f.userCommit('L'); f.text('d',G.replace('one','D first')); await f.t.finish('d'); const r=await f.resume('d',true); expect(r).toContain('rebased d') })
add('refresh conflicting, unchanged on refusal', 'given-baseline:conflicting refresh', 'conflict', async f => { f.text('L',C); f.userCommit('L'); f.text('d',D); await f.t.finish('d'); expect(await f.resume('d',true)).toContain('did not refresh') }, { pair:['L','d'] })
add('adopt common unrelated commit, untracked draft survives', 'rev22:untracked common ancestor', 'clean', async f => {
  f.text('L','updated\n','keep.txt'); git(repo,'add','keep.txt'); git(repo,'commit','-qm','unrelated tracked dependency')
  const common=git(repo,'rev-parse','HEAD'); f.get('L').node=f.node(f.tree('L'),[f.get('L').node]); f.mapped.set(common,f.get('L').node)
  for(const a of ['d','u'] as const) f.adopt(a,common)
  f.text('d',G.replace('one','D first')); f.text('u',G.replace('five','U last'))
}, {kind:'untracked'})
add('shared adoption revert without keep', 'rev29:cold', 'conflict', async f => { f.text('L',C); const common=f.userCommit('L'); for(const a of ['d','u'] as const) f.adopt(a,common); f.text('d',G); f.text('u',E) }, {kind:'committed'})
add('shared adoption revert, prior conflict existed', 'rev29:existing conflict', 'conflict', async f => { f.text('L',C); const common=f.userCommit('L'); for(const a of ['d','u'] as const) f.adopt(a,common); f.text('d',D); f.text('u',E); await f.main('d','u'); f.text('d',G) }, {kind:'committed'})
add('later worker same bytes after lead commits and reverts', 'rev33:late U', 'clean', async f => {
  // Recreate U at a later point, with the same initial bytes but real ancestry
  // through a lead revision and revert. Do not identify events by equal blobs.
  f.text('L',B); f.userCommit('L'); f.text('L',G); const real=f.userCommit('L')
  git(f.get('u').dir,'reset','--hard',real); f.get('u').node=f.mapped.get(real)!
  f.text('u',E)
})
add('equal current blobs after distinct histories', 'given-adoption:equal blob', 'clean', async f => { await f.adopted(); f.text('d',E); f.text('u',E) })
add('adopted 1000 files both delete, conflict survives', 'rev33:candidate cap', 'conflict', async f => {
  await f.adopted(); for(let i=0;i<1000;i++) f.text('L','generated\n',`adopted/p${i}.txt`)
  const common=f.userCommit('L'); for(const a of ['d','u'] as const) { f.adopt(a,common); fs.rmSync(path.join(f.get(a).dir,'adopted'),{recursive:true}) }
  f.text('d',G); f.text('u',E)
})

// Supplementary counterexamples, kept individually targetable so the original
// long run and these additions have separate, explicit evidence files.
add('supplement: scratch skipped, lead later adds competing log', 'unchanged-scratch:results.log, extended to lead', 'conflict', async f => {
  f.file='results.log'; f.text('d','D log\n'); await f.keep('d'); f.text('L','lead log\n')
}, {pair:['L','d']})
add('supplement: kept D reverts to given G, U edits', 'stale-carried-conflict:kept worker uses revert', 'clean', async f => {
  f.text('d',B); await f.keep('d'); f.text('d',G); f.text('u',E)
})
add('supplement: committed revert to O without adoption', 'given-adoption:committed revert without adoption', 'conflict', async f => {
  f.text('d',B); await f.keep('d'); f.text('d',O); f.userCommit('d'); f.text('u',E)
})
add('supplement: adopted addition deleted versus edit', 'given-adoption:adopted addition', 'conflict', async f => {
  await f.adopted(); f.text('L',C,'added.txt'); const common=f.userCommit('L')
  for(const a of ['d','u'] as const) f.adopt(a,common)
  f.file='added.txt'; f.remove('d'); f.text('u',E)
})
add('supplement: actual later spawn after lead change/revert, only U adopts', 'rev33:U given X after lead change and revert', 'conflict', async f => {
  f.text('L',B); f.userCommit('L'); f.text('L',G); f.userCommit('L')
  const v=await f.t.spawn('v'); f.actors.set('u',{dir:v.dir,name:v.name,node:f.get('L').node})
  f.mapped.set(git(v.dir,'rev-parse','HEAD'),f.get('L').node)
  await f.adopted('u'); f.text('d',G); f.text('u',E)
})
add('supplement: merge adoption after independent commits', 'given-adoption:merge adoption', 'conflict', async f => {
  const {common}=await f.adopted('d')
  f.text('u','independent\n','local-u.txt'); f.userCommit('u'); f.adopt('u',common,true)
  f.text('d',G); f.text('u',E)
})
add('supplement: carried staged addition, committed deletion', 'own-baseline:committed deletion of carried staged addition', 'conflict', async f => {
  f.file='staged.txt'; f.text('L',G); git(repo,'add',f.file)
  // Real later workers inherit the staged addition; no baseline registry edits.
  vi.stubEnv('GIT_AUTHOR_DATE','2001-01-01T00:00:03Z'); vi.stubEnv('GIT_COMMITTER_DATE','2001-01-01T00:00:03Z')
  const v=await f.t.spawn('v')
  vi.stubEnv('GIT_AUTHOR_DATE','2001-01-01T00:00:04Z'); vi.stubEnv('GIT_COMMITTER_DATE','2001-01-01T00:00:04Z')
  const w=await f.t.spawn('w')
  f.get('L').node=f.snap('L')
  f.actors.set('d',{dir:v.dir,name:v.name,node:f.get('L').node})
  f.actors.set('u',{dir:w.dir,name:w.name,node:f.get('L').node})
  f.remove('d'); const head=f.userCommit('d'); f.override.set('d',head); f.text('u',E)
})
add('supplement: common unrelated adoption after keep', 'given-adoption:unrelated adoption', 'conflict', async f => {
  await f.adopted(undefined,false,true); f.text('d',G); f.text('u',E)
})
add('supplement: successful refresh after keep, then both edit', 'stale-carried-conflict:successful refresh (extended)', 'conflict', async f => {
  f.text('d',B); await f.keep('d'); f.userCommit('L')
  expect(await f.resume('d',true)).toContain('rebased d')
  f.text('L',C); f.text('d',D)
}, {pair:['L','d']})

it.each(specs)('$id', async spec => {
  console.info('study scenario:',spec.id)
  const f = new Fixture(spec)
  try {
    await f.init(); await spec.run(f)
    const [a,b] = spec.pair ?? ['d','u']
    const native=f.native(a,b), naive=f.native(a,b,true), main=await f.main(a,b)
    rows.push({id:spec.id, source:spec.source, expected:spec.expected, pair:[a,b], native, naive, main, notes:f.notes})
    // Differences are study results, not failures hidden behind it.fails.
    expect(main).toHaveLength(2)
  } finally { fs.rmSync(f.scratch,{recursive:true,force:true}) }
}, 120_000)
afterAll(() => {
  const destination=process.env.GIT_NATIVE_RESULTS
  if(destination) fs.writeFileSync(destination,JSON.stringify(rows,null,2)+'\n')
})
