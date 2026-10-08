import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { openRoomBrowser, launchBrowserHandler } from '../src/browser-open.js'

const dirs: string[] = []
const directory = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'room-open-test-')); dirs.push(d); return path.join(d, 'browser') }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const url = 'file:///opt/Room%20plugin/viewer.html#room=ws%3A%2F%2F127.0.0.1%3A1234%2Flocal%252Ftest&view=secret&relay=1'

it.each([['darwin', '/usr/bin/open', []], ['linux', 'xdg-open', []], ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler']]] as const)('opens through the %s default browser without passing a fragment to the OS', async (platform, command, prefix) => {
  const dir = directory(), launch = vi.fn(async () => {})
  await openRoomBrowser(url, dir, { platform, launch })
  const [exe, args] = launch.mock.calls[0] as unknown as [string, string[]]
  expect(exe).toBe(command)
  expect(args.slice(0, -1)).toEqual(prefix)
  expect(path.dirname(args.at(-1)!)).toBe(dir)
  expect(path.basename(args.at(-1)!)).toMatch(/^[a-f0-9]{24}\.html$/)
  const html = readFileSync(args.at(-1)!, 'utf8')
  const dom = new JSDOM(html)
  expect(dom.window.document.querySelector('a')?.getAttribute('href')).toBe(url)
  const replace = vi.fn()
  new Function('location', dom.window.document.querySelector('script')!.textContent!)({ replace })
  expect(replace).toHaveBeenCalledWith(url)
  dom.window.close()
  if (process.platform !== 'win32') {
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(args.at(-1)!).mode & 0o777).toBe(0o600)
  }
})

it('escapes page markup without changing the URL and atomically reuses one launch file', async () => {
  const dir = directory(), launch = vi.fn(async () => {})
  const hostile = 'https://room.example/#room=x&view=</script><script>alert(1)</script>"&x=\u2028'
  await openRoomBrowser(hostile, dir, { platform: 'linux', launch })
  const dom = new JSDOM(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8'))
  expect(dom.window.document.querySelectorAll('script')).toHaveLength(1)
  const replace = vi.fn()
  new Function('location', dom.window.document.querySelector('script')!.textContent!)({ replace })
  expect(replace).toHaveBeenCalledWith(hostile)
  dom.window.close()
  await openRoomBrowser(url, dir, { platform: 'linux', launch })
  expect(readdirSync(dir)).toHaveLength(2)
  await openRoomBrowser(url.replace('view=secret', 'view=refreshed'), dir, { platform: 'linux', launch })
  expect(readdirSync(dir)).toHaveLength(2)
})

it.each(['javascript:alert(1)', 'data:text/html,bad', 'not a URL'])('rejects unsupported destination %s before writing or opening', async raw => {
  const dir = directory(), launch = vi.fn(async () => {})
  await expect(openRoomBrowser(raw, dir, { launch })).rejects.toThrow()
  expect(launch).not.toHaveBeenCalled()
  expect(existsSync(dir)).toBe(false)
})

it('reports opener failure without including its arguments or the capability', async () => {
  const dir = directory()
  await expect(openRoomBrowser(url, dir, { platform: 'linux', launch: async () => { throw Error('failed '+url) } })).rejects.toThrow('Could not launch the default browser')
})

it('accepts a long-running handler without killing it', async () => {
  const dir = directory()
  const marker = path.join(dir, '..', 'finished')
  await launchBrowserHandler(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "finished"), 1500)', marker])
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 })
})

it('detects failed handler startup and immediate failure', async () => {
  await expect(launchBrowserHandler(path.join(directory(), 'missing'), [])).rejects.toThrow()
  await expect(launchBrowserHandler(process.execPath, ['-e', 'process.exit(1)'])).rejects.toThrow()
})
