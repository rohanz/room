// OS smoke fixture only. Accepts Room's constructed Claude arguments; never contacts a provider.
const args = process.argv.slice(2)
const resume = args.indexOf('--resume')
const fresh = args.indexOf('--session-id')
const sessionId = args[(resume >= 0 ? resume : fresh) + 1]
const prompt = args[resume >= 0 ? resume + 2 : args.indexOf('-p') + 1]
if (!sessionId || !prompt || !args.includes('--output-format')) process.exit(2)
const env = Object.fromEntries(['ROOM_WORKER_ID', 'ROOM_WORKER_RUN', 'ROOM_ROOM', 'PORT', 'OMP_NUM_THREADS', 'ROOM_WORKER_MEM_GB']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
console.log(JSON.stringify({ type: 'fake-host-ready', session_id: sessionId, prompt, cwd: process.cwd(), env }))
console.log(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'fake host accepted fixture prompt' }] } }))
// The parent must observe and stop this real child; the deadline bounds failed smoke runs.
setTimeout(() => process.exit(3), 25_000)
