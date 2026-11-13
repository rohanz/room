import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import { deliveryIndex, trim, type RetiredWorker } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { memorySession } from './fixtures/session.js'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn() })
function fixture(me = 'lead') {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev3-question-'))
 execFileSync('git', ['init', '-q', dir])
 const s = memorySession({name: me, kind:'agent'}, dir)
 for (const name of ['peer', 'lead', 'third']) s.room.colors.set(name, 0)
 const tools = createTools({getSession:()=>s, setSession:()=>{}, cwd:dir, log:()=>{}})
 cleanups.push(async()=>{ await tools.shutdown(); await closeRegistryForDir(dir); s.awareness.destroy(); s.room.doc.destroy(); fs.rmSync(dir,{recursive:true,force:true}) })
 return {s,tools}
}
it.each(['wrong sender','wrong recipient'])('keeps a read question answerable after an answer with %s', async mistake => {
 const {s,tools}=fixture()
 const q=hubAppend(s.room,{name:'peer',kind:'agent'},{type:'question',to:'lead',text:'Still needs an answer'})
 s.room.markSeen('lead',[q.id],{s:'lead-session',via:'reply'})
 const result = await s.post({name:mistake==='wrong sender'?'third':'lead',kind:'agent'},
   {type:'answer',to:mistake==='wrong recipient'?'third':'peer',inReplyTo:q.id,text:'Not the requested answer'})
 expect(result.ok).toBe(true)
 expect(s.room.outcomes.has(q.id)).toBe(false)
 const candidates=await tools.call('room_send',{type:'answer',inReplyTo:'typo',text:'answer'})
 expect.soft(candidates).toContain(`${q.id}:`)
 trim(s.room,Date.now(),{busKeep:0})
 expect(s.room.message(q.id)).toBeDefined()
})
it('delivers actual answer text to an already blocked asker', async()=>{
 const {s,tools}=fixture('peer')
 const q=hubAppend(s.room,s.me,{type:'question',to:'lead',text:'Question'})
 const waiting=tools.call('room_wait',{questionId:q.id,timeoutMs:1000})
 await new Promise(r=>setTimeout(r,20))
 expect(await s.post({name:'lead',kind:'agent'},{type:'answer',to:'peer',inReplyTo:q.id,text:'exact answer body'})).toMatchObject({ok:true})
 expect(await waiting).toContain('exact answer body')
 expect(s.room.seen('peer').size).toBeGreaterThan(0)
})
it('ends a blocked wait only on retirement, not ordinary disappearance',async()=>{
 const {s,tools}=fixture('peer')
 s.room.workerViews.set('w',{id:'w',name:'lead',tag:'w',lead:'peer',mode:'local',host:'codex',task:'',branch:'room/w',status:'running',run:1,startedAt:Date.now(),fence:'test'})
 const q=hubAppend(s.room,s.me,{type:'question',to:'lead',text:'Question'})
 s.room.participants.set('lead\0id',{name:'lead',kind:'agent'})
 s.room.participants.delete('lead\0id')
 expect(s.room.outcomes.has(q.id)).toBe(false)
 const waiting=tools.call('room_wait',{questionId:q.id,timeoutMs:1000})
 await new Promise(r=>setTimeout(r,20))
 const now=Date.now()
 const retired:RetiredWorker={id:'w',name:'lead',tag:'w',lead:'peer',host:'codex',task:'',summary:'done',files:[],fileCount:0,startedAt:now,finishedAt:now,retiredAt:now,outcome:'clean'}
 s.room.retireWorker('w',retired,()=>{})
 expect(await waiting).toContain('will not answer')
})
it('heals a bounded saved bus without repeatedly growing the serialized document',()=>{
 const {s}=fixture()
 const now=Date.now()
 for(let i=0;i<1000;i++) s.room.bus.push([
  {id:`q${i}`,type:'question',from:`asker${i}`,fromKind:'agent',to:`peer${i}`,text:'question',at:now,seq:2*i+1},
  {id:`a${i}`,type:'answer',from:`peer${i}`,fromKind:'agent',to:`asker${i}`,inReplyTo:`q${i}`,text:'answer',at:now,seq:2*i+2},
 ])
 trim(s.room,now)
 expect(s.room.outcomes.size).toBe(1000)
 const size=Y.encodeStateAsUpdate(s.room.doc).byteLength
 trim(s.room,now)
 expect(Y.encodeStateAsUpdate(s.room.doc).byteLength).toBe(size)
 expect(deliveryIndex(s.room).verify()).toBeUndefined()
})
it('does not accept another participant reply as the requested answer',async()=>{
 const {s,tools}=fixture('peer')
 const q=hubAppend(s.room,s.me,{type:'question',to:'lead',text:'Question for lead'})
 expect(await s.post({name:'third',kind:'agent'},{type:'answer',to:'peer',inReplyTo:q.id,text:'Unrelated participant reply'})).toMatchObject({ok:true})
 expect(s.room.outcomes.has(q.id)).toBe(false)
 expect(await tools.call('room_wait',{questionId:q.id,timeoutMs:5})).not.toContain('answered:')
})
it('does not manufacture outcomes for a typo or close a broadcast for other recipients',()=>{
 const {s}=fixture()
 s.room.bus.push([{id:'broadcast',type:'question',from:'peer',fromKind:'agent',text:'Anyone?',at:Date.now(),seq:1} as any])
 for(const name of ['lead','third']) hubAppend(s.room,{name,kind:'agent'},{type:'answer',to:'peer',inReplyTo:'broadcast',text:'My answer'})
 hubAppend(s.room,s.me,{type:'answer',to:'peer',inReplyTo:'typo',text:'Mistyped reference'})
 expect(s.room.outcomes.has('broadcast')).toBe(false)
 expect(s.room.outcomes.has('typo')).toBe(false)
})
it('publishes an accepted answer and its outcome in one hub transaction',async()=>{
 const {s}=fixture()
 const q=hubAppend(s.room,{name:'peer',kind:'agent'},{type:'question',to:'lead',text:'Question'})
 const observations:boolean[]=[]
 const observe=()=>{if(s.room.messages().some(m=>m.type==='answer')) observations.push(s.room.outcomes.get(q.id)?.outcome==='answered')}
 s.room.doc.on('update',observe)
 expect(await s.post(s.me,{type:'answer',to:'peer',inReplyTo:q.id,text:'Answer'})).toMatchObject({ok:true})
 s.room.doc.off('update',observe)
 expect(observations).toEqual([true])
})
