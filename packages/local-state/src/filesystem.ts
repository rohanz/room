/**
 * Filesystem classification for storage qualification (protocol.ts FilesystemResult). Built-ins only.
 * First release qualifies local single-host APFS, ext4 and NTFS; everything else is refused for SQL activation.
 * Detection proves only what the OS reports: a mocked or misreported mount is not network-lock qualification.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { FilesystemKind, FilesystemResult } from './protocol.js'

const QUALIFIED: ReadonlySet<FilesystemKind> = new Set(['apfs', 'ext4', 'ntfs'])
const COMMAND_TIMEOUT_MS = 3_000

type Maybe<T> = T | Promise<T>
/** Injectable OS readers; tests use them to simulate platforms. Production readers never block the event loop. */
export interface FilesystemReaders {
  platform: NodeJS.Platform
  realpath(file: string): Maybe<string>
  statfsType(file: string): Maybe<number | undefined>
  /** macOS `mount` output. */
  macMounts(): Maybe<string>
  /** Linux /proc/self/mountinfo. */
  linuxMountinfo(): Maybe<string>
  /** Windows `<DriveType> <file system name>` for `X:`, such as `Fixed NTFS` (the name is empty when unreadable). */
  windowsDrive(drive: string): Maybe<string>
  home(): string
  env: NodeJS.ProcessEnv
}

const run = (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, ...(env ? { env } : {}) },
    (error, stdout) => error ? reject(error) : resolve(stdout))
})
/**
 * GetDriveType and GetVolumeInformation through .NET's DriveInfo: no elevation needed (`fsutil fsinfo volumeinfo` fails
 * without it), and .NET types only, so PowerShell loads no modules. The drive travels through the environment.
 */
const WINDOWS_DRIVE_SCRIPT = "$d=[IO.DriveInfo]::new($env:ROOM_DRIVE); $f=''; try { $f=$d.DriveFormat } catch { }; $d.DriveType.ToString() + ' ' + $f"


export const systemFilesystemReaders: FilesystemReaders = {
  platform: process.platform,
  realpath: file => fs.promises.realpath(file),
  statfsType: file => fs.promises.statfs(file).then(stat => stat.type, () => undefined),
  macMounts: () => run('/sbin/mount', []),
  linuxMountinfo: () => fs.promises.readFile('/proc/self/mountinfo', 'utf8'),
  windowsDrive: drive => run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_DRIVE_SCRIPT], { ...process.env, ROOM_DRIVE: `${drive}\\` }),
  home: () => os.homedir(),
  env: process.env,
}

const result = (kind: FilesystemKind, detail: string, file: string): FilesystemResult =>
  ({ kind, detail: detail.slice(0, 256), path: file, journal: QUALIFIED.has(kind) ? 'wal' : 'refuse' })

/** Synchronizing clients keep ordinary local filesystems underneath; their folders are refused by path. */
function synchronizedRoot(file: string, readers: FilesystemReaders): string | undefined {
  const home = readers.home(), paths = readers.platform === 'win32' ? path.win32 : path.posix
  const roots = [
    paths.join(home, 'Library', 'Mobile Documents'), // iCloud Drive
    paths.join(home, 'Library', 'CloudStorage'),     // File Provider clients (Dropbox, OneDrive, Google Drive, Box)
    paths.join(home, 'Dropbox'),
    ...[readers.env.OneDrive, readers.env.OneDriveConsumer, readers.env.OneDriveCommercial].filter((value): value is string => !!value),
  ]
  const normalize = (value: string) => readers.platform === 'win32' ? value.toLowerCase() : value
  const target = normalize(file)
  return roots.find(root => { const prefix = normalize(root); return target === prefix || target.startsWith(prefix + paths.sep) })
}

function longestMount<T extends { point: string }>(mounts: T[], file: string): T | undefined {
  return mounts.filter(mount => file === mount.point || file.startsWith(mount.point.endsWith('/') ? mount.point : `${mount.point}/`))
    .sort((a, b) => b.point.length - a.point.length)[0]
}

