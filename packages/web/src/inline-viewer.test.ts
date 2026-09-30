import { describe, expect, it } from 'vitest'
import { inlineViewer } from '../scripts/inline-viewer.mjs'

describe('installed viewer inliner', () => {
  it('emits a single file without external resources or executable closing tags', () => {
    const input = '<html><head><link rel="icon" href="/favicon.png"><link rel="preconnect" href="https://fonts.test"><link rel="stylesheet" crossorigin href="/assets/main.css"><script type="module" crossorigin src="/assets/main.js"></script></head><body></body></html>'
    const assets: Record<string, string> = { 'assets/main.css': 'body { color: red }', 'assets/main.js': 'console.log("</script>")' }
    const output = inlineViewer(input, name => assets[name]!)
    expect(output).toContain('<style>body { color: red }</style>')
    expect(output).toContain('<script type="module">console.log("<\\/script>")</script>')
    expect(output).not.toMatch(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*(?:src|href)=/i)
    expect(output).not.toContain('https://fonts.test')
  })
})
