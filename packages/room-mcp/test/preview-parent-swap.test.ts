import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fingerprintTree, validateFingerprintSync } from '../src/preview-evidence.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it.each(['parent', 'ancestor'] as const)('rejects a %s swapped for a symlink between sibling checks in one gate', async kind => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-parent-')))
  roots.push(root)
  const directory = path.join(root, 'src')
  const parent = kind === 'parent' ? directory : path.join(directory, 'nested')
  fs.mkdirSync(parent, { recursive: true })
  fs.writeFileSync(path.join(parent, 'a.txt'), 'a')
  fs.writeFileSync(path.join(parent, 'b.txt'), 'b')
  const paths = ['a.txt', 'b.txt'].map(name => path.relative(root, path.join(parent, name)))
  const tree = await fingerprintTree(root, paths)
  const lstat = fs.lstatSync
  let checked = 0
  let swapped = false
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (path.dirname(String(file)) === parent && ++checked === 2) {
      // Deterministically schedule an external directory rename at the syscall boundary.
      // The child files retain all metadata used by sameFile; only an ancestor changes.
      const moved = path.join(root, 'saved-src')
      fs.renameSync(directory, moved)
      fs.symlinkSync(moved, directory, 'dir')
      swapped = true
    }
    return lstat(file, options as never)
  }) as typeof fs.lstatSync)
  expect(() => validateFingerprintSync(tree, paths)).toThrow(/linked ancestor/)
  expect(swapped).toBe(true)
})
