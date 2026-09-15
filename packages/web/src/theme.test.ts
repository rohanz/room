/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { applyTheme, nextTheme, readTheme } from './theme.ts'

function environment(value: string | null = null) {
  const attributes = new Map<string, string>()
  const classes = new Set<string>()
  const document = { documentElement: {
    getAttribute: (name: string) => attributes.get(name),
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } }
  const localStorage = { getItem: vi.fn(() => value), setItem: vi.fn() }
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', document); vi.stubGlobal('localStorage', localStorage)
  return { attributes, document, localStorage, classes }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('applies and persists each state, including explicit System', () => {
  const { attributes, localStorage } = environment()
  for (const theme of ['dark', 'light', 'system'] as const) {
    applyTheme(theme)
    expect(attributes.get('data-theme')).toBe(theme)
    expect(localStorage.setItem).toHaveBeenLastCalledWith('room.theme', theme)
  }
})
it('cycles Light → Dark → System → Light', () => {
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
  expect(env.attributes.get('data-theme')).toBe(value === 'light' || value === 'dark' || value === 'system' ? value : 'light')
  expect(readTheme()).toBe(value === 'light' || value === 'dark' || value === 'system' ? value : 'light')
})
it('still applies themes when storage is blocked', () => {
  const env = environment()
  vi.stubGlobal('localStorage', { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } })
  expect(readTheme()).toBe('light')
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
    expect(block).toContain(':root[data-theme="system"]')
    for (const token of tokens(block)) expect(light.has(token), token).toBe(true)
  }
})

it('defaults to light before paint even when the OS prefers dark; System requires opt-in', () => {
  const env = environment()
  const matchMedia = vi.fn(() => ({ matches: true }))
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], { ...env, matchMedia })
  expect(readTheme()).toBe('light')
  expect(env.attributes.get('data-theme')).toBe('light')
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).not.toContain(':not([data-theme="light"])')
  // Every OS-dark block requires the explicit System attribute set by the control.
  const guards = [...css.matchAll(/@media \(prefers-color-scheme: dark\)\s*\{\s*([^{}]+)\{/g)].map(match => match[1].trim())
  expect(guards.length).toBeGreaterThan(0)
  expect(guards.every(guard => guard === ':root[data-theme="system"]')).toBe(true)
  applyTheme('system')
  expect(env.attributes.get('data-theme')).toBe('system')
  expect(env.localStorage.setItem).toHaveBeenLastCalledWith('room.theme', 'system')
})
it('sets Light before paint when storage cannot be read', () => {
  const env = environment()
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    ...env, localStorage: { getItem() { throw Error('blocked') } },
  })
  expect(env.attributes.get('data-theme')).toBe('light')
})

it('animates a changed theme for 160ms but not initial matching theme or reduced motion', () => {
  vi.useFakeTimers()
  const env = environment()
  env.attributes.set('data-theme', 'light')
  applyTheme('light')
  expect(env.classes.has('theme-transition')).toBe(false)
  applyTheme('dark')
  expect(env.classes.has('theme-transition')).toBe(true)
  vi.advanceTimersByTime(160)
  expect(env.classes.has('theme-transition')).toBe(false)
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  applyTheme('light')
  expect(env.classes.has('theme-transition')).toBe(false)
})
