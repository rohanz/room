import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** Doctor's command semantics: a missing executable differs from a failed/timed-out query. */
export async function installCommand(file: string, args: string[]): Promise<string | undefined> {
  try { return (await exec(file, args, { timeout: 2500, maxBuffer: 256 * 1024 })).stdout.trim() }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : '' }
}

export interface InstallIO {
  command(file: string, args: string[]): Promise<string | undefined>
  readFile(file: string): string
}
export const defaultInstallIO: InstallIO = {
  command: installCommand,
  readFile: file => fs.readFileSync(file, 'utf8'),
}
export function readInstallFile(file: string | undefined, io: Pick<InstallIO, 'readFile'> = defaultInstallIO): string | undefined {
  try { return file ? io.readFile(file) : undefined } catch { return undefined }
}
export function hookVersion(text?: string): string | undefined { return text?.match(/export const HOOKS_VERSION = ['"]([^'"]+)['"]/)?.[1] }
export function parseInstallListing(raw?: string): unknown {
  try { return JSON.parse(raw ?? '') } catch { return undefined }
}

/** Compatibility view used by the old doctor entry points. */
export type InstalledPlugin = { version?: string; recordedVersion?: string; root?: string; hooksRoot?: string; cached?: boolean }
