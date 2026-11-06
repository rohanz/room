/** Privacy-bounded activity labels shared by host decoders. */
import path from 'node:path'

export const ACTIVITY_MAX = 80

const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
export const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** "verb subject", shortened from the front of the subject so the end of a path stays visible. */
export function bounded(verb: string, subject = '', max = ACTIVITY_MAX): string {
  const label = clean(subject ? `${verb} ${subject}` : verb)
  if (label.length <= max || !subject) return label.slice(0, max)
  return `${verb} …${clean(subject).slice(-(max - verb.length - 2))}`
}

/** Worktree-relative when inside it; otherwise only the last two segments. */
export function shownPath(file: string, dir: string): string {
  if (!path.isAbsolute(file)) return file
  const rel = path.relative(dir, file)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  return `…/${file.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}`
}

/** Subcommands that are fixed words of their program. Any other second word may be data and is never shown. */
const SUBCOMMANDS = new Map<string, readonly string[]>([
  ['git', ['status', 'diff', 'commit', 'log', 'show', 'add', 'push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'stash', 'reset', 'restore', 'rm', 'mv', 'worktree', 'clone', 'grep', 'blame', 'cherry-pick', 'rev-parse', 'tag', 'remote']],
  ['npm', ['test', 'run', 'install', 'ci', 'exec']],
  ['pnpm', ['test', 'run', 'install', 'exec']],
  ['yarn', ['test', 'run', 'install']],
  ['npx', ['vitest', 'tsc', 'tsx', 'eslint', 'prettier', 'playwright']],
  ['uv', ['run', 'sync', 'add', 'lock', 'pip']],
  ['cargo', ['build', 'test', 'run', 'check', 'clippy', 'fmt']],
  ['go', ['build', 'test', 'run', 'vet', 'mod']],
])

/** Probes that say nothing about the work: the previous activity stays shown instead. */
const TRIVIAL = new Set(['env', 'printenv', 'pwd', 'which', 'echo', 'true', 'sleep', 'ls'])

/** The words after `env`'s own `-u NAME` and unquoted `NAME=value` operands; an empty list when it runs nothing. */
function afterEnv(words: string[]): string[] {
  let i = 1
  while (i < words.length) {
    if (words[i] === '-u' && /^[A-Za-z_]\w*$/.test(words[i + 1] ?? '')) i += 2
    else if (/^[A-Za-z_]\w*=[^\s'"`\\$();|&<>]*$/.test(words[i])) i++
    else break
  }
  return words.slice(i)
}

/**
 * "running <program>" from the first word of the command, and only when that word is a plain path: an env
 * assignment, quote or shell syntax there could put data in its place, so the label becomes "running a command".
 * Leading `cd <plain path> &&` steps are skipped; a quoted cd argument is not, so nothing inside quotes is read.
 * `env [-u NAME]… [NAME=value]…` is skipped to the program it runs; its names and values are never shown.
 * A trivial probe (bare `env`, `pwd`, `ls`, …) has no label, so the last meaningful one stays.
 */
export function commandLabel(command: string): string | undefined {
  const wrapped = command.trim().match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/)
  const script = (wrapped ? wrapped[2] : command).trim().replace(/^(?:(?:cd|pushd)\s+[\w.+/~-]+\s*&&\s*)+/, '')
  let words = script.split(/\s+/)
  if (/^(?:[\w.+/~-]*\/)?env$/.test(words[0])) {
    words = afterEnv(words)
    if (!words.length) return undefined
  }
  const [first = '', second = ''] = words
  const program = path.posix.basename(first)
  if (!/^[\w.+/~-]+$/.test(first) || first.startsWith('-') || !/^[\w.+-]{1,40}$/.test(program)) return 'running a command'
  if (TRIVIAL.has(program)) return undefined
  return bounded('running', SUBCOMMANDS.get(program)?.includes(second) ? `${program} ${second}` : program)
}

export function toolLabel(name: string): string {
  const tool = name.startsWith('mcp__') ? name.split('__').at(-1) ?? name : name
  const safe = tool.replace(/[^\w.:-]/g, '').slice(0, 60)
  return safe.startsWith('room_') ? safe : `using ${safe || 'a tool'}`
}

/** An event's own time, when the host writes one (ISO string or epoch milliseconds). */
export function eventTime(value: unknown): number | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(at) && at > 0 ? at : undefined
}

