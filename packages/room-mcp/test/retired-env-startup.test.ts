import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RETIRED_ENVIRONMENT } from '@room/shared'

it('logs retired client settings once at process startup without their values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retired-env-'))
  try {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
      cwd: dir, input: '', encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ROOM_HOST: 'codex', ROOM_DIR: dir, ROOM_SERVER: '',
        ...Object.fromEntries(RETIRED_ENVIRONMENT.client.map(name => [name, 'invalid-secret-value'])) },
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    for (const name of RETIRED_ENVIRONMENT.client) {
      expect(result.stderr.split(`${name} is retired and no longer has an effect`)).toHaveLength(2)
    }
    expect(result.stderr).not.toContain('invalid-secret-value')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
