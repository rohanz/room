import { expect, it, vi } from 'vitest'

it('imports the preview tool without a synchronous process probe', async () => {
  vi.resetModules()
  vi.doMock('@room/relay/process', async importOriginal => ({
    ...await importOriginal<typeof import('@room/relay/process')>(),
    probeProcess: () => { throw new Error('synchronous process probe at import') },
  }))
  try {
    const module = await import('../src/tools/files.js')
    expect(module.previewCachePath).toBeTypeOf('function')
  } finally {
    vi.doUnmock('@room/relay/process')
    vi.resetModules()
  }
})
