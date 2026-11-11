import { expect, it } from 'vitest'
import { RETIRED_ENVIRONMENT, warnRetiredEnvironment } from './retired-env.js'

it('names each set retired variable once, including empty/invalid values, without leaking values', () => {
  for (const target of ['server', 'client'] as const) {
    const names = RETIRED_ENVIRONMENT[target]
    for (const value of ['', 'invalid-secret-value', '1']) {
      const lines: string[] = []
      warnRetiredEnvironment(target, { ...Object.fromEntries(names.map(name => [name, value])), ROOM_MAX_WORKERS: '2' }, line => lines.push(line))
      expect(lines).toEqual(names.map(name => `${name} is retired and no longer has an effect`))
    }
    const lines: string[] = []
    warnRetiredEnvironment(target, {}, line => lines.push(line))
    expect(lines).toEqual([])
  }
})
it('classifies each retired name under exactly one startup entry point', () => {
  const names = Object.values(RETIRED_ENVIRONMENT).flat()
  expect(names).toHaveLength(22)
  expect(new Set(names).size).toBe(names.length)
})
