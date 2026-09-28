import { parseWorkHandoffResult, type WorkflowVersionV3 } from '@graphql/contracts/wave25'
import type { RepeatRunRepository } from './repeatPostgres.js'
import type { RepeatExecutionDriver } from './repeatNode.js'
import { ExecutionLimiter } from './limiter.js'
import { repeatConflict } from './repeatResolution.js'

/** One LangGraph activation task. Every durable decision is idempotent, so a
 * checkpoint replay reconciles the exact native execution and work receipts. */
export function workHandoffNodeAction(input: {
  version: WorkflowVersionV3
  store: Pick<RepeatRunRepository, 'admitWorkActivation' | 'acceptWorkTerminal' | 'admitWorkRequest'
    | 'returnWork' | 'recordWorkUnresolved'>
  driver: RepeatExecutionDriver; limiter: ExecutionLimiter; signal: AbortSignal
}) {
  return async (activationId: string): Promise<readonly string[]> => {
    input.signal.throwIfAborted()
    const admitted = await input.store.admitWorkActivation(activationId,
      (nodeId) => input.driver.candidate({ nodeId, occurrence: null }, 1))
    let execution = admitted.execution
    for (;;) {
      input.signal.throwIfAborted()
      if (execution.state === 'completed') await input.driver.observe(execution, input.signal)
      else await input.limiter.run(input.signal, () => input.driver.observe(execution, input.signal))
      const terminal = await input.store.acceptWorkTerminal(execution.id,
        (attempt) => input.driver.candidate({ nodeId: execution.workflowNodeId, occurrence: null }, attempt))
      if (terminal.kind === 'retry') { execution = terminal.execution; continue }
      const result = parseWorkHandoffResult(terminal.execution.result)
      if (result.routing.kind === 'return') {
        const returned = await input.store.returnWork(terminal.execution.id)
        return returned.value.continuationActivationId ? [returned.value.continuationActivationId] : []
      }
      const selected: string[] = []
      if (result.routing.kind === 'request') {
        const admitted = await input.store.admitWorkRequest(terminal.execution.id)
        if (admitted.kind === 'limit_reached') return [admitted.notice.continuationActivationId]
        if (admitted.kind === 'needs_direction') return []
        if (admitted.destinationReady) selected.push(admitted.request.destinationActivationId)
      } else {
        const node = input.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
        if (!node) return repeatConflict('WORKFLOW_NODE_NOT_FOUND')
        const routes = result.routing.outcome === undefined && result.data.remainingFindings.length ? []
          : node.choice ? (() => {
          const declared = node.choice.outcomes.find((item) => item.outcome === result.routing.outcome)
          if (!declared) {
            if (result.routing.outcome === undefined && result.data.remainingFindings.length) return []
            return repeatConflict('WORK_FINISH_OUTCOME_REQUIRED')
          }
          return declared.target.kind === 'edge' ? [declared.target.relationshipId] : []
        })() : input.version.definition.edges.filter((edge) => edge.kind === 'execution'
          && edge.source === node.id).map((edge) => edge.id)
        for (const relationshipId of routes) {
          const admitted = await input.store.admitWorkRequest(terminal.execution.id, relationshipId)
          if (admitted.kind === 'limit_reached') {
            selected.push(admitted.notice.continuationActivationId)
            continue
          }
          if (admitted.kind === 'needs_direction') continue
          if (admitted.destinationReady) selected.push(admitted.request.destinationActivationId)
        }
        if (!routes.length && result.data.remainingFindings.length) {
          await input.store.recordWorkUnresolved(terminal.execution.id)
        }
      }
      return [...new Set(selected)]
    }
  }
}
