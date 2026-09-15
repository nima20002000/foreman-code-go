import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSchema,
  GetRunResponseSchema,
  WorkflowDefinitionSchema,
  WorkspaceSchema,
  type GetRunResponse,
} from '@graphql/contracts'

import { buildApp } from '../src/app.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { LocalHarnessResolver } from '../src/modules/harnesses/resolver.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

const realHarnessesEnabled = process.env.RUN_REAL_HARNESS_TESTS === '1'

describe.skipIf(!realHarnessesEnabled)('real workflow acceptance', () => {
  it('runs Codex to OpenCode to Codex with durable handoffs through the product API', async () => {
    const database = createDatabase({ connectionString, maxConnections: 4, connectionTimeoutMs: 5000 })
    const checkpoints = createCheckpointStore(connectionString, 'langgraph')
    const suffix = randomUUID()
    const workspaceId = `acceptance-workspace-${suffix}`
    const workflowId = `acceptance-workflow-${suffix}`
    const agentIds = [`acceptance-researcher-${suffix}`, `acceptance-developer-${suffix}`, `acceptance-reviewer-${suffix}`]
    const nodeIds = [`acceptance-node-researcher-${suffix}`, `acceptance-node-developer-${suffix}`, `acceptance-node-reviewer-${suffix}`]
    let app: ReturnType<typeof buildApp> | undefined
    let runId: string | undefined
    let projectDirectory: string | undefined
    let runtimeDirectory: string | undefined
    try {
      await database.migrate()
      await checkpoints.setup()
      projectDirectory = await mkdtemp(join(tmpdir(), 'graphql-acceptance-project-'))
      runtimeDirectory = await mkdtemp(join(tmpdir(), 'graphql-acceptance-runtime-'))
      const commands = new PostgresCommandCoordinator(database.pool)
      const locations = new WorkspaceLocationService(database.pool, commands, runtimeDirectory)
      const workflows = new PostgresWorkflowRepository(database.pool)
      const runs = new PostgresRunRepository(database.pool, workflows, locations)
      const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
      const settings = new PostgresSettingsRepository(database.pool)
      const engine = new LangGraphWorkflowEngine(
        runs,
        workflows,
        new LocalHarnessResolver('codex', 'opencode'),
        checkpoints.saver,
        runtimeDirectory,
        300_000,
        locations,
      )
      app = buildApp({
        readiness: { database, checkpoints },
        product: { workflows, runs, workspaces, settings, engine },
      })

      const workspace = WorkspaceSchema.parse({ id: workspaceId, name: 'Real harness acceptance' })
      await database.pool.query('insert into workspaces (id, record) values ($1, $2::jsonb)', [workspaceId, JSON.stringify(workspace)])
      const projectDetails = await stat(projectDirectory)
      await database.pool.query(
        `update workspaces set execution_location = $2::jsonb, execution_location_identity = $3::jsonb,
           location_revision = 1 where id = $1`,
        [workspaceId, JSON.stringify({ runnerId: 'runner-local', rootPath: await realpath(projectDirectory) }),
          JSON.stringify({ device: String(projectDetails.dev), inode: String(projectDetails.ino) })],
      )
      const agents = [
        AgentSchema.parse({
          id: agentIds[0], name: 'Researcher', harness: 'codex', model: 'gpt-5.6-luna', effort: 'low',
          harnessConfiguration: { harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
          prompt: { system: 'Produce exactly three concise facts about honeybees. Use general knowledge only and return plain text.' }, assignedSkills: [],
        }),
        AgentSchema.parse({
          id: agentIds[1], name: 'Summarizer', harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max',
          harnessConfiguration: { harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: false },
          prompt: { system: 'Turn only the supplied prior result into a short factual summary. Do not research or use files.' }, assignedSkills: [],
        }),
        AgentSchema.parse({
          id: agentIds[2], name: 'Reviewer', harness: 'codex', model: 'gpt-5.6-luna', effort: 'medium',
          harnessConfiguration: { harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
          prompt: { system: 'Review only the supplied summary and produce a polished final response. Do not research or use files.' }, assignedSkills: [],
        }),
      ]
      const workflow = WorkflowDefinitionSchema.parse({
        id: workflowId, workspaceId, name: 'Real three-agent handoff', executionCondition: { kind: 'manual' },
        nodes: [
          { id: nodeIds[0], agentId: agentIds[0], name: 'Researcher' },
          { id: nodeIds[1], agentId: agentIds[1], name: 'Summarizer' },
          { id: nodeIds[2], agentId: agentIds[2], name: 'Reviewer' },
        ],
        edges: [
          { id: `acceptance-edge-1-${suffix}`, source: nodeIds[0], target: nodeIds[1] },
          { id: `acceptance-edge-2-${suffix}`, source: nodeIds[1], target: nodeIds[2] },
        ],
        executionPolicy: { maxParallelism: 3, maxNodeExecutions: 3 },
      })
      const saveResponse = await app.inject({
        method: 'PUT',
        url: `/api/workspaces/${workspaceId}/graph`,
        payload: { workspaceId, workflow, agents },
      })
      expect(saveResponse.statusCode).toBe(200)
      const savedVersion = await workflows.getCurrentVersion(workspaceId, workflow.id)
      expect(savedVersion?.entryNodeId).toBe(workflow.nodes[0]!.id)

      const startResponse = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/workflows/${workflow.id}/runs`,
        payload: { workspaceId, workflowId: workflow.id, expectedLocationRevision: 1, input: {} },
      })
      expect(startResponse.statusCode).toBe(202)
      runId = startResponse.json().run.id as string
      const pinnedVersionId = startResponse.json().run.workflowVersionId as string
      const laterSave = await app.inject({
        method: 'PUT',
        url: `/api/workspaces/${workspaceId}/graph`,
        payload: { workspaceId, workflow },
      })
      expect(laterSave.statusCode).toBe(200)
      expect((await workflows.getCurrentVersion(workspaceId, workflow.id))?.id).not.toBe(pinnedVersionId)

      let details: GetRunResponse | undefined
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}/runs/${runId}`,
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
        ...agentIds,
      ])
      expect(new Set([first?.nativeSessionId, second?.nativeSessionId, third?.nativeSessionId]).size).toBe(3)
      expect(second?.input).toEqual({
        previous: {
          predecessorNodeId: nodeIds[0],
          executionId: first?.id,
          result: first?.result?.output,
        },
      })
      expect(third?.input).toEqual({
        previous: {
          predecessorNodeId: nodeIds[1],
          executionId: second?.id,
          result: second?.result?.output,
        },
      })
      expect(details?.run.result?.output).toEqual(third?.result?.output)
      expect(await checkpoints.saver.getTuple({
        configurable: { thread_id: runId },
      })).toBeDefined()
    } finally {
      await app?.close().catch(() => undefined)
      if (runId) await checkpoints.saver.deleteThread(runId).catch(() => undefined)
      await database.pool.query('delete from run_activity where run_id in (select id from runs where workspace_id = $1)', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from harness_native_events where execution_id in (select id from harness_executions where run_id in (select id from runs where workspace_id = $1))', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from harness_executions where run_id in (select id from runs where workspace_id = $1)', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from runs where workspace_id = $1', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from workflow_versions where workspace_id = $1', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from workflows where workspace_id = $1', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from agent_configuration_versions where workspace_id = $1', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from agents where workspace_id = $1', [workspaceId]).catch(() => undefined)
      await database.pool.query('delete from workspaces where id = $1', [workspaceId]).catch(() => undefined)
      await Promise.allSettled([checkpoints.close(), database.close()])
      if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true })
      if (projectDirectory) await rm(projectDirectory, { recursive: true, force: true })
    }
  }, 360_000)
})
