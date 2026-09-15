/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { applyTheme, nextTheme, readTheme } from './theme.ts'

function environment(value: string | null = null) {
  const attributes = new Map<string, string>()
  const document = { documentElement: {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } }
  const localStorage = { getItem: vi.fn(() => value), setItem: vi.fn() }
  vi.stubGlobal('document', document); vi.stubGlobal('localStorage', localStorage)
  return { attributes, document, localStorage }
}
afterEach(() => vi.unstubAllGlobals())
it('applies and persists each state, removing the explicit theme for System', () => {
  const { attributes, localStorage } = environment()
  for (const theme of ['dark', 'light', 'system'] as const) {
    applyTheme(theme)
    expect(attributes.get('data-theme')).toBe(theme === 'system' ? undefined : theme)
    expect(localStorage.setItem).toHaveBeenLastCalledWith('room.theme', theme)
  }
})
it('cycles System → Light → Dark → System', () => {
  expect(nextTheme('system')).toBe('light')
  expect(nextTheme('light')).toBe('dark')
  expect(nextTheme('dark')).toBe('system')
})
it.each(['light', 'dark', 'system', 'invalid', null])('restores %s consistently before stylesheet loading', value => {
  const env = environment(value)
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)!
  expect(html.indexOf(script[0])).toBeLessThan(html.indexOf('rel="stylesheet"'))
  runInNewContext(script[1], env)
  expect(env.attributes.get('data-theme')).toBe(value === 'light' || value === 'dark' ? value : undefined)
  expect(readTheme()).toBe(value === 'light' || value === 'dark' ? value : 'system')
})
it('still applies themes when storage is blocked', () => {
  const env = environment()
  vi.stubGlobal('localStorage', { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } })
  expect(readTheme()).toBe('system')
  expect(() => applyTheme('dark')).not.toThrow()
  expect(env.attributes.get('data-theme')).toBe('dark')
})
it('defines every dark-media token on a bare :root too (text-based CSS check)', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const tokens = (text: string) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])
  const light = new Set([...css.matchAll(/^:root\s*\{([^}]+)\}/gm)].flatMap(match => tokens(match[1])))
  const mediaBlocks: string[] = []
  for (const match of css.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/g)) {
    let end = match.index! + match[0].length, depth = 1
    const start = end
    for (; depth && end < css.length; end++) {
      if (css[end] === '{') depth++
      if (css[end] === '}') depth--
    }
    mediaBlocks.push(css.slice(start, end - 1))
  }
  expect(mediaBlocks.length).toBeGreaterThan(0)
  for (const block of mediaBlocks) {
    expect(block).toContain(':root:not([data-theme="light"])')
    for (const token of tokens(block)) expect(light.has(token), token).toBe(true)
  }
})
