import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * A two-package workspace (b requires a and a third-party package) with a fake lead install:
 * npm hoists everything into node_modules with workspace links; pnpm keeps b's links in
 * packages/b/node_modules and third-party code under node_modules/.pnpm.
 */
export function workspaceRepo(options: { layout?: 'npm' | 'pnpm'; lockfile?: boolean; nodeModules?: boolean } = {}) {
  const { layout = 'npm', lockfile = true, nodeModules = true } = options
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-ws-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
  const put = (rel: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), text, mode ? { mode } : undefined)
  }
  const link = (target: string, rel: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.symlinkSync(target, path.join(repo, rel))
  }
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  put('.gitignore', 'node_modules/\n.room/\n')
  put('package.json', JSON.stringify(layout === 'npm' ? { name: 'fx-root', private: true, workspaces: ['packages/*'] } : { name: 'fx-root', private: true }))
  if (layout === 'pnpm') put('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - '!**/test/**'\n")
  if (lockfile) put(layout === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml', layout === 'npm' ? '{"lockfileVersion":3}\n' : "lockfileVersion: '9.0'\n")
  put('packages/a/package.json', JSON.stringify({ name: '@fx/a', version: '1.0.0', main: 'index.js' }))
  put('packages/a/index.js', "module.exports = 'lead-a'\n")
  put('packages/b/package.json', JSON.stringify({ name: '@fx/b', version: '1.0.0', main: 'index.js', dependencies: { '@fx/a': '*', third: '1.0.0' } }))
  put('packages/b/index.js', "module.exports = require('@fx/a') + ':' + require('third')\n")
  git('add', '.'); git('commit', '-qm', 'init')
  if (nodeModules) {
    const third = layout === 'npm' ? 'node_modules/third' : 'node_modules/.pnpm/third@1.0.0/node_modules/third'
    put(`${third}/package.json`, JSON.stringify({ name: 'third', version: '1.0.0', main: 'index.js', bin: 'cli.js' }))
    put(`${third}/index.js`, "module.exports = 'third'\n")
    put(`${third}/cli.js`, "#!/usr/bin/env node\nconsole.log(require('./'))\n", 0o755)
    if (layout === 'npm') {
      link('../../packages/a', 'node_modules/@fx/a')
      link('../../packages/b', 'node_modules/@fx/b')
      link('../third/cli.js', 'node_modules/.bin/third')
      put('node_modules/.package-lock.json', '{}\n')
    } else {
      link('.pnpm/third@1.0.0/node_modules/third', 'node_modules/third')
      link('../../../a', 'packages/b/node_modules/@fx/a')
      link('../../../node_modules/.pnpm/third@1.0.0/node_modules/third', 'packages/b/node_modules/third')
      put('node_modules/.modules.yaml', 'layoutVersion: 5\n')
    }
  }
  /** A Room-style worker worktree under the lead, with its own edit to package a. */
  const worktree = (tag = 'w') => {
    const dir = path.join(repo, '.room', 'workers', tag)
    git('worktree', 'add', '-q', '-b', `room/${tag}`, dir)
    fs.writeFileSync(path.join(dir, 'packages/a/index.js'), "module.exports = 'worker-a'\n")
    return dir
  }
  return { repo, git, head: git('rev-parse', 'HEAD'), worktree }
}

/** What package b sees when node runs it from `dir`. */
export function requireB(dir: string): string {
  return execFileSync(process.execPath, ['-p', "require('./')"], { cwd: path.join(dir, 'packages', 'b'), stdio: 'pipe' }).toString().trim()
}
