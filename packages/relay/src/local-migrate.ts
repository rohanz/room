/** Insert-only catch-up from the previous local relay generation. The old relay may
 * still write its snapshots, so copy new IDs on every observed change until it exits. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, type Claim, type Msg, type Scope } from '@room/shared'
import { pidAlive } from './process.js'
import { saveMemory } from './memory.js'

interface Ledger { messages: string[]; claims: string[]; scopes: string[]; sources: Record<string, number>; complete: boolean }
const empty = (): Ledger => ({ messages: [], claims: [], scopes: [], sources: {}, complete: false })
const ledgerFile = (common: string) => path.join(common, 'room', 'relay', 'migrated.json')
const legacyDir = (common: string) => path.join(common, 'room-local')
function oldRunning(common: string): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(common, 'room-local.json'), 'utf8')) as { pid?: number }
    return pidAlive(Number(info.pid))
  } catch { return false }
}
function readLedger(common: string): Ledger {
  try {
    const value = JSON.parse(fs.readFileSync(ledgerFile(common), 'utf8')) as Partial<Ledger>
    return { messages: value.messages ?? [], claims: value.claims ?? [], scopes: value.scopes ?? [], sources: value.sources ?? {}, complete: !!value.complete }
  } catch { return empty() }
}
function writeLedger(common: string, ledger: Ledger): void {
  const file = ledgerFile(common), temp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(temp, JSON.stringify(ledger) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, file)
  } finally { fs.rmSync(temp, { force: true }) }
}
function sources(common: string, room: string): { file: string; name: string; mtime: number }[] {
  try {
    return fs.readdirSync(legacyDir(common)).filter(file => file.endsWith('.ydoc')).flatMap(file => {
      let name: string
      try { name = decodeURIComponent(file.slice(0, -5)) } catch { return [] }
      if (name !== room && !name.startsWith(`${room}/`)) return []
      const full = path.join(legacyDir(common), file)
      return [{ file: full, name, mtime: fs.statSync(full).mtimeMs }]
    })
  } catch { return [] }
}

/** Return whether a legacy relay is still live. Saving precedes the ID ledger: a crash
 * between them replays harmlessly because target IDs are checked too. */
export function catchUpLocal(common: string, room: string, targetDoc: Y.Doc, log: (line: string) => void = console.error): boolean {
  const files = sources(common, room)
  const running = oldRunning(common)
  const ledger = readLedger(common)
  if (!files.length && !running) return false
  const target = new RoomDoc(targetDoc)
  const messages = new Set(ledger.messages), claims = new Set(ledger.claims), scopes = new Set(ledger.scopes)
  const existing = new Set([...target.bus.toArray().map(m => m.id), ...target.mail.keys()])
  const loaded: { name: string; mtime: number; source: RoomDoc; doc: Y.Doc }[] = []
  for (const { file, name, mtime } of files) {
    const doc = new Y.Doc()
    try { Y.applyUpdate(doc, fs.readFileSync(file)); loaded.push({ name, mtime, source: new RoomDoc(doc), doc }) }
    catch (error) { log(`local migration: cannot read ${file}: ${String(error)}`); doc.destroy() }
  }
  const occurrences = new Map<string, Set<string>>()
  const mark = (person: string | undefined, source: string) => {
    if (!person) return
    let names = occurrences.get(person)
    if (!names) { names = new Set(); occurrences.set(person, names) }
    names.add(source)
  }
  for (const { name, source } of loaded) {
    for (const person of source.scopes.keys()) mark(person, name)
    for (const claim of source.claims.values()) mark(claim.by, name)
    for (const person of source.overlays.keys()) mark(person, name)
    for (const person of source.deleted.keys()) mark(person, name)
    for (const msg of [...source.bus.toArray(), ...source.mail.values()]) { mark(msg.from, name); mark(msg.to, name) }
  }
  const translated = (person: string, source: string) => (occurrences.get(person)?.size ?? 0) > 1
    ? `?${crypto.createHash('sha256').update(`${source}\0${person}`).digest('hex').slice(0, 16)}` : person
  const unresolved = targetDoc.getMap<{ placeholder: string; claims: Claim[]; scope?: Scope }>('unresolved')
  let changed = false
  let scanned = false
  for (const { name, mtime, source, doc } of loaded) {
    if (ledger.sources[name] === mtime) { doc.destroy(); continue }
    scanned = true
    targetDoc.transact(() => {
      for (const msg of [...source.bus.toArray(), ...source.mail.values()]) {
        if (messages.has(msg.id)) continue
        if (!existing.has(msg.id)) {
          const copy = { ...msg, from: translated(msg.from, name), ...(msg.to ? { to: translated(msg.to, name) } : {}) } as Msg
          if (msg.to && !source.seen(msg.to).has(msg.id)) target.mail.set(msg.id, copy)
          else target.bus.push([copy])
          existing.add(msg.id); changed = true
        }
        messages.add(msg.id)
      }
      for (const claim of source.claims.values()) {
        if (claims.has(claim.id)) continue
        const by = translated(claim.by, name)
        const { anchor: _anchor, ...rest } = claim
        const copy = { ...rest, by, origin: name } as Claim
        if (by !== claim.by) {
          const key = `${name}\0${claim.by}`
          const old = unresolved.get(key) ?? { placeholder: by, claims: [] }
          if (!old.claims.some(item => item.id === claim.id)) { unresolved.set(key, { ...old, claims: [...old.claims, copy] }); changed = true }
        } else if (!target.claims.has(claim.id)) { target.claims.set(claim.id, copy); changed = true }
        claims.add(claim.id)
      }
      for (const [person, scope] of source.scopes) {
        const key = `${name}\0${person}`
        if (scopes.has(key)) continue
        const by = translated(person, name)
        const copy = { ...scope, by } as Scope
        if (by !== person) {
          const old = unresolved.get(key) ?? { placeholder: by, claims: [] }
          unresolved.set(key, { ...old, scope: copy }); changed = true
        } else if (!target.scopes.has(person)) { target.scopes.set(person, copy); changed = true }
        scopes.add(key)
      }
    })
    ledger.sources[name] = mtime
    doc.destroy()
  }
  if (target.metaMap.get('localMigrating') !== Number(running)) { target.metaMap.set('localMigrating', Number(running)); changed = true }
  const completionChanged = ledger.complete !== !running
  ledger.complete = !running
  if (changed && !saveMemory(common, room, targetDoc, log)) throw new Error('local migration could not save the new room snapshot')
  ledger.messages = [...messages]; ledger.claims = [...claims]; ledger.scopes = [...scopes]
  if (scanned || changed || completionChanged) writeLedger(common, ledger)
  return running
}

export function forgetLegacyLocal(common: string, room: string): void {
  for (const { file } of sources(common, room)) fs.rmSync(file, { force: true })
  fs.rmSync(ledgerFile(common), { force: true })
}
