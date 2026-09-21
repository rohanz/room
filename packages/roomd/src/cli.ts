#!/usr/bin/env tsx
/**
 * roomd CLI: `roomd --room ws://host:1234/<room> --dir <clone> --name <Name> [--share intent|declared|full]`
 */
import { startRoomd, RoomdError, parseShare } from './index.js'

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
const shareRaw = args.share ?? process.env.ROOM_SHARE
const share = parseShare(shareRaw)
if (!room || !name || args.help || (shareRaw && !share)) {
  console.error('usage: roomd --room ws://host:1234/<room> --dir <clone> --name <Name> [--share intent|declared|full]')
  process.exit(args.help ? 0 : 1)
}

startRoomd({ room, dir, name, share })
  .then(d => {
    process.on('SIGINT', () => { void d.stop('SIGINT').then(() => process.exit(0)) })
    process.on('SIGTERM', () => { void d.stop('SIGTERM').then(() => process.exit(0)) })
    process.on('uncaughtException', error => { void d.stop(`uncaught exception: ${error.stack ?? error}`).finally(() => process.exit(1)) })
    process.on('unhandledRejection', error => { void d.stop(`unhandled rejection: ${String(error)}`).finally(() => process.exit(1)) })
  })
  .catch(err => {
    console.error(`[roomd] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(err instanceof RoomdError ? err.code : 1)
  })
