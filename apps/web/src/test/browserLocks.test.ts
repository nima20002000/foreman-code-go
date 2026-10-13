import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserLocks } from './browserLocks'

const browserNavigator = navigator
const originalLocks = Object.getOwnPropertyDescriptor(browserNavigator, 'locks')

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalLocks) Object.defineProperty(browserNavigator, 'locks', originalLocks)
  else Reflect.deleteProperty(browserNavigator, 'locks')
})

it('keeps browser connectivity and identity when installing Web Locks', async () => {
  const online = navigator.onLine
  const userAgent = navigator.userAgent
  installBrowserLocks()

  expect(navigator.onLine).toBe(online)
  expect(navigator.userAgent).toBe(userAgent)
  expect(navigator).toBe(browserNavigator)
  await expect(navigator.locks.request('editor-command', lock => lock.name)).resolves.toBe('editor-command')
})
