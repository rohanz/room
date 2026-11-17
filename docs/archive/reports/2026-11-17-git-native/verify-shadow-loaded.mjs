// Three default runs under one owned CPU load. No sleep/power assertions or system settings.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd=fileURLToPath(new URL('../../../../',import.meta.url))
const output=path.resolve(process.argv[2]??'/tmp/room-shadow-loaded')
const runs=Number(process.argv[3]??3)
if(!Number.isInteger(runs)||runs<1||runs>3)throw new Error('Run count must be 1, 2 or 3')
if(fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('Choose a fresh output directory')
fs.mkdirSync(output,{recursive:true})
const env={...process.env}
for(const key of ['TEST_SCALE','ROOM_TAG','ROOM_OWNER','ROOM_SERVER'])delete env[key]
const files=fs.readdirSync(path.join(cwd,'packages/room-mcp/test')).filter(name=>name.includes('shadow')&&name.endsWith('.test.ts')).map(name=>'packages/room-mcp/test/'+name)
files.push(...['git-read-deadline','git-read-cancellation','git-default-options'].map(name=>'packages/roomd/test/'+name+'.test.ts'))
const load=spawn(process.execPath,['--input-type=module','-e',`
  import {createHash} from 'node:crypto'
  const parent=process.ppid,start=process.cpuUsage(),bytes=Buffer.alloc(1024*1024,7)
  if(parent===1)process.exit(1)
  process.on('disconnect',()=>process.exit(1))
  process.on('SIGTERM',()=>{process.send?.({cpuMicros:process.cpuUsage(start)});process.exit(0)})
  process.send?.({ready:true})
  const work=()=>{
    try{process.kill(parent,0)}catch{process.exit(1)}
    for(let n=0;n<8;n++)createHash('sha256').update(bytes).digest()
    setImmediate(work)
  };work()
`],{cwd,env,stdio:['ignore','ignore','inherit','ipc']})
let active,loadUsage,cancelled=false
const record=()=>fs.writeFileSync(path.join(output,'processes.json'),JSON.stringify({supervisor:process.pid,load:load.pid,test:active?.pid})+'\n')
record()
load.on('message',message=>{if(message.cpuMicros)loadUsage=message.cpuMicros})
const cancel=()=>{cancelled=true;active?.kill('SIGTERM');load.kill('SIGTERM')}
process.on('SIGTERM',cancel);process.on('SIGINT',cancel)
try{
  await once(load,'message')
  for(let n=1;n<=runs;n++){
    if(cancelled||load.exitCode!==null)throw new Error('CPU load ended before the run')
    const log=fs.openSync(path.join(output,`run-${n}.log`),'w'),start=Date.now()
    active=spawn(process.platform==='win32'?'npx.cmd':'npx',['vitest','run',...files,'--maxWorkers=1'],{cwd,env,stdio:['ignore',log,log]})
    record()
    const [code,signal]=await once(active,'close');fs.closeSync(log);active=undefined
    const result={run:n,code,signal,elapsedMs:Date.now()-start,loadAlive:load.exitCode===null}
    fs.appendFileSync(path.join(output,'results.jsonl'),JSON.stringify(result)+'\n');console.log(JSON.stringify(result))
    if(code!==0||!result.loadAlive||cancelled)throw new Error('Loaded default run failed; inspect its log')
  }
}finally{
  if(active?.exitCode===null){active.kill('SIGTERM');await once(active,'close')}
  if(load.exitCode===null){load.kill('SIGTERM');await once(load,'close')}
  fs.writeFileSync(path.join(output,'load.json'),JSON.stringify({pid:load.pid,exitCode:load.exitCode,cpuMicros:loadUsage})+'\n')
  process.off('SIGTERM',cancel);process.off('SIGINT',cancel)
}
