// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { OperatorAccessPicker } from './OperatorAccessPicker'

describe('Operator access picker', () => {
  it('shows Codex sandbox modes and clears incompatible writable settings', async () => {
    const onChange = vi.fn().mockResolvedValue(true)
    const value = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' as const,
      advanced: { ...DEFAULT_HARNESS_DEFAULTS.codex.advanced!, additionalWritableDirectories: ['/tmp/project'] } }
    render(<OperatorAccessPicker value={value} disabled={false} onChange={onChange} />)
    const user = userEvent.setup()
    await user.hover(screen.getByRole('button', { name: 'Operator access: Workspace write' }))
    expect(within(screen.getByRole('menu', { name: 'Operator access' })).getAllByRole('menuitem')).toHaveLength(2)
    await user.hover(screen.getByRole('menuitem', { name: 'Codex sandbox' }))
    await user.click(within(screen.getByRole('menu', { name: 'Codex sandbox' })).getByRole('menuitemradio', { name: 'Read only' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'read-only',
      advanced: expect.objectContaining({ additionalWritableDirectories: [] }) }))
  })

  it('requires an explicit confirmation before removing Codex sandbox limits', async () => {
    const onChange = vi.fn().mockResolvedValue(true)
    render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.codex} disabled={false} onChange={onChange} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Operator access: Read only' }))
    await user.hover(screen.getByRole('menuitem', { name: 'Codex sandbox' }))
    await user.click(within(screen.getByRole('menu', { name: 'Codex sandbox' })).getByRole('menuitemradio', { name: 'Full access' }))
    expect(onChange).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'Type “full access” to confirm' }), 'full access')
    await user.click(screen.getByRole('button', { name: 'Use full access' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'danger-full-access' }))
  })

  it('keeps Codex sandbox and approval policy as separate saved settings', async () => {
    const onChange = vi.fn().mockResolvedValue(true)
    render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.codex} disabled={false} onChange={onChange} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Operator access: Read only' }))
    await user.hover(screen.getByRole('menuitem', { name: 'Approval requests' }))
    await user.click(within(screen.getByRole('menu', { name: 'Approval requests' })).getByRole('menuitemradio', { name: 'Never request escalation' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'read-only',
      advanced: expect.objectContaining({ approvalPolicy: 'never' }) }))
  })

  it('opens the Codex submenu with the keyboard and returns to its row on Escape', async () => {
    render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.codex} disabled={false} onChange={vi.fn().mockResolvedValue(true)} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Operator access: Read only' }))
    const row = screen.getByRole('menuitem', { name: 'Codex sandbox' })
    row.focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Read only' })).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(row).toHaveFocus()
    expect(screen.queryByRole('menu', { name: 'Codex sandbox' })).not.toBeInTheDocument()
  })

  it('edits ordered OpenCode permission rules without calling them a sandbox', async () => {
    const onChange = vi.fn().mockResolvedValue(true)
    render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.opencode} disabled={false} onChange={onChange} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Operator access: 0 OpenCode rules' }))
    expect(screen.getByText(/They are not a filesystem sandbox/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Action 1' }), 'deny')
    await user.click(screen.getByRole('button', { name: 'Save access rules' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ advanced: expect.objectContaining({
      permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' }],
    }) }))
  })
})
