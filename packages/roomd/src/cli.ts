#!/usr/bin/env tsx
/**
 * roomd CLI: `roomd --room ws://host:1234/<room> --dir <clone> --name <Name>`
 */
import { startRoomd, RoomdError } from './index.js'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2)
      if (v !== undefined) out[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
      else out[k] = 'true'
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const room = args.room ?? process.env.ROOM_URL
const dir = args.dir ?? process.env.ROOM_DIR ?? process.cwd()
const name = args.name ?? process.env.ROOM_NAME
if (!room || !name || args.help) {
  console.error('usage: roomd --room ws://host:1234/<room> --dir <clone> --name <Name>')
  process.exit(args.help ? 0 : 1)
}

startRoomd({ room, dir, name })
  .then(d => {
    const stop = () => d.stop().then(() => process.exit(0))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  .catch(err => {
    console.error(`[roomd] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(err instanceof RoomdError ? err.code : 1)
  })
