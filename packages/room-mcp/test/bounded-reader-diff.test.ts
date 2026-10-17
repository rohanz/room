import { beforeEach, expect, it, vi } from 'vitest'
import { applyPatch } from 'diff'
import { boundedTwoFilesPatch } from '../src/tools/files.js'
import { diffPage } from '../src/tools/reader-diff.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const probes = vi.hoisted(() => [] as Array<{ tokens: number; edits: number }>)
vi.mock('diff', async importOriginal => {
  const actual = await importOriginal<typeof import('diff')>()
  return { ...actual, structuredPatch: (...args: Parameters<typeof actual.structuredPatch>) => {
    const [, , before, after, , , options] = args
    probes.push({ tokens: before.split('\n').length + after.split('\n').length, edits: (options as { maxEditLength?: number })?.maxEditLength ?? Infinity })
    return actual.structuredPatch(...args)
  } }
})

beforeEach(() => { probes.length = 0 })
function checkBudget() {
  expect(probes.reduce((sum, { tokens, edits }) => sum + tokens * edits, 0)).toBeLessThanOrEqual(2_000_000)
  for (const { edits } of probes) expect(edits).toBeLessThanOrEqual(128)
  probes.length = 0
}

function checkGitApply(name: string, before: string, after: string, patch: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-reader-git-'))
  try {
    fs.writeFileSync(path.join(dir, name), before)
    execFileSync('git', ['apply', '-'], { cwd: dir, input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(after)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

it('restores global context when fallback partitions meet at a single unchanged anchor', () => {
  // Both halves exceed Myers' 128-edit cap. Without global context restoration,
  // the left replacement looks like EOF to Git even though the right half follows.
  const lines = Array.from({ length: 140 }, (_, i) => `line ${i}\n`)
  const before = lines.join(''), after = lines.map((line, i) => i === 70 ? line : `edit ${i}\n`).join('')
  const patch = boundedTwoFilesPatch('anchor.txt', before, after, 'Ben')
  checkGitApply('anchor.txt', before, after, patch)
  checkBudget()
})

it('keeps repetitive fallback output exact and every continuation bounded', () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => i % 7 === 0 ? '}\n' : `  x = ${i % 50};\n`)
  const before = lines.join('')
  for (let i = 0; i < 200; i++) lines[i * 10 + 3] = `  y = ${i};\n`
  const after = lines.join(''), patch = boundedTwoFilesPatch('repetitive.txt', before, after, 'Ben')
  checkBudget()
  let cursor: string | undefined, restored = '', pages = 0
  do {
    const page = diffPage(patch, cursor)
    expect(page.length).toBeLessThan(13_000)
    restored += page.slice(page.indexOf('\n') + 1, page.lastIndexOf('\n['))
    cursor = /cursor="([^"]+)"/.exec(page)?.[1]
    pages++
  } while (cursor)
  expect(pages).toBeGreaterThan(1)
  expect(restored).toBe(patch)
  checkGitApply('repetitive.txt', before, after, restored)
})

it('produces exact bounded patches for a 60 KB JSON rewrite and unrelated 800-line source', () => {
  const json = (seed: number) => '[' + Array.from({ length: 1_200 }, (_, i) => `{"id":${i},"v":"${seed}-${String(i).padStart(30, 'x')}"}`).join(',') + ']'
  const source = (seed: number) => Array.from({ length: 800 }, (_, i) => `const item${i} = ${seed} * ${i};`).join('\n') + '\n'
  for (const [name, before, after] of [
    ['data.json', json(1), json(2)],
    ['source.ts', source(1), source(2)],
    ['without-newline.ts', source(5).trimEnd(), source(6).trimEnd()],
    ['added.ts', '', source(3)],
    ['deleted.ts', source(4), ''],
  ]) {
    const patch = boundedTwoFilesPatch(name, before, after, 'Ben')
    expect(applyPatch(before, patch), name).toBe(after)
    expect(patch).toContain(`--- a/${name}`)
    expect(patch).toContain(`+++ b/${name}`)
    checkBudget()
  }
})

it('keeps scattered edits in a large source localized instead of replacing the whole file', () => {
  const lines = Array.from({ length: 3_100 }, (_, i) => `  call${i}();\n`)
  const before = lines.join('')
  for (const at of [2_600, 1_500, 400]) lines.splice(at, 8, ...Array.from({ length: 80 }, (_, i) => `  added${at}_${i}();\n`))
  const after = lines.join('')
  const patch = boundedTwoFilesPatch('backend.ts', before, after, 'Ben')
  expect(applyPatch(before, patch)).toBe(after)
  expect(patch.split('\n').length).toBeLessThan(500)
  checkBudget()
  checkGitApply('backend.ts', before, after, patch)
})

it('preserves exact patches for repeated lines, moves, Unicode, CRLF and missing final newlines', () => {
  let seed = 7
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
  for (let n = 0; n < 100; n++) {
    const before = Array.from({ length: 300 }, (_, i) => `${i % 4 ? next() % 15 : i} 🦊\r\n`).join('')
    const lines = before.match(/.*\n/g)!
    for (let edit = 0; edit < 180; edit++) lines.splice(next() % lines.length, next() % 3, `${next() % 20}\n`)
    const after = lines.slice(100).concat(lines.slice(0, 100)).join('').trimEnd()
    expect(applyPatch(before, boundedTwoFilesPatch('test', before, after, 'Ben')), `case ${n}`).toBe(after)
    checkBudget()
  }
  const before = '\n'.repeat(20_000), after = 'new\n'.repeat(20_000)
  expect(applyPatch(before, boundedTwoFilesPatch('test', before, after, 'Ben'))).toBe(after)
  checkBudget()
})

it('pages huge lines without losing characters or splitting Unicode, and rejects stale cursors', () => {
  const text = 'a'.repeat(11_999) + '🦊'.repeat(20_000)
  let cursor: string | undefined, restored = '', firstCursor = ''
  do {
    const page = diffPage(text, cursor)
    expect(Buffer.byteLength(page)).toBeLessThan(50_000)
    const body = page.slice(page.indexOf('\n') + 1, page.lastIndexOf('\n['))
    expect(body).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    restored += body
    cursor = /cursor="([^"]+)"/.exec(page)?.[1]
    firstCursor ||= cursor ?? ''
  } while (cursor)
  expect(restored).toBe(text)
  expect(diffPage(text + 'changed', firstCursor)).toContain('diff changed')
  expect(diffPage(text, 'junk')).toContain('invalid diff cursor')
  expect(diffPage('short diff', undefined)).toBe('short diff')
})
