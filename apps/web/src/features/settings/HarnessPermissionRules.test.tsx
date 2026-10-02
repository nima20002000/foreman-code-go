import { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type OpenCodeAdvancedConfiguration } from '@graphql/contracts'
import { HarnessSectionFields } from './HarnessSectionFields'
import { HarnessPermissionRules } from './HarnessPermissionRules'
import { createHarnessEditor, prepareHarnessEditor } from './harnessEditor'

type Rules = OpenCodeAdvancedConfiguration['permissionRules']
const rules: Rules = [
  { permission: 'shell', pattern: '*', effect: 'deny' },
  { permission: 'shell', pattern: 'git *', effect: 'ask' },
  { permission: 'custom_tool', pattern: ' /tmp/** literal? ', effect: 'allow' },
]

afterEach(cleanup)

function Editor({ onSave = vi.fn(), disabled = false }: { onSave?(value: ReturnType<typeof prepareHarnessEditor>): void; disabled?: boolean }) {
  const initial = createHarnessEditor({ ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!, permissionRules: structuredClone(rules) } })
  const [editor, setEditor] = useState(initial)
  return <form onSubmit={event => { event.preventDefault(); onSave(prepareHarnessEditor(editor)) }}>
    <fieldset disabled={disabled}>
      <HarnessSectionFields editor={editor} onChange={setEditor} section="permissions" />
      <button type="submit">Save</button>
      <button type="button" onClick={() => setEditor(initial)}>Discard</button>
    </fieldset>
  </form>
}

describe('OpenCode permission editor', () => {
  it('saves custom permissions, wildcard patterns and ordered decisions exactly', async () => {
    const saved = vi.fn()
    render(<Editor onSave={saved} />)
    const user = userEvent.setup()
    expect(screen.getByLabelText('Permission 3')).toHaveValue('custom_tool')
    expect(screen.getByLabelText('Pattern 3')).toHaveValue(' /tmp/** literal? ')
    await user.clear(screen.getByLabelText('Pattern 2'))
    await user.type(screen.getByLabelText('Pattern 2'), 'git diff *')
    await user.selectOptions(screen.getByLabelText('Decision 2'), 'deny')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved).toHaveBeenCalledOnce()
    expect(saved.mock.calls[0]![0].advanced.permissionRules).toEqual([rules[0], { ...rules[1], pattern: 'git diff *', effect: 'deny' }, rules[2]])
    expect(saved.mock.calls[0]![0].autoApprove).toBe(false)
  })

  it('changes priority only through explicit keyboard reorder and retains row identity', async () => {
    const saved = vi.fn()
    render(<Editor onSave={saved} />)
    const user = userEvent.setup()
    const specific = screen.getByLabelText('Pattern 2')
    const move = screen.getByRole('button', { name: 'Move permission rule 2 down' })
    expect(move).toHaveAttribute('title', expect.stringContaining('higher priority'))
    move.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByLabelText('Permission 3')).toHaveFocus())
    expect(screen.getByLabelText('Pattern 3')).toBe(specific)
    expect(screen.getByRole('button', { name: 'Move permission rule 3 down' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move permission rule 1 up' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Rule moved to position 3. Later matching rules take priority.')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved.mock.calls[0]![0].advanced.permissionRules).toEqual([rules[0], rules[2], rules[1]])
  })

  it('keeps removal as a draft and restores exact rules on Discard', async () => {
    const saved = vi.fn()
    render(<Editor onSave={saved} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove permission rule 2' }))
    expect(screen.queryByLabelText('Pattern 3')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Pattern 2')).toHaveValue(rules[2]!.pattern)
    expect(saved).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    const permissions = screen.getAllByRole('textbox', { name: /^Permission \d+$/ })
    expect(new Set(permissions.map(field => field.id)).size).toBe(3)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved.mock.calls[0]![0].advanced.permissionRules).toEqual(rules)
  })

  it('adds an Ask rule without altering existing patterns or granting Allow', async () => {
    const saved = vi.fn()
    render(<Editor onSave={saved} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add custom rule' }))
    await waitFor(() => expect(screen.getByLabelText('Permission 4')).toHaveFocus())
    expect(screen.getByLabelText('Decision 4')).toHaveValue('ask')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved.mock.calls[0]![0].advanced.permissionRules).toEqual([...rules, { permission: 'shell', pattern: '*', effect: 'ask' }])
  })

  it('shows native empty-state and permission semantics without replacing configured rules', async () => {
    render(<HarnessPermissionRules value={[]} onChange={vi.fn()} issues={[]} />)
    expect(screen.getByText('Native rules apply')).toBeVisible()
    expect(screen.getByText('Last matching rule wins.')).toBeVisible()
    const user = userEvent.setup()
    await user.click(screen.getByText('How rules work'))
    expect(screen.getByText(/not an operating-system sandbox/)).toBeVisible()
  })

  it('keeps saved native-auto visible but unavailable for new selections', () => {
    const editor = createHarnessEditor({ ...DEFAULT_HARNESS_DEFAULTS.opencode, autoApprove: true,
      advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!, permissionHandling: 'native_auto', permissionRules: rules } })
    const change = vi.fn()
    render(<HarnessSectionFields editor={editor} onChange={change} section="permissions" />)
    const handling = screen.getByRole('combobox', { name: 'Permission handling' })
    expect(handling).toHaveValue('native_auto')
    expect(within(handling).getByRole('option', { name: 'Native automatic handling (unavailable)' })).toBeDisabled()
    expect(change).not.toHaveBeenCalled()
  })

  it('keeps validation associated with permission, pattern and decision', () => {
    render(<HarnessPermissionRules value={[{ permission: '', pattern: '', effect: 'ask' }]} onChange={vi.fn()}
      issues={(['permission', 'pattern', 'effect'] as const).map(field => ({ path: ['advanced', 'permissionRules', 0, field], message: `Invalid ${field}` }))} />)
    for (const [label, field] of [['Permission 1', 'permission'], ['Pattern 1', 'pattern'], ['Decision 1', 'effect']] as const) {
      const control = screen.getByLabelText(label)
      expect(control).toHaveAttribute('aria-invalid', 'true')
      expect(control).toHaveAccessibleDescription(`Invalid ${field}`)
    }
  })

  it('honors an enclosing read-only or pending lock for every editing action', async () => {
    const saved = vi.fn()
    render(<Editor disabled onSave={saved} />)
    const user = userEvent.setup()
    for (const control of [...screen.getAllByRole('textbox'), ...screen.getAllByRole('combobox'), ...screen.getAllByRole('button')]) expect(control).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add custom rule' }))
    await user.click(screen.getByRole('button', { name: 'Remove permission rule 2' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByLabelText('Pattern 2')).toHaveValue('git *')
    expect(saved).not.toHaveBeenCalled()
  })
})
