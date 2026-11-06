/** Classification from OS-reported mount data. Mocked mounts test parsing only; they qualify nothing. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { detectFilesystem, windowsDriveMemo, type FilesystemReaders } from '../src/filesystem.js'

const base = (overrides: Partial<FilesystemReaders>): FilesystemReaders => ({
  platform: 'linux', realpath: file => file, statfsType: () => undefined, macMounts: () => '', linuxMountinfo: () => '',
  windowsDrive: () => '', home: () => '/home/u', env: {}, ...overrides,
})
const mountinfo = (lines: [string, string][]) => lines.map(([point, type], n) => `${20 + n} 1 0:${n} / ${point} rw,relatime shared:1 - ${type} src rw`).join('\n')

it.each([
  ['/home/u/repo/.git', [['/', 'ext4']], 'ext4', 'wal'],
  ['/home/u/repo/.git', [['/', 'ext4'], ['/home', 'nfs4']], 'network', 'refuse'],
  ['/mnt/share/repo/.git', [['/', 'ext4'], ['/mnt/share', 'cifs']], 'network', 'refuse'],
  ['/work/.git', [['/', 'overlay']], 'other-local', 'refuse'],
  ['/home/u/repo/.git', [['/', 'btrfs']], 'other-local', 'refuse'],
  ['/home/u/x/.git', [['/', 'ext4'], ['/home/u/x', 'fuse.sshfs']], 'network', 'refuse'],
  ['/home/u/x/.git', [['/', 'ext4'], ['/home/u/x', 'fuse.unknownfs']], 'unknown', 'refuse'],
  ['/workspace/.git', [['/', 'ext4'], ['/workspace', 'virtiofs']], 'network', 'refuse'],
] as const)('linux %s on %j is %s', async (file, mounts, kind, journal) => {
  expect(await detectFilesystem(file, base({ linuxMountinfo: () => mountinfo(mounts as unknown as [string, string][]) }))).toMatchObject({ kind, journal })
})

it('uses the longest mount prefix, not a sibling with a shared string prefix', async () => {
  const readers = base({ linuxMountinfo: () => mountinfo([['/', 'ext4'], ['/home/u/repo-other', 'nfs']]) })
  expect((await detectFilesystem('/home/u/repo/.git', readers)).kind).toBe('ext4')
})

it('decodes escaped mount points', async () => {
  const readers = base({ linuxMountinfo: () => '30 1 0:5 / /mnt/my\\040share rw - cifs //s/x rw\n31 1 0:6 / / rw - ext4 /dev/sda rw' })
  expect((await detectFilesystem('/mnt/my share/repo', readers)).kind).toBe('network')
})

it.each([
  ['/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)', '/System/Volumes/Data/r/.git', 'apfs'],
  ['//u@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by u)', '/Volumes/share/r/.git', 'network'],
  ['server:/export on /Volumes/nfs (nfs, nodev)', '/Volumes/nfs/r/.git', 'network'],
  ['/dev/disk4s1 on /Volumes/Old (hfs, local, journaled)', '/Volumes/Old/r/.git', 'other-local'],
] as const)('macOS %s', async (line, file, kind) => {
  const readers = base({ platform: 'darwin', macMounts: () => `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n${line}\n` })
  expect((await detectFilesystem(file, readers)).kind).toBe(kind)
})

it('refuses synchronized folders even on a qualified local filesystem', async () => {
  const mac = base({ platform: 'darwin', home: () => '/Users/u', macMounts: () => '/dev/disk3s1 on / (apfs, local, journaled)' })
  expect((await detectFilesystem('/Users/u/Library/Mobile Documents/com~apple~CloudDocs/r/.git', mac)).kind).toBe('synchronized')
  expect((await detectFilesystem('/Users/u/Library/CloudStorage/Dropbox/r/.git', mac)).kind).toBe('synchronized')
  expect((await detectFilesystem('/Users/u/code/r/.git', mac)).kind).toBe('apfs')
})

it.each([
  ['\\\\server\\share\\r\\.git', 'Fixed NTFS', 'network'],
  ['\\\\?\\UNC\\server\\share\\r', 'Fixed NTFS', 'network'],
  ['C:\\Users\\u\\r\\.git', 'Fixed NTFS', 'ntfs'],
  ['D:\\r\\.git', 'Network ', 'network'],
  ['E:\\r\\.git', 'Fixed ReFS', 'other-local'],
  ['F:\\r\\.git', 'Removable FAT32', 'unknown'],
  ['G:\\r\\.git', 'Fixed ', 'unknown'],
] as const)('windows %s', async (file, drive, kind) => {
  const readers = base({ platform: 'win32', windowsDrive: () => drive, home: () => 'C:\\Users\\u' })
  expect((await detectFilesystem(file, readers)).kind).toBe(kind)
})

it('windows OneDrive folders are synchronized', async () => {
  const readers = base({ platform: 'win32', windowsDrive: () => 'Fixed NTFS',
    home: () => 'C:\\Users\\u', env: { OneDrive: 'C:\\Users\\u\\OneDrive' } })
  expect((await detectFilesystem('C:\\Users\\u\\OneDrive\\r\\.git', readers)).kind).toBe('synchronized')
})

it('is unknown, never qualified, when mount information cannot be read', async () => {
  const readers = base({ linuxMountinfo: () => { throw new Error('EACCES') } })
  expect(await detectFilesystem('/r/.git', readers)).toMatchObject({ kind: 'unknown', journal: 'refuse' })
  expect((await detectFilesystem('/missing', base({ realpath: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } }))).kind).toBe('unknown')
})

it('classifies this machine\'s temporary directory without throwing', async () => {
  const os = await import('node:os')
  const result = await detectFilesystem(os.tmpdir())
  expect(['apfs', 'ext4', 'ntfs', 'other-local', 'network', 'synchronized', 'unknown']).toContain(result.kind)
})

// Representative native runner mount/volume reports. CI separately probes the actual temp AND
// workspace mounts; these fixtures catch parsing regressions and cannot qualify a runner by themselves.
it.each(['/home/runner/work/_temp/probe', '/home/runner/work/room/room/.git'])('resolves Ubuntu runner path %s on ext4', async file => {
  const readers = base({ statfsType: () => 0xef53, linuxMountinfo: () => mountinfo([['/', 'ext4'], ['/mnt', 'ext4'], ['/tmp', 'tmpfs']]) })
  expect(await detectFilesystem(file, readers)).toMatchObject({ kind: 'ext4', journal: 'wal' })
})

it.each(['/private/var/folders/xy/temp/probe', '/Users/runner/work/room/room/.git'])('resolves macOS runner path %s on APFS', async file => {
  const readers = base({ platform: 'darwin', statfsType: () => 0x1a, macMounts: () =>
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)' })
  expect(await detectFilesystem(file, readers)).toMatchObject({ kind: 'apfs', journal: 'wal' })
})

it.each(['D:\\a\\_temp\\probe', 'D:\\a\\room\\room\\.git'])('resolves Windows runner path %s on NTFS', async file => {
  const readers = base({ platform: 'win32', windowsDrive: () => 'Fixed NTFS' })
  expect(await detectFilesystem(file, readers)).toMatchObject({ kind: 'ntfs', journal: 'wal' })
})

it('refuses a temp mount that differs from the qualified workspace mount', async () => {
  const readers = base({ linuxMountinfo: () => mountinfo([['/', 'ext4'], ['/home/runner/work/_temp', 'tmpfs']]) })
  expect(await detectFilesystem('/home/runner/work/_temp/probe', readers)).toMatchObject({ kind: 'other-local', journal: 'refuse' })
  expect(await detectFilesystem('/home/runner/work/room/room/.git', readers)).toMatchObject({ kind: 'ext4', journal: 'wal' })
})

it('native evidence rejects unqualified, missing-WAL and wrong-filesystem results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-evidence-contract-'))
  try {
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, 'plugins', 'room', 'server'), { recursive: true })
    const script = path.join(root, 'scripts', 'sqlite-evidence.mjs')
    fs.copyFileSync(new URL('../../../scripts/sqlite-evidence.mjs', import.meta.url), script)
    const bundle = path.join(root, 'plugins', 'room', 'server', 'room-state.mjs')
    const kind = { darwin: 'apfs', linux: 'ext4', win32: 'ntfs' }[process.platform]!
    for (const [storage, filesystem, passed] of [
      ['qualified', { kind, journal: 'wal' }, true],
      ['unqualified', { kind: 'unknown', journal: 'refuse' }, false],
      ['unqualified', { kind: 'other-local', journal: 'refuse' }, false],
      ['qualified', { kind, journal: 'refuse' }, false],
      ['unqualified', { kind, journal: 'wal' }, false],
      ['qualified', { kind: kind === 'apfs' ? 'ext4' : 'apfs', journal: 'wal' }, false],
    ] as const) {
      fs.writeFileSync(bundle, `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, storage, evidence: { filesystem } }))})`)
      const child = spawnSync(process.execPath, [script, '--scratch-parent', root], { encoding: 'utf8', timeout: 10_000 })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(passed ? 0 : 1)
      expect(JSON.parse(child.stdout).passed).toBe(passed)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('remembers a complete Windows drive answer per volume, and asks again after a failed or partial one or a remount', async () => {
  const answers = ['Fixed ', 'Fixed NTFS']
  let serial = 1n, failNext = true
  const query = vi.fn(async () => {
    if (failNext) { failNext = false; throw new Error('powershell cold start timed out') }
    return answers.shift() ?? 'Fixed NTFS'
  })
  const drive = windowsDriveMemo(query, async () => serial)
  await expect(drive('D:')).rejects.toThrow('timed out')
  expect(await drive('D:')).toBe('Fixed ') // partial: the file system name was unreadable
  expect(await drive('D:')).toBe('Fixed NTFS') // asked again
  expect(await drive('D:')).toBe('Fixed NTFS')
  expect(query).toHaveBeenCalledTimes(3) // the complete answer is kept
  serial = 2n // another volume mounted under the same letter
  expect(await drive('D:')).toBe('Fixed NTFS')
  expect(query).toHaveBeenCalledTimes(4)
})
