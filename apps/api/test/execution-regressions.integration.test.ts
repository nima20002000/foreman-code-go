import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { graphHarness } from './helpers/eng04A1GraphHarness.js'

let database: Awaited<ReturnType<typeof agent3Database>>

async function authoring(form: 'single' | 'parallel' = 'single') {
  const db = database
  const f = makeCurrentWorkflowFixture(randomUUID(), form)
  try {
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const commands = new PostgresCommandCoordinator(db.pool), access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Regression author', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
    const workflows = new WorkflowManagementService(db.pool, commands)
    const managed = await workflows.get(writer.principal, f.scope.workspaceId, f.scope.workflowId)
    const input = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, executionSemanticsVersion: 3,
      commandId: randomUUID(), expectedRevision: managed.revision, expectedWorkflowVersionId: f.version.id,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, expectedLocationRevision: 1,
      graph: f.version.definition }
    return { db, f, commands, writer, workflows, input }
  } catch (error) { await db.close(); throw error }
}

describe.skipIf(!postgresEnabled)('current execution regressions', () => {
  it('recovers persisted queued work without replaying predecessor or native turns', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      expect((await f.runs.get(f.f.run.id))?.executionState).toBe('queued')
      const errors: unknown[] = []
      await f.engine.reconcile((error) => errors.push(error))
      await expect.poll(async () => (await f.runs.get(f.f.run.id))?.executionState, { timeout: 45000 }).toBe('waiting')
      const [interaction] = await f.pending()
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction!))
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, responses: 1 })
      expect(errors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})

