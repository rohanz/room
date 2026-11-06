import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

it('routes the standalone CLI and requires explicit confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-cli-'))
  try {
    execFileSync('git', ['init', '-q', root])
    const source = 'room/registry/workers/w.json'
    const file = path.join(root, '.git', source)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ id: 'w', runs: [{ n: 1, launch: { outcome: 'ambiguous' } }] }))
    const entry = fileURLToPath(new URL('../../../plugins/room/server/room-mcp.mjs', import.meta.url))
    const args = [entry, 'cutover-resolve', '--dir', root, '--record', source]
    expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(1)
    const result = spawnSync(process.execPath, [...args, '--confirm-not-running', '--note', 'verified'], { encoding: 'utf8' })
    expect(result.stdout).toContain('resolved by operator')
    expect(result.status).toBe(0)
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.git/room/daemon-cutover-resolutions.json'), 'utf8'))
    expect(saved.resolutions[0]).toMatchObject({ source, note: 'verified' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
