import type { DurableInteraction } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect } from 'vitest'
import type { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { approvalResponse } from './eng06ApprovalFaults.js'

export async function respondWaitingApproval(
  fixture: Awaited<ReturnType<typeof currentOperatorIntegration>>,
  pending: DurableInteraction,
  transport: 'http' | 'mcp',
): Promise<void> {
  const input = approvalResponse(pending)
  if (transport === 'http') {
    const { interactionId, optionId, expectedRevision } = input
    const response = await fixture.app.inject({ method: 'POST',
      url: `/api/management/interactions/${pending.id}/respond`,
      headers: { authorization: `Bearer ${fixture.writer.token}` },
      payload: { interactionId, optionId, expectedRevision } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ interaction: { deliveryState: 'delivered' } })
    return
  }
  const response = await fixture.client.callTool({ name: 'interaction_respond', arguments: input })
  expect(response.isError).not.toBe(true)
  expect(decodeMcpToolResult(response)).toMatchObject({ interaction: { deliveryState: 'delivered' } })
}
