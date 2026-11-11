import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ listing: '' }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  // Isolate JS path normalization from Git startup and disk latency. The fixture
  // is below the real execFile maxBuffer (64 MiB).
  execFile: (_file: string, args: string[], _options: unknown, done: (error: null, stdout: string) => void) => {
    setImmediate(() => done(null, args.includes('ls-files') ? fixture.listing : ''))
  },
}))
import { createPreviewTreePaths } from '../src/preview-evidence.js'

it('yields while normalizing an allowed large Git path listing', async () => {
  const count = 1_000_000
  fixture.listing = Array.from({ length: count }, (_, i) => `src/${String((i * 104729) % count).padStart(7, '0')}/source-file.ts\0`).join('')
  expect(Buffer.byteLength(fixture.listing)).toBeLessThan(64 * 1024 * 1024)
  const listing = await createPreviewTreePaths('/unused-repo', 'HEAD', '/unused-preview')
  let previous = performance.now(), longest = 0
  const tick = () => { const now = performance.now(); longest = Math.max(longest, now - previous); previous = now }
  const heartbeat = setInterval(tick, 1)
  try {
    expect((await listing.paths()).length).toBe(count)
    await new Promise(resolve => setTimeout(resolve, 0))
    tick()
    process.stdout.write(`Git path normalization longest timer gap: ${longest.toFixed(1)} ms\n`)
    expect(longest).toBeLessThan(200)
  } finally { clearInterval(heartbeat); await listing.dispose(); fixture.listing = '' }
}, 30_000)
