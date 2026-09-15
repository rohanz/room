export type Theme = 'system' | 'light' | 'dark'
export const nextTheme = (theme: Theme): Theme => theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem('room.theme')
    if (value === 'light' || value === 'dark') return value
  } catch { /* Storage may be blocked; system remains usable. */ }
  return 'system'
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem('room.theme', theme) } catch { /* Keep the in-page choice. */ }
}