describe.skipIf(!postgresEnabled)('current execution snapshots and authoring regressions', () => {
  beforeEach(async () => {
    database = await agent3Database()
    const close = database.close
    let closing: Promise<void> | undefined
    database.close = () => closing ??= close()
  }, 60_000)
  afterEach(async () => { await database?.close() }, 60_000)

  it('keeps its accepted project directory when workspace settings later point elsewhere', async () => {
    const db = database
    try {
      const f = await currentRepositoryFixture(db)
      const accepted = f.f.run.executionLocation!
      const replacement = join(db.directory, 'replacement'); await mkdir(replacement)
      await f.locations.set(f.issued.principal, 'http', { workspaceId: f.f.scope.workspaceId,
        commandId: randomUUID(), expectedLocationRevision: accepted.locationRevision, runnerId: 'runner-local', rootPath: replacement })
      const saved = await f.repository.get(f.f.run.id)
      expect(saved?.executionLocation).toEqual(accepted)
      await f.locations.revalidateSnapshot(f.f.scope.workspaceId, accepted, 'read-only')
    } finally { await db.close() }
  })

  it('rejects a replaced accepted inode before allowing any native work', async () => {
    const db = database
    const original = `${db.directory}-original`
    try {
      const f = await currentRepositoryFixture(db)
      await rename(db.directory, original); await mkdir(db.directory)
      await expect(f.locations.revalidateSnapshot(f.f.scope.workspaceId, f.f.run.executionLocation!, 'read-only'))
        .rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_CHANGED' })
      expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toEqual([])
    } finally {
      await removeFixtureDirectory(db.directory); await rename(original, db.directory)
      await db.close()
    }
  })

  it('rechecks the accepting Operator authority before any queued native launch', async () => {
    const db = database
    try {
      const f = await currentRepositoryFixture(db)
      await new PostgresAccessService(db.pool).revoke(f.issued.principal.id)
      await expect(f.locations.revalidateRunAuthorization(f.f.run.authorizationPrincipalId!, f.f.scope.workspaceId, f.f.scope.workflowId))
        .rejects.toMatchObject({ code: 'RUN_AUTHORIZATION_REVOKED' })
      expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toEqual([])
    } finally { await db.close() }
  })

  it('does not steal live ownership and preserves the authorized Stop fence for the replacement owner', async () => {
    const db = database
    try {
      const f = await currentRepositoryFixture(db)
      const owner = await f.repository.acquireOwnership(f.f.run.id, () => undefined)
      expect(owner).toBeTruthy()
      try {
        expect(await f.repository.acquireOwnership(f.f.run.id, () => undefined)).toBeUndefined()
        await f.stop()
        expect((await f.repository.getRepeatSnapshot(f.f.run.id, owner!)).stopRequested).toBe(true)
      } finally { await owner!.release() }
      const replacement = await f.repository.acquireOwnership(f.f.run.id, () => undefined)
      expect(replacement).toBeTruthy()
      try { expect((await f.repository.getRepeatSnapshot(f.f.run.id, replacement!)).stopRequested).toBe(true) }
      finally { await replacement!.release() }
      expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toEqual([])
    } finally { await db.close() }
  })

  it('preserves old Agent settings and requires the newly displayed pin on Save', async () => {
    const f = await authoring()
    try {
      const original = f.f.configurations[0]!
      const agents = new OperatorAgentMutationService(f.db.pool, f.commands, { qualifyConfiguration: async (configuration) => ({
        harness: configuration.harness, version: 'fixture', authenticated: true, ready: true, structuredEvents: true,
        supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
        supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
      }) })
      const revision = Number((await f.db.pool.query('select metadata_revision from agents where id=$1', [original.agentId])).rows[0].metadata_revision)
      const updated = await agents.update(f.writer.principal, { workspaceId: original.workspaceId, agentId: original.agentId,
        commandId: randomUUID(), expectedRevision: revision, expectedConfigurationVersionId: original.id,
        configuration: SupportedHarnessConfigurationSchema.parse({ ...original.harness, model: 'new-current-model' }) })
      const id = updated.value.agent.configurationVersionId!
      expect(id).not.toBe(original.id)
      expect((await f.db.pool.query('select record from agent_configuration_versions where id=$1', [original.id])).rows[0].record).toEqual(original)
      // A meaningful executable edit must validate the displayed current pins.
      // Saving the unchanged definition preserves its existing immutable version.
      const edited = { ...f.input, graph: { ...f.input.graph, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 1 } } }
      await expect(f.workflows.current.save(f.writer.principal, 'mcp', edited)).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_CONFLICT' })
      const saved = await f.workflows.current.save(f.writer.principal, 'mcp', { ...edited, commandId: randomUUID(),
        expectedAgentConfigurationVersionIds: { [original.agentId]: id } })
      expect(saved.value.version.agentConfigurationVersionIds[original.agentId]).toBe(id)
    } finally { await f.db.close() }
  })

  it('rejects a workflow ID from another workspace without changing immutable versions', async () => {
    const f = await authoring()
    try {
      const before = (await f.db.pool.query('select id,record from workflow_versions order by id')).rows
      await expect(f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input,
        workspaceId: 'foreign-workspace', graph: { ...f.input.graph, workspaceId: 'foreign-workspace' } })).rejects.toThrow()
      expect((await f.db.pool.query('select id,record from workflow_versions order by id')).rows).toEqual(before)
    } finally { await f.db.close() }
  })

  it('requires an explicit sufficient execution budget for all four parallel steps', async () => {
    const f = await authoring('parallel')
    try {
      await expect(f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input,
        graph: { ...f.input.graph, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 3 } } })).rejects.toThrow()
      const saved = await f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input, commandId: randomUUID(),
        graph: { ...f.input.graph, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 4 } } })
      expect(saved.value.version.definition.executionPolicy?.maxNodeExecutions).toBe(4)
    } finally { await f.db.close() }
  })

  for (const maximum of [1, 2]) it(`persists maxParallelism=${maximum} and the real graph honors it`, async () => {
    const f = await authoring('parallel')
    try {
      const saved = await f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input,
        graph: { ...f.input.graph, executionPolicy: { maxParallelism: maximum, maxNodeExecutions: 4 } } })
      f.f.version = agentWorkflowVersion(saved.value.version)
      f.f.scope.workflowVersionId = saved.value.currentVersionId
      f.f.run.workflowVersionId = saved.value.currentVersionId
      ExecutableWorkflowV3Schema.parse({ version: f.f.version, configurations: f.f.configurations })
      let active = 0, peak = 0
      const graph = graphHarness(f.f, { beforeObserve: async () => {
        active++; peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 20)); active--
      } })
      await graph.run()
      expect(peak).toBe(maximum)
      expect(graph.executions.size).toBe(4)
    } finally { await f.db.close() }
  })

  it('persists all-required fan-in and executes the final node once after both predecessors', async () => {
    const f = await authoring('parallel')
    try {
      const seen: string[] = [], final = f.f.version.definition.nodes.at(-1)!.id
      const graph = graphHarness(f.f, { beforeObserve: async (execution) => {
        if (execution.workflowNodeId === final) expect(seen).toEqual(expect.arrayContaining(f.f.version.definition.nodes.slice(1, 3).map((node) => node.id)))
        seen.push(execution.workflowNodeId)
      } })
      await graph.run()
      expect(seen.filter((id) => id === final)).toHaveLength(1)
      expect(f.f.version.definition.nodes.at(-1)?.join).toEqual({ mode: 'all' })
    } finally { await f.db.close() }
  })
})
