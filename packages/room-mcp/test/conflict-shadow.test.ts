import './shadow-controlled-fixture.js'
import { applyShadowEvent } from './shadow-event-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const full = process.env.TEST_SCALE === '1' ? it : it.skip
import * as Y from 'yjs'
import { RoomDoc, gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictShadow, shadowIdle, type ShadowEvent } from '../src/conflict-shadow.js'
import { ShadowGraph } from '../src/shadow-graph.js'
import { captureShadow } from '../src/shadow-snapshot.js'
import { ConflictSet, type ConflictSlot } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { registryForDir } from '../src/worker-registry.js'
import { workerByTag } from './registry-fixture.js'
import { world, repo, put, git, commit } from './worker-refresh-fixture.js'

class ManualShadow extends ConflictShadow { override enqueue(): void {} }
type TestShadow = { validateHistory(a:unknown,r:import('../src/worker-status.js').WorkerRecord[],common:string):Promise<void>; newEvent(a:unknown,k:string,e:Awaited<ReturnType<typeof captureShadow>>['entries']):Promise<void>; init():Promise<void>; event(e:ShadowEvent):Promise<void>; pass():Promise<void>; actors:Map<string,{node:string;observed:number;events:string[]}> }
async function family() {
  const t = world()
  // Distinct housekeeping commits expose today's false conflict after kept delivery.
  // Git deduplicates identical carry commits made in the same second, eliminating it.
  const spawn = async (tag: string, date: string) => {
    const author = process.env.GIT_AUTHOR_DATE, committer = process.env.GIT_COMMITTER_DATE
    vi.stubEnv('GIT_AUTHOR_DATE', date); vi.stubEnv('GIT_COMMITTER_DATE', date)
    try { return await t.spawn(tag) }
    finally { vi.stubEnv('GIT_AUTHOR_DATE', author); vi.stubEnv('GIT_COMMITTER_DATE', committer) }
  }
  const d = await spawn('d', '2001-01-01T00:00:00Z'), u = await spawn('u', '2001-01-02T00:00:00Z')
  let clock = Date.now() - 1000
  const logs: string[] = [], shadow = new ManualShadow(t.leadSession(), l => logs.push(l), () => clock)
  const internal = shadow as unknown as TestShadow
  await internal.init()
  const registry = await registryForDir(repo)
  for (const w of [d,u]) await applyShadowEvent(shadow, {kind:'spawn',record:(await registry.read(w.id))!,supplied:false})
  const s = t.leadSession(), actors = [{name:s.me.name,dir:repo,id:''},d,u]
  vi.spyOn(s.awareness,'getStates').mockImplementation(()=>new Map(actors.map((a,i)=>[i,{user:{name:a.name,kind:'agent'},sessionId:`session-${a.name}`}])) as never)
  const publish=(rev=1)=>publishActors(s,actors,registry,clock,rev)
  async function authoritative() {
    for(const w of [d,u]) {
      const peer={...s,me:{name:w.name,kind:'agent'},dir:w.dir,post:vi.fn().mockResolvedValue({ok:true}),lease:{fence:()=> '1'}} as unknown as Session
      const set=new ConflictSet(peer,w.name,peer,()=>{},0)
      try{await set.reconcile('shadow fixture')}finally{set.stop()}
    }
  }
  const records=()=>{
    const file=path.join(path.dirname(shadow.graph.root),'disagreements.jsonl')
    return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
  }
  return {t,d,u,s,shadow,internal,publish,authoritative,records,logs,clock:(n:number)=>{clock+=n}}
}
async function publishActors(s:Session,actors:{name:string;dir:string;id:string}[],registry:Awaited<ReturnType<typeof registryForDir>>,clock:number,rev=1) {
    const room=s.room; room.ensureRoomSalt()
    for(const a of actors) {
      const record=a.id?await registry.read(a.id):undefined
      const base=record?.base??git(repo,'rev-parse','HEAD')
      epochPublication(room,a.name,base)
      room.participants.set(`${a.name}\0id`,{name:a.name,kind:'agent'})
      room.manifestHead.set(a.name,{...room.manifestHead.get(a.name)!,level:'full',semRev:rev})
      const entries=new Y.Map<ManifestEntry>()
      const paths=new Set(git(a.dir,'ls-files','--cached','--others','--exclude-standard').split('\n').filter(Boolean))
      for(const p of paths) {
        let old:string|undefined
        try{old=git(a.dir,'show',`${base}:${p}`)+'\n'}catch{/* untracked */}
        const inherited=record?.carriedUntracked?.find(e=>e.path===p)?.sha
        const text=fs.readFileSync(path.join(a.dir,p),'utf8')
        if(gitBlobHash(text)!==(inherited??(old===undefined?undefined:gitBlobHash(old)))) {
          entries.set(p,{change:old===undefined?'A':'M',state:'shared',hash:gitBlobHash(text),at:clock,fence:'1'})
          room.setOverlay(manifestKey(a.name,'1'),p,text)
        }
      }
      room.manifest.set(manifestKey(a.name,'1'),entries)
    }
  }


