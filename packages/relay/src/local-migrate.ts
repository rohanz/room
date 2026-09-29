/** Insert-only catch-up from the previous local relay generation. The old relay may
 * still write its snapshots, so copy new IDs on every observed change until it exits. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, type Claim, type Msg, type Scope } from '@room/shared'
import { probeProcess, type ProcessProbe } from './process.js'
import { saveMemory } from './memory.js'

interface Ledger { messages: string[]; claims: string[]; scopes: string[]; sources: Record<string, number>; messageSources: Record<string, string>; identities: Record<string, string[]>; complete: boolean }
const empty = (): Ledger => ({ messages: [], claims: [], scopes: [], sources: {}, messageSources: {}, identities: {}, complete: false })
const ledgerFile = (common: string) => path.join(common, 'room', 'relay', 'migrated.json')
const legacyDir = (common: string) => path.join(common, 'room-local')
function oldRunning(common: string, probe: ProcessProbe): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(common, 'room-local.json'), 'utf8')) as { pid?: number; startTime?: string; executable?: string }
    const observed = probe(Number(info.pid))
    if (!observed) return false
    // Older discovery files carry only a pid. An unreadable identity is indeterminate,
    // so keep catching up until disappearance can be established.
    if (info.startTime && observed.startTime && info.startTime !== observed.startTime) return false
    if (info.executable && observed.executable && info.executable !== observed.executable) return false
    return true
  } catch { return false }
}
function readLedger(common: string): Ledger {
  try {
    const value = JSON.parse(fs.readFileSync(ledgerFile(common), 'utf8')) as Partial<Ledger>
    return { messages: value.messages ?? [], claims: value.claims ?? [], scopes: value.scopes ?? [], sources: value.sources ?? {}, messageSources: value.messageSources ?? {}, identities: value.identities ?? {}, complete: !!value.complete }
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
export function catchUpLocal(common: string, room: string, targetDoc: Y.Doc, log: (line: string) => void = console.error, probe: ProcessProbe = probeProcess): boolean {
  const files = sources(common, room)
  const running = oldRunning(common, probe)
  const ledger = readLedger(common)
  if (ledger.complete) return false // completed snapshots are an immutable archive
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
    for (const person of source.legacyDeleted.keys()) mark(person, name)
    for (const msg of [...source.bus.toArray(), ...source.mail.values()]) { mark(msg.from, name); mark(msg.to, name) }
  }
  const translated = (person: string, source: string) => (occurrences.get(person)?.size ?? 0) > 1
    ? `?${crypto.createHash('sha256').update(`${source}\0${person}`).digest('hex').slice(0, 16)}` : person
  const unresolved = targetDoc.getMap<{ placeholder: string; claims: Claim[]; scope?: Scope }>('unresolved')
  let changed = false
  let scanned = false
  // A later snapshot can make a previously unique name ambiguous. Move only facts
  // still present in the target; an already released claim or received mail stays gone.
  targetDoc.transact(() => {
    for (const [person, prior] of Object.entries(ledger.identities)) {
      if (prior.length !== 1 || (occurrences.get(person)?.size ?? 0) <= 1) continue
      const source = prior[0], placeholder = translated(person, source), key = `${source}\0${person}`
      const old = unresolved.get(key) ?? { placeholder, claims: [] }
      const moved = [...old.claims]
      for (const [id, claim] of target.claims) {
        if (claim.by !== person || (claim as Claim & { origin?: string }).origin !== source) continue
        target.claims.delete(id)
        if (!moved.some(item => item.id === id)) moved.push({ ...claim, by: placeholder })
        changed = true
      }
      const oldScope = target.scopes.get(person)
      const scope = ledger.scopes.includes(key) && oldScope ? { ...oldScope, by: placeholder } : old.scope
      if (scope && oldScope) { target.scopes.delete(person); changed = true }
      for (const [id, message] of target.mail) {
        if (ledger.messageSources[id] !== source || message.from !== person && message.to !== person) continue
        target.mail.set(id, { ...message, from: message.from === person ? placeholder : message.from,
          ...(message.to === person ? { to: placeholder } : {}) } as Msg)
        changed = true
      }
      if (moved.length || scope) { unresolved.set(key, { placeholder, claims: moved, ...(scope ? { scope } : {}) }); changed = true }
    }
  })
  for (const { name, mtime, source, doc } of loaded) {
    if (ledger.sources[name] === mtime) { doc.destroy(); continue }
    scanned = true
    targetDoc.transact(() => {
      for (const msg of [...source.bus.toArray(), ...source.mail.values()]) {
        if (messages.has(msg.id)) continue
        if (!existing.has(msg.id)) {
          const copy = { ...msg, from: translated(msg.from, name), ...(msg.to ? { to: translated(msg.to, name) } : {}) } as Msg
          if (msg.to) {
            if (!source.seen(msg.to).has(msg.id)) { target.mail.set(msg.id, copy); existing.add(msg.id); changed = true }
          } else { target.bus.push([copy]); existing.add(msg.id); changed = true }
        }
        messages.add(msg.id)
        ledger.messageSources[msg.id] = name
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
  // The snapshot must be durable before the import ledger can advance. In particular,
  // a retry with IDs already in the live doc still saves the snapshot.
  if ((scanned || changed || completionChanged) && !saveMemory(common, room, targetDoc, log)) throw new Error('local migration could not save the new room snapshot')
  ledger.messages = [...messages]; ledger.claims = [...claims]; ledger.scopes = [...scopes]
  ledger.identities = Object.fromEntries([...occurrences].map(([person, names]) => [person, [...names].sort()]))
  if (scanned || changed || completionChanged) writeLedger(common, ledger)
  return running
}

export function forgetLegacyLocal(common: string, room: string): void {
  for (const { file } of sources(common, room)) fs.rmSync(file, { force: true })
  fs.rmSync(ledgerFile(common), { force: true })
}
