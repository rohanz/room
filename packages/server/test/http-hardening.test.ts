import { describe, expect, it } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bodyReader, HttpFailure, isAdminIdentity, RateLimit, safeUrl, staticFile } from '../src/http.js'

describe('HTTP entry guards', () => {
  it('M5 rejects malformed request targets without throwing URL errors', () => {
    expect(() => safeUrl('//[')).toThrow(HttpFailure)
    expect(safeUrl('/health').pathname).toBe('/health')
  })
  it('M6 refuses an oversized streamed body and settles on abort', async () => {
    const read = bodyReader({ maxBytes: 4 })
    const req = new IncomingMessage(new Socket())
    const result = read(req)
    req.emit('data', Buffer.from('12345'))
    await expect(result).rejects.toMatchObject({ status: 413 })
    const aborted = new IncomingMessage(new Socket())
    const pending = read(aborted)
    aborted.emit('aborted')
    await expect(pending).rejects.toMatchObject({ status: 400 })
  })
  it('S3 keeps static files within the real root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-static-'))
    const sibling = root + '-secrets'
    fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'key'), 'secret')
    try { expect(staticFile(root, '/../' + path.basename(sibling) + '/key')).toBeUndefined() }
    finally { fs.rmSync(root, { recursive: true }); fs.rmSync(sibling, { recursive: true }) }
  })
  it('S1 limits repeated requests with a retry delay', () => {
    const limit = new RateLimit(2, 1000)
    expect(limit.check('ip', 0)).toBe(0)
    expect(limit.check('ip', 0)).toBe(0)
    expect(limit.check('ip', 0)).toBe(1)
  })
  it('S4 never authorizes an OIDC display name as a GitHub administrator', () => {
    const admins = new Set(['octocat', 'oidc:idp.example:sub-1'])
    expect(isAdminIdentity({ provider: 'oidc', login: 'octocat', id: 'oidc:idp.example:sub-2' }, admins)).toBe(false)
    expect(isAdminIdentity({ provider: 'oidc', login: 'someone', id: 'oidc:idp.example:sub-1' }, admins)).toBe(true)
  })
})
