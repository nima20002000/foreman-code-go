// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { AgentSettingsForm } from './AgentSettingsForm'
import { WorkflowExecutionLimits } from './WorkflowExecutionLimits'

vi.mock('../settings/HarnessConfigurationFields', () => ({ HarnessConfigurationFields: () => null }))
afterEach(cleanup)
describe('PR17 agent versus workflow scope', () => {
  it('keeps workflow limits out of the agent inspector and preserves the existing policy', async () => {
    const onSave = vi.fn()
    const policy = { maxNodeExecutions: 50, maxParallelism: 7 }
    render(<AgentSettingsForm agent={{ id: 'agent', name: 'Coder', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex }} executionPolicy={policy} onSave={onSave} onClose={() => {}} />)
    expect(screen.queryByLabelText('Maximum node executions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save agent settings' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(onSave.mock.calls[0]![2]).toEqual(policy)
    expect(screen.getByText(/use Save graph to persist/)).toBeInTheDocument()
  })
  it('allows a name validation attempt and focuses its explained error', async () => {
    const onSave = vi.fn()
    render(<AgentSettingsForm agent={{ id: 'agent', name: 'Coder', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex }} onSave={onSave} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus())
    expect(screen.getByText('Enter an agent name.')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })
  it('rejects blank, fractional and out-of-range workflow limits before applying', async () => {
    const onApply = vi.fn()
    render(<WorkflowExecutionLimits value={{ maxNodeExecutions: 3, maxParallelism: 1 }} nodeCount={4} onApply={onApply} />)
    const user = userEvent.setup()
    const nodes = screen.getByLabelText('Maximum node executions')
    expect(nodes).toHaveAttribute('aria-invalid', 'true')
    await user.click(screen.getByRole('button', { name: 'Apply workflow limits to draft' }))
    await waitFor(() => expect(nodes).toHaveFocus())
    for (const value of ['', '4.5', '10001']) {
      fireEvent.change(nodes, { target: { value } })
      await user.click(screen.getByRole('button', { name: 'Apply workflow limits to draft' }))
    }
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.change(nodes, { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Maximum parallel agents'), { target: { value: '101' } })
    await user.click(screen.getByRole('button', { name: 'Apply workflow limits to draft' }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Maximum parallel agents'), { target: { value: '2' } })
    await user.click(screen.getByRole('button', { name: 'Apply workflow limits to draft' }))
    expect(onApply).toHaveBeenCalledOnce()
    expect(onApply).toHaveBeenCalledWith({ maxNodeExecutions: 4, maxParallelism: 2 })
    expect(screen.getByRole('status')).toHaveTextContent('Use Save graph to persist')
  })
})