full('records a false settled conflict after kept delivery, with no contents or notices', async () => {
  put(repo,'shared.txt','received\n')
  const f=await family()
  try {
    expect(f.d.base).not.toBe(f.u.base)
    put(f.d.dir,'shared.txt','delivered\n');await f.t.finish('d')
    expect(await f.t.call('room_collect',{tag:'d',keep:true})).toContain('kept d')
    const r=(await (await registryForDir(repo)).read(f.d.id))!
    await applyShadowEvent(f.shadow, {kind:'collection',workers:[{id:r.id,name:r.name,head:git(r.dir,'rev-parse','HEAD'),source:r.base,paths:['shared.txt']}],
      initial:new Map([['shared.txt','received\n']]),merged:new Map([['shared.txt','delivered\n']]),modes:new Map()})
    await f.publish();await f.authoritative()
    const slots=[...f.s.room.doc.getMap<ConflictSlot>('conflicts').values()]
    expect(slots.some(s=>s.path==='shared.txt'&&s.settled==='conflict'), JSON.stringify(slots)).toBe(true)
    const notices=f.t.messages().length
    await f.internal.pass(); expect(f.records()).toEqual([])
    f.clock(60_001); await f.internal.pass()
    expect(f.records()).toContainEqual(expect.objectContaining({today:'conflict',shadow:'clean',path:'shared.txt'}))
    expect(JSON.stringify(f.records())).not.toMatch(/received|delivered/)
    expect(f.t.messages()).toHaveLength(notices)
    expect(f.records().every(r => r.observation === '60-second-stable-heuristic' && r.stableForMs >= 60_000)).toBe(true)
    const count = f.records().length; await f.internal.pass(); expect(f.records()).toHaveLength(count)
    f.clock(60_001); await f.internal.pass(); expect(f.records()).toHaveLength(count)
  } finally {f.shadow.stop()}
})
full('does not record agreement or an unsettled slot', async () => {
  const f=await family()
  try {
    put(f.d.dir,'shared.txt','D\n');put(f.u.dir,'shared.txt','U\n')
    await f.publish();await f.authoritative();await f.internal.pass()
    expect(f.records()).toEqual([])
    const map=f.s.room.doc.getMap<ConflictSlot>('conflicts')
    for(const [key,s]of map)map.set(key,{...s,status:'unknown',settled:'conflict'})
    await f.internal.pass();expect(f.records()).toEqual([])
  } finally {f.shadow.stop()}
})
full('waits 60 stable seconds for absent slots, resets on publication movement and records once', async () => {
  const f=await family()
  try {
    put(f.d.dir,'shared.txt','D\n');put(f.u.dir,'shared.txt','U\n')
    await f.publish();await f.internal.pass();expect(f.records()).toEqual([])
    f.clock(59_000);await f.internal.pass();expect(f.records()).toEqual([])
    await f.publish(2);f.clock(6000);await f.internal.pass();expect(f.records()).toEqual([])
    f.clock(60_001);await f.internal.pass()
    expect(f.records()).toContainEqual(expect.objectContaining({today:'none-after-60s',shadow:'conflict',path:'shared.txt'}))
    const count=f.records().length;await f.internal.pass();expect(f.records()).toHaveLength(count)
  } finally {f.shadow.stop()}
})
full('policy exclusions and unsafe/nested paths remain gaps, including tracked excluded paths', async () => {
  const t=world(), d=await t.spawn('d'), graph=new ShadowGraph(path.join(repo,'.git/room/shadow/policy'),repo)
  try {
    await graph.init()
    put(d.dir,'.env','secret\n');put(d.dir,'.roomignore','private.txt\n');put(d.dir,'private.txt','hidden\n')
    put(d.dir,'big.txt','x'.repeat(512*1024+1));put(d.dir,'nested/.git/HEAD','ref: refs/heads/main\n');put(d.dir,'nested/file','nested secret\n')
    fs.symlinkSync(path.join(repo,'shared.txt'),path.join(d.dir,'link'))
    const scan=await captureShadow(graph,d.dir,d.base!)
    expect(scan.entries.has('.env')).toBe(false);expect(scan.gaps.has('.env')).toBe(true)
    expect(scan.entries.has('private.txt')).toBe(false);expect(scan.gaps.has('private.txt')).toBe(true)
    expect(scan.gaps.has('big.txt')).toBe(true);expect(scan.gaps.has('link')).toBe(true)
    expect([...scan.entries.keys()].some(p=>p.startsWith('nested/'))).toBe(false)
    put(d.dir,'.gitattributes','*.txt text eol=crlf\n')
    await expect(captureShadow(graph,d.dir,d.base!)).rejects.toThrow('unmodelled history')
  } finally {await fs.promises.rm(graph.root,{recursive:true,force:true})}
})
full('real hooks enqueue an immutable spawn, masked delivery and successful refresh', async () => {
  vi.stubEnv('ROOM_CONFLICT_SHADOW','1');const t=world()
  const kinds:string[]=[]
  const original=ShadowGraph.prototype.event
  const spy=vi.spyOn(ShadowGraph.prototype,'event').mockImplementation(async function(this:ShadowGraph,...args){kinds.push(args[0]);return original.apply(this,args)})
  try {
    const d=await t.spawn('d');await shadowIdle(t.leadSession())
    expect(kinds).toContain('spawn')
    put(d.dir,'shared.txt','output\n');put(d.dir,'results.log','scratch\n');await t.finish('d')
    expect(await t.call('room_collect',{tag:'d',keep:true})).toContain('kept d')
    await shadowIdle(t.leadSession());expect(kinds).toContain('delivery');expect(kinds).toContain('collection')
    commit(repo,'accept')
    expect(await t.call('room_send',{type:'note',to:d.name,text:'continue',refresh:true})).toContain('rebased d')
    await shadowIdle(t.leadSession());expect(kinds).toContain('refresh')
  } finally {spy.mockRestore()}
})

