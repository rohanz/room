import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diff3Merge } from 'node-diff3'

export interface MergeConflict {
  /** One-based range occupied by the conflicting source region in the merged text. */
  from: number
  to: number
  a: string[]
  o: string[]
  b: string[]
}

export type MergeChunk = { ok: string[]; conflict?: never } | { ok?: never; conflict: MergeConflict }

export interface GitMergeResult {
  status: 'clean' | 'conflict'
  /** Exact stdout from `git merge-file -p --diff3`. */
  text: string
  chunks: MergeChunk[]
  conflicts: MergeConflict[]
}

let warnedFallback = false

/** Merge three file texts with Git's own merge algorithm, falling back only when Git is unavailable. */
export async function gitMergeFile(
  base: string,
  ours: string,
  theirs: string,
  labels: { ours: string; base: string; theirs: string },
): Promise<GitMergeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-merge-file-'))
  const oursPath = path.join(dir, 'ours'), basePath = path.join(dir, 'base'), theirsPath = path.join(dir, 'theirs')
  try {
    fs.writeFileSync(oursPath, ours)
    fs.writeFileSync(basePath, base)
    fs.writeFileSync(theirsPath, theirs)
    const result = await new Promise<{ code: number; stdout: string; unavailable: boolean; error?: Error }>(resolve => {
      execFile('git', ['merge-file', '-p', '--diff3', '-L', labels.ours, '-L', labels.base, '-L', labels.theirs, oursPath, basePath, theirsPath],
        { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
          const raw = error && (error as NodeJS.ErrnoException & { code?: unknown }).code
          resolve({
            code: typeof raw === 'number' ? raw : error ? -1 : 0,
            stdout,
            unavailable: raw === 'ENOENT',
            error: error ?? undefined,
          })
        })
    })
    if (result.unavailable) return fallback(base, ours, theirs, labels)
    if (result.code < 0) throw result.error ?? new Error('git merge-file failed')
    return parseGitMerge(result.stdout, labels, result.code)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function fallback(base: string, ours: string, theirs: string, labels: { ours: string; base: string; theirs: string }): GitMergeResult {
  if (!warnedFallback) {
    warnedFallback = true
    console.error('room: git is unavailable; falling back to node-diff3 for merge previews')
  }
  const raw = diff3Merge(ours.split('\n'), base.split('\n'), theirs.split('\n'))
  const chunks: MergeChunk[] = []
  const rendered: string[] = []
  const conflicts: MergeConflict[] = []
  let line = 1
  for (const part of raw) {
    if (part.ok) {
      chunks.push({ ok: part.ok })
      rendered.push(...part.ok)
      line += part.ok.length
      continue
    }
    if (!part.conflict) continue
    const conflict = { from: line, to: line + Math.max(0, part.conflict.o.length - 1), ...part.conflict }
    chunks.push({ conflict })
    conflicts.push(conflict)
    rendered.push(`<<<<<<< ${labels.ours}`, ...conflict.a, `||||||| ${labels.base}`, ...conflict.o, '=======', ...conflict.b, `>>>>>>> ${labels.theirs}`)
    line += conflict.o.length
  }
  return { status: conflicts.length ? 'conflict' : 'clean', text: rendered.join('\n'), chunks, conflicts }
}

function parseGitMerge(text: string, labels: { ours: string; base: string; theirs: string }, exitCode: number): GitMergeResult {
  if (exitCode === 0) return { status: 'clean', text, chunks: [{ ok: text.split('\n') }], conflicts: [] }
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
  return { status: 'conflict', text, chunks, conflicts }
}
