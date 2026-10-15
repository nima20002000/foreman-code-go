import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { expect } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { SavedRunDetailsSchema, makeCurrentWorkflowFixture, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { readDispatchIntent, readExecutionPlacement, readNativePlacement } from '../../src/modules/placement/persistence.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { insertRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { VerifiedRemoteEvidence } from '../../src/modules/runs/remote/resultBridge.js'
import { persistVerifiedRemoteReceipt } from '../../src/modules/runs/remote/persistence.js'
import type { DispatchIntent, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import type { NativeManagerResolutionContext } from '../../src/modules/interactions/runtimePorts.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../../src/modules/access/workerCredentials.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { providerAppEndpoint } from './wave25Br1003Runtime.js'
import { faultWorkflowWorker } from './faultWorkflowWorker.js'
import { readUntil } from './observableCondition.js'
import { mixedComputerPlacement } from './mixedComputerPlacement.js'
import { prepareHandoffSource } from './handoffSourcePreparation.js'
import { insertCurrentRunFixture } from './eng04CurrentRunFixture.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

function faultWorkflowDefinition(options: { loop?: boolean }) {
  const definition = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
  definition.version.definition.nodes = definition.version.definition.nodes.slice(0, 3)
  const [entry, affected, sibling] = definition.version.definition.nodes
  if (!entry || !affected || !sibling) throw new Error('Expected entry and two sibling Agents')
  definition.version.definition.edges = definition.version.definition.edges.filter(edge => edge.source === entry.id)
  definition.version.definition.executionPolicy = { maxParallelism: 3, maxNodeExecutions: 8 }
  definition.configurations = definition.configurations.slice(0, 3).map(configuration =>
    AgentConfigurationVersionSchema.parse({ ...configuration, harness: { ...configuration.harness,
      model: 'test-model', advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' },
    } }))
  definition.version.agentConfigurationVersionIds = Object.fromEntries(
    definition.configurations.map(configuration => [configuration.agentId, configuration.id]))
  definition.version.approval = { handler: 'native' }
  definition.version.definition.approval = { handler: 'native' }
  definition.run.approval = { handler: 'native' }
  if (options.loop) entry.interval = { everySeconds: 10 }
  return { definition, entry, affected, sibling }
}

export async function faultWorkflowFixture(options: { loop?: boolean; mcpUnavailable?: boolean } = {}) {
  const directory = await privateFixtureDirectory('workflow-fault-')
  const worker = await faultWorkflowWorker(directory)
  const { definition, entry, affected, sibling } = faultWorkflowDefinition(options)
  const intents = new Map<string, DispatchIntent>()
  const contexts = new Map<string, NativeManagerResolutionContext>()
  let placements: Awaited<ReturnType<typeof mixedComputerPlacement>>
  const nativePlacements = new Map<string, NativeExecutionPlacement>()
  let preparationFailure: { error: unknown } | undefined
  let mcpReady = !options.mcpUnavailable
  let unavailableInspections = 0
  const base = await currentOperatorIntegration({ fixture: definition, insertRun: false,
    approvalNodeIds: [], workerParallelism: 3,
    admitPlacementExecutionLocked: async (sql, owner, run, execution, ref, inputDigest) => {
      await placements.producer.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId)
      const intent = await readDispatchIntent(sql, execution.id)
      if (!intent) throw new Error('Expected admitted dispatch')
      intents.set(execution.id, intent)
    },
    preparePlacementExecution: async (owner, run, execution) => {
      try {
        const paths = await prepareHandoffSource(owner, run, execution, placements)
        const native = await readNativePlacement(base.db.pool, execution.id)
        if (!native) throw new Error('Expected prepared native source')
        nativePlacements.set(execution.id, native)
        return paths
      } catch (error) {
        preparationFailure = { error }
        throw error
      }
    },
    prepareManagerContext: async context => {
      const acceptedPlacement = await readExecutionPlacement(base.db.pool, context.executionId)
      return acceptedPlacement?.hostRef.kind === 'device' ? { ...context, acceptedPlacement } : context
    },
    managerFactory: (context, getOwner) => {
      contexts.set(context.executionId, context)
      if (!context.acceptedPlacement) return worker.manager()
      const intent = intents.get(context.executionId)
      if (!intent) throw new Error('Remote execution requires its admitted dispatch')
      let prior: Parameters<typeof persistVerifiedRemoteReceipt>[2]['receipt'] | null = null
      const placement = context.acceptedPlacement
      const native = nativePlacements.get(context.executionId)
      if (!native) throw new Error('Expected native placement before manager allocation')
      const originalConnection = { ...worker.connection }
      const originalIncarnationId = worker.incarnationId
      return worker.proxy(placement, intent, context.configuration, native, async receipt => {
        const owner = getOwner()
        if (!owner) throw new Error('Remote readback requires the active Run owner')
        await VerifiedRemoteEvidence.commit(receipt, worker.connection, {
          transaction: (_operationId, work) => owner.oneShotConnection().transaction(async sql => work({
            authority: async () => ({ intent, placement, originalConnection,
              originalIncarnationId, grantIsLive: true,
              lastSequence: prior?.sequence ?? -1, lastReceipt: prior,
              native: prior?.native ?? null, terminal: prior?.terminal ?? null }),
            reject: async (_receipt, reason) => { throw new Error(`Worker receipt rejected: ${reason}`) },
            accept: async verified => {
              await persistVerifiedRemoteReceipt(sql, owner, verified, async () => owner.assertOwned())
              prior = verified.receipt
            },
          })),
        })
      })
    },
    mcpInspector: manager => ({ inspect: async input => {
      const remote = manager.harness === 'codex' && input.workingDirectory === '/worker/project'
      if (remote && !mcpReady) unavailableInspections += 1
      return { harness: input.harness, providerVersion: '0.154.0', runnerId: input.runnerId,
        workingDirectory: input.workingDirectory, inspectedAt: new Date().toISOString(), entry: {
          name: input.serverName, transport: 'streamable-http', endpoint: providerAppEndpoint,
          enabled: true, credentialEnvironmentVariable: APP_MCP_TOKEN_ENVIRONMENT_VARIABLE,
          status: remote && !mcpReady ? 'status_unavailable' : 'connected',
        } }
    } }),
  }).catch(async (error: unknown) => {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  try {
    placements = await mixedComputerPlacement(base, directory)
    if (placements.remote.hostRef.kind !== 'device') throw new Error('Expected remote device placement')
    Object.assign(worker.connection, { mainId: placements.remote.hostRef.mainId,
      deviceId: placements.remote.hostRef.deviceId })
    const registration = (await base.db.pool.query<{ record: { workerInstallationId: string } }>(
      'select record from device_registrations where id=$1', [worker.connection.deviceId])).rows[0]!.record
    worker.connection.workerInstallationId = registration.workerInstallationId
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, {
      worktrees: { readyRoot: async () => undefined, sources: placements.sources, roots: placements.policies },
    })
    const saveInput = await base.create()
    saveInput.graph.nodes = saveInput.graph.nodes.map(node => ({ ...node,
      placement: node.id === affected.id ? placements.remote : placements.local }))
    const saved = (await base.services.workflows.current.save(base.writer.principal, 'http', saveInput)).value
    base.f.run.executionLocation = await withTransaction(base.db.pool, sql =>
      base.locations.snapshotAssigned(sql, base.f.run.workspaceId, placements.locationRevision))
    const draft = await insertCurrentRunFixture(base.db.pool, base.f, saved, base.writer.principal.id, { insert: false })
    const prepared = await placements.producer.prepare(draft.accepted.snapshot.request, base.writer.principal)
    if (!prepared) throw new Error('Expected remote placement admission')
    await withExclusiveGraphConnection(base.db.pool, connection => connection.transaction(async sql => {
      await insertRepeatRun(sql, draft.accepted, repeatStartPublication, 'manual', prepared)
    }))
    base.f.run = draft.run
    base.f.version = draft.version as typeof base.f.version
    const reader = await base.access.issue({ name: 'Fault observer', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read'], scope: { runIds: [base.f.run.id] } }] })
    const headers = { authorization: `Bearer ${reader.token}` }
    const readerClient = await base.connect(reader.token)
    const path = `/api/management/workspaces/${base.f.run.workspaceId}/runs/${base.f.run.id}`
    const read = async () => {
      const response = await base.app.inject({ url: path, headers })
      expect(response.statusCode, response.body).toBe(200)
      return SavedRunDetailsSchema.parse(response.json())
    }
    const readStartup = async () => {
      if (preparationFailure) throw preparationFailure.error
      const details = await read()
      const failed = details.executions.find(execution => execution.result?.outcome === 'failed')
      expect(failed?.result, canonicalGraphJson(failed?.result ?? null)).toBeUndefined()
      return details
    }
    const completed = new Set<string>()
    let releaseAffected = false
    let releaseSibling = !options.loop
    const pump = setInterval(() => {
      for (const turn of worker.replay.starts) {
        if (completed.has(turn.correlationId)) continue
        const context = contexts.get(turn.correlationId.replace('execution:', ''))
        if (!context) continue
        if (context.agentId === affected.agentId && !releaseAffected) continue
        if (context.agentId === sibling.agentId && !releaseSibling) continue
        if (context.agentId === entry.agentId && completed.has(`agent:${entry.agentId}`)) continue
        worker.replay.complete(turn.sessionId, turn.nativeTurnId, 'fixture complete')
        completed.add(turn.correlationId)
        if (context.agentId === entry.agentId) completed.add(`agent:${entry.agentId}`)
      }
    }, 10)
    let started: Promise<PromiseSettledResult<void>[]> | undefined
    return {
      base, worker, entry, affected, sibling, read, intents, contexts,
      async mcpInspections() { await readStartup(); return unavailableInspections },
      makeMcpReady() { mcpReady = true },
      launch() { started = Promise.allSettled([base.engine.start(base.f.run.id)]) },
      release() { releaseAffected = true; releaseSibling = true },
      active: () => readUntil(readStartup, details => details.executions.some(execution =>
        execution.workflowNodeId === affected.id && execution.state === 'running')
        && details.activity.some(activity => activity.payload.nativeEventType === 'turn.started'
          && details.executions.some(execution => execution.id === activity.harnessExecutionId
            && execution.workflowNodeId === affected.id)),
      { timeoutMs: 4_000, description: 'remote Agent turn admission' }),
      async finished() {
        const details = await readUntil(read, value => value.run.executionState === 'completed'
          && value.cleanupPending === false, { timeoutMs: 8_000, description: 'terminal Run readback' })
        const mcp = await readerClient.callTool({ name: 'run_get', arguments: {
          workspaceId: base.f.run.workspaceId, runId: base.f.run.id, detail: 'full',
        } })
        expect(mcp.isError).not.toBe(true)
        expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(mcp))).toEqual(details)
        const persisted = await base.runs.get(base.f.run.id)
        expect(persisted).toMatchObject({ executionState: details.run.executionState, outcome: details.run.outcome })
        return details
      },
      async close() {
        clearInterval(pump)
        worker.reconnect()
        for (const turn of worker.replay.starts) {
          const thread = worker.replay.threads.get(turn.sessionId)
          if (thread?.turns.find(item => item.id === turn.nativeTurnId)?.status === 'inProgress') {
            worker.replay.complete(turn.sessionId, turn.nativeTurnId, 'fixture teardown')
          }
        }
        try {
          await base.close()
          await started
        } finally {
          await worker.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try { await base.close() }
    finally {
      await worker.close()
      await rm(directory, { recursive: true, force: true })
    }
    throw error
  }
}

export function expectBoundedNodeFault(details: ReturnType<typeof SavedRunDetailsSchema.parse>,
  fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>, activity: RegExp) {
  expect(details.run.executionState).toBe('completed')
  expect(['succeeded', 'failed']).toContain(details.run.outcome)
  expect(details.run.stopCause).toBeUndefined()
  expect(details.cleanupPending).toBe(false)
  const sibling = details.executions.filter(execution => execution.workflowNodeId === fixture.sibling.id)
  expect(sibling).toHaveLength(1)
  expect(sibling[0]).toMatchObject({ attempt: 1, state: 'completed', result: { outcome: 'succeeded' } })
  const affected = details.executions.filter(execution => execution.workflowNodeId === fixture.affected.id)
  expect(affected.length).toBeGreaterThan(0)
  expect(affected.length).toBeLessThanOrEqual(3)
  const last = affected.at(-1)!
  expect(last.state).toBe('completed')
  expect(['succeeded', 'failed']).toContain(last.result?.outcome)
  if (last.result?.outcome === 'failed') {
    expect(affected.length).toBeGreaterThanOrEqual(2)
    expect(details.run.outcome).toBe('failed')
  } else {
    expect(details.run.outcome).toBe('succeeded')
  }
  expect(details.executions.filter(execution => execution.result?.outcome === 'failed')
    .every(execution => execution.workflowNodeId === fixture.affected.id)).toBe(true)
  expect(details.activity.some(item => activity.test(canonicalGraphJson(item.payload)))).toBe(true)
}

export function expectRecoveredFault(details: ReturnType<typeof SavedRunDetailsSchema.parse>,
  fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>, activity: RegExp) {
  expect(details.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
  expect(details.cleanupPending).toBe(false)
  const sibling = details.executions.filter(execution => execution.workflowNodeId === fixture.sibling.id)
  expect(sibling).toHaveLength(1)
  expect(sibling[0]).toMatchObject({ attempt: 1, state: 'completed', result: { outcome: 'succeeded' } })
  const affected = details.executions.filter(execution => execution.workflowNodeId === fixture.affected.id)
  expect(affected.length).toBeGreaterThan(0)
  expect(affected.length).toBeLessThanOrEqual(3)
  expect(affected.at(-1)).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
  expect(details.activity.some(item => activity.test(canonicalGraphJson(item.payload)))).toBe(true)
}
