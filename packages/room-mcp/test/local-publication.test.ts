import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { localLeadRoot, witnessPublishedPath } from '../src/local-publication.js'
import type { ParticipantMetadataSnapshot } from '@room/shared'
import { nameLeaseFile } from '../src/names.js'

const roots: string[] = []
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-local-publication-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  return { root, git, put: (text: string) => fs.writeFileSync(path.join(root, 'file.txt'), text) }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('witnesses shared bytes and invalidates them on modification or deletion', async () => {
  const t = fixture(); t.put('shared\n')
  const proof = await witnessPublishedPath(t.root, 'file.txt', 'shared\n', undefined, 1024)
  expect(proof.matches).toBe(true)
  expect(await proof.current()).toBe(true)
  t.put('different\n')
  expect(await proof.current()).toBe(false)
  fs.rmSync(path.join(t.root, 'file.txt'))
  expect(await proof.current()).toBe(false)
})

it('requires a witnessed absence for published deletion', async () => {
  const t = fixture()
  const proof = await witnessPublishedPath(t.root, 'file.txt', null, undefined, 1024)
  expect(proof.matches).toBe(true)
  t.put('not deleted\n')
  expect(await proof.current()).toBe(false)
  expect((await witnessPublishedPath(t.root, 'file.txt', null, undefined, 1024)).matches).toBe(false)
})

it('rejects unsafe or oversized local inputs without using them as published text', async () => {
  const t = fixture(); t.put('large contents\n')
  expect((await witnessPublishedPath(t.root, '../outside', null, undefined, 1024)).matches).toBe(false)
  expect((await witnessPublishedPath(t.root, 'file.txt', 'large contents\n', undefined, 3)).matches).toBe(false)
  fs.symlinkSync(os.tmpdir(), path.join(t.root, 'outside'))
  expect((await witnessPublishedPath(t.root, 'outside/not-present', null, undefined, 1024)).matches).toBe(false)
})

it('allows clean-filtered base bytes but requires exact bytes for a changed entry', async () => {
  const t = fixture()
  fs.writeFileSync(path.join(t.root, '.gitattributes'), '*.txt text eol=crlf\n')
  t.put('committed\n'); t.git('add', '.'); t.git('commit', '-qm', 'base')
  const base = t.git('rev-parse', 'HEAD')
  t.put('committed\r\n')
  const proof = await witnessPublishedPath(t.root, 'file.txt', 'committed\n', base, 1024)
  expect(proof.matches).toBe(true)
  expect((await witnessPublishedPath(t.root, 'file.txt', 'committed\n', undefined, 1024)).matches).toBe(false)
  t.put('changed\r\n')
  expect(await proof.current()).toBe(false)
  expect((await witnessPublishedPath(t.root, 'file.txt', 'committed\n', base, 1024)).matches).toBe(false)
})

it('requires the captured publisher’s local name lease to name the witnessed checkout', async () => {
  const t = fixture(), common = path.join(t.root, '.git')
  const holder = { sessionId: 'publisher', pid: process.pid, startTime: 'fixture-start', executable: 'node', epoch: 1 }
  const publisher = { name: 'lead', fenceValid: true, record: { holder } } as ParticipantMetadataSnapshot
  const key = 'local/test', file = nameLeaseFile(common, key, 'lead')
  const lease = { roomKey: key, name: 'lead', worktree: t.root, holder }
  const write = (value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
  expect(await localLeadRoot(common, publisher, key)).toBeUndefined()
  write(lease)
  const binding = (await localLeadRoot(common, publisher, key))!
  expect(binding.root).toBe(t.root)
  expect(binding.current()).toBe(true)
  expect(await localLeadRoot(common, publisher, undefined)).toBeUndefined()
  expect(await localLeadRoot(path.join(t.root, 'other.git'), publisher, key)).toBeUndefined()
  for (const value of [
    { ...lease, holder: { ...holder, sessionId: 'different-session' } },
    { ...lease, holder: { ...holder, startTime: 'different-process' } },
    { ...lease, worktree: path.join(t.root, 'another-worktree') },
    { ...lease, roomKey: 'another-room' },
  ]) {
    write(value)
    expect(binding.current()).toBe(false)
    expect(await localLeadRoot(common, publisher, key)).toBeUndefined()
  }
  fs.writeFileSync(file, '{broken')
  expect(await localLeadRoot(common, publisher, key)).toBeUndefined()
})
