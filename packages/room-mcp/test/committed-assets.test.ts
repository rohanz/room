import { expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it.each(['untracked', 'modified', 'deleted'] as const)('CI rejects %s generated plugin assets', change => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const step = workflow.split('      - name: Check committed plugin assets\n')[1]
  expect(step).toBeDefined()
  const command = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'room-ci-assets-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  const check = () => spawnSync('sh', ['-eu', '-c', command], { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    mkdirSync(join(dir, 'plugins/room/server'), { recursive: true })
    const bundle = join(dir, 'plugins/room/server/index.mjs')
    writeFileSync(bundle, 'original\n'); git('add', '.'); git('commit', '-qm', 'committed assets')
    expect(check().status).toBe(0)
    if (change === 'untracked') writeFileSync(join(dir, 'plugins/room/server/parse-worker.mjs'), 'new generated asset\n')
    if (change === 'modified') writeFileSync(bundle, 'rebuilt\n')
    if (change === 'deleted') rmSync(bundle)
    expect(check().status).toBe(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
