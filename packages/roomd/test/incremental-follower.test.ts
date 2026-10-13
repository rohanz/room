import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import chokidar from 'chokidar'
import { EventEmitter } from 'node:events'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '../src/index.js'
import { policyFromLevel } from '../src/policy.js'
import { setGitObserver } from '../src/git.js'
import { manifestText } from './manifest-assert.js'

for (const finalPublisher of [false, true]) it(`coalesces rapid role flapping and rescans rename/deletion when final publisher is ${finalPublisher}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-incremental-follower-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], {stdio:'pipe'})
  const watch = vi.spyOn(chokidar, 'watch'), listings: string[][] = []
  let daemon: Roomd | undefined
  try {
    git('init', '-q'); git('config', 'user.name', 'synthetic'); git('config', 'user.email', 'synthetic@example.test')
    fs.writeFileSync(path.join(dir, 'old.txt'), 'rename\n'); fs.writeFileSync(path.join(dir, 'deleted.txt'), 'delete\n')
    git('add', '.'); git('commit', '-qm', 'synthetic fixture')
    const providerFactory = (_s: string, _n: string, doc: any) => {
      let state: any
      return {synced:true,on(){},off(){},destroy(){},awareness:{setLocalState(s:any){state=s},getLocalState:()=>state,getStates:()=>new Map([[doc.clientID,state]])}} as unknown as WebsocketProvider
    }
    daemon = await startRoomd({dir,name:'Test',room:'ws://synthetic/follower',policy:policyFromLevel('full', [], 'full', false),providerFactory,
      basePollMs:0,trackedRefreshMs:10000,reconcileIntervalMs:0,debounceMs:5,log:()=>{}})
    expect(watch).not.toHaveBeenCalled()
    fs.renameSync(path.join(dir,'old.txt'),path.join(dir,'renamed.txt')); fs.rmSync(path.join(dir,'deleted.txt'))
    setGitObserver(args=>listings.push([...args]))
    for(let i=0;i<25;i++) {
      daemon.applyInputs({...daemon.inputs,policy:policyFromLevel('full')})
      daemon.applyInputs({...daemon.inputs,policy:policyFromLevel('full', [], 'full', false)})
    }
    daemon.applyInputs({...daemon.inputs,policy:policyFromLevel('full', [], 'full', finalPublisher)})
    await daemon.enqueue(async()=>{})
    expect(watch).toHaveBeenCalledTimes(finalPublisher ? 1 : 0)
    const internals = daemon as any
    if(finalPublisher) {
      expect(internals.trackedPoll).toBeDefined()
      expect(internals.tracked.has('renamed.txt')).toBe(true)
      expect(manifestText(daemon.roomDoc,'renamed.txt','Test')).toBe('rename\n')
      const entries = daemon.roomDoc.manifest.get(`Test\0${daemon.fence}`)!
      expect(entries.get('old.txt')?.change).toBe('D')
      expect(entries.get('deleted.txt')?.change).toBe('D')
    } else {
      expect(internals.trackedPoll).toBeUndefined(); expect(internals.watcher).toBeNull()
      expect(internals.tracked.size).toBe(0)
      expect(listings.filter(args=>args[0]==='ls-files')).toEqual([])
    }
    await daemon.stop()
    expect(internals.watcher).toBeNull(); expect(internals.trackedPoll).toBeUndefined()
  } finally { await daemon?.stop(); setGitObserver(undefined); watch.mockRestore(); fs.rmSync(dir,{recursive:true,force:true}) }
})

it('drains setup and permits repromotion after demotion before watcher readiness', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'room-incremental-watch-ready-'))
  const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'})
  const watchers: EventEmitter[]=[]
  let daemon: Roomd | undefined, closed!:()=>void
  const firstClosed=new Promise<void>(resolve=>{closed=resolve})
  const watch=vi.spyOn(chokidar,'watch').mockImplementation(()=>{
    const first=watchers.length===0
    const mock=Object.assign(new EventEmitter(),{getWatched:()=>({[dir]:['a.txt']}),
      close:vi.fn(async()=>{if(first)closed()}),add:vi.fn(),unwatch:vi.fn()})
    watchers.push(mock)
    if(first)queueMicrotask(()=>daemon!.applyInputs({...daemon!.inputs,policy:policyFromLevel('full',[],'full',false)}))
    else queueMicrotask(()=>mock.emit('ready'))
    return mock as unknown as ReturnType<typeof chokidar.watch>
  })
  try {
    git('init','-q');git('config','user.name','synthetic');git('config','user.email','synthetic@example.test')
    fs.writeFileSync(path.join(dir,'a.txt'),'base\n');git('add','.');git('commit','-qm','synthetic fixture')
    const providerFactory=(_s:string,_n:string,doc:any)=>{let state:any;return {synced:true,on(){},off(){},destroy(){},
      awareness:{setLocalState(s:any){state=s},getLocalState:()=>state,getStates:()=>new Map([[doc.clientID,state]])}} as unknown as WebsocketProvider}
    daemon=await startRoomd({dir,name:'Test',room:'ws://synthetic/ready',policy:policyFromLevel('full',[],'full',false),
      providerFactory,basePollMs:0,trackedRefreshMs:10000,reconcileIntervalMs:0,log:()=>{}})
    daemon.applyInputs({...daemon.inputs,policy:policyFromLevel('full')})
    await firstClosed
    fs.writeFileSync(path.join(dir,'a.txt'),'edited while setup was cancelled\n')
    daemon.applyInputs({...daemon.inputs,policy:policyFromLevel('full')})
    const drained=await Promise.race([daemon.enqueue(async()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))])
    expect(drained,'closing an unready watcher must release the setup queue').toBe(true)
    expect(watchers).toHaveLength(2)
    expect((daemon as any).trackedPoll).toBeDefined()
    expect(manifestText(daemon.roomDoc,'a.txt','Test')).toBe('edited while setup was cancelled\n')
  } finally {
    // Release the faulty baseline promise for cleanup; this synthetic event is not part of the assertion.
    for(const mock of watchers)mock.emit('ready')
    await daemon?.stop();watch.mockRestore();fs.rmSync(dir,{recursive:true,force:true})
  }
})
