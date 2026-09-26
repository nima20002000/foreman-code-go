import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GetInteractionResponseSchema, ListInteractionsResponseSchema, RespondToInteractionResponseSchema } from '@graphql/contracts'
import { ManagedInteractionPageSchema } from '@graphql/contracts/management'
import { RepeatGraphSnapshotV3Schema, RunExecutionsPageSchema, RunRecordDetailSchema } from '@graphql/contracts/wave25'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { scenarioFixture, scenarioIds } from './helpers/eng07BScenarios.js'
import { runPath, scenarioHarness, type Harness, type Started } from './helpers/eng07BHarness.js'
import { assertScenarioEvidence } from './helpers/eng07BEvidence.js'

afterEach(() => vi.restoreAllMocks())

async function approveThroughHttp(f: Harness, started: Started) {
  const { workspaceId, workflowId, runId } = started.scope
  const user = await f.base.access.issue({ name: 'ENG07 human approver', audience: 'user',
    expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['interactions:read', 'interactions:respond'],
      scope: { workspaceIds: [workspaceId], workflowIds: [workflowId], runIds: [runId] } }] })
  // All three constrained grant dimensions must be present on the list request.
  // Keep the original underspecified request as a denial regression; do not
  // broaden the human's grant to make a run-only list succeed.
  const underspecified = await f.rawHttp('GET', `/api/user/interactions?runId=${encodeURIComponent(runId)}&limit=10`, undefined, user.token)
  expect(underspecified.status).toBe(403)
  expect(underspecified.body).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  const query = new URLSearchParams({ workspaceId, workflowId, runId, limit: '10' })
  const list = () => f.http('GET', `/api/user/interactions?${query}`, undefined, user.token)
  await vi.waitFor(async () => {
    const page = ListInteractionsResponseSchema.parse(await list())
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ runId, status: 'pending' })
    const record = RunRecordDetailSchema.parse(await f.http('GET', `${runPath(started.scope)}/record`))
    expect(record.run.executionState).toBe('waiting')
  }, { timeout: 25000, interval: 50 })
  const page = ListInteractionsResponseSchema.parse(await list()), interaction = page.items[0]!
  const monitoring = ManagedInteractionPageSchema.parse(await f.mcp('interaction_list', { workspaceId, workflowId, runId, limit: 10 }))
  expect(monitoring.items).toEqual(page.items)
  expect(f.base.provider.startedNodes).toEqual(f.scenario.nodes.slice(0, 2).map((node) => node.id))
  const current = RepeatGraphSnapshotV3Schema.parse(await f.graph(started.scope, 'snapshot'))
  expect(current.state.run.pendingInteractionCount).toBe(1)
  expect(current.state.occurrences).toEqual([]); expect(current.state.decisions).toEqual([])
  const detail = GetInteractionResponseSchema.parse(await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, user.token))
  expect(detail.canRespond).toBe(true); expect(detail.interaction).toEqual(interaction)
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  expect(option).toBeDefined()
  const input = { interactionId: interaction.id, expectedRevision: interaction.revision,
    optionId: option!.optionId }
  const path = `/api/user/interactions/${interaction.id}/respond`
  // Operator MCP is read-only monitoring of a human-handled interaction.
  const tools = await f.client.listTools()
  expect(tools.tools.map((tool) => tool.name)).not.toContain('interaction_respond')
  const denied = await f.rawHttp('POST', path, input)
  expect(denied.status).toBe(403)
  expect(denied.body).toMatchObject({ error: { code: 'AUTH_WRONG_AUDIENCE' } })
  expect(f.base.provider.counts.responses).toBe(0)
  const decision = RespondToInteractionResponseSchema.parse(await f.http('POST', path, input, user.token))
  expect(decision.interaction).toMatchObject({ id: interaction.id, runId, deliveryState: 'delivered' })
  const replay = RespondToInteractionResponseSchema.parse(await f.http('POST', path, input, user.token))
  expect(replay.interaction.id).toBe(interaction.id)
  expect(replay.interaction.deliveryState).toBe('delivered')
  expect(f.base.provider.counts.responses).toBe(1)
  await f.settled(started.scope)
  const final = GetInteractionResponseSchema.parse(await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, user.token))
  expect(final.interaction).toMatchObject({ id: interaction.id, deliveryState: 'delivered' })
  const finalMonitor = ManagedInteractionPageSchema.parse(await f.mcp('interaction_list', { workspaceId, workflowId, runId, limit: 10 }))
  expect(finalMonitor.items).toEqual(ListInteractionsResponseSchema.parse(await list()).items)
}