async function classifyMac(file: string, readers: FilesystemReaders, statfs: string): Promise<FilesystemResult> {
  const mounts = (await readers.macMounts()).split('\n').flatMap(line => {
    const match = / on (.+) \(([^,)]+)((?:, [^)]*)?)\)$/.exec(line)
    return match ? [{ point: match[1], type: match[2], flags: match[3].split(', ').filter(Boolean) }] : []
  })
  const mount = longestMount(mounts, file)
  if (!mount) return result('unknown', `${statfs}; no mount covers the path`, file)
  const detail = `${statfs}; mount ${mount.type} at ${mount.point} (${mount.flags.join(',')})`
  if (['nfs', 'smbfs', 'afpfs', 'webdav', 'cifs', 'ftp', 'osxfuse', 'macfuse', 'fuse'].includes(mount.type)) return result('network', detail, file)
  if (!mount.flags.includes('local')) return result('network', detail, file)
  return result(mount.type === 'apfs' ? 'apfs' : 'other-local', detail, file)
}

const LINUX_NETWORK = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'ceph', 'glusterfs', '9p', 'virtiofs', 'afs', 'lustre', 'gpfs', 'ocfs2', 'gfs2', 'beegfs'])
const LINUX_LOCAL = new Set(['ext2', 'ext3', 'btrfs', 'xfs', 'zfs', 'f2fs', 'tmpfs', 'overlay', 'bcachefs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs3'])

async function classifyLinux(file: string, readers: FilesystemReaders, statfs: string): Promise<FilesystemResult> {
  // mountinfo: id parent major:minor root mountpoint options [optional...] - fstype source superoptions
  const mounts = (await readers.linuxMountinfo()).split('\n').flatMap(line => {
    const [left, right] = line.split(' - ')
    if (!left || !right) return []
    const fields = left.split(' '), point = fields[4]?.replace(/\\(\d{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    const type = right.split(' ')[0]
    return point && type ? [{ point, type }] : []
  })
  const mount = longestMount(mounts, file)
  if (!mount) return result('unknown', `${statfs}; no mount covers the path`, file)
  const detail = `${statfs}; mount ${mount.type} at ${mount.point}`
  if (mount.type === 'ext4') return result('ext4', detail, file)
  if (LINUX_NETWORK.has(mount.type) || mount.type.startsWith('fuse.sshfs') || mount.type === 'fuse.rclone') return result('network', detail, file)
  if (mount.type.startsWith('fuse')) return result('unknown', detail, file)
  return result(LINUX_LOCAL.has(mount.type) ? 'other-local' : 'unknown', detail, file)
}

async function classifyWindows(file: string, readers: FilesystemReaders): Promise<FilesystemResult> {
  // realpathSync.native resolves mapped network drives to \\?\UNC\ or \\server\share.
  if (/^\\\\(\?\\UNC\\|[^?.])/i.test(file)) return result('network', 'UNC path', file)
  const drive = /^(?:\\\\\?\\)?([A-Za-z]:)/.exec(file)?.[1]
  if (!drive) return result('unknown', 'no drive letter', file)
  let info: string
  try { info = (await readers.windowsDrive(drive)).trim() } catch (error) { return result('unknown', `drive information unavailable: ${(error as Error).message}`, file) }
  const [type = '', name = ''] = info.split(/\s+/)
  if (/^network$/i.test(type)) return result('network', `${drive} ${info}`, file)
  if (!/^fixed$/i.test(type)) return result('unknown', `${drive} ${info || 'drive type unknown'}`, file)
  if (!name) return result('unknown', `${drive} ${type}: file system name missing`, file)
  return result(name.toUpperCase() === 'NTFS' ? 'ntfs' : 'other-local', `${drive} ${type}; ${name}`, file)
}

/** Classify the filesystem holding `target` (an existing path). Never rejects: failures are `unknown`. */
export async function detectFilesystem(target: string, readers: FilesystemReaders = systemFilesystemReaders): Promise<FilesystemResult> {
  let file: string
  try { file = await readers.realpath(target) } catch (error) { return result('unknown', `unresolvable path: ${(error as NodeJS.ErrnoException).code ?? error}`, target) }
  const synced = synchronizedRoot(file, readers)
  if (synced) return result('synchronized', `inside synchronized folder ${synced}`, file)
  const type = await readers.statfsType(file)
  const statfs = type === undefined ? 'statfs unavailable' : `statfs 0x${type.toString(16)}`
  try {
    if (readers.platform === 'darwin') return await classifyMac(file, readers, statfs)
    if (readers.platform === 'linux') return await classifyLinux(file, readers, statfs)
    if (readers.platform === 'win32') return await classifyWindows(file, readers)
  } catch (error) { return result('unknown', `${statfs}; mount information unavailable: ${(error as Error).message}`, file) }
  return result('unknown', `${statfs}; unsupported platform ${readers.platform}`, file)
}
