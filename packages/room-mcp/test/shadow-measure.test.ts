import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect,it } from 'vitest'
import { ShadowGraph } from '../src/shadow-graph.js'
import { captureShadow } from '../src/shadow-snapshot.js'

it.skipIf(process.env.TEST_SCALE !== '1')('measures six workers editing 1 KiB files every five simulated seconds',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'room-shadow-measure-')))
  const git=(dir:string,...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim()
  const bytes=async(dir:string):Promise<number>=>{
    let total=0
    for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);total+=e.isDirectory()?await bytes(p):(await fs.stat(p)).size}
    return total
  }
  try {
    const lead=path.join(root,'lead');await fs.mkdir(lead)
    git(lead,'init','-q');git(lead,'config','user.name','test');git(lead,'config','user.email','test@example.test')
    for(let n=0;n<100;n++)await fs.writeFile(path.join(lead,`file-${n}.txt`),'base\n'+'x'.repeat(1019))
    git(lead,'add','.');git(lead,'commit','-qm','base');const head=git(lead,'rev-parse','HEAD')
    const workers=[]
    for(let n=0;n<6;n++){const dir=path.join(root,`worker-${n}`);git(lead,'worktree','add','-qb',`w${n}`,dir);workers.push(dir)}
    const graph=new ShadowGraph(path.join(lead,'.git/room/shadow/measure'),lead);await graph.init()
    const entries=await graph.entries(head),tree=await graph.tree(entries),anchor=await graph.event('spawn',tree,[])
    const nodes=Array(7).fill(anchor) as string[], samples:number[]=[]
    const sourceBefore=git(lead,'count-objects','-v'),before=await bytes(graph.root),objectBefore=await bytes(path.join(graph.repo,'objects'))
    const rounds=12
    for(let round=0;round<rounds;round++){
      const start=performance.now()
      for(let n=0;n<6;n++){
        await fs.writeFile(path.join(workers[n],`file-${n}.txt`),`worker ${n} round ${round}\n`+'x'.repeat(1000))
        const scan=await captureShadow(graph,workers[n],head)
        expect(scan.entries.size).toBe(100);expect(scan.gaps.size).toBe(0)
        expect(scan.entries.get(`file-${n}.txt`)!.oid).not.toBe(entries.get(`file-${n}.txt`)!.oid)
        nodes[n+1]=await graph.event('observation',await graph.tree(scan.entries,`worker-${n}`,workers[n]),[nodes[n+1]])
      }
      for(let a=0;a<7;a++)for(let b=a+1;b<7;b++)await graph.compare(nodes[a],nodes[b])
      samples.push(performance.now()-start)
    }
    expect(git(lead,'count-objects','-v')).toBe(sourceBefore)
    const after=await bytes(graph.root),objectAfter=await bytes(path.join(graph.repo,'objects'))
    const result={git:git(lead,'--version'),files:100,workers:6,rounds,simulatedSeconds:rounds*5,
      medianPassMs:samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)],initialBytes:before,growthBytes:after-before,objectGrowthBytes:objectAfter-objectBefore,
      projectedBytesPerHour:(after-before)*3600/(rounds*5),projectedObjectBytesPerHour:(objectAfter-objectBefore)*3600/(rounds*5)}
    if(process.env.SHADOW_MEASUREMENT_FILE)await fs.writeFile(process.env.SHADOW_MEASUREMENT_FILE,JSON.stringify(result,null,2)+'\n')
    console.info('shadow measurement',JSON.stringify(result))
  }finally{await fs.rm(root,{recursive:true,force:true})}
},120_000)
