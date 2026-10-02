import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { BoardAlerts } from './BoardAlerts'
import { useInspectionPresentation } from './inspect/presentation'

afterEach(() => { cleanup(); useInspectionPresentation.setState({ open: {} }); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const hint = { code: 'ENTRY_REQUIRED', message: 'Choose the worker that starts the workflow.' }
const props = { scope: 'owned-board', hints: [hint], validation: undefined, pending: false, openIssue: vi.fn(), openField: vi.fn() }

it('counts each source finding once and displays warning/error rows with actionable paths', async () => {
  const openField = vi.fn()
  render(<BoardAlerts {...props} openField={openField} validation={{ revision: 1, valid: false, issues: [hint] }}
    error={new ApiError({ code: 'INVALID_GRAPH', message: 'Check settings.', details: { issues: [
      { code: 'LIMIT', message: 'Enter a positive execution limit.', path: ['executionPolicy', 'maxParallelism'] },
      { code: 'LIMIT', message: 'Enter a positive execution limit.', path: ['executionPolicy', 'maxNodeExecutions'] },
    ] } }, 422)} />)
  await userEvent.click(screen.getByRole('button', { name: 'Workflow alerts, 3' }))
  const dialog = screen.getByRole('dialog', { name: 'Workflow alerts' })
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(3)
  expect(within(dialog).getByText('Warning:')).toBeInTheDocument()
  expect(within(dialog).getAllByText('Error:')).toHaveLength(2)
  await userEvent.click(within(dialog).getAllByRole('button', { name: 'Review setting' })[1]!)
  expect(openField).toHaveBeenCalledWith(['executionPolicy', 'maxParallelism'])
  expect(screen.queryByRole('dialog', { name: 'Workflow alerts' })).not.toBeInTheDocument()
})

it('uses live source items, keeps inside drags open, dismisses on backdrop/Escape and restores focus', async () => {
  const view = render(<BoardAlerts {...props} />)
  const trigger = screen.getByRole('button', { name: 'Workflow alerts, 1' })
  await userEvent.click(trigger)
  view.rerender(<BoardAlerts {...props} hints={[{ ...hint, message: 'Choose another starting worker.' }]} />)
  expect(screen.getByRole('button', { name: 'Workflow alerts, 1' })).toBe(trigger)
  expect(screen.getByText('Choose another starting worker.')).toBeVisible()
  const dialog = screen.getByRole('dialog', { name: 'Workflow alerts' })
  fireEvent.pointerDown(screen.getByText('Choose another starting worker.'))
  fireEvent.click(dialog)
  expect(dialog).toBeVisible()
  await userEvent.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  await userEvent.click(trigger)
  const reopened = screen.getByRole('dialog', { name: 'Workflow alerts' })
  fireEvent.pointerDown(reopened); fireEvent.click(reopened)
  expect(screen.queryByRole('dialog', { name: 'Workflow alerts' })).not.toBeInTheDocument()
})

it('does not show an empty alert control or pending/success status without an actual finding', () => {
  render(<BoardAlerts {...props} hints={[]} pending validation={{ revision: 1, valid: true, issues: [] }} />)
  expect(screen.queryByRole('button', { name: /Workflow alerts/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Workflow alerts' })).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('closes and removes resolved alerts, without reopening the popover when a new finding appears', async () => {
  const view = render(<BoardAlerts {...props} />)
  await userEvent.click(screen.getByRole('button', { name: 'Workflow alerts, 1' }))
  view.rerender(<BoardAlerts {...props} hints={[]} />)
  expect(screen.queryByRole('button', { name: /Workflow alerts/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Workflow alerts' })).not.toBeInTheDocument()
  expect(useInspectionPresentation.getState().open['board-alerts:owned-board']).toBeFalsy()
  view.rerender(<BoardAlerts {...props} />)
  expect(screen.getByRole('button', { name: 'Workflow alerts, 1' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('dialog', { name: 'Workflow alerts' })).not.toBeInTheDocument()
})

it('shows an error even when local hints and validation contain no warnings', async () => {
  render(<BoardAlerts {...props} hints={[]} error={new Error('The workflow could not be saved.')} />)
  await userEvent.click(screen.getByRole('button', { name: 'Workflow alerts, 1' }))
  const dialog = screen.getByRole('dialog', { name: 'Workflow alerts' })
  expect(within(dialog).getByRole('listitem')).toHaveAttribute('data-tone', 'danger')
  expect(within(dialog).getByText('The workflow could not be saved.')).toBeVisible()
})

it('retains the modal and shows check status while Save is pending', async () => {
  render(<BoardAlerts {...props} pending />)
  await userEvent.click(screen.getByRole('button', { name: 'Workflow alerts, 1' }))
  expect(screen.getByText('Checking the submitted workflow…')).toBeVisible()
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: 'Workflow alerts' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Close workflow alerts' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Review setting' })).toBeDisabled()
})

it('opens above its bottom-left trigger and clamps the shared dialog inside a resized viewport', async () => {
  vi.stubGlobal('innerWidth', 1024); vi.stubGlobal('innerHeight', 768)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const dialog = this instanceof HTMLDialogElement
    const width = dialog ? Math.min(360, window.innerWidth - 24) : 50
    const left = dialog ? 0 : 16, top = dialog ? 0 : window.innerHeight - 52, height = dialog ? 180 : 36
    return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) }
  })
  render(<BoardAlerts {...props} />)
  await userEvent.click(screen.getByRole('button', { name: 'Workflow alerts, 1' }))
  const dialog = screen.getByRole('dialog', { name: 'Workflow alerts' })
  expect(dialog.style.left).toBe('12px'); expect(dialog.style.top).toBe('528px')
  vi.stubGlobal('innerWidth', 320)
  vi.stubGlobal('innerHeight', 240)
  fireEvent(window, new Event('resize'))
  expect(dialog.style.left).toBe('12px'); expect(dialog.style.top).toBe('12px')
  expect(dialog.style.maxHeight).toBe('216px')
})
