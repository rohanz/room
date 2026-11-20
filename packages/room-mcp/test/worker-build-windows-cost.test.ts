/** Instrument the real Windows privacy boundary on every OS; this does not validate native ACLs. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as childProcess from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { privateStateDirectory } from '@room/relay'
import { prepareWorkerBuildDir } from '../src/worker-build-dir.js'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('adds no Windows ACL subprocesses beyond the pre-existing protected worktree root', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-build-windows-')))
  roots.push(parent)
  const worker = path.join(parent, 'worker')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const aclPaths: string[] = []
  vi.mocked(childProcess.execFileSync).mockImplementation(((_file: unknown, _args: unknown, options: { env: NodeJS.ProcessEnv }) => {
    aclPaths.push(options.env.ROOM_PRIVATE_PATH!)
    return JSON.stringify({ owner: 'user', user: 'user', protected: true, directory: true, grants: ['user'] })
  }) as typeof childProcess.execFileSync)
  // prepareWorktree already does this once; its existing root ACL check is not new build cost.
  privateStateDirectory(worker, { exclusive: true })
  expect(aclPaths).toEqual([worker])
  await new Promise<void>((resolve, reject) => childProcess.execFile('git', ['init', '-q'], { cwd: worker }, error => error ? reject(error) : resolve()))
  const before = aclPaths.length
  await prepareWorkerBuildDir(worker, 'w')
  expect(aclPaths.slice(before)).toEqual([])
  // Resume in the same process must also add no calls (nor rely on the Windows ACL cache).
  await prepareWorkerBuildDir(worker, 'w')
  expect(aclPaths).toEqual([worker])
})
