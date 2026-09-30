import { displayName, workerLive, type Identity } from '@room/shared'
import type { Session } from '../session.js'
import { isPrName } from '../prs.js'

export interface NameContext {
  all: () => Session[]
  presences: (session: Session) => { user: Identity }[]
  myWorkers: (session: Session) => { name: string; tag: string; lead: string }[]
}

export function knownNames(session: Session, presences: NameContext['presences']): Set<string> {
  return new Set([
    session.me.name, ...presences(session).map(p => p.user.name), ...session.room.colors.keys(), ...session.room.scopes.keys(), ...session.room.manifestHead.keys(),
    ...session.room.openClaims().map(c => c.by), ...Array.from(session.room.workerViews.values(), w => w.name),
    ...session.room.retiredWorkers().map(w => w.name), ...session.room.messages().map(m => m.from),
    ...Array.from(session.room.mail.values(), m => m.from),
    ...Array.from(session.room.doc.getMap<{ placeholder: string }>('unresolved').values(), value => value.placeholder),
    ...session.room.doc.getMap<string>('aliases').values(),
  ].filter(n => !isPrName(n)))
}

const addressKey = (name: string) => name.replace(/\u2019/g, "'").toLocaleLowerCase()

/** Resolve a spoken participant name, including a lead's worker tag. Exact raw names win. */
export function resolveDisplayedName(requested: string, context: NameContext, caller: Session): { name?: string; ambiguous?: string[] } {
  const sessions = context.all()
  const known = new Set(sessions.flatMap(s => [...knownNames(s, context.presences)]))
  if (known.has(requested)) return { name: requested }
  const candidates = new Set<string>()
  const key = addressKey(requested)
  for (const name of known) if (addressKey(name) === key) candidates.add(name)
  for (const room of sessions) {
    for (const identity of [room.me, ...context.presences(room).map(p => p.user)]) {
      if (addressKey(displayName(identity)) === key) candidates.add(identity.name)
    }
    for (const scope of room.room.allScopes()) {
      if (addressKey(displayName({ name: scope.by, kind: scope.byKind })) === key) candidates.add(scope.by)
    }
    for (const claim of room.room.openClaims()) {
      if (addressKey(displayName({ name: claim.by, kind: claim.byKind })) === key) candidates.add(claim.by)
    }
    for (const worker of context.myWorkers(room)) if (worker.lead === caller.me.name && (addressKey(worker.tag) === key || addressKey(worker.name) === key)) candidates.add(worker.name)
    for (const worker of room.room.retiredWorkers()) if (worker.lead === caller.me.name && addressKey(worker.tag) === key) candidates.add(worker.name)
  }
  const names = [...candidates].sort()
  if (names.length) return names.length > 1 ? { ambiguous: names } : { name: names[0] }
  const owner = key.endsWith("'s agent") ? key.slice(0, -"'s agent".length) : key
  // Presence is the active roster. Old scopes, mail and retired workers must not win this fallback.
  const active = new Map<string, Identity>()
  for (const room of sessions) for (const identity of [room.me, ...context.presences(room).map(p => p.user)]) {
    if (identity.kind === 'agent') active.set(identity.name, identity)
  }
  for (const room of sessions) for (const worker of room.room.acceptedWorkerViews()) {
    if (workerLive(worker.status) && !active.has(worker.name)) active.set(worker.name, { name: worker.name, kind: 'agent' })
  }
  const owned = [...active.values()].filter(id => addressKey(id.owner ?? id.name.split('+')[0]) === owner)
  // Workers count only here, after exact names and displayed names have failed.
  const owners = owned.map(id => id.name).sort()
  return owners.length > 1 ? { ambiguous: owners } : { name: owners[0] }
}
