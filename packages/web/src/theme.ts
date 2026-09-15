export type Theme = 'light' | 'dark' | 'system'
export const nextTheme = (theme: Theme): Theme => theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem('room.theme')
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch { /* Storage may be blocked; light remains usable. */ }
  return 'light'
}

let transitionTimer: ReturnType<typeof setTimeout> | undefined

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (root.getAttribute('data-theme') && root.getAttribute('data-theme') !== theme && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    clearTimeout(transitionTimer)
    root.classList.add('theme-transition')
    transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 220)
  }
  root.setAttribute('data-theme', theme)
  try { localStorage.setItem('room.theme', theme) } catch { /* Keep the in-page choice. */ }
}
