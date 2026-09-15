export type Theme = 'light' | 'dark' | 'system'
export const nextTheme = (theme: Theme): Theme => theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem('room.theme')
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch { /* Storage may be blocked; light remains usable. */ }
  return 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem('room.theme', theme) } catch { /* Keep the in-page choice. */ }
}
