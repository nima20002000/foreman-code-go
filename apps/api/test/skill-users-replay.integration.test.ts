import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentConfigurationVersionSchema, AgentSchema, type Agent } from '@foreman-code/contracts'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import { SkillUsageService } from '../src/modules/skills/usage.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { CurrentWorkflowAuthoring } from '../src/modules/workflows/currentAuthoring.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

const configuration = {
  harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
} as const

describe.skipIf(!postgresEnabled)('Skill consumer update plans over authenticated MCP', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let app: FastifyInstance
  let address: string
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let agents: OperatorAgentMutationService
  let authoring: CurrentWorkflowAuthoring
  let client: Client
  const clients: Client[] = []

  async function connect(token: string) {
    const connected = new Client({ name: 'skill-consumers', version: '1' })
    clients.push(connected)
    await connected.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return connected
  }

  async function call<T>(name: string, schema: z.ZodType<T>, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args }, { timeout: 240_000 })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return schema.parse(decodeMcpToolResult(response))
  }

  beforeAll(async () => {
    database = await currentDatabase()
    commands = new PostgresCommandCoordinator(database.pool)
    access = new PostgresAccessService(database.pool)
    const locations = new WorkspaceLocationService(database.pool, commands, undefined, 'runner-local', database.directory)
    agents = new OperatorAgentMutationService(database.pool, commands, { qualifyConfiguration: async (value) => ({
      harness: value.harness, version: 'fixture', authenticated: true, ready: true,
      structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
      supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
    }) })
    authoring = new CurrentWorkflowAuthoring(database.pool, commands)
    const services = {
      commands, locations, workspaces: new WorkspaceManagementService(database.pool, commands, locations),
      workflows: new WorkflowManagementService(database.pool, commands),
      extensions: { agents, skills: new SkillCatalogService(database.pool, commands),
        skillUsage: new SkillUsageService(database.pool, agents, authoring, commands) },
    } as unknown as OperatorServices
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services },
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
    const owner = await access.issue({ name: 'Consumer owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }],
      expiresAt: new Date(Date.now() + 3_600_000) })
    client = await connect(owner.token)
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled(clients.map(connected => connected.close()))
    await app?.close()
    await database?.close()
  })

  async function makeAgent(workspaceId: string, skillId?: string, agentId = `consumer-${randomUUID()}`) {
    return (await call('agent_create', c.AgentMutationResultSchema, {
      workspaceId, agentId, commandId: randomUUID(), name: agentId, productRole: 'coder', configuration,
      assignedSkills: skillId ? [{ skillId, version: '1' }] : [],
    })).value
  }

  async function makeWorkflow(workspaceId: string, members: Agent[], name = 'Consumers') {
    const workflow = (await call('workflow_create', current.SavedManagedWorkflowCommandResultSchema, {
      workspaceId, commandId: randomUUID(), name,
    })).value
    const located = await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })
    const nodes = members.map((agent, index) => ({ id: `step-${index}`, agentId: agent.id, name: agent.name }))
    return (await call('workflow_save_v3', current.CurrentWorkflowSaveResultSchema, {
      workspaceId, workflowId: workflow.workflow.id, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedRevision: workflow.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: Object.fromEntries(members.map(agent => [agent.id, agent.configurationVersionId])),
      expectedLocationRevision: located.locationRevision,
      graph: { ...workflow.workflow, entryNodeId: nodes[0]!.id, nodes,
        edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, kind: 'execution',
          source: nodes[index]!.id, target: node.id })),
        approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: members.length },
      },
    })).value
  }

  async function fixture() {
    const workspace = (await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, {
      commandId: randomUUID(), name: 'Skill consumers',
    })).value
    const workspaceId = workspace.workspace.id
    const rootPath = join(database.directory, randomUUID())
    await mkdir(rootPath)
    await call('workspace_location_set', c.WorkspaceLocationSetResultSchema, {
      workspaceId, commandId: randomUUID(), expectedLocationRevision: workspace.locationRevision,
      runnerId: 'runner-local', rootPath,
    })
    const skill = (await call('skill_create', c.SkillMutationResultSchema, {
      workspaceId, commandId: randomUUID(), name: 'Guide', instructions: 'Version one',
    })).value.skill
    const consumer = await makeAgent(workspaceId, skill.skillId)
    const workflow = await makeWorkflow(workspaceId, [consumer.agent])
    return { workspaceId, skillId: skill.skillId, skill, consumer, workflow }
  }

  async function publish(workspaceId: string, skillId: string, revision: number, instructions: string) {
    return call('skill_update', c.SkillMutationResultSchema, {
      workspaceId, skillId, commandId: randomUUID(), expectedRevision: revision, name: 'Guide', instructions,
    })
  }

  async function seedConsumerFixtures(f: Awaited<ReturnType<typeof fixture>>) {
    const baseConfiguration = await configurationOf(f.workspaceId, f.consumer.agent.id)
    const records = JSON.stringify(Array.from({ length: 1000 }, (_, index) => {
      const agentId = `consumer-${f.workspaceId}-${index}`
      const configuration = AgentConfigurationVersionSchema.parse({
        ...baseConfiguration, id: randomUUID(), agentId,
      })
      const agent = AgentSchema.parse({ ...f.consumer.agent, id: agentId, name: `Consumer ${index}`,
        configurationVersionId: configuration.id })
      const workflowId = randomUUID()
      const version = current.WorkflowVersionV3Schema.parse({ ...f.workflow.version, id: randomUUID(), workflowId,
        agentConfigurationVersionIds: { [agentId]: configuration.id },
        definition: { ...f.workflow.version.definition, id: workflowId,
          nodes: [{ ...f.workflow.version.definition.nodes[0]!, agentId, name: agent.name }] } })
      version.contentHash = graphSourceDigest({ definition: version.definition,
        configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
      return { agent, configuration, version, graph: version.definition }
    }))
    const sql = await database.pool.connect()
    try {
      await sql.query('begin')
      await sql.query(`insert into agents(id,workspace_id,record)
        select item#>>'{agent,id}',$2,item->'agent' from jsonb_array_elements($1::jsonb) item`, [records, f.workspaceId])
      await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
        select item#>>'{configuration,id}',$2,item#>>'{agent,id}',
          (item#>>'{configuration,version}')::integer,item->'configuration'
        from jsonb_array_elements($1::jsonb) item`, [records, f.workspaceId])
      await sql.query(`update agents set current_configuration_version_id=item#>>'{configuration,id}'
        from jsonb_array_elements($1::jsonb) item where agents.id=item#>>'{agent,id}'`, [records])
      await sql.query(`insert into workflows(id,workspace_id,current_version_id,record,revision)
        select item#>>'{graph,id}',$2,item#>>'{version,id}',item->'graph',$3
        from jsonb_array_elements($1::jsonb) item`, [records, f.workspaceId, f.workflow.revision])
      await sql.query(`insert into workflow_versions
        (id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
        select item#>>'{version,id}',$2,item#>>'{graph,id}',(item#>>'{version,version}')::integer,
          item#>>'{version,entryNodeId}',item->'version',3 from jsonb_array_elements($1::jsonb) item`,
      [records, f.workspaceId])
      await sql.query('commit')
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally {
      sql.release()
    }
  }

  async function configurationOf(workspaceId: string, agentId: string) {
    const rows = await database.pool.query<{ record: unknown }>(
      `select c.record from agents a join agent_configuration_versions c on c.id=a.current_configuration_version_id
       where a.workspace_id=$1 and a.id=$2`, [workspaceId, agentId])
    return AgentConfigurationVersionSchema.parse(rows.rows[0]?.record)
  }

  it('leaves unrelated stale workflows and immutable history unchanged', async () => {
    const f = await fixture()
    const unrelated = await makeAgent(f.workspaceId)
    const untouched = await makeWorkflow(f.workspaceId, [unrelated.agent], 'Unrelated')
    await call('agent_update', c.AgentMutationResultSchema, {
      workspaceId: f.workspaceId, agentId: unrelated.agent.id, commandId: randomUUID(),
      expectedRevision: unrelated.metadataRevision, expectedConfigurationVersionId: unrelated.agent.configurationVersionId,
      prompt: { system: 'Unrelated edit' },
    })
    const before = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: untouched.workflowId,
    })
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const usage = await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId })
    expect(usage.workflows.map(workflow => workflow.workflowId)).toEqual([f.workflow.workflowId])
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result.failed).toEqual([])
    expect(result.agents.map(agent => agent.agentId)).toEqual([f.consumer.agent.id])
    expect(result.workflows.map(workflow => workflow.workflowId)).toEqual([f.workflow.workflowId])
    expect(await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: untouched.workflowId,
    })).toEqual(before)
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.workflow.workflowId,
    })
    expect(read.version.executionSemanticsVersion).toBe(3)
    expect(await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.workflow.workflowId, workflowVersionId: f.workflow.currentVersionId,
    })).toMatchObject({ version: f.workflow.version })
  })

  it('does not adopt an unrelated changed Agent pin inside an affected workflow', async () => {
    const f = await fixture()
    const unrelated = await makeAgent(f.workspaceId)
    const mixed = await makeWorkflow(f.workspaceId, [f.consumer.agent, unrelated.agent], 'Mixed')
    await call('agent_update', c.AgentMutationResultSchema, {
      workspaceId: f.workspaceId, agentId: unrelated.agent.id, commandId: randomUUID(),
      expectedRevision: unrelated.metadataRevision, expectedConfigurationVersionId: unrelated.agent.configurationVersionId,
      prompt: { system: 'Unrelated edit' },
    })
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ kind: 'workflow', id: mixed.workflowId, code: 'AGENT_CONFIGURATION_CONFLICT' })
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: mixed.workflowId,
    })
    expect(read.currentVersionId).toBe(mixed.currentVersionId)
    expect(read.revision).toBe(mixed.revision)
    expect(read.version).toEqual(mixed.version)
  })

  it('recovers workflow pins when its consumer Agent already has the current skill version', async () => {
    const f = await fixture()
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const agent = (await call('agent_update', c.AgentMutationResultSchema, {
      workspaceId: f.workspaceId, agentId: f.consumer.agent.id, commandId: randomUUID(),
      expectedRevision: f.consumer.metadataRevision,
      expectedConfigurationVersionId: f.consumer.agent.configurationVersionId,
      assignedSkills: [{ skillId: f.skillId, version: '2' }],
    })).value.agent
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId }))
      .toMatchObject({ agents: [], workflows: [{ workflowId: f.workflow.workflowId }] })
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result).toMatchObject({ agents: [], failed: [], workflows: [{ workflowId: f.workflow.workflowId }] })
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.workflow.workflowId,
    })
    expect(read.version.agentConfigurationVersionIds).toEqual({ [agent.id]: agent.configurationVersionId })
  })

  it.each(['partial', 'response-gap'] as const)('retains its original plan across a %s and later head/consumer changes',
    async (interruption) => {
      const f = await fixture()
      await publish(f.workspaceId, f.skillId, 1, 'Version two')
      const commandId = interruption.padEnd(200, 'p')
      const input = { workspaceId: f.workspaceId, skillId: f.skillId, commandId }
      const execute = commands.execute.bind(commands)
      let interrupt = true
      const intercepted: typeof commands.execute = async (command) => {
        if (interruption === 'response-gap' && interrupt && command.operation === 'skill.users.update') {
          interrupt = false
          return execute({ ...command, perform: async (sql) => {
            await command.perform(sql)
            throw new Error('Parent response interrupted after child commits')
          } })
        }
        return execute(command)
      }
      const commandSpy = vi.spyOn(commands, 'execute').mockImplementation(intercepted)
      const workflowSpy = vi.spyOn(authoring, 'save')
      if (interruption === 'partial') workflowSpy.mockImplementationOnce(async () => {
        throw new DomainError('WORKFLOW_BUSY', 'Workflow is busy.', 409)
      })
      try {
        const first = await client.callTool({ name: 'skill_users_update', arguments: input })
        if (interruption === 'response-gap') {
          expect(first.isError).toBe(true)
          expect(workflowSpy).toHaveBeenCalledTimes(1)
        } else expect(c.SkillUsersUpdateResultSchema.parse(decodeMcpToolResult(first)).failed)
          .toEqual([{ kind: 'workflow', id: f.workflow.workflowId, code: 'WORKFLOW_BUSY', message: 'Workflow is busy.' }])
        const accepted = await configurationOf(f.workspaceId, f.consumer.agent.id)
        expect(accepted.assignedSkills).toEqual([{ skillId: f.skillId, version: '2' }])
        const newcomer = await makeAgent(f.workspaceId, f.skillId)
        await publish(f.workspaceId, f.skillId, 2, 'Version three')
        const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, input)
        expect(result).toMatchObject({ headVersion: '2', failed: [],
          agents: [{ agentId: f.consumer.agent.id, configurationVersionId: accepted.id }] })
        expect(result.workflows.map(workflow => workflow.workflowId)).toEqual([f.workflow.workflowId])
        expect(await configurationOf(f.workspaceId, f.consumer.agent.id)).toEqual(accepted)
        expect((await configurationOf(f.workspaceId, newcomer.agent.id)).assignedSkills)
          .toEqual([{ skillId: f.skillId, version: '1' }])
        const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
          workspaceId: f.workspaceId, workflowId: f.workflow.workflowId,
        })
        expect(read.version.agentConfigurationVersionIds).toEqual({ [f.consumer.agent.id]: accepted.id })
        expect(await call('skill_users_update', c.SkillUsersUpdateResultSchema, input)).toEqual(result)
        expect((await database.pool.query('select count(*)::int as count from agent_configuration_versions where agent_id=$1',
          [f.consumer.agent.id])).rows[0].count).toBe(2)
        const other = (await call('skill_create', c.SkillMutationResultSchema, {
          workspaceId: f.workspaceId, commandId: randomUUID(), name: 'Other', instructions: 'Other instructions',
        })).value.skill
        const conflict = await client.callTool({ name: 'skill_users_update', arguments: { ...input, skillId: other.skillId } })
        expect(conflict.isError).toBe(true)
        expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
      } finally {
        workflowSpy.mockRestore()
        commandSpy.mockRestore()
      }
    })

  it('lists all consumers in a supported workspace with more than 1000 Agents and workflows', async () => {
    const f = await fixture()
    await seedConsumerFixtures(f)
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const usage = await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId })
    expect(usage.agents).toHaveLength(1001)
    expect(usage.workflows).toHaveLength(1001)
    expect(new Set(usage.agents.map(agent => agent.agentId)).size).toBe(1001)
    expect(new Set(usage.workflows.map(workflow => workflow.workflowId)).size).toBe(1001)
    const reader = await access.issue({ name: 'Consumer reader', audience: 'operator',
      grants: [{ actions: ['skills:read'], scope: { workspaceIds: [f.workspaceId] } }],
      expiresAt: new Date(Date.now() + 600_000) })
    const denied = await (await connect(reader.token)).callTool({ name: 'skill_users_update', arguments: {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    } })
    expect(denied.isError).toBe(true)
    expect((await configurationOf(f.workspaceId, f.consumer.agent.id)).assignedSkills)
      .toEqual([{ skillId: f.skillId, version: '1' }])
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result.failed).toEqual([])
    expect(result.agents).toHaveLength(1001)
    expect(result.workflows).toHaveLength(1001)
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId }))
      .toMatchObject({ agents: [], workflows: [] })
    const last = result.workflows.at(-1)!
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: last.workflowId,
    })
    expect(read.version.id).toBe(last.workflowVersionId)
    expect(read.version.executionSemanticsVersion).toBe(3)
  }, 240_000)
})
