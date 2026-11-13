import { setGitObserver } from '@room/roomd/git'
import { registryForDir } from '../src/worker-registry.js'
import { realRepo, setupLead } from './workers-fixture.js'
import { workerByTag } from './registry-fixture.js'
import { ConflictSet, type ConflictSlot, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { epochPublication } from '@room/shared/testing'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'

const file = 'docs/carried.md'
const prefix = Array.from({ length: 252 }, (_, i) => `original line ${i + 1}`).join('\n')
const additions = Array.from({ length: 30 }, (_, i) => `worker addition ${i + 1}`).join('\n') + '\n'
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

describe('conflicts on real spawn-carried untracked text', () => {
  async function fixture(trailingNewline: boolean, withSibling = false, tracked = false) {
    const { repo, head: initial } = realRepo()
    let head = initial
    fs.mkdirSync(path.join(repo, 'docs'))
    const original = prefix + (trailingNewline ? '\n' : '')
    if (tracked) {
      fs.writeFileSync(path.join(repo, file), original.replace('original line 126', 'committed line 126'))
      git(repo, 'add', file); git(repo, 'commit', '-qm', 'tracked carried baseline')
      head = git(repo, 'rev-parse', 'HEAD')
    }
    fs.writeFileSync(path.join(repo, file), original)
    const t = setupLead(repo, head)
    expect(await t.leadTools.call('room_spawn', { tag: 'carried', task: 'extend carried documentation', carry: true })).toContain('spawned carried')
    const worker = (await workerByTag(repo, 'carried'))!
    if (!tracked) expect(worker.carriedUntracked).toEqual([expect.objectContaining({ path: file, sha: gitBlobHash(original) })])
    expect(fs.readFileSync(path.join(worker.dir, file), 'utf8')).toBe(original)
    expect(git(worker.dir, 'ls-files', '--', file)).toBe(tracked ? file : '')
    if (withSibling) expect(await t.leadTools.call('room_spawn', { tag: 'sibling', task: 'leave carried documentation unchanged', carry: true })).toContain('spawned sibling')
    const sibling = withSibling ? (await workerByTag(repo, 'sibling'))! : undefined
    const room = t.a
    room.ensureRoomSalt()
    const states = new Map()
    const post = vi.fn().mockResolvedValue({ ok: true })
    const publish = (name: string, dir: string) => {
      room.participants.delete(`${name}\0proj`)
      epochPublication(room, name, head)
      room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      states.set(name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
      const oldHead = room.manifestHead.get(name)!
      room.manifestHead.set(name, { ...oldHead, level: 'full', rev: oldHead.rev + 1, semRev: oldHead.semRev + 1 })
      const text = fs.readFileSync(path.join(dir, file), 'utf8')
      const entries = new Y.Map<ManifestEntry>()
      entries.set(file, { change: name === 'rohanz' ? 'A' : 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
      room.manifest.set(manifestKey(name, '1'), entries)
      room.setOverlay(manifestKey(name, '1'), file, text)
    }
    const check = async (owner: string, nonPublisher?: 'owner' | 'peer', third = false) => {
      publish('rohanz', repo)
      publish(worker.name, worker.dir)
      if (third) publish('independent', repo)
      if (sibling) publish(sibling.name, sibling.dir)
      if (nonPublisher) {
        const name = 'checkout-editor'
        epochPublication(room, name, head)
        room.participants.set(`${name}\0id`, { name, kind: 'agent' })
        room.participants.delete(`${name}\0git`)
        states.set(name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
        room.manifestHead.set(name, { ...room.manifestHead.get(name)!,
          coverage: { kind: 'none', reason: 'not-publisher' }, publisher: nonPublisher === 'owner' ? 'rohanz' : worker.name })
      }
      post.mockClear()
      const session = { ...t.session, me: { name: owner, kind: 'agent' }, dir: owner === worker.name ? worker.dir : repo,
        post, awareness: { getStates: () => states }, provider: { synced: true }, lease: { fence: () => '1' } } as unknown as Session
      const set = new ConflictSet(session, owner, session, () => {}, 0)
      try { await set.reconcile('real carried untracked regression') } finally { set.stop() }
      const other = nonPublisher === 'peer' ? 'checkout-editor' : owner === worker.name ? 'rohanz' : worker.name
      return {
        merge: room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'merge', other, file)),
        overlap: room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'edit-in-claim', other, file)),
        notices: post.mock.calls.map(call => call[1]),
      }
    }
    return { ...t, repo, worker, original, check }
  }


  it.each([false, true])('tracks carried modifications to an already committed file (lead edits %s)', async leadEdits => {
    const f = await fixture(true, false, true)
    try {
      const text = f.original.replace('original line 126', 'worker new line 126')
      fs.writeFileSync(path.join(f.worker.dir, file), text)
      if (leadEdits) fs.writeFileSync(path.join(f.repo,file), f.original.replace('original line 126', 'lead new line 126'))
      f.a.addClaim({by:f.worker.name,byKind:'agent',path:file,from:126,to:126,intent:'edit carried tracked region',claimedHash:gitBlobHash(text)})
      expect((await f.check('rohanz')).overlap?.status).toBe(leadEdits?'conflict':'clean')
    } finally { await f.leadTools.shutdown() }
  })
  it('does not give an unrelated third participant the carried ancestor', async()=>{
    const f=await fixture(true)
    try {
      const text=f.original.replace('original line 126','worker new line 126')
      fs.writeFileSync(path.join(f.worker.dir,file),text)
      f.a.addClaim({by:f.worker.name,byKind:'agent',path:file,from:126,to:126,intent:'claimed region',claimedHash:gitBlobHash(text)})
      expect((await f.check('independent',undefined,true)).overlap?.status).toBe('conflict')
    } finally { await f.leadTools.shutdown() }
  })
  it.each(['missing','oversized'])('keeps an unavailable %s carried blob unknown',async kind=>{
    const f=await fixture(true)
    try {
      const registry=await registryForDir(f.repo)
      let sha='0'.repeat(40)
      if(kind==='oversized') {
        const scratch=path.join(f.repo,'oversized-baseline')
        fs.writeFileSync(scratch,'x'.repeat(512*1024+1))
        sha=git(f.repo,'hash-object','-w',scratch)
      }
      const record=(await registry.reserved('carried'))!
      await registry.command(record.id,{type:'rebase',expectedBase:record.base,base:record.base,carriedBase:record.carriedBase,carriedUntracked:[{path:file,sha}]})
      const text=f.original.replace('original line 126','worker new line 126')
      fs.writeFileSync(path.join(f.worker.dir,file),text)
      f.a.addClaim({by:f.worker.name,byKind:'agent',path:file,from:126,to:126,intent:'claimed region',claimedHash:gitBlobHash(text)})
      expect((await f.check('rohanz')).overlap?.status).toBe('unknown')
    } finally { await f.leadTools.shutdown() }
  })
  it('reuses the carried ancestor already read by text comparison for the claim',async()=>{
    const f=await fixture(true)
    try {
      const text=f.original.replace('original line 126','worker new line 126')
      fs.writeFileSync(path.join(f.worker.dir,file),text)
      f.a.addClaim({by:f.worker.name,byKind:'agent',path:file,from:126,to:126,intent:'claimed region',claimedHash:gitBlobHash(text)})
      await f.check('rohanz') // warm the immutable historical ancestor cache
      const commands:string[][]=[]
      setGitObserver(args=>commands.push([...args]))
      await f.check('rohanz')
      setGitObserver(undefined)
      const reads=commands.filter(args=>args[0]==='cat-file' && args[1]==='--filters' && args.at(-1)===gitBlobHash(f.original))
      expect(reads).toHaveLength(1)
    } finally { setGitObserver(undefined); await f.leadTools.shutdown() }
  })
})
