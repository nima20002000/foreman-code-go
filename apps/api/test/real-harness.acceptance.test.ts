import { describe, expect, it } from 'vitest'
import {
  GetRunResponseSchema,
  WorkspaceDetailsResponseSchema,
  type GetRunResponse,
} from '@graphql/contracts'

import { buildApp } from '../src/app.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { LocalHarnessResolver } from '../src/modules/harnesses/resolver.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

const realHarnessesEnabled = process.env.RUN_REAL_HARNESS_TESTS === '1'

describe.skipIf(!realHarnessesEnabled)('real workflow acceptance', () => {
  it('runs Codex to OpenCode to Codex with durable handoffs through the product API', async () => {
    const database = createDatabase({ connectionString, maxConnections: 4, connectionTimeoutMs: 5000 })
    const checkpoints = createCheckpointStore(connectionString, 'langgraph')
    try {
      await database.migrate()
      await ensureAcceptanceSeed(database.pool)
      await checkpoints.setup()
      const workflows = new PostgresWorkflowRepository(database.pool)
      const runs = new PostgresRunRepository(database.pool, workflows)
      const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
      const settings = new PostgresSettingsRepository(database.pool)
      const engine = new LangGraphWorkflowEngine(
        runs,
        workflows,
        new LocalHarnessResolver('codex', 'opencode'),
        checkpoints.saver,
        '/tmp/graphql-harness-acceptance',
        300_000,
      )
      const app = buildApp({
        readiness: { database, checkpoints },
        product: { workflows, runs, workspaces, settings, engine },
      })

      const workspaceResponse = await app.inject({ method: 'GET', url: '/api/workspaces/workspace-1' })
      expect(workspaceResponse.statusCode).toBe(200)
      const workflow = WorkspaceDetailsResponseSchema.parse(workspaceResponse.json()).workflows[0]!
      const saveResponse = await app.inject({
        method: 'PUT',
        url: '/api/workspaces/workspace-1/graph',
        payload: { workspaceId: 'workspace-1', workflow },
      })
      expect(saveResponse.statusCode).toBe(200)
      const savedVersion = await workflows.getCurrentVersion('workspace-1', workflow.id)
      expect(savedVersion?.entryNodeId).toBe(workflow.nodes[0]!.id)

      const startResponse = await app.inject({
        method: 'POST',
        url: `/api/workspaces/workspace-1/workflows/${workflow.id}/runs`,
        payload: { workspaceId: 'workspace-1', workflowId: workflow.id, input: {} },
      })
      expect(startResponse.statusCode).toBe(202)
      const runId = startResponse.json().run.id as string
      const pinnedVersionId = startResponse.json().run.workflowVersionId as string
      const laterSave = await app.inject({
        method: 'PUT',
        url: '/api/workspaces/workspace-1/graph',
        payload: { workspaceId: 'workspace-1', workflow },
      })
      expect(laterSave.statusCode).toBe(200)
      expect((await workflows.getCurrentVersion('workspace-1', workflow.id))?.id).not.toBe(pinnedVersionId)

      let details: GetRunResponse | undefined
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/workspaces/workspace-1/runs/${runId}`,
        })
        expect(response.statusCode).toBe(200)
        details = GetRunResponseSchema.parse(response.json())
        if (details?.run.executionState === 'completed') break
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }

      expect(details?.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(details?.run.workflowVersionId).toBe(pinnedVersionId)
      expect(details?.executions).toHaveLength(3)
      const [first, second, third] = details?.executions ?? []
      expect([first?.agentId, second?.agentId, third?.agentId]).toEqual([
        'agent-researcher',
        'agent-developer',
        'agent-reviewer',
      ])
      expect(new Set([first?.nativeSessionId, second?.nativeSessionId, third?.nativeSessionId]).size).toBe(3)
      expect(second?.input).toEqual({
        previous: {
          predecessorNodeId: 'node-researcher',
          executionId: first?.id,
          result: first?.result?.output,
        },
      })
      expect(third?.input).toEqual({
        previous: {
          predecessorNodeId: 'node-developer',
          executionId: second?.id,
          result: second?.result?.output,
        },
      })
      expect(details?.run.result?.output).toEqual(third?.result?.output)
      expect(await checkpoints.saver.getTuple({
        configurable: { thread_id: runId },
      })).toBeDefined()
      await app.close()
    } finally {
      await Promise.allSettled([checkpoints.close(), database.close()])
    }
  }, 360_000)
})
