import { expect, it } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import { HarnessExecutionSchema, HarnessExecutionRequestSchema, type HarnessExecution } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import type { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { RepeatNativeLaunchStore } from '../src/modules/interactions/repeatObservation.js'
import { repeatNativeObserver } from '../src/modules/runs/repeatRuntime.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import { buildRepeatGraph } from '../src/modules/runs/repeatGraph.js'
import { repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { native2Fixture } from './eng04-native2-fixtures.js'
import { nativeCompleted } from './eng04-native-fixtures.js'

it('honors saved workflow parallelism above the startup capacity default', async () => {
  const f = makeCurrentWorkflowFixture('parallel-starts', 'single')
  const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `node-${index}`,
    agentId: f.configurations[0]!.agentId, name: `Worker ${index}` }))
  const version = WorkflowVersionV3Schema.parse({ ...f.version, entryNodeId: nodes[0]!.id,
    definition: { ...f.version.definition, entryNodeId: nodes[0]!.id, nodes,
      executionPolicy: { maxParallelism: 5, maxNodeExecutions: 6 },
      edges: nodes.slice(1).map(node => ({ id: `edge-${node.id}`, kind: 'execution',
        source: nodes[0]!.id, target: node.id })) } })
  const executions = new Map<string, HarnessExecution>()
  const started: string[] = []
  let finish!: () => void
  const working = new Promise<void>(resolve => { finish = resolve })
  const graph = buildRepeatGraph({ runId: f.run.id, version, checkpointer: new MemorySaver(),
    signal: new AbortController().signal,
    store: {
      admit: async (_ref, candidate) => {
        const execution = candidate()
        executions.set(execution.id, execution)
        return { kind: 'admitted', execution, reused: false }
      },
      acceptTerminal: async executionId => ({ kind: 'accepted', resolution: repeatTerminalResolution(version,
        f.scope, { nodeId: executions.get(executionId)!.workflowNodeId, occurrence: null }, executions.get(executionId)!) }),
      enterBlock: async () => { throw new Error('Ordinary graph has no repeat block') },
      readOccurrence: async () => { throw new Error('Ordinary graph has no occurrence') },
      transition: async () => { throw new Error('Ordinary graph has no repeat transition') },
    },
    driver: {
      candidate: ref => HarnessExecutionSchema.parse({ id: `execution-${ref.nodeId}`, runId: f.run.id,
        workflowNodeId: ref.nodeId, agentId: f.configurations[0]!.agentId,
        agentConfigurationVersionId: f.configurations[0]!.id, attempt: 1, state: 'queued', input: {}, createdAt: f.createdAt }),
      observe: async execution => {
        if (execution.workflowNodeId !== nodes[0]!.id) {
          started.push(execution.workflowNodeId)
          await working
        }
        executions.set(execution.id, nativeCompleted(execution, {}))
      },
    } })
  const task = graph.graph.invoke({ runId: f.run.id, occurrences: {}, boundaries: {}, executionIds: {} }, graph.config)
  try {
    await expect.poll(() => started.length, { timeout: 500 }).toBe(5)
  } finally {
    finish()
    await task
  }
})

it('admits the next Run after native startup without waiting for the first Agent to finish', async () => {
  const admission = new RunnerAdmission(1)
  const started: string[] = []
  let finish!: () => void
  const working = new Promise<void>(resolve => { finish = resolve })
  async function observer(runId: string) {
    const f = native2Fixture(false)
    const run = { ...f.run, id: runId }
    const execution = { ...f.get(), id: `execution-${runId}`, runId }
    const owner = { ...f.owner, runId }
    const stored = await f.store.readExecution(f.get().id)
    const occurrence = stored.ref.occurrence!
    const ref = { ...stored.ref, occurrence: { ...occurrence, scope: { ...occurrence.scope, runId } } }
    const store: RepeatNativeLaunchStore = {
      ...f.store,
      readExecution: async () => ({ ...stored, execution, ref }),
      claimLaunch: async () => undefined,
      beginNativeEntry: async () => { throw new Error('Recovery has no fresh entry permit') },
      recoverSession: async () => execution,
      readWorkExecutionContext: async () => { throw new Error('Ordinary graph has no handoff context') },
    }
    const native: Pick<ApprovalExecutionCoordinator, 'observeExact' | 'assertResume'> = {
      assertResume: async () => undefined,
      observeExact: async input => {
        started.push(runId)
        input.onStarted?.()
        if (runId === 'first') await working
        const terminal = nativeCompleted(input.execution)
        return { state: 'completed', execution: terminal, result: terminal.result! }
      },
    }
    const observe = repeatNativeObserver({ run, version: f.fixture.version, owner: owner as never,
      store, native, admission, workflows: { getAgentConfiguration: async () => f.configuration },
      locations: { revalidateRunAuthorization: async () => undefined, revalidateSnapshot: async () => undefined },
      directory: () => execution.runtimeDirectory! })
    return () => observe(execution, new AbortController().signal)
  }
  const first = (await observer('first'))()
  const second = (await observer('second'))()
  try {
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
    expect(started).toEqual(['first', 'second'])
  } finally {
    finish()
    await Promise.all([first, second])
  }
})

it('announces recovered native startup before observing the ongoing model turn', async () => {
  const f = native2Fixture(false)
  f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  let started = false
  const reconcile = f.manager.reconcile
  f.manager.reconcile = async () => {
    expect(started).toBe(true)
    return reconcile()
  }
  const request = HarnessExecutionRequestSchema.parse({ executionId: f.get().id, runId: f.run.id, workspaceId: f.run.workspaceId,
    workflowNodeId: f.get().workflowNodeId, workingDirectory: f.get().workingDirectory,
    runtimeDirectory: f.get().runtimeDirectory, input: f.get().input, configuration: f.configuration })
  const result = await f.coordinator.observeExact({ execution: f.get(), request, approval: f.run.approval,
    store: f.store, owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id,
    signal: new AbortController().signal, onStarted: () => { started = true } })
  expect(result.state).toBe('completed')
  expect(started).toBe(true)
})

it('announces a new native session after persisted readback and before waiting for model output', async () => {
  const f = native2Fixture(false)
  f.set({ ...f.get(), nativeSessionId: undefined })
  f.store.consumeLaunch = () => true
  let started = false
  const physical = { ...f.manager,
    createSession: async () => f.session,
    async *startTurnBatches(_session: unknown, input: { onSessionReady?(): Promise<void> }) {
      await input.onSessionReady!()
      expect(f.get().nativeSessionId).toBe(f.session.nativeSessionId)
      expect(f.get().state).toBe('running')
      expect(started).toBe(true)
      yield [{ executionId: f.get().id, connectionId: 'startup-connection', sequence: 1,
        occurredAt: f.at, type: 'startup-observed', payload: {} }]
    },
  }
  f.internals.resolveManager = () => ({ manager: physical as never, processState: 'needs_start' })
  f.internals.prepareEnvironment = async () => undefined
  const request = HarnessExecutionRequestSchema.parse({ executionId: f.get().id, runId: f.run.id, workspaceId: f.run.workspaceId,
    workflowNodeId: f.get().workflowNodeId, workingDirectory: f.get().workingDirectory,
    runtimeDirectory: f.get().runtimeDirectory, input: f.get().input, configuration: f.configuration })
  const result = await f.coordinator.observeExact({ execution: f.get(), request, approval: f.run.approval,
    store: f.store, owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id,
    signal: new AbortController().signal, onStarted: () => { started = true } })
  expect(result.state).toBe('completed')
  expect(started).toBe(true)
})
