import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diff3Merge } from 'node-diff3'
import { diffLines } from 'diff'

interface MergeConflict {
  /** One-based range occupied by the conflicting source region in the merged text. */
  from: number
  to: number
  a: string[]
  o: string[]
  b: string[]
}

type MergeChunk = { ok: string[]; conflict?: never } | { ok?: never; conflict: MergeConflict }

export interface GitMergeResult {
  status: 'clean' | 'conflict'
  algorithm: 'git' | 'fallback'
  fallbackReason?: string
  /** Exact stdout from `git merge-file -p --diff3`. */
  text: string
  chunks: MergeChunk[]
  conflicts: MergeConflict[]
}

let warnedFallback = false

/** node-diff3 scans each matching equivalence class against its LCS candidates. */
function diff3WithinBudget(a: string[], o: string[], b: string[]): boolean {
  if ((a.length + b.length) * o.length > 2_000_000 || a.length + o.length + b.length > 4096) return false
  const counts = new Map<string, number>()
  for (const line of o) counts.set(line, (counts.get(line) ?? 0) + 1)
  let work = 0
  for (const side of [a, b]) {
    const candidates = Math.min(side.length, o.length) + 1
    for (const line of side) {
      work += (counts.get(line) ?? 0) * candidates
      if (work > 2_000_000) return false
    }
  }
  return true
}

/** Merge three file texts with Git's own merge algorithm, falling back only when Git is unavailable. */
export async function gitMergeFile(
  base: string,
  ours: string,
  theirs: string,
  labels: { ours: string; base: string; theirs: string },
): Promise<GitMergeResult> {
  const clean = (text: string): GitMergeResult => ({ status: 'clean', algorithm: 'git', text, chunks: [{ ok: text.split('\n') }], conflicts: [] })
  if (ours === theirs || theirs === base) return clean(ours)
  if (ours === base) return clean(theirs)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-merge-file-'))
  const oursPath = path.join(dir, 'ours'), basePath = path.join(dir, 'base'), theirsPath = path.join(dir, 'theirs')
  try {
    fs.writeFileSync(oursPath, ours)
    fs.writeFileSync(basePath, base)
    fs.writeFileSync(theirsPath, theirs)
    const result = await new Promise<{ code: number; stdout: string; unavailable: boolean; error?: Error }>(resolve => {
      execFile('git', ['merge-file', '-p', '--diff3', '-L', labels.ours, '-L', labels.base, '-L', labels.theirs, oursPath, basePath, theirsPath],
        { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
          const raw = error && (error as NodeJS.ErrnoException & { code?: unknown }).code
          resolve({
            code: typeof raw === 'number' ? raw : error ? -1 : 0,
            stdout,
            unavailable: raw === 'ENOENT',
            error: error ?? undefined,
          })
        })
    })
    if (result.unavailable) return fallback(base, ours, theirs, labels, 'git unavailable')
    // Git setup failures and binary inputs may produce no markers.
    if (result.code < 0 || (result.code > 0 && !result.stdout.includes('<<<<<<< ' + labels.ours))) return fallback(base, ours, theirs, labels, result.error?.message ?? `git exited ${result.code} without conflict markers`)
    try { return parseGitMerge(result.stdout, labels, result.code) }
    catch (error) { return fallback(base, ours, theirs, labels, `could not parse git output: ${String(error)}`) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function fallback(base: string, ours: string, theirs: string, labels: { ours: string; base: string; theirs: string }, fallbackReason: string): GitMergeResult {
  if (!warnedFallback) {
    warnedFallback = true
    console.error('room: git could not render this preview; falling back to node-diff3')
  }
  const a = ours.split('\n'), o = base.split('\n'), b = theirs.split('\n')
  const edits = Math.max(1, Math.min(128, Math.floor(2_000_000 / Math.max(1, a.length + o.length + b.length))))
  const bounded = diff3WithinBudget(a, o, b) && diffLines(ours, base, { maxEditLength: edits }) && diffLines(theirs, base, { maxEditLength: edits })
  // A distant rewrite is an uncertain whole-file conflict. Its alternatives stay exact.
  const raw: ReturnType<typeof diff3Merge<string>> = bounded ? diff3Merge(a, o, b)
    : [{ conflict: { a, o, b, aIndex: 0, oIndex: 0, bIndex: 0 } }]
  const chunks: MergeChunk[] = []
  const rendered: string[] = []
  const conflicts: MergeConflict[] = []
  let line = 1
  for (const part of raw) {
    if (part.ok) {
      chunks.push({ ok: part.ok })
      for (const text of part.ok) rendered.push(text)
      line += part.ok.length
      continue
    }
    if (!part.conflict) continue
    const conflict = { from: line, to: line + Math.max(0, part.conflict.o.length - 1), ...part.conflict }
    chunks.push({ conflict })
    conflicts.push(conflict)
    rendered.push(`<<<<<<< ${labels.ours}`)
    for (const text of conflict.a) rendered.push(text)
    rendered.push(`||||||| ${labels.base}`)
    for (const text of conflict.o) rendered.push(text)
    rendered.push('=======')
    for (const text of conflict.b) rendered.push(text)
    rendered.push(`>>>>>>> ${labels.theirs}`)
    line += conflict.o.length
  }
  return { status: conflicts.length ? 'conflict' : 'clean', algorithm: 'fallback', fallbackReason, text: rendered.join('\n'), chunks, conflicts }
}

function parseGitMerge(text: string, labels: { ours: string; base: string; theirs: string }, exitCode: number): GitMergeResult {
  if (exitCode === 0) return { status: 'clean', algorithm: 'git', text, chunks: [{ ok: text.split('\n') }], conflicts: [] }
  const lines = text.split('\n')
  const chunks: MergeChunk[] = []
  const conflicts: MergeConflict[] = []
  let plain: string[] = []
  let sourceLine = 1
  const flush = () => {
    if (!plain.length) return
    chunks.push({ ok: plain })
    sourceLine += plain.length
    plain = []
  }
  for (let i = 0; i < lines.length;) {
    if (lines[i] !== `<<<<<<< ${labels.ours}`) { plain.push(lines[i++]); continue }
    flush()
    const baseMarker = lines.indexOf(`||||||| ${labels.base}`, i + 1)
    const divider = baseMarker < 0 ? -1 : lines.indexOf('=======', baseMarker + 1)
    const end = divider < 0 ? -1 : lines.indexOf(`>>>>>>> ${labels.theirs}`, divider + 1)
    if (baseMarker < 0 || divider < 0 || end < 0) throw new Error('could not parse git merge-file conflict markers')
    const a = lines.slice(i + 1, baseMarker), o = lines.slice(baseMarker + 1, divider), b = lines.slice(divider + 1, end)
    const conflict: MergeConflict = { from: sourceLine, to: sourceLine + Math.max(0, o.length - 1), a, o, b }
    chunks.push({ conflict })
    conflicts.push(conflict)
    sourceLine += o.length
    i = end + 1
  }
  flush()
  if (!conflicts.length) throw new Error(`git merge-file exited ${exitCode} without conflict markers`)
  return { status: 'conflict', algorithm: 'git', text, chunks, conflicts }
}
