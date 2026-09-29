import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watcherExclusionWarning } from '../src/watcher-exclusions.js'

const roots: string[] = []
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-watchers-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it.each([
  ['vite.config.ts', "export default { server: { watch: { ignored: ['**/.room/**'] } } }"],
  ['vite.config.mts', "export default { server: { watch: { ignored: '**/.room/**' } } }"],
  ['webpack.config.cjs', "module.exports = { watchOptions: { ignored: ['**/.room/**'] } }"],
  ['webpack.config.production.js', "module.exports = { watchOptions: { ignored: '**/.room/**' } }"],
  ['nodemon.json', '{"ignore":["**/.room/**"]}'],
  ['package.json', '{"nodemonConfig":{"ignore":["**/.room/**"]}}'],
  ['tsconfig.json', '{"watchOptions":{"excludeDirectories":["**/.room/**"]}}'],
  ['tsconfig.json', '{"watchOptions":{"excludeFiles":["**/.room/**"]}}'],
  ['.watchmanconfig', '{"ignore_dirs":[".room"]}'],
])('warns for %s when its watcher exclusion includes .room', (name, content) => {
  const root = repo()
  fs.writeFileSync(path.join(root, name), content)
  expect(watcherExclusionWarning(root)).toContain(`${name} appears to ignore`)
  expect(watcherExclusionWarning(root)).toContain('worker\'s worktree')
})

it.each(['.room', '.room/', '.room/**', '**/.room/**'])('recognizes the .room path component in %s', pattern => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), `export default { server: { watch: { ignored: ['${pattern}'] } } }`)
  expect(watcherExclusionWarning(root)).toContain('appears to ignore .room')
})

it.each(['.room-cache', '.roomy'])('does not mistake %s for .room', pattern => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), `export default { server: { watch: { ignored: ['**/${pattern}/**'] } } }`)
  expect(watcherExclusionWarning(root)).toBeUndefined()
})

it('ignores commented-out watcher exclusions without breaking URLs in strings', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), [
    "// server: { watch: { ignored: ['**/.room/**'] } }",
    "/* server: { watch: { ignored: ['**/.room/**'] } } */",
    "export default { url: 'http://example.test/.room', server: { watch: { ignored: ['dist'] } } }",
  ].join('\n'))
  expect(watcherExclusionWarning(root)).toBeUndefined()
})

it('warns when a regex exclusion contains an escaped slash', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), String.raw`export default { server: { watch: { ignored: /\.room\// } } }`)
  expect(watcherExclusionWarning(root)).toContain('appears to ignore .room')
})

it('finds an exclusion after a regex containing escaped URL slashes', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), String.raw`const r = /https?:\/\//; export default { server: { watch: { ignored: '.room' } } }`)
  expect(watcherExclusionWarning(root)).toContain('appears to ignore .room')
})

it('keeps a slash after division as a comment', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), "const ratio = a / b // server: { watch: { ignored: '.room' } }\nexport default { server: { watch: { ignored: 'dist' } } }")
  expect(watcherExclusionWarning(root)).toBeUndefined()
})

it('finds a later matching key path after an earlier nested key', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), "export default { plugins: [{ server: { watch: { ignored: ['dist'] } } }], server: { watch: { ignored: ['**/.room/**'] } } }")
  expect(watcherExclusionWarning(root)).toContain('appears to ignore .room')
})

it('ignores configs without a .room token or without a watcher exclusion', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.ts'), "export default { server: { watch: { ignored: ['**/dist/**'] } }, note: '.room' }")
  fs.writeFileSync(path.join(root, 'webpack.config.js'), "module.exports = { watchOptions: { ignored: ['**/dist/**'] } }")
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"echo .room"},"nodemonConfig":{"ignore":["dist"]}}')
  expect(watcherExclusionWarning(root)).toBeUndefined()
})

it('skips oversized or unreadable configs without throwing', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'vite.config.js'), 'x'.repeat(70_000) + "server: { watch: { ignored: '**/.room/**' } }")
  fs.mkdirSync(path.join(root, 'nodemon.json'))
  expect(watcherExclusionWarning(root)).toBeUndefined()
})

it('skips a config when reading its file fails', () => {
  const root = repo()
  const file = path.join(root, 'vite.config.ts')
  fs.writeFileSync(file, "export default { server: { watch: { ignored: ['**/.room/**'] } } }")
  const readFileSync = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === file) throw new Error('EACCES')
    return readFileSync(target, options as BufferEncoding)
  }) as typeof fs.readFileSync)
  expect(watcherExclusionWarning(root)).toBeUndefined()
})
