import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { GraphIndex } from '../src/graph-index.js'
import { ContractAnalysisCache } from '../src/conflict-set.js'
import { setFixtureLocalRoot } from './fixtures/manifest.js'

it('does not restore retained graph facts after stopping an index during a blocked parse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-incremental-retention-'))
  const git = (...args: string[]) => execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim()
  const room = new RoomDoc()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve=>{enter=resolve}), gate=new Promise<void>(resolve=>{release=resolve})
  const parser = { stop:vi.fn(), parse:vi.fn(async (_path:string,texts:(string|undefined)[])=>{
    enter(); await gate
    return texts.map(text=>text===undefined?undefined:{defs:[{name:'synthetic',from:1,to:1,signature:'function synthetic()'}],refs:[],ownRefs:[],imports:[]})
  }) }
  let index: GraphIndex | undefined
  try {
    git('init','-q'); git('config','user.name','synthetic'); git('config','user.email','synthetic@example.test')
    fs.writeFileSync(path.join(dir,'synthetic.js'),'export function synthetic() {}')
    git('add','.');git('commit','-qm','synthetic fixture');const base=git('rev-parse','HEAD')
    setParticipantBase(room,'Test',base);setFixtureLocalRoot(room,'Test',dir)
    index=new GraphIndex(room,'Test',dir,undefined,{random:()=>0,minPublishMs:0,parser,maxRetainedSymbols:20})
    index.start(); const idle=index.whenIdle().catch(()=>{})
    await entered
    index.stop();release();await idle
    await new Promise<void>(resolve=>setImmediate(resolve))
    expect(parser.stop).toHaveBeenCalledTimes(1)
    expect(index.graph.size).toBe(0)
    expect(index.retainedBudgetForTest.symbols).toBe(0)
    expect(index.retainedBudgetForTest.processSymbols).toBe(0)
  } finally { release();index?.stop();room.doc.destroy();fs.rmSync(dir,{recursive:true,force:true}) }
})

it('keeps an exact weighted-cache boundary and refunds an oversized replacement before declining it', () => {
  const value = { status:'ok' as const, method:'parsed' as const, changes:[{symbol:'é',kind:'signature' as const,detail:'é'.repeat(10)}] }
  const measure = new ContractAnalysisCache(100000)
  measure.set('synthetic',value)
  const exact = measure.bytes
  const cache = new ContractAnalysisCache(exact)
  cache.set('synthetic',value)
  expect(cache.bytes).toBe(exact);expect(cache.get('synthetic')).toBe(value)
  const tooSmall = new ContractAnalysisCache(exact-1)
  tooSmall.set('synthetic',value);expect(tooSmall.size).toBe(0)
  cache.set('synthetic',{...value,changes:[{...value.changes[0],detail:'x'.repeat(exact*2)}]})
  expect(cache.size).toBe(0);expect(cache.bytes).toBe(0)
  cache.set('synthetic',value);expect(cache.get('synthetic')).toBe(value)
  measure.clear();cache.clear();tooSmall.clear()
})
