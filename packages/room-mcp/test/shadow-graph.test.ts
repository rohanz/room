import './shadow-controlled-fixture.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { ShadowGraph } from '../src/shadow-graph.js'

const roots: string[] = []
let prepared: string | undefined
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'room-shadow-graph-')); roots.push(dir)
  if (!prepared) {
    prepared = await fs.mkdtemp(path.join(os.tmpdir(), 'room-shadow-graph-base-'))
    git(prepared, 'init', '-q'); git(prepared, 'config', 'user.name', 'test'); git(prepared, 'config', 'user.email', 'test@example.test')
    await fs.writeFile(path.join(prepared, 'f'), 'base\n'); git(prepared, 'add', '.'); git(prepared, 'commit', '-qm', 'base')
  }
  await fs.cp(prepared, dir, { recursive: true })
  const graph = new ShadowGraph(path.join(dir, '.git/room/shadow/test'), dir)
  await graph.init()
  const entries = await graph.entries(git(dir, 'rev-parse', 'HEAD'))
  const anchor = await graph.event('spawn', await graph.tree(entries), [])
  return { dir, graph, anchor, entries }
}
afterAll(async () => { if (prepared) await fs.rm(prepared, { recursive: true, force: true }) })
afterEach(async () => { for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
it('uses an alternate read-only: snapshots, merges, refs and indexes belong only to the private bare repo', async () => {
  const { dir, graph, anchor, entries } = await fixture()
  const before = git(dir, 'count-objects', '-v'), index = await fs.readFile(path.join(dir, '.git/index'))
  const changed = new Map(entries); changed.set('f', { mode: '100644', oid: await graph.blob('worker\n') })
  const worker = await graph.event('observation', await graph.tree(changed), [anchor])
  const lead = await graph.event('observation', await graph.tree(entries), [anchor])
  expect((await graph.compare(lead, worker)).paths).toEqual([])
  expect(git(dir, 'count-objects', '-v')).toBe(before)
  expect(await fs.readFile(path.join(dir, '.git/index'))).toEqual(index)
  expect(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/room/shadow')).toBe('')
  await graph.pin('worker', worker)
  expect(await graph.run(['rev-parse', 'refs/room/shadow/worker'])).toBe(worker)
})
it('parses NUL structured conflict records, preserving tabs and newlines in paths', async () => {
  const { graph, anchor, entries } = await fixture()
  const file = 'odd\tname\n.txt'
  const a = new Map(entries), b = new Map(entries)
  a.set(file, { mode: '100644', oid: await graph.blob('one\n') }); b.set(file, { mode: '100644', oid: await graph.blob('two\n') })
  const aa = await graph.event('observation', await graph.tree(a), [anchor]), bb = await graph.event('observation', await graph.tree(b), [anchor])
  expect((await graph.compare(aa, bb)).paths).toEqual([file])
})
it('delivery mask leaves skipped scratch competing after keep', async () => {
  const { graph, anchor, entries } = await fixture()
  const source = new Map(entries); source.set('results.log', { mode: '100644', oid: await graph.blob('worker log\n') })
  source.set('f', { mode: '100644', oid: await graph.blob('accepted\n') })
  const delivered = new Map(entries); delivered.set('f', source.get('f')!)
  const delivery = await graph.event('delivery', await graph.tree(delivered), [anchor])
  const merged = await graph.event('collection', await graph.tree(delivered), [anchor, delivery])
  const lead = new Map(delivered); lead.set('results.log', { mode: '100644', oid: await graph.blob('lead log\n') })
  const aa = await graph.event('observation', await graph.tree(lead), [merged]), bb = await graph.event('observation', await graph.tree(source), [delivery])
  expect((await graph.compare(aa, bb)).paths).toEqual(['results.log'])
})
it('honors expected-value private ref updates and treats missing main objects as unknown', async()=>{
  const {dir,graph,anchor,entries}=await fixture()
  await graph.pin('worker',anchor)
  const next=await graph.event('observation',await graph.tree(entries),[anchor])
  await graph.run(['update-ref','refs/room/shadow/worker',next])
  await expect(graph.pin('worker',next)).rejects.toThrow('shadow Git step failed')
  const blob=entries.get('f')!.oid
  await fs.rm(path.join(dir,'.git/objects',blob.slice(0,2),blob.slice(2)))
  const a=new Map(entries),b=new Map(entries)
  a.set('f',{mode:'100644',oid:await graph.blob('A\n')});b.set('f',{mode:'100644',oid:await graph.blob('B\n')})
  const aa=await graph.event('observation',await graph.tree(a),[anchor]),bb=await graph.event('observation',await graph.tree(b),[anchor])
  await expect(graph.compare(aa,bb)).rejects.toThrow()
})
it('private-index add through an alternate leaves the user index and object store unchanged',async()=>{
  const {dir,graph}=await fixture()
  const count=git(dir,'count-objects','-v'),index=await fs.readFile(path.join(dir,'.git/index'))
  await fs.writeFile(path.join(dir,'f'),'foreign working tree\n')
  const privateIndex=path.join(graph.root,'foreign.index')
  await graph.run(['read-tree','HEAD'],undefined,privateIndex,dir).catch(async()=>{await graph.run(['read-tree',git(dir,'rev-parse','HEAD')],undefined,privateIndex,dir)})
  // Exclude Room state from this illustrative add; production uses explicit policy-selected index-info.
  await graph.run(['add','-A','--','f'],undefined,privateIndex,dir)
  const tree=await graph.run(['write-tree'],undefined,privateIndex,dir)
  expect(await graph.run(['show',`${tree}:f`])).toBe('foreign working tree')
  expect(await fs.readFile(path.join(dir,'.git/index'))).toEqual(index)
  expect(git(dir,'count-objects','-v')).toBe(count)
})
it('does not reuse a cached answer after an alternate object disappears',async()=>{
  const {dir,graph,anchor,entries}=await fixture()
  const a=new Map(entries),b=new Map(entries)
  a.set('f',{mode:'100644',oid:await graph.blob('A\n')});b.set('f',{mode:'100644',oid:await graph.blob('B\n')})
  const aa=await graph.event('observation',await graph.tree(a),[anchor]),bb=await graph.event('observation',await graph.tree(b),[anchor])
  expect((await graph.compare(aa,bb)).paths).toEqual(['f'])
  const blob=entries.get('f')!.oid
  await fs.rm(path.join(dir,'.git/objects',blob.slice(0,2),blob.slice(2)))
  await expect(graph.compare(aa,bb)).rejects.toThrow()
})

it('keeps independent identical observations distinct so a later revert does not invent shared history',async()=>{
  const {graph,anchor,entries}=await fixture()
  const internals=graph as unknown as {environment(index?:string):NodeJS.ProcessEnv},environment=internals.environment.bind(graph)
  const fixed=vi.spyOn(internals,'environment').mockImplementation(index=>({...environment(index),GIT_AUTHOR_DATE:'2001-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2001-01-01T00:00:00Z'}))
  try{
    const same=new Map(entries);same.set('f',{mode:'100644',oid:await graph.blob('identical edits\n')})
    const a=await graph.event('observation',await graph.tree(same),[anchor]),b=await graph.event('observation',await graph.tree(same),[anchor])
    const other=new Map(entries);other.set('f',{mode:'100644',oid:await graph.blob('later edit\n')})
    const aa=await graph.event('observation',await graph.tree(entries),[a]),bb=await graph.event('observation',await graph.tree(other),[b])
    expect((await graph.compare(aa,bb)).paths).toEqual([])
    expect(a).not.toBe(b)
  }finally{fixed.mockRestore()}
})

it('clears stale locks only in its private index and ref namespace', async () => {
  const { dir, graph, anchor, entries } = await fixture()
  const userIndex = await fs.readFile(path.join(dir, '.git/index'))
  await fs.writeFile(path.join(graph.root, 'retry.index.lock'), 'abandoned private index lock')
  expect(await graph.tree(entries, 'retry')).toBe(await graph.run(['rev-parse', `${anchor}^{tree}`]))
  await fs.mkdir(path.join(graph.repo, 'refs/room/shadow'), { recursive: true })
  await fs.writeFile(path.join(graph.repo, 'refs/room/shadow/retry.lock'), 'abandoned private ref lock')
  await graph.pin('retry', anchor)
  expect(await fs.readFile(path.join(dir, '.git/index'))).toEqual(userIndex)
  await expect(graph.tree(entries, '../../outside')).rejects.toThrow('invalid shadow identity')
})
