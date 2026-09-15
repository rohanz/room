export type View = 'board' | 'code'
export function initialView(search: string): View {
  const params = new URLSearchParams(search)
  return params.getAll('view').reverse().find(value => value === 'board' || value === 'code') as View ?? (params.has('view') ? 'board' : 'code')
}
/** Keep the legacy read-only credential when changing the presentation. */
export function viewUrl(raw: string, view: View): string {
  const url = new URL(raw)
  const keys = url.searchParams.getAll('view').filter(value => value !== 'board' && value !== 'code')
  url.searchParams.delete('view')
  for (const key of keys) url.searchParams.append('view', key)
  url.searchParams.append('view', view)
  return url.toString()
}
