import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { git, withGitWorktreeOperation } from '../../src/git.js'
import { prepareWorktree } from '../../../room-mcp/src/worker-git.js'
import { withGuardAsyncOperation } from '../../../relay/src/leases.js'

const [mode, repo, signal, ...args] = process.argv.slice(2)
const mark = (suffix: string, value = '') => fs.writeFileSync(`${signal}.${suffix}`, value)
async function until(file: string) {
  const deadline = performance.now() + 60_000
  while (!fs.existsSync(file)) {
    if (performance.now() >= deadline) throw new Error(`fixture timed out: ${file}`)
    await delay(25)
  }
}
try {
  if (mode === 'prepare') {
    const [prefix, carry] = args
    mark('ready'); await until(`${signal}.go`)
    const results = await Promise.all(Array.from({ length: 3 }, (_, i) => prepareWorktree(repo, `${prefix}-${i}`, 'test', { carry: carry === 'true' })))
    for (const result of results) {
      if (result.carryFailed) throw new Error(result.carryError)
      if (carry === 'true' && (fs.readFileSync(path.join(result.dir, 'tracked'), 'utf8') !== 'carried\n'
        || fs.readFileSync(path.join(result.dir, 'untracked'), 'utf8') !== 'untracked\n')) throw new Error('carried bytes differ')
    }
    mark('result', JSON.stringify(results.map(result => result.dir)))
  } else if (mode === 'hold') {
    await withGitWorktreeOperation(repo, async () => {
      mark('ready'); await until(`${signal}.release`)
    })
  } else if (mode === 'window') {
    const commonFile = args[0], original = fs.readFileSync(commonFile)
    await withGitWorktreeOperation(repo, async () => {
      fs.writeFileSync(commonFile, ''); mark('ready')
      try { await until(`${signal}.release`) } finally { fs.writeFileSync(commonFile, original) }
    })
  } else if (mode === 'orphan' || mode === 'add') {
    await git(repo, ['worktree', 'add', '-q', '--detach', args[0], 'HEAD'])
  } else if (mode === 'reenter') {
    // A real post-checkout hook is a separate process, outside the parent's ALS.
    await withGuardAsyncOperation(path.join(repo, '.git', 'room', 'worktree-operation'), () => mark('entered'), { timeoutMs: 160 })
  } else if (mode === 'list' || mode === 'unguarded-list') {
    mark('ready')
    mark('result', mode === 'list' ? await git(repo, ['worktree', 'list', '--porcelain'])
      : execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, stdio: 'pipe' }).toString())
  } else throw new Error(`unknown fixture mode: ${mode}`)
} catch (error) { console.error(error); process.exitCode = 1 }
