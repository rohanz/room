import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Options = { platform?: NodeJS.Platform; launch?: (command: string, args: string[]) => Promise<void> }

/** Some desktop openers remain alive for the browser's lifetime. Never kill them. */
export function launchBrowserHandler(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { child.unref(); resolve() }, 1000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Browser handler failed')) })
  })
}

/** Open a private, reusable redirect page: OS file handlers may discard URL fragments. */
export async function openRoomBrowser(url: string, directory: string, options: Options = {}): Promise<void> {
  const parsed = new URL(url)
  if (!['file:', 'http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported browser URL')
  const platform = options.platform ?? process.platform
  const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'rundll32.exe' : platform === 'linux' ? 'xdg-open' : undefined
  if (!command) throw new Error('Opening the browser is unsupported on this platform')
  const quoted = JSON.stringify(url).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const escaped = url.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const script = `location.replace(${quoted})`
  const digest = createHash('sha256').update(script).digest('base64')
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'"><title>Opening Room</title><p>Opening your room. <a href="${escaped}">Continue to Room</a></p><script>${script}</script>`
  // Keep the capability out of the source tree, shell arguments and output. Reuse one file
  // per destination; leave it available for browsers that read it after the OS opener exits.
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = new URLSearchParams(parsed.hash.slice(1)).get('room') ?? parsed.href.split('#')[0]
  const name = createHash('sha256').update(destination).digest('hex').slice(0, 24)
  const entry = path.join(directory, `${name}.html`), temporary = path.join(directory, `${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, html, { mode: 0o600, flag: 'wx' })
    await rename(temporary, entry)
  } finally { await rm(temporary, { force: true }) }
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', entry] : [entry]
  try {
    await (options.launch ?? launchBrowserHandler)(command, args)
  } catch { throw new Error('Could not launch the default browser') }
}
