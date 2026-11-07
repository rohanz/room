import { execFileSync } from 'node:child_process'
export const parentCommand: () => string = () => execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], {
  encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim()