describe.skipIf(!postgresEnabled)('ENG07-B S3-01..05 / real PostgreSQL + HTTP + authenticated Operator MCP', () => {
  describe.each(['http', 'mcp'] as const)('%s admission with cross-transport replay', (via) => {
    it.each(scenarioIds)('%s preserves exact routing, history, input/result and graph evidence', async (id) => {
      const scenario = scenarioFixture(id, randomUUID()), f = await scenarioHarness(scenario)
      try {
        const { saved } = await f.save(via)
        const releaseEntry = f.hold(scenario.nodes[0]!.id)
        const releaseSlow = scenario.slowNodeId ? f.hold(scenario.slowNodeId) : undefined
        const releaseFast = scenario.joinNodeId ? f.hold(scenario.nodes[1]!.id) : undefined
        const releaseRouter = id === 'S3-03' ? f.hold(scenario.nodes[2]!.id) : undefined
        const started = await f.start(via, saved)
        await f.waitUntilParked(started.scope, scenario.nodes[0]!.id)
        const initial = RepeatGraphSnapshotV3Schema.parse(await f.graph(started.scope, 'snapshot'))
        expect(initial.state.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
        expect(f.base.provider.counts.starts).toBe(1)
        releaseEntry()
        if (releaseSlow) {
          // Rendezvous at the fork before either sibling may complete. Holding
          // only the slow branch would incorrectly let a serial engine pass.
          await vi.waitFor(() => {
            expect(f.parked.has(scenario.nodes[1]!.id)).toBe(true)
            expect(f.parked.has(scenario.nodes[2]!.id)).toBe(true)
          }, { timeout: 25000 })
          for (const node of scenario.nodes.slice(1, 3)) expect(f.trace.some((event) =>
            event.nodeId === node.id && event.phase === 'completed')).toBe(false)
          releaseFast!(); releaseRouter?.()
          await vi.waitFor(async () => {
            expect(f.parked.has(scenario.slowNodeId!)).toBe(true)
            const page = RunExecutionsPageSchema.parse(await f.http('GET', `${runPath(started.scope)}/executions?limit=100`))
            expect(page.items.find((item) => item.workflowNodeId === scenario.nodes[1]!.id))
              .toMatchObject({ state: 'completed', acceptedResultAvailable: true })
          }, { timeout: 25000, interval: 50 })
          // This gate proves overlapping branches, rather than merely observing
          // an eventually-successful diamond that may have run serially.
          expect(f.base.provider.startedNodes).toContain(scenario.nodes[1]!.id)
          expect(f.base.provider.startedNodes).toContain(scenario.slowNodeId!)
          expect(f.base.provider.startedNodes).not.toContain(scenario.joinNodeId!)
          if (id === 'S3-03') expect(f.base.provider.startedNodes).not.toContain(scenario.nodes[4]!.id)
          releaseSlow()
        }
        if (id === 'S3-04') await approveThroughHttp(f, started)
        await f.settled(started.scope)
        const view = await assertScenarioEvidence(f, started, initial)
        if (id === 'S3-04') expect(view.events.some((event) => event.fact.type === 'worker.resumed'
          && event.evidence.sourceKind === 'native_event')).toBe(true)
        const expectedNodes = Array.from({ length: scenario.occurrences }, () => scenario.executedIndexes
          .map((index) => scenario.nodes[index]!.id)).flat()
        expect([...f.base.provider.startedNodes].sort()).toEqual([...expectedNodes].sort())
        expect(new Set(f.base.provider.startedExecutions).size).toBe(expectedNodes.length)
        expect(f.base.provider.counts).toMatchObject({ sessions: expectedNodes.length, starts: expectedNodes.length,
          responses: id === 'S3-04' ? 1 : 0 })
        if (id === 'S3-01' || id === 'S3-04' || scenario.repeat) expect(f.base.provider.startedNodes).toEqual(expectedNodes)
        if (scenario.joinNodeId) {
          const join = f.trace.findIndex((event) => event.nodeId === scenario.joinNodeId && event.phase === 'started')
          for (const nodeId of [scenario.nodes[1]!.id, scenario.slowNodeId!]) {
            const done = f.trace.findIndex((event) => event.nodeId === nodeId && event.phase === 'completed')
            expect(done).toBeGreaterThanOrEqual(0); expect(join).toBeGreaterThan(done)
          }
        }
        if (id === 'S3-03') {
          const router = view.snapshot.state.resolutions.find((item) => item.ref.nodeId === scenario.nodes[2]!.id)!
          expect(router.value).toMatchObject({ resolution: 'succeeded', outcome: 'long',
            selectedRelationshipIds: [scenario.edges[2]!.id], unselectedRelationshipIds: [scenario.edges[3]!.id] })
          expect(view.snapshot.state.resolutions.find((item) => item.ref.nodeId === scenario.nodes[4]!.id)?.value)
            .toMatchObject({ resolution: 'skipped', selectedRelationshipIds: [], unselectedRelationshipIds: [scenario.edges[6]!.id] })
        }
      } finally { await f.close() }
    }, 90000)
  })
})
