import { describe, expect, it } from 'vitest'
import { isRegenerableBuildPath } from './build-output.js'

describe('regenerable worker output', () => {
  it('discards Python check caches but retains a virtualenv', () => {
    expect(isRegenerableBuildPath('.mypy_cache/x')).toBe(true)
    expect(isRegenerableBuildPath('.ruff_cache/x')).toBe(true)
    expect(isRegenerableBuildPath('.venv/x')).toBe(false)
  })
})
