import { describe, expect, it } from 'vitest'
import { initialView, viewUrl } from './view.ts'

describe('view navigation', () => {
  it('opens shared links on Board and ordinary inspector links on Code', () => {
    expect(initialView('?view=readonly-secret')).toBe('board')
    expect(initialView('?view=')).toBe('board')
    expect(initialView('?view=board')).toBe('board')
    expect(initialView('?view=code')).toBe('code')
    expect(initialView('?key=local')).toBe('code')
    expect(initialView('')).toBe('code')
  })
  it('preserves authentication and room identity through repeated switches', () => {
    let raw = 'https://room.example/?room=wss%3A%2F%2Froom.example%2Frepo&view=readonly-secret&key=local'
    for (const view of ['code', 'board', 'code'] as const) {
      raw = viewUrl(raw, view)
      const url = new URL(raw)
      expect(url.searchParams.getAll('view')).toEqual(['readonly-secret', view])
      expect(url.searchParams.get('key')).toBe('local')
      expect(url.searchParams.get('room')).toBe('wss://room.example/repo')
      expect(initialView(url.search)).toBe(view)
    }
  })
})