full('spawn, keep and refresh finish while private initialization is stalled', async()=>{
  vi.stubEnv('ROOM_CONFLICT_SHADOW','1');const t=world()
  let fail!:()=>void, entered!:()=>void, hanging=true
  const reached=new Promise<void>(resolve=>{entered=resolve})
  const pending=new Promise<void>((_,reject)=>{fail=()=>{hanging=false;reject(new Error('stalled then failed'))}})
  void pending.catch(()=>{})
  const spy=vi.spyOn(ShadowGraph.prototype,'init').mockImplementation(()=>{entered();return pending})
  try {
    const d=await t.spawn('d')
    const diagnostic=shadowIdle(t.leadSession())
    await reached
    put(d.dir,'shared.txt','accepted\n');await t.finish('d')
    expect(await t.call('room_collect',{tag:'d',keep:true})).toContain('kept d')
    commit(repo,'accept')
    expect(await t.call('room_send',{type:'note',to:d.name,text:'continue',refresh:true})).toContain('rebased d')
    expect(spy).toHaveBeenCalled();expect(hanging).toBe(true);fail();await diagnostic
  }finally{fail();spy.mockRestore()}
})
full('stops at the private size ceiling, logs once and removes the family on leave',async()=>{
  const f=await family()
  try{
    const file=path.join(f.shadow.graph.root,'ceiling')
    const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,200*1024*1024);fs.closeSync(fd)
    const spy=vi.spyOn(f.shadow.graph,'compare')
    await f.shadow.idle();await f.shadow.idle()
    expect(spy).not.toHaveBeenCalled()
    expect(f.logs.filter(l=>l.includes('family stopped for this session')&&l.includes('session ceiling'))).toHaveLength(1)
    for(const name of [f.s.me.name,f.d.name,f.u.name])expect(f.logs.filter(l=>l.includes('session ceiling')&&l.includes(`(${name})`))).toHaveLength(1)
    f.shadow.stop()
    await (f.shadow as unknown as {cleanup:Promise<void>}).cleanup
    expect(fs.existsSync(f.shadow.graph.root)).toBe(false)
  }finally{f.shadow.stop()}
})
full('reclaims a retired worker ref and private index even when observation has halted',async()=>{
  const f=await family()
  const releases:Promise<void>[]=[],pin=f.shadow.graph.pin.bind(f.shadow.graph)
  vi.spyOn(f.shadow.graph,'pin').mockImplementation((...args)=>{const work=pin(...args);if(!args[1])releases.push(work);return work})
  try{
    const worker=[...f.internal.actors.entries()].find(([name])=>name===f.d.name)![1] as unknown as {id:string}
    expect(fs.existsSync(path.join(f.shadow.graph.root,`${worker.id}.index`))).toBe(true)
    const file=path.join(f.shadow.graph.root,'ceiling'),fd=fs.openSync(file,'w');fs.ftruncateSync(fd,200*1024*1024);fs.closeSync(fd)
    await f.shadow.idle()
    await f.t.finish('d');expect(await f.t.call('room_collect',{tag:'d',discard:true})).toContain('discarded d')
    await f.shadow.idle()
    await Promise.all(releases)
    expect(fs.existsSync(path.join(f.shadow.graph.root,`${worker.id}.index`))).toBe(false)
    await expect(f.shadow.graph.run(['rev-parse','--verify',`refs/room/shadow/${worker.id}`])).rejects.toThrow()
  }finally{f.shadow.stop()}
})

