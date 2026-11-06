/** Classification from OS-reported mount data. Mocked mounts test parsing only; they qualify nothing. */
import { expect, it } from 'vitest'
import { detectFilesystem, type FilesystemReaders } from '../src/filesystem.js'

const base = (overrides: Partial<FilesystemReaders>): FilesystemReaders => ({
  platform: 'linux', realpath: file => file, statfsType: () => undefined, macMounts: () => '', linuxMountinfo: () => '',
  windowsDriveType: () => '', windowsVolumeInfo: () => '', home: () => '/home/u', env: {}, ...overrides,
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
  ['\\\\server\\share\\r\\.git', 'Fixed Drive', 'NTFS', 'network'],
  ['\\\\?\\UNC\\server\\share\\r', 'Fixed Drive', 'NTFS', 'network'],
  ['C:\\Users\\u\\r\\.git', 'C: - Fixed Drive', 'File System Name : NTFS', 'ntfs'],
  ['D:\\r\\.git', 'D: - Remote/Network Drive', '', 'network'],
  ['E:\\r\\.git', 'E: - Fixed Drive', 'File System Name : ReFS', 'other-local'],
  ['F:\\r\\.git', 'F: - Removable Drive', '', 'unknown'],
] as const)('windows %s', async (file, type, volume, kind) => {
  const readers = base({ platform: 'win32', windowsDriveType: () => type, windowsVolumeInfo: () => volume, home: () => 'C:\\Users\\u' })
  expect((await detectFilesystem(file, readers)).kind).toBe(kind)
})

it('windows OneDrive folders are synchronized', async () => {
  const readers = base({ platform: 'win32', windowsDriveType: () => 'Fixed Drive', windowsVolumeInfo: () => 'File System Name : NTFS',
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
