import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputerAccountChips } from './ComputerAccounts'
import computerStyles from './computers.css?inline'

afterEach(() => vi.unstubAllGlobals())

it('allows unavailable account feedback and its full retry action to wrap in a narrow content area', async () => {
  vi.stubGlobal('innerWidth', 390)
  const retry = vi.fn()
  render(<>
    <style>{computerStyles}</style>
    <div style={{ width: 274 }}>
      <ComputerAccountChips accounts={null} onRetry={retry} onGitHub={() => {}} onDrive={() => {}} />
    </div>
  </>)
  const group = screen.getByRole('group', { name: 'Accounts' })
  const feedback = within(group).getByText('Account state unavailable').parentElement!
  const groupStyle = getComputedStyle(group)
  const feedbackStyle = getComputedStyle(feedback)
  // jsdom resolves CSS but does not measure layout; verify wrapping and shrinking on the rendered elements.
  expect(groupStyle.flexShrink).toBe('1')
  expect(groupStyle.minWidth).toBe('0px')
  expect(groupStyle.maxWidth).toBe('100%')
  expect(feedbackStyle.flexWrap).toBe('wrap')
  expect(feedbackStyle.maxWidth).toBe('100%')
  const button = within(group).getByRole('button', { name: 'Retry accounts' })
  expect(button).toBeVisible()
  expect(getComputedStyle(button).flexShrink).toBe('0')
  await userEvent.click(button)
  expect(retry).toHaveBeenCalledOnce()
})