full.each(['hard','mixed'])('models commit then %s reset back to prepared HEAD exactly like edits without a detour',async mode=>{
  const f=await family()
  try{
    const prepared=git(f.d.dir,'rev-parse','HEAD')
    put(f.d.dir,'shared.txt','worker edit\n');commit(f.d.dir,'detour')
    git(f.d.dir,'reset',`--${mode}`,prepared)
    if(mode==='hard')put(f.d.dir,'shared.txt','worker edit\n')
    put(f.u.dir,'shared.txt','sibling edit\n')
    const plain=await f.t.spawn('plain'),registry=await registryForDir(repo)
    await applyShadowEvent(f.shadow, {kind:'spawn',record:(await registry.read(plain.id))!,supplied:false})
    put(plain.dir,'shared.txt','worker edit\n')
    const actor=f.internal.actors.get(f.d.name)!,clean=f.internal.actors.get(plain.name)!,sibling=f.internal.actors.get(f.u.name)!
    await expect(f.internal.validateHistory(actor,(await registry.list()).records,registry.commonDir)).resolves.toBeUndefined()
    for(const [a,w]of [[actor,f.d],[clean,plain],[sibling,f.u]] as const){
      const r=(await registry.read(w.id))!,captured=await captureShadow(f.shadow.graph,w.dir,r.base!,r.carriedUntracked)
      await f.internal.newEvent(a,'observation',captured.entries)
    }
    expect((await f.shadow.graph.compare(actor.node,sibling.node)).paths).toEqual((await f.shadow.graph.compare(clean.node,sibling.node)).paths)
    expect((await f.shadow.graph.compare(actor.node,sibling.node)).paths).toEqual(['shared.txt'])
  }finally{f.shadow.stop()}
})

full('join reclaims only a provably dead session and preserves unverifiable ownership',async()=>{
  const f=await family();f.shadow.stop()
  const parent=path.dirname(f.shadow.graph.root),dead=path.join(parent,'00000000-0000-4000-8000-000000000001'),live=path.join(parent,'00000000-0000-4000-8000-000000000002')
  for(const dir of [dead,live]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'marker'),'private state')}
  fs.writeFileSync(path.join(dead,'owner.json'),JSON.stringify({pid:2147483647,startTime:'gone',executable:'gone'}))
  fs.writeFileSync(path.join(live,'owner.json'),JSON.stringify({pid:process.pid,startTime:'',executable:''}))
  const next=new ManualShadow(f.s,()=>{})
  try{
    await(next as unknown as TestShadow).init()
    expect(fs.existsSync(dead)).toBe(false);expect(fs.readFileSync(path.join(live,'marker'),'utf8')).toBe('private state')
  }finally{next.stop()}
})

it('initializes and reads shadow state without opening or mutating the lifecycle registry',async()=>{
  const room=new RoomDoc(new Y.Doc()),s={dir:repo,room,me:{name:'lead',kind:'agent'},local:true} as unknown as Session
  const shadow=new ManualShadow(s,()=>{})
  try{
    expect(fs.existsSync(path.join(repo,'.git/room/registry'))).toBe(false)
    await shadow.idle()
    expect(fs.existsSync(path.join(repo,'.git/room/registry'))).toBe(false)
    expect(fs.existsSync(shadow.graph.repo)).toBe(true)
  }finally{shadow.stop();room.doc.destroy()}
})

