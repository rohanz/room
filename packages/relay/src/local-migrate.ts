/** Insert-only catch-up from the previous local relay generation. The old relay may
 * still write its snapshots, so copy new IDs on every observed change until it exits. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, isLegacyBranchNotice, isRoomNotice, type Claim, type Msg, type Scope } from '@room/shared'
import { probeProcess, type ProcessProbe } from './process.js'
import { saveMemory } from './memory.js'

interface Ledger { messages: string[]; claims: string[]; scopes: string[]; scopeSnapshots: Record<string, string>; sources: Record<string, number>; messageSources: Record<string, string>; identities: Record<string, string[]>; complete: boolean }
const empty = (): Ledger => ({ messages: [], claims: [], scopes: [], scopeSnapshots: {}, sources: {}, messageSources: {}, identities: {}, complete: false })
const ledgerFile = (common: string, room: string) => path.join(common, 'room', 'relay', `migrated-${crypto.createHash('sha256').update(room).digest('hex').slice(0, 16)}.json`)
const legacyDir = (common: string) => path.join(common, 'room-local')
/** A Room 0.16 relay still serving this clone (its discovery file names a live process). */
export function legacyRelayRunning(common: string, probe: ProcessProbe = probeProcess): boolean { return oldRunning(common, probe) }
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
function readLedger(common: string, room: string): Ledger {
  const scoped = ledgerFile(common, room)
  let file = scoped
  if (!fs.existsSync(scoped)) {
    const old = path.join(common, 'room', 'relay', 'migrated.json')
    try {
      const candidate = JSON.parse(fs.readFileSync(old, 'utf8')) as Partial<Ledger>
      const names = Object.keys(candidate.sources ?? {})
      // The pre-fix ledger had no room key. Adopt it only when its recorded
      // sources prove it belongs entirely to this target room.
      if (names.length && names.every(name => name === room || name.startsWith(`${room}/`))) file = old
    } catch { /* no prior migration ledger */ }
  }
  let value: Partial<Ledger>
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Ledger> }
  catch { return empty() }
  const ledger = { messages: value.messages ?? [], claims: value.claims ?? [], scopes: value.scopes ?? [], scopeSnapshots: value.scopeSnapshots ?? {}, sources: value.sources ?? {}, messageSources: value.messageSources ?? {}, identities: value.identities ?? {}, complete: !!value.complete }
  if (file !== scoped) writeLedger(common, room, ledger)
  return ledger
}
function writeLedger(common: string, room: string, ledger: Ledger): void {
  const file = ledgerFile(common, room), temp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
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
      try { name = decodeURIComponent(file.slice(0, -5)) }
      catch { throw new Error(`invalid legacy snapshot name: ${file}`) }
      if (name !== room && !name.startsWith(`${room}/`)) return []
      const full = path.join(legacyDir(common), file)
      return [{ file: full, name, mtime: fs.statSync(full).mtimeMs }]
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Return whether a legacy relay is still live. Saving precedes the ID ledger: a crash
 * between them replays harmlessly because target IDs are checked too. */
export function catchUpLocal(common: string, room: string, targetDoc: Y.Doc, log: (line: string) => void = console.error, probe: ProcessProbe = probeProcess): boolean {
  let files: ReturnType<typeof sources>
  try { files = sources(common, room) }
  catch (error) {
    log(`local migration: cannot enumerate ${legacyDir(common)}: ${String(error)}`)
    new RoomDoc(targetDoc).metaMap.set('localMigrating', 1)
    if (!saveMemory(common, room, targetDoc, log)) throw new Error('local migration could not save the new room snapshot')
    return true
  }
  const running = oldRunning(common, probe)
  const ledger = readLedger(common, room)
  if (ledger.complete) return false // completed snapshots are an immutable archive
  if (!files.length && !running) return false
  const target = new RoomDoc(targetDoc)
  const messages = new Set(ledger.messages), claims = new Set(ledger.claims), scopes = new Set(ledger.scopes)
  const existing = new Set([...target.bus.toArray().map(m => m.id), ...target.mail.keys()])
  // Room's own notices repeat word for word (one per daemon start, one per branch room): import each once.
  const noticeKey = (m: Msg) => `${m.type}\0${m.to ?? ''}\0${JSON.stringify((m as { text?: unknown }).text ?? null)}`
  const notices = new Set([...target.bus.toArray(), ...target.mail.values()].filter(isRoomNotice).map(noticeKey))
  const loaded: { name: string; mtime: number; source: RoomDoc; doc: Y.Doc }[] = []
  let unreadable = false
  for (const { file, name, mtime } of files) {
    const doc = new Y.Doc()
    try { Y.applyUpdate(doc, fs.readFileSync(file)); loaded.push({ name, mtime, source: new RoomDoc(doc), doc }) }
    catch (error) { log(`local migration: cannot read ${file}: ${String(error)}`); unreadable = true; doc.destroy() }
  }
  // Identity evidence is monotonic while catch-up is pending. A snapshot that
  // temporarily fails to parse cannot make an ambiguous legacy name unique.
  const occurrences = new Map<string, Set<string>>(Object.entries(ledger.identities)
    .map(([person, names]) => [person, new Set(names)]))
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
    for (const msg of [...source.bus.toArray(), ...source.mail.values()]) { if (!isRoomNotice(msg)) mark(msg.from, name); mark(msg.to, name) }
  }
  const aliases = targetDoc.getMap<string>('aliases')
  const placeholder = (person: string, source: string) => `?${crypto.createHash('sha256').update(`${source}\0${person}`).digest('hex').slice(0, 16)}`
  const translated = (person: string, source: string) => {
    const by = placeholder(person, source)
    return aliases.get(by) ?? ((occurrences.get(person)?.size ?? 0) > 1 ? by : person)
  }
  const unresolved = targetDoc.getMap<{ placeholder: string; claims: Claim[]; scope?: Scope }>('unresolved')
  let changed = false
  let scanned = false
  // A later snapshot can make a previously unique name ambiguous. Move only facts
  // still present in the target; an already released claim or received mail stays gone.
  targetDoc.transact(() => {
    for (const [person, found] of occurrences) if (found.size > 1) for (const source of found) {
      const key = `${source}\0${person}`, by = placeholder(person, source)
      if (!aliases.has(by) && !unresolved.has(key)) { unresolved.set(key, { placeholder: by, claims: [] }); changed = true }
    }
    for (const [person, prior] of Object.entries(ledger.identities)) {
      if (prior.length !== 1 || (occurrences.get(person)?.size ?? 0) <= 1) continue
      const source = prior[0], by = translated(person, source), key = `${source}\0${person}`
      const old = unresolved.get(key) ?? { placeholder: by, claims: [] }
      const moved = [...old.claims]
      for (const [id, claim] of target.claims) {
        if (claim.by !== person || (claim as Claim & { origin?: string }).origin !== source) continue
        target.claims.delete(id)
        if (!moved.some(item => item.id === id)) moved.push({ ...claim, by })
        changed = true
      }
      const oldScope = target.scopes.get(person)
      const importedScope = !!oldScope && ledger.scopeSnapshots[key] === JSON.stringify(oldScope)
      const scope = importedScope ? { ...oldScope, by } : old.scope
      if (importedScope) { target.scopes.delete(person); changed = true }
      for (const [id, message] of target.mail) {
        if (ledger.messageSources[id] !== source || message.from !== person && message.to !== person) continue
        target.mail.set(id, { ...message, from: message.from === person ? by : message.from,
          ...(message.to === person ? { to: by } : {}) } as Msg)
        changed = true
      }
      if (by.startsWith('?')) {
        if (moved.length || scope) { unresolved.set(key, { placeholder: by, claims: moved, ...(scope ? { scope } : {}) }); changed = true }
      } else {
        for (const claim of moved) if (!target.claims.has(claim.id)) { target.claims.set(claim.id, { ...claim, by }); changed = true }
        if (scope && !target.scopes.has(by)) {
          const copy = { ...scope, by }
          target.scopes.set(by, copy)
          ledger.scopeSnapshots[key] = JSON.stringify(copy)
          changed = true
        }
        if (unresolved.has(key)) { unresolved.delete(key); changed = true }
      }
    }
  })
  for (const { name, mtime, source, doc } of loaded) {
    if (ledger.sources[name] === mtime) { doc.destroy(); continue }
    scanned = true
    targetDoc.transact(() => {
      for (const msg of [...source.bus.toArray(), ...source.mail.values()]) {
        if (messages.has(msg.id)) continue
        // 0.16 branch-following notices mean nothing in a repository room, and a repeat of a Room notice already here adds nothing.
        const skip = isLegacyBranchNotice(msg) || isRoomNotice(msg) && notices.has(noticeKey(msg))
        if (!existing.has(msg.id) && !skip) {
          if (isRoomNotice(msg)) notices.add(noticeKey(msg))
          const copy = { ...msg, from: isRoomNotice(msg) ? msg.from : translated(msg.from, name), ...(msg.to ? { to: translated(msg.to, name) } : {}) } as Msg
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
        if (by.startsWith('?')) {
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
        const copy = { ...scope, by, origin: name } as Scope
        if (by.startsWith('?')) {
          const old = unresolved.get(key) ?? { placeholder: by, claims: [] }
          unresolved.set(key, { ...old, scope: copy }); changed = true
        } else if (!target.scopes.has(by)) { target.scopes.set(by, copy); ledger.scopeSnapshots[key] = JSON.stringify(copy); changed = true }
        scopes.add(key)
      }
    })
    ledger.sources[name] = mtime
    doc.destroy()
  }
  const pending = running || unreadable
  if (target.metaMap.get('localMigrating') !== Number(pending)) { target.metaMap.set('localMigrating', Number(pending)); changed = true }
  const completionChanged = ledger.complete !== !pending
  ledger.complete = !pending
  // The snapshot must be durable before the import ledger can advance. In particular,
  // a retry with IDs already in the live doc still saves the snapshot.
  if ((scanned || changed || completionChanged) && !saveMemory(common, room, targetDoc, log)) throw new Error('local migration could not save the new room snapshot')
  ledger.messages = [...messages]; ledger.claims = [...claims]; ledger.scopes = [...scopes]
  ledger.identities = Object.fromEntries([...occurrences].map(([person, names]) => [person, [...names].sort()]))
  if (scanned || changed || completionChanged) writeLedger(common, room, ledger)
  return pending
}

export function forgetLegacyLocal(common: string, room: string): void {
  for (const { file } of sources(common, room)) fs.rmSync(file, { force: true })
  fs.rmSync(ledgerFile(common, room), { force: true })
  const old = path.join(common, 'room', 'relay', 'migrated.json')
  try {
    const ledger = JSON.parse(fs.readFileSync(old, 'utf8')) as Partial<Ledger>
    const names = Object.keys(ledger.sources ?? {})
    if (names.length && names.every(name => name === room || name.startsWith(`${room}/`))) fs.rmSync(old, { force: true })
  } catch { /* no legacy global ledger */ }
}
