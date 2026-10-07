import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { WorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { FixtureServer, manager, request, sessionFor } from './opencode-fixtures.js'

it('reports the sanitized original OpenCode restart closure cause while retaining uncertainty and the same session for retry', async () => {
  const server = new FixtureServer(), native = manager(server), session = await sessionFor(native)
  const dispose = server.dispose.bind(server)
  let failClose = true, detachments = 0
  const secret = 'fixture-owner-token'
  // Only the external server port fails. The real OpenCode close path must
  // retain its session until that original port confirms disposal.
  server.dispose = async () => {
    if (failClose) throw new Error(`OpenCode process closure unconfirmed: ${secret}`)
    await dispose()
  }
  const input = request()
  const execution: HarnessExecution = {
    id: input.executionId, runId: input.runId, workflowNodeId: input.workflowNodeId,
    agentId: input.configuration.agentId, agentConfigurationVersionId: input.configuration.id,
    workingDirectory: input.workingDirectory, runtimeDirectory: input.runtimeDirectory,
    attempt: 1, input: {}, state: 'waiting', nativeSessionId: session.nativeSessionId,
    createdAt: input.configuration.createdAt,
  }
  const closures = { async recordDetached(actual: HarnessExecution, reference: NativeSessionReference,
    generation: string, check: () => void) {
    check(); assert.equal(actual, execution); assert.equal(reference, session)
    assert.equal(generation, 'original-generation'); detachments++
  } } as WorkflowClosureStore
  type Dependencies = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator({} as Dependencies[0], { coordination: {} } as Dependencies[1],
    {} as Dependencies[2], {} as Dependencies[3], 60_000, undefined, undefined, closures)
  // Seed only the resident-lifetime seam, not SQL ownership or native proof.
  // No provider process, database, listener, qualification or replacement runs.
  const owned = { execution, context: input, manager: native, controller: new AbortController(), generation: 1,
    closureGeneration: 'original-generation', session }
  const internals = coordinator as unknown as {
    ownedSessions: Map<string, typeof owned>
    managerCredentials: WeakMap<typeof native, { environment: { variables: Record<string, string> } }>
    closedExecutions: Set<string>
  }
  internals.ownedSessions.set(execution.id, owned)
  internals.managerCredentials.set(native, { environment: { variables: { GRAPHQL_MCP_TOKEN: secret } } })
  const callsBefore = [...server.calls], restartsBefore = server.restartEnvironments.length
  try {
    const closing = coordinator.closeForRestart()
    assert.equal(coordinator.closeForRestart(), closing)
    const failure = await closing.catch((error: unknown) => error)
    assert(failure instanceof AggregateError)
    assert.equal(failure.message, 'Native restart closure was incomplete.')
    assert.equal(failure.errors.length, 1)
    const contextual = failure.errors[0] as Error
    assert.equal(contextual.message, `${execution.id}: close for restart`)
    assert(contextual.cause instanceof Error)
    assert.equal(contextual.cause.message, 'OpenCode process closure unconfirmed: [REDACTED]')
    assert.equal(detachments, 0)
    assert.equal(internals.closedExecutions.has(execution.id), false)
    assert.equal(internals.ownedSessions.get(execution.id), owned)
    assert.equal(owned.session, session)
    assert.equal(server.disposals, 0)
    assert.deepEqual(server.calls, callsBefore)
    assert.equal(server.restartEnvironments.length, restartsBefore)
    // Reporters that omit AggregateError.errors follow the normal cause chain.
    assert.equal(failure.cause, contextual, 'The reported aggregate must expose the sanitized original closure failure.')
    assert(!String((failure.cause as Error).cause).includes(secret))
    failClose = false
    await coordinator.closeForRestart()
    assert.equal(detachments, 1)
    assert.equal(internals.closedExecutions.has(execution.id), false, 'detachment is not terminal closure')
    assert.equal(server.disposals, 1)
    assert.deepEqual(server.calls, callsBefore)
    assert.equal(server.restartEnvironments.length, restartsBefore)
  } finally {
    failClose = false
    await native.dispose()
  }
})
