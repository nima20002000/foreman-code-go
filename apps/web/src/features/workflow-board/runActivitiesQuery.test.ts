// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RepeatGraphScopeV3, RunActivityPublic } from '@graphql/contracts/wave25'
import { server } from '../../mocks/server'
import { mergeRunActivities, readRunActivities, readRunActivityFeed } from './runActivitiesQuery'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a',
  workflowVersionId: 'version-a', runId: 'run-a', executionSemanticsVersion: 3 }
const item = (sequence: string): RunActivityPublic => ({ id: `run-a:${sequence}`, scope,
  sequence, occurredAt: '2026-09-28T00:00:00.000Z', source: 'backend', kind: 'work_notice',
  status: 'delivered', severity: 'info', summary: 'Notice delivered', refs: {} })

describe('bounded public Run Activities client', () => {
  it('coalesces overlap, sorts out-of-order arrivals by full server sequence, and bounds memory', () => {
    const high = '9007199254740994', low = '9007199254740993'
    expect(mergeRunActivities([item(high)], [item(low), item(high)]).map((event) => event.sequence)).toEqual([low, high])
    expect(mergeRunActivities(Array.from({ length: 1000 }, (_, i) => item(String(i + 1))), [item('1001')]))
      .toHaveLength(1000)
    expect(() => mergeRunActivities([item('1')], [{ ...item('1'), id: 'changed-identity' }])).toThrow(/identity/)
  })

  it('rejects a same-user response for another Run before it reaches the Board', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () =>
      HttpResponse.json({ scope: { ...scope, runId: 'run-b' }, items: [], mode: 'initial',
        highWater: '0', retainedFrom: '0', nextCursor: 'cursor', olderCursor: null, hasMore: false })))
    await expect(readRunActivities(scope)).rejects.toThrow(/different Run/)
  })
  it('catches up through overlapping newer pages before exposing the next feed', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      const sequences = cursor === 'cursor-1' ? ['2', '3'] : ['3', '4']
      return HttpResponse.json({ scope, items: sequences.map(item), mode: 'newer',
        highWater: '4', retainedFrom: '1', nextCursor: cursor === 'cursor-1' ? 'cursor-2' : 'cursor-4',
        olderCursor: null, hasMore: cursor === 'cursor-1' })
    }))
    const feed = await readRunActivityFeed(scope, { items: [item('1')], olderCursor: null,
      nextCursor: 'cursor-1', retainedFrom: '1' })
    expect(feed.items.map((event) => event.sequence)).toEqual(['1', '2', '3', '4'])
    expect(feed.nextCursor).toBe('cursor-4')
  })
})
it('rejects a cross-Run projection even if the outer page has the selected authorized scope', async () => {
  server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () => HttpResponse.json({
    scope, items: [], mode: 'initial', highWater: '0', retainedFrom: '0', nextCursor: 'cursor', olderCursor: null, hasMore: false,
    activitySnapshot: { schemaVersion: 1, revision: '1', scope: { kind: 'workflow_run', workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: 'other-run', workflowVersionId: scope.workflowVersionId },
      active: [], queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } },
  })))
  await expect(readRunActivities(scope)).rejects.toThrow(/another Run/)
})
