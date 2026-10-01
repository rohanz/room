import { describe, expect, it } from 'vitest'
import { ignoredOutputNotes } from '../src/tools/combined-tree.js'

describe('gitignored paths a preview leaves out', () => {
  it('summarises regenerable build output across participants in one line and keeps other paths per person', () => {
    const notes = ignoredOutputNotes(new Map([
      ['lead', ['packages/web/dist/', 'artifact.bin']],
      ['w1', ['packages/a/dist/', 'packages/b/dist/', 'node_modules/']],
      ['w2', ['packages/a/dist/', 'coverage/']],
      ['w3', ['build/', 'notes/scratch.md']],
      ['w4', ['packages/c/dist/', '.venv/']],
    ]))
    expect(notes).toEqual([
      'build output not previewed (gitignored, regenerable): 7 folders (build/, coverage/, dist/) across 5 participants',
      'NOT previewed (gitignored, lead): artifact.bin',
      'NOT previewed (gitignored, w3): notes/scratch.md',
    ])
  })

  it('names the one participant and counts a regenerable file as a path', () => {
    expect(ignoredOutputNotes(new Map([['Rohan', ['dist/', 'out/bundle.js', 'tsconfig.tsbuildinfo']]]))).toEqual([
      'build output not previewed (gitignored, regenerable): 2 paths (dist/, out/) from Rohan',
    ])
  })

  it('says nothing when only caches and Room files are ignored', () => {
    expect(ignoredOutputNotes(new Map([['Rohan', ['.venv/', '__pycache__/', '.room/', '.room.json', 'node_modules/']]]))).toEqual([])
  })
})
