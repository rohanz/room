import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { registryForDir } from '../src/worker-registry.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it.skipIf(process.platform === 'win32')('refuses to open a worker registry in a directory that is not a Git directory', async () => {
  // Resolution that lands on the working tree (here: a git stub answering "." for the common dir)
  // must not create <repo>/room/registry; a Git directory always has HEAD.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-registry-guard-'))
  roots.push(root)
  const bin = path.join(root, 'bin'), repo = path.join(root, 'repo')
  fs.mkdirSync(bin); fs.mkdirSync(repo)
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho .\n', { mode: 0o755 })
  const previous = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previous}`
  try {
    await expect(registryForDir(repo)).rejects.toThrow(/not a Git directory/)
  } finally { process.env.PATH = previous }
  expect(fs.existsSync(path.join(repo, 'room'))).toBe(false)
})
