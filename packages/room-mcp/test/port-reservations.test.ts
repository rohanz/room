import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reserveWorkerPort } from '../src/port-reservations.js'

const roots: string[] = []
const configHome = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-port-reservations-')); roots.push(root); return root }
const file = (root: string, port: number) => path.join(root, 'room', 'ports', String(port))
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('machine-wide worker ports', () => {
  it('gives two independent allocators distinct ports', () => {
    const root = configHome()
    const first = reserveWorkerPort('lead-a/worker', [], root)
    const second = reserveWorkerPort('lead-b/worker', [], root)
    try {
      expect(first.port).toBe(4400)
      expect(second.port).toBe(4401)
      expect(JSON.parse(fs.readFileSync(file(root, first.port), 'utf8'))).toMatchObject({ pid: process.pid, workerId: 'lead-a/worker' })
    } finally { first.release(); second.release() }
    expect(fs.existsSync(file(root, first.port))).toBe(false)
    expect(fs.existsSync(file(root, second.port))).toBe(false)
  })

  it('reclaims a dead owner port', () => {
    const root = configHome()
    fs.mkdirSync(path.dirname(file(root, 4400)), { recursive: true })
    fs.writeFileSync(file(root, 4400), JSON.stringify({ pid: 99999999, workerId: 'dead', startedAt: 1, nonce: 'dead' }))
    const next = reserveWorkerPort('live', [], root)
    try { expect(next.port).toBe(4400) }
    finally { next.release() }
  })
})
