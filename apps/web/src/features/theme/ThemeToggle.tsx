import { Moon, Sun } from 'lucide-react'

import { IconButton } from '../../shared/ui/nocturne'
import { toggleTheme, useTheme } from './themeStore'

export function ThemeToggle() {
  const theme = useTheme()
  const destination = theme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${destination} theme`
  const Icon = destination === 'light' ? Sun : Moon

  return (
    <IconButton
      className="theme-toggle"
      label={label}
      onClick={toggleTheme}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={2} />
    </IconButton>
  )
}
