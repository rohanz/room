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
  it('keeps a late stream error handled after the body settles', async () => {
    const read = bodyReader({ maxConcurrent: 1 })
    const req = new IncomingMessage(new Socket())
    const result = read(req)
    req.emit('end')
    await expect(result).resolves.toBe('')
    expect(() => req.emit('error', new Error('late socket error'))).not.toThrow()
    expect(req.listenerCount('error')).toBe(1)
  })
  it('accepts the byte limit exactly, overrides it per request, and decodes split UTF-8', async () => {
    const read = bodyReader({ maxBytes: 2, maxConcurrent: 1 })
    const exact = new IncomingMessage(new Socket())
    const exactResult = read(exact)
    exact.emit('data', Buffer.from('ab'))
    exact.emit('end')
    await expect(exactResult).resolves.toBe('ab')
    expectSettled(exact)

    const split = new IncomingMessage(new Socket())
    const splitResult = read(split, { maxBytes: 3 })
    const utf8 = Buffer.from('€')
    split.emit('data', utf8.subarray(0, 1))
    split.emit('data', utf8.subarray(1))
    split.emit('end')
    await expect(splitResult).resolves.toBe('€')
    expectSettled(split)
  })
  it('rejects a byte over the per-request limit and releases its concurrency slot', async () => {
    const read = bodyReader({ maxBytes: 2, maxConcurrent: 1 })
    const tooLarge = new IncomingMessage(new Socket())
    const result = read(tooLarge, { maxBytes: 3 })
    tooLarge.emit('data', Buffer.from('abcd'))
    await expect(result).rejects.toMatchObject({ status: 413 })
    expectSettled(tooLarge)
    const next = new IncomingMessage(new Socket())
    const pending = read(next)
    next.emit('end')
    await expect(pending).resolves.toBe('')
    expectSettled(next)
  })
  it('settles unfinished uploads on timeout, close, abort, and stream error', async () => {
    const read = bodyReader({ maxConcurrent: 1, timeoutMs: 10 })
    for (const [event, status] of [['timeout', 408], ['close', 400], ['aborted', 400], ['error', 400]] as const) {
      const req = new IncomingMessage(new Socket())
      const result = read(req)
      req.emit('data', Buffer.from('partial'))
      if (event === 'error') req.emit('error', new Error('stream failed'))
      else if (event !== 'timeout') req.emit(event)
      await expect(result).rejects.toMatchObject({ status })
      expectSettled(req)
      expect(() => req.emit('error', new Error('late'))).not.toThrow()
    }
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

function expectSettled(req: IncomingMessage) {
  for (const event of ['data', 'end', 'aborted', 'close']) expect(req.listenerCount(event)).toBe(0)
  expect(req.listenerCount('error')).toBe(1)
}
