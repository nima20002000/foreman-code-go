import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UnsavedChangesProvider } from './UnsavedChangesProvider'
import { useUnsavedChanges, type LeaveTarget } from './unsavedChanges'

const blocker = vi.hoisted(() => ({ current: undefined as unknown as {
  shouldBlockFn(input: { current: LeaveTarget; next: LeaveTarget }): Promise<boolean>
  enableBeforeUnload(): boolean
} }))
vi.mock('@tanstack/react-router', () => ({ useBlocker: (options: typeof blocker.current) => { blocker.current = options } }))
afterEach(cleanup)
function Editor({ retained }: { retained: boolean }) {
  useUnsavedChanges({ label: 'Board', dirty: true, canResume: () => retained, save() {}, discard() {} })
  return null
}
it('allows navigation and reload for recoverable edits without displaying a dialog', async () => {
  render(<UnsavedChangesProvider><Editor retained /></UnsavedChangesProvider>)
  expect(blocker.current.enableBeforeUnload()).toBe(false)
  let blocked = true
  await act(async () => { blocked = await blocker.current.shouldBlockFn({
    current: { pathname: '/workspaces/one', search: {} }, next: { pathname: '/settings', search: {} },
  }) })
  expect(blocked).toBe(false)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})
it('retains the browser warning when edits cannot be recovered', () => {
  render(<UnsavedChangesProvider><Editor retained={false} /></UnsavedChangesProvider>)
  expect(blocker.current.enableBeforeUnload()).toBe(true)
})
