import { createTools } from '@room/room-mcp'
let s: any = null
const t = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: process.env.CLONE! })
const j = await t.call('room_join', {}); console.log(j.split('\n').find((l: string) => l.startsWith('browser view:')))
console.log(await t.call('room_state', {})); await t.shutdown(); process.exit(0)
