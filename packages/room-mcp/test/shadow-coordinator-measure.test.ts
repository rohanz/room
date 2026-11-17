import { applyShadowEvent } from './shadow-event-fixture.js'
import fs from 'node:fs'
import { expect,it,vi } from 'vitest'
import * as Y from 'yjs'
import { gitBlobHash,manifestKey,type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictShadow,type ShadowEvent } from '../src/conflict-shadow.js'
import { registryForDir } from '../src/worker-registry.js'
import { world,repo,put,git,commit } from './worker-refresh-fixture.js'

class ManualShadow extends ConflictShadow {override enqueue():void{}}
it.skipIf(process.env.TEST_SCALE !== '1')('measures the actual coordinator for a lead and six workers',async()=>{
  for(let n=0;n<100;n++)put(repo,`benchmark/file-${n}.txt`,'x'.repeat(1024))
  commit(repo,'measurement base')
  const t=world(),workers=[]
  for(let n=0;n<6;n++)workers.push(await t.spawn(`m${n}`))
  let clock=Date.now()
  const logs:string[]=[],s=t.leadSession(),shadow=new ManualShadow(s,line=>logs.push(line),()=>clock)
  const internal=shadow as unknown as {init():Promise<void>;event(e:ShadowEvent):Promise<void>}
  const registry=await registryForDir(repo)
  try{
    await internal.init()
    for(const w of workers)await applyShadowEvent(shadow, {kind:'spawn',record:(await registry.read(w.id))!,supplied:false})
    const actors=[{name:s.me.name,dir:repo,id:''},...workers]
    vi.spyOn(s.awareness,'getStates').mockImplementation(()=>new Map(actors.map((a,i)=>[i,{user:{name:a.name,kind:'agent'},sessionId:`session-${a.name}`}])) as never)
    s.room.ensureRoomSalt()
    const compare=vi.spyOn(shadow.graph,'compare'),samples:number[]=[],before=git(repo,'count-objects','-v')
    for(let round=0;round<3;round++){
      clock+=6000
      for(let n=0;n<6;n++)put(workers[n].dir,`worker-${n}.txt`,`round ${round}\n`+'x'.repeat(1000))
      for(const [i,a]of actors.entries()){
        const base=a.id?(await registry.read(a.id))!.base!:git(repo,'rev-parse','HEAD')
        epochPublication(s.room,a.name,base)
        s.room.participants.set(`${a.name}\0id`,{name:a.name,kind:'agent'})
        s.room.manifestHead.set(a.name,{...s.room.manifestHead.get(a.name)!,level:'full',semRev:round+1})
        const entries=new Y.Map<ManifestEntry>()
        if(i){const p=`worker-${i-1}.txt`,text=`round ${round}\n`+'x'.repeat(1000);entries.set(p,{change:'A',state:'shared',hash:gitBlobHash(text),at:clock,fence:'1'});s.room.setOverlay(manifestKey(a.name,'1'),p,text)}
        s.room.manifest.set(manifestKey(a.name,'1'),entries)
      }
      const start=performance.now();await shadow.idle();samples.push(performance.now()-start)
      expect(compare).toHaveBeenCalledTimes((round+1)*21)
      expect(logs.some(line=>line.includes('failed')||line.includes('over budget'))).toBe(false)
    }
    expect(git(repo,'count-objects','-v')).toBe(before)
    const result={workers:6,participants:7,baseFiles:103,editBytes:1008,rounds:3,samplesMs:samples,medianPassMs:[...samples].sort((a,b)=>a-b)[1],pairsPerPass:21,
      includes:'production scheduling/budget wrapper, read-only registry, seven snapshots, publication byte checks, 21 comparisons, disk/publication revalidation',liveHosts:false}
    if(process.env.SHADOW_COORDINATOR_FILE)fs.writeFileSync(process.env.SHADOW_COORDINATOR_FILE,JSON.stringify(result,null,2)+'\n')
  }finally{shadow.stop()}
},120_000)
