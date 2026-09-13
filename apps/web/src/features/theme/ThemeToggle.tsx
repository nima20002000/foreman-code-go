import { Moon, Sun } from 'lucide-react'

import { toggleTheme, useTheme } from './themeStore'

export function ThemeToggle() {
  const theme = useTheme()
  const destination = theme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${destination} theme`
  const Icon = destination === 'light' ? Sun : Moon

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" size={15} strokeWidth={2} />
      <span>{label}</span>
    </button>
  )
}