full('an overflowing lifecycle hook only enqueues its failure diagnostic',async()=>{
  const t=world(),logs:string[]=[],shadow=new ConflictShadow(t.leadSession(),line=>logs.push(line))
  try{
    for(let n=0;n<33;n++)shadow.enqueue(()=>({kind:'unsupported',id:'unused',reason:'partial collection'}))
    expect(logs).toEqual([])
    await Promise.resolve();expect(logs.filter(line=>line.includes('event queue'))).toHaveLength(1)
  }finally{shadow.stop()}
})

full('invalidates history instead of deleting a previously covered path when policy excludes it',async()=>{
  const f=await family()
  try{
    const actor=f.internal.actors.get(f.d.name)!,before=actor.node
    put(f.d.dir,'.roomignore','shared.txt\n')
    await f.publish();await f.internal.pass()
    expect(actor.node).toBe(before)
    expect(actor as unknown as {disabled:string}).toMatchObject({disabled:'unmodelled history: coverage changed'})
    expect(f.records()).toEqual([])
  }finally{f.shadow.stop()}
})
full('kept collection does not insert newly created private paths into the lead or worker graph',async()=>{
  const f=await family()
  try{
    put(f.d.dir,'.env','private value\n');await f.t.finish('d')
    expect(await f.t.call('room_collect',{tag:'d',keep:true})).toContain('kept d')
    const r=(await(await registryForDir(repo)).read(f.d.id))!
    await applyShadowEvent(f.shadow, {kind:'collection',workers:[{id:r.id,name:r.name,head:git(r.dir,'rev-parse','HEAD'),source:r.base,paths:['.env']}],
      initial:new Map([['.env',null]]),merged:new Map([['.env','private value\n']]),modes:new Map()})
    for(const name of [f.s.me.name,f.d.name])expect((await f.shadow.graph.entries(f.internal.actors.get(name)!.node)).has('.env')).toBe(false)
  }finally{f.shadow.stop()}
})

full('later spawns inherit historical coverage gaps from their shared lead anchor',async()=>{
  put(repo,'.roomignore','shared.txt\n')
  const f=await family()
  try{
    fs.rmSync(path.join(repo,'.roomignore'))
    const v=await f.t.spawn('later'),r=(await(await registryForDir(repo)).read(v.id))!
    await applyShadowEvent(f.shadow, {kind:'spawn',record:r,supplied:false})
    const actor=f.internal.actors.get(v.name)! as unknown as {node:string;gaps:Set<string>}
    expect(actor.gaps.has('shared.txt')).toBe(true)
    expect((await f.shadow.graph.entries(actor.node)).has('shared.txt')).toBe(false)
  }finally{f.shadow.stop()}
})

full('does not silently drop a delivery when its lead history is unmodelled',async()=>{
  const f=await family()
  try{
    const lead=f.internal.actors.get(f.s.me.name)! as unknown as {disabled:string}
    lead.disabled='coverage changed'
    await expect(f.internal.event({kind:'collection',workers:[],initial:new Map(),merged:new Map(),modes:new Map()})).rejects.toThrow('unmodelled lead history')
  }finally{f.shadow.stop()}
})

full('restarts the heuristic window on a new publication even when the ordinary input key is unchanged', async () => {
  put(repo, 'shared.txt', 'received\n')
  const f = await family()
  try {
    expect(f.d.base).not.toBe(f.u.base)
    put(f.d.dir, 'shared.txt', 'delivered\n'); await f.t.finish('d')
    expect(await f.t.call('room_collect', { tag: 'd', keep: true })).toContain('kept d')
    const r = (await (await registryForDir(repo)).read(f.d.id))!
    await applyShadowEvent(f.shadow, { kind: 'collection', workers: [{ id: r.id, name: r.name, head: git(r.dir, 'rev-parse', 'HEAD'), source: r.base, paths: ['shared.txt'] }],
      initial: new Map([['shared.txt', 'received\n']]), merged: new Map([['shared.txt', 'delivered\n']]), modes: new Map() })
    await f.publish(); await f.authoritative(); await f.internal.pass(); f.clock(60_001); await f.internal.pass()
    const count = f.records().length
    expect(count).toBeGreaterThan(0)
    const slots = f.s.room.doc.getMap<ConflictSlot>('conflicts'), before = [...slots.values()]
    f.clock(6000)
    for (const [name, head] of f.s.room.manifestHead) f.s.room.manifestHead.set(name, { ...head, rev: head.rev + 1 })
    await f.authoritative()
    // Ordinary slot input keys omit publication clocks; identical evaluations retain checkedAt.
    expect([...slots.values()]).toEqual(before)
    await f.internal.pass()
    expect(f.records()).toHaveLength(count)
  } finally { f.shadow.stop() }
})
