import type { Msg, ScopeMsg } from '@room/shared'

export interface TimelineItem {
  message: Msg
  replies: TimelineItem[]
  alsoSentTo: string[]
}

export interface Episode {
  id: string
  person: string
  area: string
  summary: string
  at: number
  paths: string[]
  status: 'in progress' | 'done'
  items: TimelineItem[]
  alsoSentTo: string[]
}

interface Folded { message: Msg; alsoSentTo: string[] }

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}

function comparableBody(message: Msg): string {
  const { id: _id, at: _at, priority: _priority, to: _to, copyOf: _copyOf, from: _from, fromKind: _kind, ...body } = message
  return JSON.stringify(stable(body))
}

/** Hides addressed upgrade copies and annotates their broadcast original. */
export function foldUpgradeCopies(messages: readonly Msg[]): Folded[] {
  const eligible = new Set<Msg['type']>(['claim', 'changed', 'scope'])
  const folded = messages.map(message => ({ message, alsoSentTo: [] as string[] }))
  const hidden = new Set<string>()
  for (const copy of folded) {
    const message = copy.message
    if (!message.to || !eligible.has(message.type)) continue
    const original = folded.find(candidate => {
      const value = candidate.message
      return !value.to && value.type === message.type && value.from === message.from
        && Math.abs(value.at - message.at) <= 2_000
        && comparableBody(value) === comparableBody(message)
    })
    if (!original) continue
    if (!original.alsoSentTo.includes(message.to)) original.alsoSentTo.push(message.to)
    hidden.add(message.id)
  }
  return folded.filter(item => !hidden.has(item.message.id))
}

function emptyEpisode(scope: ScopeMsg): Episode {
  return {
    id: scope.id,
    person: scope.from,
    area: scope.area,
    summary: scope.summary,
    at: scope.at,
    paths: scope.paths,
    status: 'in progress',
    items: [],
    alsoSentTo: [],
  }
}

/** Groups each person's activity between their consecutive scope declarations. */
export function groupEpisodes(messages: readonly Msg[]): Episode[] {
  const folded = foldUpgradeCopies([...messages].sort((a, b) => a.at - b.at))
  const episodes: Episode[] = []
  const active = new Map<string, Episode>()
  const questions = new Map<string, { episode: Episode; item: TimelineItem }>()

  for (const foldedMessage of folded) {
    const message = foldedMessage.message
    if (message.type === 'scope') {
      const episode = emptyEpisode(message)
      episode.alsoSentTo = foldedMessage.alsoSentTo
      episodes.push(episode)
      active.set(message.from, episode)
      continue
    }

    if (message.type === 'answer') {
      const question = questions.get(message.inReplyTo)
      if (question) {
        question.item.replies.push({ message, replies: [], alsoSentTo: foldedMessage.alsoSentTo })
        continue
      }
    }

    const episode = active.get(message.from)
    if (!episode) continue
    const item: TimelineItem = { message, replies: [], alsoSentTo: foldedMessage.alsoSentTo }
    episode.items.push(item)
    if (message.type === 'question') questions.set(message.id, { episode, item })
  }

  for (const episode of episodes) {
    const lastRelease = Math.max(-Infinity, ...episode.items.filter(item => item.message.type === 'release').map(item => item.message.at))
    if (lastRelease > -Infinity && episode.items.some(item => item.message.type === 'changed' && item.message.at > lastRelease)) episode.status = 'done'
  }
  return episodes.sort((a, b) => a.at - b.at)
}
