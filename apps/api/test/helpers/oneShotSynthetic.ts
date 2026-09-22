import { randomUUID } from 'node:crypto'
import { HarnessExecutionSchema, type HarnessExecution } from '@graphql/contracts'
import { makeWave25Fixture, ExecutableWorkflowV2Schema, type NodeResolution, type WorkflowChoice, type InputBinding } from '@graphql/contracts/wave25'
import type { OneShotAdmission } from '../../src/modules/runs/oneShotPostgres.js'
import { bindOneShotInput, inactiveOneShotResolution, normalizeOneShotTerminal, oneShotResolution } from '../../src/modules/runs/oneShotResolution.js'
import { compileOneShotTopology, decideOneShotAdmission } from '../../src/modules/runs/topology.js'

/** Synthetic durable-domain stand-in ONLY for real LangGraph wrapper tests.
 * SQL atomicity/locks are tested separately against actual PostgreSQL. */
export function syntheticOneShot(names: string[], edges: Array<[string, string]>, choices: Record<string, WorkflowChoice> = {}) {
  const f = makeWave25Fixture(randomUUID())
  const configurations = names.map((name) => ({ ...f.configurations[0]!, id: `cfg-${name}`, agentId: `agent-${name}` }))
  const version = ExecutableWorkflowV2Schema.parse({ configurations, version: {
    ...f.version, entryNodeId: names[0],
    agentConfigurationVersionIds: Object.fromEntries(configurations.map((item) => [item.agentId, item.id])),
    definition: { ...f.version.definition, entryNodeId: names[0],
      executionPolicy: { maxParallelism: 4, maxNodeExecutions: names.length },
      nodes: names.map((name) => ({ id: name, agentId: `agent-${name}`, name, ...(choices[name] ? { choice: choices[name] } : {}) })),
      edges: edges.map(([source, target]) => ({ id: `${source}-${target}`, source, target, kind: 'execution' })),
    },
  } }).version
  const topology = compileOneShotTopology(version)
  const resolutions = new Map<string, NodeResolution>()
  const executions = new Map<string, { execution: HarnessExecution; accepted: boolean }>()
  const receipts: InputBinding[] = []
  const constructed: string[] = [], nativeCalls: string[] = []
  const completionOrder: string[] = []
  let active = 0, peak = 0
  let failAcceptance = false
  const candidate = (nodeId: string) => {
    constructed.push(nodeId)
    return HarnessExecutionSchema.parse({ id: `exec-${nodeId}`, runId: f.run.id, workflowNodeId: nodeId,
      agentId: `agent-${nodeId}`, agentConfigurationVersionId: `cfg-${nodeId}`, attempt: 1,
      input: {}, state: 'queued', createdAt: f.createdAt })
  }
  const store = {
    async admit(nodeId: string, create: () => HarnessExecution): Promise<OneShotAdmission> {
      const decision = decideOneShotAdmission(topology, nodeId, resolutions)
      if (decision.kind === 'resolved') return { kind: 'resolved', resolution: decision.resolution }
      if (decision.kind === 'waiting') return { kind: 'waiting' }
      if (decision.kind === 'skipped' || decision.kind === 'excluded') {
        const resolution = inactiveOneShotResolution(version, nodeId, decision.kind, f.createdAt)
        resolutions.set(nodeId, resolution)
        return { kind: 'resolved', resolution }
      }
      const existing = [...executions.values()].find((item) => item.execution.workflowNodeId === nodeId)
      if (existing) return { kind: 'admitted', execution: existing.execution, reused: true }
      const result = bindOneShotInput({ version, runInput: {}, recipient: create(), resolutions, predecessors: executions, boundAt: f.createdAt })
      executions.set(result.execution.id, { execution: result.execution, accepted: false })
      receipts.push(...result.bindings)
      return { kind: 'admitted', execution: result.execution, reused: false }
    },
    async acceptTerminal(id: string): Promise<NodeResolution> {
      if (failAcceptance) { failAcceptance = false; throw new Error('synthetic acceptance/checkpoint boundary crash') }
      const row = executions.get(id)!
      const old = resolutions.get(row.execution.workflowNodeId)
      if (old) return old
      row.execution = normalizeOneShotTerminal(version, row.execution)
      const resolution = oneShotResolution(version, row.execution)
      row.accepted = resolution.resolution === 'succeeded'
      resolutions.set(resolution.workflowNodeId, resolution)
      return resolution
    },
  }
  const driver = (output: (nodeId: string) => unknown = () => ({ done: true }), wait: (nodeId: string) => Promise<void> = async () => undefined) => ({
    candidate,
    async observe(execution: HarnessExecution, signal: AbortSignal) {
      signal.throwIfAborted()
      nativeCalls.push(execution.workflowNodeId); active++; peak = Math.max(peak, active)
      try {
        await wait(execution.workflowNodeId)
        signal.throwIfAborted()
        executions.get(execution.id)!.execution = HarnessExecutionSchema.parse({ ...execution,
          state: 'completed', result: { outcome: 'succeeded', output: output(execution.workflowNodeId) }, finishedAt: f.createdAt })
        completionOrder.push(execution.workflowNodeId)
      } finally { active-- }
    },
  })
  return { runId: f.run.id, version, store, driver, resolutions, executions, receipts, constructed, nativeCalls, completionOrder,
    get peak() { return peak }, failNextAcceptance: () => { failAcceptance = true } }
}
