import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DISK_TEXT_LIMIT, readBoundedDiskText } from '../src/tools/disk-text.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('reads at the publication ceiling and rejects a larger local file before decoding it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-disk-text-'))
  dirs.push(dir)
  const file = path.join(dir, 'large.txt')
  fs.writeFileSync(file, 'x'.repeat(DISK_TEXT_LIMIT))
  expect(await readBoundedDiskText(file)).toBe('x'.repeat(DISK_TEXT_LIMIT))
  fs.appendFileSync(file, 'y')
  await expect(readBoundedDiskText(file)).rejects.toThrow('file too large for Room read')
})
