// Default-off coverage uses real clocks, budgets and Git; only host configuration is isolated.
import './shadow-git-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect,it,vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { setGitObserver } from '@room/roomd/git'
import { enqueueShadow,shadowIdle,stopShadow } from '../src/conflict-shadow.js'
import { ShadowGraph } from '../src/shadow-graph.js'
import type { Session } from '../src/session.js'
import { world,repo } from './worker-refresh-fixture.js'

it('off and worker-process gates issue zero shadow Git commands and allocate no state', async () => {
  const room=new RoomDoc(new Y.Doc()),s={dir:repo,room,me:{name:'lead',kind:'agent'},local:true} as unknown as Session
  const timer=vi.spyOn(globalThis,'setTimeout'),listener=vi.spyOn(room.doc,'on'),observe=vi.spyOn(room.doc.getMap('conflicts'),'observe')
  const calls:string[][]=[]
  setGitObserver(a=>calls.push([...a]))
  try {
    enqueueShadow(s,()=>{throw new Error('must not build payload')})
    vi.stubEnv('ROOM_CONFLICT_SHADOW','1');vi.stubEnv('ROOM_WORKER_ID','w_test')
    enqueueShadow(s,()=>{throw new Error('must not build payload')})
    vi.stubEnv('ROOM_WORKER_ID','')
    enqueueShadow(s,()=>{throw new Error('empty worker marker must also be off')})
    await shadowIdle(s)
    expect(calls).toHaveLength(0)
    expect(timer).not.toHaveBeenCalled();expect(listener).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(repo,'.git/room/shadow'))).toBe(false)
  } finally { setGitObserver(undefined); stopShadow(s);timer.mockRestore();listener.mockRestore();observe.mockRestore(); room.doc.destroy() }
})
it('real disabled spawns issue zero shadow Git commands with the flag unset or explicitly off',async()=>{
  const t=world();await t.spawn('warm')
  const spy=vi.spyOn(ShadowGraph.prototype,'command'),init=vi.spyOn(ShadowGraph.prototype,'init'),counts:number[]=[],ordinary:number[]=[]
  try{
    for(const flag of [undefined,'0']){
      if(flag===undefined)delete process.env.ROOM_CONFLICT_SHADOW;else process.env.ROOM_CONFLICT_SHADOW=flag
      let count=0,total=0;setGitObserver(args=>{total++;if(args.some(arg=>arg.includes('/room/shadow/')))count++})
      await t.spawn(flag===undefined?'unset':'off');counts.push(count);ordinary.push(total)
    }
    expect(ordinary.every(n=>n>0)).toBe(true);expect(counts).toEqual([0,0]);expect(spy).not.toHaveBeenCalled();expect(init).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(repo,'.git/room/shadow'))).toBe(false)
  }finally{setGitObserver(undefined);spy.mockRestore();init.mockRestore()}
})
