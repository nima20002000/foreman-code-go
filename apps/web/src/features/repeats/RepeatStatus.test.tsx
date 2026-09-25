import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { RepeatOccurrenceV1Schema, type RepeatOccurrenceV1 } from '@graphql/contracts/wave25'
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

describe('RepeatStatus', () => {
  it('keeps technical attempts separate from business occurrence numbers', async () => {
    const client: RepeatClient = {
      authoring: vi.fn(), save: vi.fn(), run: vi.fn().mockResolvedValue({ headRevision: 7, complete: false, occurrences: [
        { occurrence: occurrence(), status: 'running', technicalAttempt: 3 },
      ] }),
    }
    render(wrap(<RepeatStatus scope={scope} client={client} />))
    expect(await screen.findByText('review-fix · occurrence 1')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('(same business occurrence)')).toBeInTheDocument()
  })

  it('does not turn a repeat decision into a claim that the successor is running', async () => {
    const first = occurrence()
    const client: RepeatClient = {
      authoring: vi.fn(), save: vi.fn(), run: vi.fn().mockResolvedValue({ headRevision: 8, complete: false, occurrences: [{
        occurrence: first, status: 'succeeded', decision: {
          contractVersion: 1, decisionId: 'decision-1', occurrence: first,
          exitExecution: { workflowNodeId: 'exit', executionId: 'exec-1', agentId: 'agent-1', agentConfigurationVersionId: 'cfg-1', attempt: 1, occurrence: first.identity },
          acceptedResultDigest: `sha256:${'3'.repeat(64)}`, outcome: 'issues', reason: 'repeat',
          target: { kind: 'next_occurrence', entryNodeId: 'entry', occurrenceIndex: 2 }, decidedAt: '2026-09-25T00:00:00.000Z',
        },
      }] }),
    }
    render(wrap(<RepeatStatus scope={scope} client={client} />))
    expect(await screen.findByText(/Requested occurrence 2; running state requires its own durable occurrence\/execution fact/)).toBeInTheDocument()
  })
})
