import { beforeEach, describe, it } from 'vitest'

/** Disk setup is not the behavior's deadline. Keep the ordinary test timeout,
 * while preparing its private fixture in a hook without a wall-clock limit.
 */
export function preparedTest<T>(name: string, prepare: () => T | Promise<T>, check: (fixture: T) => unknown | Promise<unknown>, timeout?: number): void {
  describe('prepared fixture', () => {
    let fixture: T
    beforeEach(async () => { fixture = await prepare() }, 0)
    it(name, async () => { await check(fixture) }, timeout)
  })
}

export function preparedEach<T, F>(rows: readonly T[], name: string, prepare: (row: T) => F | Promise<F>, check: (fixture: F, row: T) => unknown | Promise<unknown>): void {
  for (const row of rows) preparedTest(name.replace('%s', String(row)), () => prepare(row), fixture => check(fixture, row))
}
