/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
const tokens = Object.fromEntries([...dark.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map(m => [m[1], m[2]]))
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
it('keeps every dark semantic text token readable on every dark surface', () => {
  for (const foreground of ['ink', 'heading', 'muted', 'accent-text', 'danger', 'ok', 'warn', 'purple']) {
    for (const background of ['bg', 'surface', 'line-soft', 'floor']) {
      expect(contrast(tokens[foreground], tokens[background]), `${foreground}/${background}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  for (const [foreground, background] of [
    [tokens.warn, '#352914'], [tokens.ok, '#19392e'], [tokens.danger, '#3e242b'],
    [tokens.heading, '#3e242b'], [tokens.muted, '#3e242b'],
    ['#ffffff', '#075fa8'], ['#ffffff', '#9624b5'], ['#ffffff', '#141e33'],
    ['#245b9e', '#e1edff'], ['#7a1f1f', '#fff4f4'],
  ]) expect(contrast(foreground, background), `${foreground}/${background}`).toBeGreaterThanOrEqual(4.5)
})
