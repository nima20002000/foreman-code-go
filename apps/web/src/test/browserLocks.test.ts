import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBrowserLocks } from './browserLocks'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser locks fixture', () => {
  it.each(['userAgent', 'onLine'] as const)('preserves the native %s getter while providing locks', async (property) => {
    const expected = navigator[property]

    installBrowserLocks()

    expect(navigator[property]).toBe(expected)
    await expect(navigator.locks.request('browser-command', (lock) => lock?.name)).resolves.toBe('browser-command')
  })

  it('reads changes to native connectivity after installation', () => {
    const browserNavigator = navigator
    installBrowserLocks()

    vi.spyOn(browserNavigator, 'onLine', 'get').mockReturnValue(false)

    expect(navigator.onLine).toBe(false)
  })

  it('preserves native methods and restores the original navigator', () => {
    const browserNavigator = navigator
    const expected = browserNavigator.javaEnabled()

    installBrowserLocks()

    expect(navigator.javaEnabled()).toBe(expected)
    vi.unstubAllGlobals()
    expect(navigator).toBe(browserNavigator)
  })
})
