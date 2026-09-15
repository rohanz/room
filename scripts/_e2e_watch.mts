import { createTools } from '@room/room-mcp'
let s: any = null
process.env.ROOM_TAG = 'watch'
const t = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: '/tmp/shop-watch' })
await t.call('room_join', { where: 'team' })
const pres = Array.from(s.provider.awareness.getStates().values()).map((x: any) => `${x.user?.name}[${(x.status ?? '').slice(0, 40)}]`).filter((n: string) => !n.startsWith('rohanz+watch'))
console.log('T', new Date().toISOString().slice(11, 19), 'present:', pres.join(' | '))
console.log('  claims:', s.room.openClaims().map((c: any) => `${c.by}:${c.path}:${c.from}-${c.to}`).join(' ') || 'none')
const msgs = s.room.messages().slice(-6)
for (const m of msgs) console.log('  ', new Date(m.at).toISOString().slice(11, 19), m.type.padEnd(8), (m.from + '').padEnd(13), '→', (m.to ?? '*').padEnd(13), (m.text ?? '').slice(0, 90).replace(/\n/g, ' '))
await t.shutdown(); process.exit(0)
