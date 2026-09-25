import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { RepeatDecisionV1Schema, RepeatOccurrenceV1Schema, type RepeatOccurrenceV1 } from '@graphql/contracts/wave25'
import { describe, expect, it, vi } from 'vitest'
import { RepeatStatus } from './RepeatStatus'
import type { RepeatClient, RepeatRunScope } from './client'

const scope: RepeatRunScope = {
  workspaceId: 'ws-status', workflowId: 'wf-status', runId: 'run-status', workflowVersionId: 'wv-status', executionSemanticsVersion: 3,
}

function occurrence(index = 1): RepeatOccurrenceV1 {
  return RepeatOccurrenceV1Schema.parse({
    contractVersion: 1,
    identity: { scope, blockId: 'review-fix', occurrenceId: `occ-${index}`, occurrenceIndex: index },
    input: { bindingId: `binding-${index}`, inputDigest: `sha256:${'1'.repeat(64)}`, previous: index === 1 ? null : {
      occurrenceId: `occ-${index - 1}`, occurrenceIndex: index - 1, decisionId: `decision-${index - 1}`, acceptedResultDigest: `sha256:${'2'.repeat(64)}`,
    } },
  })
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function bareClient(run: RepeatClient['run']): RepeatClient {
  return { capabilities: vi.fn(), workflowMeta: vi.fn(), workspaceMeta: vi.fn(), get: vi.fn(), mutate: vi.fn(), run } as unknown as RepeatClient
}

describe('RepeatStatus', () => {
  it('keeps the exit technical attempt separate from the business occurrence number', async () => {
    const first = occurrence()
    const decision = RepeatDecisionV1Schema.parse({
      contractVersion: 1, decisionId: 'decision-1', occurrence: first,
      exitExecution: { workflowNodeId: 'exit', executionId: 'exec-1', agentId: 'agent-1', agentConfigurationVersionId: 'cfg-1', attempt: 3, occurrence: first.identity },
      acceptedResultDigest: `sha256:${'3'.repeat(64)}`, outcome: 'pass', reason: 'early_exit', target: { kind: 'branch_end' },
      resultData: { latestDeliverable: { text: 'ready' }, remainingFindings: [] }, decidedAt: '2026-09-25T00:00:00.000Z',
    })
    const client = bareClient(vi.fn().mockResolvedValue({ contractVersion: 1, executionSemanticsVersion: 3,
      workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
      items: [{ occurrence: first, decision }], pageInfo: { nextCursor: null } }))
    render(wrap(<RepeatStatus scope={scope} client={client} />))
    expect(await screen.findByText('review-fix · business occurrence 1')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('(same business occurrence)')).toBeInTheDocument()
  })

  it('shows exact limit outcome and remaining findings from durable decision detail', async () => {
    const first = occurrence()
    const decision = RepeatDecisionV1Schema.parse({
      contractVersion: 1, decisionId: 'decision-1', occurrence: first,
      exitExecution: { workflowNodeId: 'exit', executionId: 'exec-1', agentId: 'agent-1', agentConfigurationVersionId: 'cfg-1', attempt: 1, occurrence: first.identity },
      acceptedResultDigest: `sha256:${'4'.repeat(64)}`, outcome: 'issues', reason: 'limit_exit', target: { kind: 'branch_end' },
      resultData: { latestDeliverable: { summary: 'best available' }, remainingFindings: [{ text: 'one issue remains' }] },
      decidedAt: '2026-09-25T00:00:00.000Z',
    })
    const client = bareClient(vi.fn().mockResolvedValue({ contractVersion: 1, executionSemanticsVersion: 3,
      workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
      items: [{ occurrence: first, decision }], pageInfo: { nextCursor: null } }))
    render(wrap(<RepeatStatus scope={scope} live={false} client={client} />))
    expect(await screen.findByText('Limit exit')).toBeInTheDocument()
    expect(screen.getByText('{"summary":"best available"}')).toBeInTheDocument()
    expect(screen.getByText('{"text":"one issue remains"}')).toBeInTheDocument()
    expect(screen.getByText('Historical Run')).toBeInTheDocument()
  })

  it('does not turn a repeat decision into a claim that the successor is running', async () => {
    const first = occurrence()
    const decision = RepeatDecisionV1Schema.parse({
      contractVersion: 1, decisionId: 'decision-1', occurrence: first,
      exitExecution: { workflowNodeId: 'exit', executionId: 'exec-1', agentId: 'agent-1', agentConfigurationVersionId: 'cfg-1', attempt: 1, occurrence: first.identity },
      acceptedResultDigest: `sha256:${'5'.repeat(64)}`, outcome: 'issues', reason: 'repeat',
      target: { kind: 'next_occurrence', entryNodeId: 'entry', occurrenceIndex: 2 },
      resultData: { latestDeliverable: 'draft', remainingFindings: [] }, decidedAt: '2026-09-25T00:00:00.000Z',
    })
    const client = bareClient(vi.fn().mockResolvedValue({ contractVersion: 1, executionSemanticsVersion: 3,
      workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
      items: [{ occurrence: first, decision }], pageInfo: { nextCursor: null } }))
    render(wrap(<RepeatStatus scope={scope} client={client} />))
    expect(await screen.findByText(/Requested occurrence 2\. It is not shown as running until its own durable occurrence\/execution facts exist/)).toBeInTheDocument()
  })
})
