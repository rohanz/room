import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStaleVersionWarning } from '../src/stale-version.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function plugin(version: string, root?: string) {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'room-stale-'))
  if (!root) dirs.push(dir)
  mkdirSync(join(dir, 'server'), { recursive: true })
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
  return join(dir, 'server', 'room-mcp.mjs')
}

it('warns only for a strictly newer numeric version and ignores bad manifests', () => {
  const modulePath = plugin('0.16.36')
  const manifest = join(modulePath, '..', '..', '.claude-plugin', 'plugin.json')
  expect(createStaleVersionWarning(modulePath, '0.13.0')()).toBe('this session runs Room 0.13.0; 0.16.36 is installed. Restart the session or reconnect Room (/mcp) to use it.')
  expect(createStaleVersionWarning(modulePath, '0.16.36')()).toBeUndefined()
  expect(createStaleVersionWarning(modulePath, '0.17.0')()).toBeUndefined()
  expect(createStaleVersionWarning(modulePath, '0.9.0')()).toContain('0.16.36 is installed')
  writeFileSync(manifest, '{broken')
  expect(createStaleVersionWarning(modulePath, '0.13.0')()).toBeUndefined()
  writeFileSync(manifest, JSON.stringify({ version: '0.16.x' }))
  expect(createStaleVersionWarning(modulePath, '0.13.0')()).toBeUndefined()
  rmSync(manifest)
  expect(createStaleVersionWarning(modulePath, '0.13.0')()).toBeUndefined()
})

it('re-reads after the TTL', () => {
  const modulePath = plugin('0.16.36')
  const manifest = join(modulePath, '..', '..', '.claude-plugin', 'plugin.json')
  let now = 1000
  const readFile = vi.fn((path: string) => readFileSync(path, 'utf8'))
  const warning = createStaleVersionWarning(modulePath, '0.13.0', { now: () => now, readFile })
  expect(warning()).toContain('0.16.36 is installed')
  writeFileSync(manifest, JSON.stringify({ version: '0.16.37' }))
  now += 29_999
  expect(warning()).toContain('0.16.36 is installed')
  expect(readFile).toHaveBeenCalledTimes(1)
  now += 1
  expect(warning()).toContain('0.16.37 is installed')
  expect(readFile).toHaveBeenCalledTimes(2)
})

it('finds the active sibling when the loaded Claude cache directory is orphaned', () => {
  const cache = mkdtempSync(join(tmpdir(), 'room-cache-'))
  dirs.push(cache)
  const old = plugin('0.13.0', join(cache, '0.13.0'))
  writeFileSync(join(cache, '0.13.0', '.orphaned_at'), 'today')
  plugin('0.16.36', join(cache, '0.16.36'))
  const orphan = plugin('0.17.0', join(cache, '0.17.0'))
  writeFileSync(join(cache, '0.17.0', '.orphaned_at'), 'today')
  expect(createStaleVersionWarning(old, '0.13.0')()).toContain('0.16.36 is installed')
  expect(createStaleVersionWarning(orphan, '0.17.0')()).toBeUndefined()
})

it('resolves a source module against the checkout plugin manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'room-source-'))
  dirs.push(root)
  const source = join(root, 'packages', 'room-mcp', 'src', 'stale-version.ts')
  mkdirSync(join(root, 'packages', 'room-mcp', 'src'), { recursive: true })
  plugin('0.16.36', join(root, 'plugins', 'room'))
  expect(createStaleVersionWarning(source, '0.13.0')()).toContain('0.16.36 is installed')
})
