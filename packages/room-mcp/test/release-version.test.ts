import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Every file that carries the release version must agree (scripts/bump-version.mjs stamps them).
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8')
const json = (rel: string) => JSON.parse(read(rel)) as { version?: string; plugins?: { name: string; version: string }[] }

describe('release version', () => {
  const version = json('plugins/room/.claude-plugin/plugin.json').version!

  it('is a plain major.minor.patch', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('matches the Codex manifest and the marketplace entry', () => {
    expect(json('plugins/room/.codex-plugin/plugin.json').version).toBe(version)
    expect(json('.claude-plugin/marketplace.json').plugins!.find(p => p.name === 'room')?.version).toBe(version)
  })

  it('matches the hooks version stamp', () => {
    expect(read('plugins/room/hooks/common.mjs')).toContain(`export const HOOKS_VERSION = '${version}'`)
  })

  it('has a CHANGELOG heading', () => {
    expect(read('CHANGELOG.md')).toContain(`\n## ${version}\n`)
  })
})
