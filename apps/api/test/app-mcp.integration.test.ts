import { copyFile, mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { registerAppRoute } from '../src/modules/harnesses/appMcpLauncher.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { seedInteractionOwners } from './helpers/interactionOwners.js'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  HarnessExecutionSchema,
  NATIVE_INTERACTION_FIXTURES,
  WorkflowRunSchema,
} from '@graphql/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { seedOrchestratorApproval } from './helpers/seedOrchestratorApproval.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2600'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => undefined)
})

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object')
  return result.structuredContent as Record<string, unknown>
}

function failureText(result: { isError?: boolean; structuredContent?: unknown; content?: unknown }): string {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()
  if (!Array.isArray(result.content) || !result.content.length) throw new Error('Expected a nonempty text-only MCP failure')
  return result.content.map((part: unknown) => {
    if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'text'
      || !('text' in part) || typeof part.text !== 'string') throw new Error('MCP failure included non-text content')
    return part.text
  }).join('\n')
}

describe.each(['http', 'launcher'] as const)('App MCP real %s transport and PostgreSQL policy', (transport) => {
  it('isolates identities, catalogs, scopes, responses, replay, revocation, and audience', async () => {
    const suffix = randomUUID()
    const schema = `app_mcp_${suffix.replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString })
    await admin.query(`create schema "${schema}"`)
    const scopedConnection = new URL(connectionString)
    scopedConnection.searchParams.set('options', `-c search_path=${schema}`)
    const database = createDatabase({ connectionString: scopedConnection.toString(), maxConnections: 8, connectionTimeoutMs: 5000, queryTimeoutMs: 5000 })
    cleanup.push(async () => {
      await database.close()
      try { await admin.query(`drop schema "${schema}" cascade`) } finally { await admin.end() }
    })
    await database.migrate()
    await ensureAcceptanceSeed(database.pool)
    await seedOrchestratorApproval(database.pool)
    const access = new PostgresAccessService(database.pool)
    const commands = new PostgresCommandCoordinator(database.pool)
    const interactions = new PostgresInteractionRepository(database.pool)
    const appInteractions = new PostgresAppInteractionService(database.pool, interactions, commands, {
      respond: async (responder, input) => {
        // Current App MCP delegates auditing to the shared decision writer; it
        // must not pass a caller-supplied transaction callback to this port.
        expect('beforeCommit' in responder ? responder.beforeCommit : undefined).toBeUndefined()
        const current = await interactions.get(input.interactionId)
        if (!current) throw new Error('interaction missing')
        const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
        if (!option) throw new Error('option missing')
        return interactions.decide({
          id: current.id, optionId: option.optionId, expectedRevision: input.expectedRevision,
          nativeResponse: { optionId: option.optionId, semantic: option.semantic },
          ...(responder.principal ? { principal: responder.principal } : {}),
        })
      },
    })
    const credentials = new WorkerCredentialService(database.pool, access)
    const runId = `run-app-${suffix}`
    const run = WorkflowRunSchema.parse({
      id: runId,
      workspaceId: 'workspace-1',
      workflowId: 'workflow-content-pipeline',
      workflowVersionId: 'workflow-content-pipeline-v1',
      agentConfigurationVersionIds: {
        'agent-developer': 'agent-developer-config-v1',
        'agent-reviewer': 'agent-reviewer-config-v1',
        'agent-researcher': 'agent-researcher-config-v1',
      },
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-reviewer' },
      executionCondition: { kind: 'manual' },
      executionState: 'waiting', outcome: 'pending', input: {},
      createdAt: new Date().toISOString(),
    })
    await database.pool.query(
      `insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)],
    )
    const executionIds = {
      coder: `execution-coder-${suffix}`,
      orchestrator: `execution-orchestrator-${suffix}`,
      wrongReviewer: `execution-wrong-${suffix}`,
    }
    for (const [key, agentId, configId] of [
      ['coder', 'agent-developer', 'agent-developer-config-v1'],
      ['orchestrator', 'agent-reviewer', 'agent-reviewer-config-v1'],
      ['wrongReviewer', 'agent-researcher', 'agent-researcher-config-v1'],
    ] as const) {
      const execution = HarnessExecutionSchema.parse({
        id: executionIds[key], runId, workflowNodeId: key === 'coder' ? 'node-developer' : key === 'orchestrator' ? 'node-reviewer' : 'node-researcher', agentId,
        agentConfigurationVersionId: configId, attempt: 1, input: {}, state: 'starting',
        createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      })
      await database.pool.query(
        `insert into harness_executions
          (id,run_id,workflow_node_id,agent_id,attempt,accepted,record)
         values ($1,$2,$3,$4,$5,false,$6::jsonb)`,
        [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, execution.attempt, JSON.stringify(execution)],
      )
    }

    const pending = {
      ...NATIVE_INTERACTION_FIXTURES.codex,
      id: `interaction-pending-${suffix}`,
      workspaceId: run.workspaceId, workflowId: run.workflowId, runId,
      executionId: executionIds.coder, requestingAgentId: 'agent-developer',
      nativeSessionId: `session-${suffix}`, nativeRequestId: `request-${suffix}`,
      approval: run.approval!,
    }
    const self = {
      ...pending,
      id: `interaction-self-${suffix}`,
      executionId: executionIds.orchestrator, requestingAgentId: 'agent-reviewer',
      nativeSessionId: `session-self-${suffix}`, nativeRequestId: `request-self-${suffix}`,
    }
    const foreign = {
      ...pending,
      id: `interaction-foreign-${suffix}`,
      workspaceId: 'workspace-foreign', workflowId: 'workflow-foreign', runId: 'run-foreign',
      executionId: `execution-foreign-${suffix}`, requestingAgentId: 'agent-foreign',
      nativeSessionId: `session-foreign-${suffix}`, nativeRequestId: `request-foreign-${suffix}`,
    }
    await interactions.create(pending)
    await interactions.create(self)
    await seedInteractionOwners(database.pool, foreign)
    await interactions.create(foreign)

    const coderCredential = await credentials.issueForExecution(executionIds.coder)
    const orchestratorCredential = await credentials.issueForExecution(executionIds.orchestrator)
    const wrongReviewerCredential = await credentials.issueForExecution(executionIds.wrongReviewer)
    const operatorCredential = await access.issue({
      name: 'operator-not-worker', audience: 'operator',
      grants: [{ actions: ['capabilities:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000),
    })
    const token = (credential: typeof coderCredential) => credential.environment.variables.GRAPHQL_MCP_TOKEN!
    const app = buildApp({
      readiness: { database, checkpoints: { ping: async () => undefined } },
      appMcp: { access, interactions: appInteractions },
    })
    let firstRequests = 0
    app.addHook('onRequest', async (request) => { if (request.headers.authorization === `Bearer ${token(coderCredential)}`) firstRequests++ })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    cleanup.push(async () => { await app.close() })

    const directory = await mkdtemp(join(tmpdir(), 'worker-mcp-routing-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const launcher = join(directory, 'launcher.mjs')
    await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
    const secondApp = buildApp({ readiness: { database, checkpoints: { ping: async () => undefined } }, appMcp: { access, interactions: appInteractions } })
    let secondRequests = 0
    secondApp.addHook('onRequest', async (request) => { if (request.headers.authorization === `Bearer ${token(coderCredential)}`) secondRequests++ })
    const secondAddress = await secondApp.listen({ host: '127.0.0.1', port: 0 })
    cleanup.push(() => secondApp.close())
    const connect = async (name: string, bearer: string) => {
      const client = new Client({ name, version: '1.0.0' })
      cleanup.push(async () => client.close())
      if (transport === 'launcher') {
        await registerAppRoute(bearer, `${name === 'orchestrator' || name === 'wrong-reviewer' ? address : secondAddress}/mcp`, new Date(Date.now() + 60_000).toISOString(), launcher)
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], env: { GRAPHQL_MCP_TOKEN: bearer }, stderr: 'pipe' }))
      } else await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => bearer },
      }))
      return client
    }
    const [coder, orchestrator, wrongReviewer] = await Promise.all([
      connect('coder', token(coderCredential)),
      connect('orchestrator', token(orchestratorCredential)),
      connect('wrong-reviewer', token(wrongReviewerCredential)),
    ])

    const beforeFirst = firstRequests
    const beforeSecond = secondRequests
    const coderTools = await coder.listTools()
    if (transport === 'launcher') {
      expect(firstRequests).toBe(beforeFirst)
      expect(secondRequests).toBeGreaterThan(beforeSecond)
    }
    const orchestratorTools = await orchestrator.listTools()
    const wrongTools = await wrongReviewer.listTools()
    // Each role lists only its own tools; a Coder never sees interaction_respond.
    for (const tools of [coderTools, wrongTools]) {
      expect(tools.tools.map((tool) => tool.name)).toEqual(['context_get', 'interaction_list', 'interaction_get'])
    }
    expect(orchestratorTools.tools.map((tool) => tool.name)).toEqual(['context_get', 'interaction_list', 'interaction_get', 'interaction_respond'])
    expect(orchestratorTools.tools.every((tool) => tool.inputSchema.additionalProperties === false
      && tool.outputSchema?.additionalProperties === false)).toBe(true)

    const [coderContext, orchestratorContext] = await Promise.all([
      coder.callTool({ name: 'context_get', arguments: {} }),
      orchestrator.callTool({ name: 'context_get', arguments: {} }),
    ])
    expect(structured(coderContext)).toMatchObject({ principal: { agentId: 'agent-developer' }, role: 'coder', capabilities: { interactionRespond: false } })
    expect(structured(orchestratorContext)).toMatchObject({ principal: { agentId: 'agent-reviewer' }, role: 'orchestrator', capabilities: { interactionRespond: true } })
    expect(token(coderCredential)).not.toBe(token(orchestratorCredential))

    const firstPage = structured(await orchestrator.callTool({
      name: 'interaction_list', arguments: { limit: 1 },
    })) as unknown as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.nextCursor).not.toBe(firstPage.items[0]!.id)
    const secondPage = structured(await orchestrator.callTool({
      name: 'interaction_list', arguments: { limit: 1, cursor: firstPage.nextCursor },
    })) as unknown as { items: Array<{ id: string }> }
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
    const invalidCursor = await orchestrator.callTool({ name: 'interaction_list', arguments: { cursor: 'not-a-cursor' } })
    expect(failureText(invalidCursor)).toContain('INVALID_CURSOR')

    const foreignGet = await orchestrator.callTool({ name: 'interaction_get', arguments: { interactionId: foreign.id } })
    expect(failureText(foreignGet)).toContain('INTERACTION_NOT_FOUND')
    const selfResponse = await orchestrator.callTool({ name: 'interaction_respond', arguments: {
      interactionId: self.id, optionId: self.responseOptions[0]!.optionId, expectedRevision: 0,
    } })
    expect(failureText(selfResponse)).toContain('INTERACTION_NOT_FOUND')
    expect(failureText(await coder.callTool({ name: 'interaction_respond', arguments: {
      interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: 0,
    } }))).toContain('ROLE_NOT_ALLOWED')

    const responseInput = {
      interactionId: pending.id,
      optionId: pending.responseOptions[0]!.optionId,
      expectedRevision: 0,
    }
    const response = structured(await orchestrator.callTool({ name: 'interaction_respond', arguments: responseInput }))
    expect(response).toMatchObject({ replayed: false, interaction: {
      status: 'delivery_pending', selectedOptionId: responseInput.optionId,
    } })
    const replay = structured(await orchestrator.callTool({ name: 'interaction_respond', arguments: responseInput }))
    expect(replay).toMatchObject({ replayed: true })
    expect((await database.pool.query(
      "select count(*)::int as count from management_audit where principal_id=$1 and action='interaction_respond' and outcome='succeeded'",
      [orchestratorCredential.principalId],
    )).rows[0]?.count).toBe(2)

    if (transport === 'launcher') {
      // Existing clients and tokens follow a restarted owner on a different port.
      await app.close()
      const routes = new AppMcpRoutes(database.pool, `${secondAddress}/mcp`, launcher)
      cleanup.push(() => routes.close())
      await routes.refresh()
      expect(structured(await orchestrator.callTool({ name: 'interaction_get', arguments: { interactionId: pending.id } })))
        .toMatchObject({ interaction: { status: 'delivery_pending', selectedOptionId: responseInput.optionId } })
      expect((await interactions.get(pending.id))?.selectedOptionId).toBe(responseInput.optionId)
      for (const file of await readdir(join(directory, 'routes'))) {
        const stored = await readFile(join(directory, 'routes', file), 'utf8')
        expect(stored).not.toContain(token(coderCredential))
        expect(stored).not.toContain(token(orchestratorCredential))
      }
    }
    await credentials.revoke(orchestratorCredential)
    await expect(orchestrator.listTools()).rejects.toThrow()
    await expect(connect('operator-wrong-audience', operatorCredential.token)).rejects.toThrow()

    const expiring = await credentials.issueForExecution(executionIds.wrongReviewer)
    await database.pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1", [expiring.principalId])
    await expect(connect('expired', token(expiring))).rejects.toThrow()

    const coderRestart = await credentials.issueForExecution(executionIds.coder)
    const otherAgentRestart = await credentials.issueForExecution(executionIds.wrongReviewer)
    expect(token(coderRestart)).not.toBe(token(otherAgentRestart))
    // Terminal/Stop revokes every still-active credential for only the target execution.
    expect(await credentials.revokeForExecution(executionIds.coder)).toBe(2)
    expect(await credentials.revokeForExecution(executionIds.coder)).toBe(0)
    await expect(access.authenticate(token(coderRestart), 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await expect(access.authenticate(token(otherAgentRestart), 'worker')).resolves.toMatchObject({ agentId: 'agent-researcher' })
  }, 30_000)
})
