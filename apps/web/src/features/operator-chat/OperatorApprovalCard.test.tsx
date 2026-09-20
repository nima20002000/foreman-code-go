// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PendingNativeInteraction } from '@graphql/contracts'
import { OperatorApprovalCard } from './OperatorApprovalCard'

const option = (optionId: string, semantic: PendingNativeInteraction['responseOptions'][number]['semantic'], label: string, persistence: PendingNativeInteraction['responseOptions'][number]['persistence']) => ({
  optionId, semantic, label, persistence, affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: persistence === 'persistent_config',
})
const interaction: PendingNativeInteraction = {
  session: { harness: 'codex', providerVersion: 'test', nativeSessionId: 'session' },
  turn: { nativeTurnId: 'turn', nativeRequestId: 'request' },
  nativeRequestType: 'mcpServer/elicitation/request',
  request: { mode: 'form', message: 'Allow Browser use to access http://127.0.0.1:5173?', serverName: 'cua_repl',
    _meta: { origin: 'http://127.0.0.1:5173', connector_name: 'Browser use', tool_name: 'access_browser_origin', tool_title: 'Access browser origin',
      tool_params: { origin: 'http://127.0.0.1:5173' }, codex_approval_kind: 'mcp_tool_call' } },
  responseOptions: [option('once', 'approve_once', 'Accept', 'request'), option('always', 'persistent_policy_change', "Allow and don't ask me again", 'persistent_config'),
    option('reject', 'reject', 'Decline', 'request'), option('cancel', 'cancel', 'Cancel request', 'request')],
}

describe('Operator approval card', () => {
  it('shows the destination and native decisions without raw provider JSON', async () => {
    const onSelect = vi.fn()
    render(<OperatorApprovalCard interaction={interaction} disabled={false} onSelect={onSelect} />)
    const card = screen.getByLabelText('Operator approval request')
    expect(within(card).getByText('Access browser origin?')).toBeVisible()
    expect(within(card).getByText('MCP tool · Browser use')).toBeVisible()
    expect(within(card).getByText('http://127.0.0.1:5173', { selector: '.operator-approval-target strong' })).toBeVisible()
    expect(within(card).queryByText('Cancel request')).not.toBeInTheDocument()
    expect(within(card).queryByText(/callId/)).not.toBeInTheDocument()
    expect(within(card).getByText('Request details').closest('details')).not.toHaveAttribute('open')
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Allow once' }))
    expect(onSelect).toHaveBeenCalledWith('once')
    await userEvent.setup().click(within(card).getByRole('button', { name: "Allow and don't ask me again" }))
    expect(onSelect).toHaveBeenCalledWith('always')
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Decline' }))
    expect(onSelect).toHaveBeenCalledWith('reject')
    await userEvent.setup().click(within(card).getByText('Request details'))
    expect(within(card).getByText('MCP tool call through the connected provider')).toBeVisible()
    expect(within(card).getByText('Changes persistent native policy for future requests.')).toBeVisible()
  })
})
