import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { DEFS } from '../src/tools/index.js'

const mockPath = fileURLToPath(new URL('../../../evals/mocks/room/_tools.json', import.meta.url))

it('keeps eval mock tool names, descriptions and input schemas in sync with DEFS', () => {
  const mock = JSON.parse(fs.readFileSync(mockPath, 'utf8')) as {
    tools: Array<{ name: string; annotations?: unknown; description: string; inputSchema: unknown }>
  }
  const advertised = ({ name, annotations, description, inputSchema }: typeof DEFS[number]) => ({ name, annotations, description, inputSchema })
  expect(mock.tools.map(advertised)).toEqual(DEFS.map(advertised))
})
