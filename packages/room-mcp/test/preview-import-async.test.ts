import { expect, it, vi } from 'vitest'

it('imports the preview tool without a synchronous process probe', async () => {
  vi.resetModules()
  vi.doMock('@room/local-state/process', async importOriginal => ({
    ...await importOriginal<typeof import('@room/local-state/process')>(),
    probeProcess: () => { throw new Error('synchronous process probe at import') },
  }))
  try {
    const module = await import('../src/tools/files.js')
    expect(module.previewCachePath).toBeTypeOf('function')
  } finally {
    vi.doUnmock('@room/local-state/process')
    vi.resetModules()
  }
})
