/** MCP startup attribution. Never opens source .git/room for writing. Outputs may contain private code: keep outside Git.
 * node --import tsx scripts/measure-mcp-memory.mts --owner /absolute/owner/clone [--case small|fresh|state] [--seconds 60]
 * Optional controls: --no-index (instrumented only), --shipped, --native (macOS vmmap).
 * Uses current checkout's sources, bundled like the plugin, and a real stdio MCP client.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.includes('--help')) { console.log('node --import tsx scripts/measure-mcp-memory.mts --owner <clone> [--case small|fresh|state] [--seconds 60] [--no-index | --shipped] [--native]'); process.exit(0) }
if (args.includes('--no-index') && args.includes('--shipped')) throw Error('--no-index needs instrumented sources')
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback
const owner = path.resolve(option('--owner', root))
const seconds = Number(option('--seconds', '60'))
const cases = args.includes('--case') ? [option('--case', '')] : ['small', 'fresh', 'state']
if (!cases.every(c => ['small', 'fresh', 'state'].includes(c)) || !Number.isFinite(seconds) || seconds < 1) throw Error('invalid case/seconds')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'room-mcp-memory-'))
console.log(JSON.stringify({ output, platform: os.platform(), arch: os.arch(), node: process.version, cpus: os.cpus()[0]?.model, totalMemory: os.totalmem(), mode:args.includes('--shipped')?'shipped':args.includes('--no-index')?'index-disabled':'instrumented', bundleSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'plugins/room/server/room-mcp.mjs'))).digest('hex'), source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: owner, encoding: 'utf8' }).trim() }))
const preload = path.join(output, 'probe.mjs')
fs.writeFileSync(preload, `import fs from 'node:fs'; import v8 from 'node:v8'; import {threadId,isMainThread} from 'node:worker_threads'; import {execFileSync} from 'node:child_process';
const file=process.env.MEM_OUTPUT; const start=Date.now(); let session; let live=0;
function docFacts(doc) { if(!doc) return; let structs=0,deleted=0,strings=0,items={}; for(const rows of doc.store.clients.values()) for(const item of rows) { structs++; if(item.deleted)deleted++; const name=item.constructor.name; items[name]=(items[name]||0)+1; if(item.content?.str) strings+=Buffer.byteLength(item.content.str); } return {structs,deleted,strings,items,roots:[...doc.share].map(([k,v])=> { const type=v._map.size?doc.getMap(k):v; const value=type.toJSON(); return [k,type.size??type.length,JSON.stringify(value)?.length??0]; })}; }
globalThis.__mem=(stage,extra={})=> { if(!file)return; if(extra.session){session=extra.session; extra={};} if(stage==='worker-start')live++; if(stage==='worker-exit')live--; fs.appendFileSync(file,JSON.stringify({stage,at:Date.now(),ms:Date.now()-start,pid:process.pid,threadId,memory:process.memoryUsage(),heap:v8.getHeapStatistics(),live,...extra})+'\\n'); };
globalThis.__mem('preload');
const timer=setInterval(()=>globalThis.__mem('tick'),1000); timer.unref();
if(isMainThread) globalThis.__memFinish=()=> { globalThis.__mem('minute'); if(process.env.MEM_NATIVE==='1') { try { fs.writeFileSync(file+'.vmmap',execFileSync('vmmap',['-summary',String(process.pid)],{timeout:15000,encoding:'utf8'})); } catch(e) { fs.writeFileSync(file+'.vmmap-error',String(e)); } } globalThis.__mem('inventory',{doc:docFacts(session?.room.doc),graph:session?.graph?{status:session.graph.indexingStatus,budget:session.graph.retainedBudgetForTest,cache:session.graph.cache.size,publishedCache:session.graph.publishedCache.size,baseTexts:session.graph.baseTexts.size,cacheJsonBytes:JSON.stringify([...session.graph.cache]).length,publishedJsonBytes:JSON.stringify([...session.graph.publishedCache]).length}:undefined}); globalThis.gc?.(); globalThis.__mem('after-gc'); v8.writeHeapSnapshot(file+'.heapsnapshot'); globalThis.__mem('after-snapshot'); };
`)
const patch = (contents: string, before: string, after: string) => { if (!contents.includes(before)) throw Error('probe anchor missing: '+before); return contents.replaceAll(before, after) }
const probe = 'globalThis.__mem'
const instrument = { name: 'memory-probe', setup(b: import('esbuild').PluginBuild) { b.onLoad({ filter: /\/(session|graph-index|client|worker|engine)\.ts$/ }, async a => {
  let s = fs.readFileSync(a.path, 'utf8')
  if (a.path.endsWith('/room-mcp/src/session.ts')) {
    s = patch(s, 'const reachable = await hub.hello()', `${probe}?.('first-sync'); const reachable = await hub.hello()`)
    s = patch(s, 'indexWhileLeading(session, opts.reuse?.graph, opts.log)', `${probe}?.('joined', {session}); indexWhileLeading(session, opts.reuse?.graph, opts.log)`)
    if (args.includes('--no-index')) s = patch(s, 's.graph.start() },', "globalThis.__mem?.('index-disabled') },")
    else s = patch(s, 's.graph.start() },', `s.graph.start(); void s.graph.ready.then(() => ${probe}?.('indexed', {status:s.graph?.indexingStatus, budget:s.graph?.retainedBudgetForTest}), error => globalThis.__mem?.('index-error', {error:String(error)})) },`)
  }
  if (a.path.endsWith('/parse/client.ts')) {
    s = patch(s, 'this.worker = worker', `${probe}?.('worker-start', {workerThread:worker.threadId}); this.worker = worker`)
    s = patch(s, "worker.on('exit', code => {", `worker.on('exit', code => { ${probe}?.('worker-exit', {workerThread:threadId});`)
  }
  if (a.path.endsWith('/parse/engine.ts')) s = patch(s, 'return { parser, query: language.query(spec.query), spec }', `const result = { parser, query: language.query(spec.query), spec }; ${probe}?.('grammar', {grammar:spec.grammar}); return result`)
  return { contents: s, loader: 'ts' }
}) } }
const bundle = { bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node22', tsconfig: path.join(root,'tsconfig.base.json'), plugins: [instrument], banner: { js: "import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);" } }
const finish = "globalThis.__mem?.('module-loaded'); setTimeout(()=>globalThis.__memFinish?.(), Number(process.env.MEM_SECONDS)*1000).unref();"
if (args.includes('--shipped')) {
  fs.copyFileSync(path.join(root,'plugins/room/server/room-mcp.mjs'),path.join(output,'room-mcp.mjs'))
  fs.appendFileSync(path.join(output,'room-mcp.mjs'),'\n'+finish)
  fs.copyFileSync(path.join(root,'plugins/room/server/parse-worker.mjs'),path.join(output,'parse-worker.mjs'))
} else {
  await build({ ...bundle, entryPoints: [path.join(root,'packages/room-mcp/src/index.ts')], outfile: path.join(output,'room-mcp.mjs'), footer: {js:finish} })
  await build({ ...bundle, entryPoints: [path.join(root,'packages/room-mcp/src/parse/worker.ts')], outfile: path.join(output,'parse-worker.mjs') })
}
// Use the shipped daemon and grammars: they are a separate process, excluded from MCP RSS.
fs.copyFileSync(path.join(root,'plugins/room/server/room-daemon.mjs'),path.join(output,'room-daemon.mjs'))
fs.cpSync(path.join(root,'plugins/room/server/grammars'),path.join(output,'grammars'),{recursive:true})
for (const scenario of cases) {
  const base = path.join(output,scenario); fs.mkdirSync(base)
  // Keep the basename: local/<basename> selects the same saved Y.Doc key.
  const dir = path.join(base,path.basename(owner))
  const git = (...a: string[]) => execFileSync('git',a,{cwd:dir,stdio:'pipe',encoding:'utf8'})
  if (scenario==='small') { fs.mkdirSync(dir); git('init','-q'); git('config','user.name','MemoryProbe'); git('config','user.email','memory@example.invalid'); fs.writeFileSync(path.join(dir,'app.ts'),'export const value = 1\n'); git('add','.'); git('commit','-qm','fixture') }
  else { execFileSync('git',['clone','--quiet','--no-hardlinks',owner,dir],{stdio:'pipe'}); git('config','user.name','MemoryProbe'); git('config','user.email','memory@example.invalid') }
  const room = path.join(dir,'.git','room')
  if (scenario==='state') {
    fs.cpSync(path.join(owner,'.git','room'),room,{recursive:true,preserveTimestamps:true})
    // Preserve all copied files, but do not adopt the owner's live daemon discovery.
    fs.renameSync(path.join(room,'relay.json'),path.join(room,'relay.original-copy.json'))
    const authority=path.join(room,'hub','authority.lock')
    if(fs.existsSync(authority)) fs.renameSync(authority,authority+'.original-copy')
  }
  const saved=path.join(room,'relay',encodeURIComponent('local/'+path.basename(owner))+'.ydoc')
  fs.writeFileSync(path.join(base,'fixture.json'),JSON.stringify({scenario,at:new Date().toISOString(),head:git('rev-parse','HEAD').trim(),tracked:git('ls-files','-z').split('\0').filter(Boolean).length,saved:fs.existsSync(saved)?{bytes:fs.statSync(saved).size,sha256:createHash('sha256').update(fs.readFileSync(saved)).digest('hex')}:undefined},null,2))
  const home = path.join(base,'home'); fs.mkdirSync(home)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&!/^(ROOM_|CLAUDE_|CODEX_)/.test(k))) as Record<string,string>
  delete env.NODE_OPTIONS
  Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),ROOM_DIR:dir,ROOM_OWNER:'MemoryProbe',ROOM_SHARE:'intent',MEM_OUTPUT:path.join(base,'samples.jsonl'),MEM_SECONDS:String(seconds),MEM_NATIVE:args.includes('--native')?'1':'0'})
  const child = spawn(process.execPath,['--expose-gc','--import',preload,path.join(output,'room-mcp.mjs')],{env,cwd:dir,stdio:['pipe','pipe','pipe']})
  let log=''; child.stderr.on('data',c=>{log+=String(c);fs.appendFileSync(path.join(base,'stderr.log'),c)})
  let id=0
  const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  const lines=createInterface({input:child.stdout})
  lines.on('line',line=>{ const msg=JSON.parse(line); const wait=pending.get(msg.id); if(!wait)return; pending.delete(msg.id); msg.error?wait.reject(Error(JSON.stringify(msg.error))):wait.resolve(msg.result) })
  child.on('exit',()=>{ for(const wait of pending.values())wait.reject(Error('MCP exited: '+log)); pending.clear() })
  const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const n=++id; const timer=setTimeout(()=>{pending.delete(n);reject(Error('MCP request timed out: '+method))},90000); pending.set(n,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')})
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()))
  try {
    await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'memory-probe',version:'1'}})
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
    const state=await request('tools/call',{name:'room_state',arguments:{}})
    fs.writeFileSync(path.join(base,'state.json'),JSON.stringify(state))
    if(state.isError) throw Error('MCP join failed: '+JSON.stringify(state))
    const deadline=Date.now()+(seconds+45)*1000
    while (!fs.existsSync(env.MEM_OUTPUT) || !fs.readFileSync(env.MEM_OUTPUT,'utf8').includes('\"stage\":\"after-snapshot\"')) { if (child.exitCode!==null || child.signalCode!==null) throw Error('MCP exited before snapshot completion'); if (Date.now()>deadline) throw Error('snapshot timeout'); await delay(500) }
    await delay(1000)
    console.log(JSON.stringify({scenario,pid:child.pid,samples:fs.readFileSync(env.MEM_OUTPUT,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.stage!=='tick').map(({heap,...r})=>r)}))
  } catch(e) { console.log(JSON.stringify({scenario,error:String(e),log})); throw e }
  finally {
    child.kill('SIGTERM'); await Promise.race([exited,delay(2000)]); if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL'); await exited; lines.close()
    // Stop only the daemon this scratch clone launched, never the copied original PID.
    if(fs.existsSync(path.join(room,'relay.json'))) {
      const own=JSON.parse(fs.readFileSync(path.join(room,'relay.json'),'utf8'))
      const original=fs.existsSync(path.join(room,'relay.original-copy.json'))?JSON.parse(fs.readFileSync(path.join(room,'relay.original-copy.json'),'utf8')):undefined
      if(own.pid && own.pid!==original?.pid) { try { execFileSync(process.execPath,[path.join(output,'room-daemon.mjs'),'stop','--common-dir',path.join(dir,'.git')],{timeout:15000,stdio:'pipe'}) } catch(error) { throw Error('Scratch daemon cleanup failed: '+String(error)) } }
    }
  }
}
console.log(JSON.stringify({output,complete:true}))
