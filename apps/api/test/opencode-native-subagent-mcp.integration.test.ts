import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { it } from 'vitest'
import { RunSubagentCommandReceiptSchema, RunSubagentsPageSchema } from '@graphql/contracts/subagents'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RunSubagentService } from '../src/modules/subagents/service.js'
import { backfillRunSubagents } from '../src/modules/subagents/recovery.js'
import { productionSubagentControls } from '../src/modules/subagents/productionControls.js'
import { qualifyOpenCodeSubagentInput } from '../src/modules/harnesses/qualification/suites/opencodeSubagentInput.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { eventually } from './helpers/agentChatF5.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { nativeConfigurationFixture, nativeJson, nativePrompt } from './support/opencodeNativeConfiguration.js'

it('dispatches qualified native child input through authenticated MCP with scoped denial and persisted idempotent readback', async () => {
  const f = await nativeConfigurationFixture()
  const database = await agent3Database()
  const { pool } = database
  const app = Fastify()
  const clients: Client[] = []
  let owner: RunOwnership | undefined
  let managers: ExecutionScopedNativeSessionManagerResolver | undefined
  let service: RunSubagentService | undefined
  try {
    const source = makeCurrentWorkflowFixture(randomUUID(), 'single')
    for (const configuration of source.configurations) configuration.harness = f.harness
    const seeded = await seedAgent3(pool, f.directory, source)
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const executionId = randomUUID()
    const runId = seeded.run.id
    const start = { request: { ...f.start().request, executionId, runId, workspaceId: seeded.scope.workspaceId,
      workflowNodeId: node.id, configuration } }
    owner = await RunOwnership.acquire(pool, runId, () => {})
    assert(owner)
    const { native, server } = f.allocate(node.agentId)
    managers = new ExecutionScopedNativeSessionManagerResolver(() => native)
    const resolved = managers.resolve({ harness: 'opencode', executionId, agentId: node.agentId,
      workingDirectory: f.directory, runId, attempt: 1, configuration }, owner)
    resolved.beginStart!()
    const parent = await native.createSession(start)
    assert.equal(parent.providerVersion, '1.18.31')
    resolved.markResident!()
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,1,$5::jsonb)`, [executionId, runId, node.id, node.agentId, JSON.stringify({
      id: executionId, runId, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
      agentConfigurationVersionId: configuration.id, nativeSessionId: parent.nativeSessionId, state: 'running', input: {},
    })])
    await pool.query('insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)',
      [executionId, JSON.stringify(parent)])
    const qualified = await qualifyOpenCodeSubagentInput(
      (path, body) => nativeJson(server, f.directory, path, body), parent.nativeSessionId, f.harness.model)
    assert.equal(qualified.timing, 'idle')
    const parentBefore = await nativeJson(server, f.directory, `/session/${parent.nativeSessionId}`)
    const child = await nativeJson(server, f.directory, '/session', { parentID: parent.nativeSessionId,
      title: 'Configuration child', agent: 'reviewer', permission: [{ permission: '*', pattern: '*', action: 'deny' }] })
    const initial = await nativeJson(server, f.directory, `/session/${child.id}/message`, {
      ...nativePrompt('child-initial', 'child', 'Complete the child task'), variant: 'focused', system: 'Child system text',
    })
    assert.equal(object(initial.info).finish, 'stop')
    assert.equal(object(initial.info).error, undefined)
    const childBefore = await nativeJson(server, f.directory, `/session/${child.id}`)
    service = new RunSubagentService(pool, productionSubagentControls(managers),
      (_executionId, session, cursor, signal) => native.subagentHistory(session, cursor, signal))
    const access = new PostgresAccessService(pool)
    const writer = await access.issue({ name: 'Native child writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read', 'runs:subagents:input'],
        scope: { workspaceIds: [seeded.scope.workspaceId], runIds: [runId] } }] })
    const reader = await access.issue({ name: 'Native child reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'], scope: { runIds: [runId] } }] })
    const input = { workspaceId: seeded.scope.workspaceId, runId }
    await backfillRunSubagents(service, writer.principal, input)
    const services = { commands: new PostgresCommandCoordinator(pool), runs: { subagents: service },
      workspaces: {}, workflows: {}, agents: {}, locations: {}, harnesses: {} } as unknown as OperatorServices
    app.setErrorHandler((error, _request, reply) => {
      const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'Request failed.', 500)
      reply.code(domain.status).send({ error: { code: domain.code, message: domain.message } })
    })
    registerOperatorHttpSecurity(app, access)
    registerGraphqlMcp(app, { access, operator: services })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'native-child-control', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const allowed = await connect(writer.token)
    const denied = await connect(reader.token)
    const listed = RunSubagentsPageSchema.parse((await allowed.callTool({
      name: 'run_subagents_list_v1', arguments: input,
    })).structuredContent)
    const detail = listed.items.find(value => value.subagent.native.childSessionId === child.id)!
    assert(detail)
    assert.equal(detail.availableActions.sendInput, true)
    assert.equal(detail.subagent.capabilities.sendInput.qualification, 'passed')
    const command = { ...input, subagentId: detail.subagent.id, commandId: randomUUID(),
      expectedRevision: detail.subagent.revision, text: 'Continue with the child configuration' }
    assert.equal((await denied.listTools()).tools.some(tool => tool.name === 'run_subagent_input_v1'), false)
    const refused = await denied.callTool({ name: 'run_subagent_input_v1', arguments: command }).catch(error => {
      assert.match(String(error), /not found/i)
      return { isError: true }
    })
    assert.equal(refused.isError, true)
    assert.equal((await pool.query('select count(*)::int as count from run_subagent_command_receipts')).rows[0].count, 0)
    const response = await allowed.callTool({ name: 'run_subagent_input_v1', arguments: command })
    assert.notEqual(response.isError, true, JSON.stringify(response))
    const receipt = RunSubagentCommandReceiptSchema.parse(response.structuredContent)
    assert.equal(receipt.state, 'acknowledged')
    const retry = RunSubagentCommandReceiptSchema.parse((await allowed.callTool({
      name: 'run_subagent_input_v1', arguments: command,
    })).structuredContent)
    assert.deepEqual(retry, receipt)
    await eventually(async () => {
      const response = await server.request(`/session/${child.id}/message/${receipt.nativeCorrelationId}`
        + `?directory=${encodeURIComponent(f.directory)}`)
      if (!response.ok) {
        await response.body?.cancel()
        return false
      }
      return object(object(await response.json()).info).role === 'user'
    })
    const stored = await nativeJson(server, f.directory, `/session/${child.id}/message/${receipt.nativeCorrelationId}`)
    assert.equal(object(stored.info).agent, 'reviewer')
    assert.deepEqual(object(stored.info).model, { providerID: 'fixture', modelID: 'child', variant: 'focused' })
    assert.equal(object(stored.info).system, 'Child system text')
    const childAfter = await nativeJson(server, f.directory, `/session/${child.id}`)
    assert.equal(childAfter.agent, childBefore.agent)
    assert.deepEqual(childAfter.model, childBefore.model)
    assert.deepEqual(childAfter.permission, childBefore.permission)
    assert.deepEqual(await nativeJson(server, f.directory, `/session/${parent.nativeSessionId}`), parentBefore)
    const persisted = (await pool.query('select record from run_subagent_command_receipts where id=$1', [receipt.id])).rows[0].record
    assert.deepEqual(persisted, receipt)
    const messages = await server.request(`/session/${child.id}/message?directory=${encodeURIComponent(f.directory)}`)
    const history = await messages.json() as { info: { id: string } }[]
    assert.equal(history.filter(message => message.info.id === receipt.nativeCorrelationId).length, 1)
    assert.equal(history.filter(message => message.info.id === nativeMessageId('child-initial')).length, 1)
    const fresh = new RunSubagentService(pool, productionSubagentControls(managers))
    assert.deepEqual(await fresh.input(writer.principal, 'mcp', command), receipt)
    await pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [writer.principal.id, JSON.stringify(reader.principal.grants)])
    await assert.rejects(fresh.input(writer.principal, 'mcp', command), { code: 'ACCESS_DENIED' })
    await owner.release()
    assert.equal(productionSubagentControls(managers)(detail.subagent)?.matches(detail.subagent) ?? false, false)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await service?.close()
    await managers?.dispose()
    await owner?.release()
    await f.close()
    await database.close()
  }
}, 90_000)
