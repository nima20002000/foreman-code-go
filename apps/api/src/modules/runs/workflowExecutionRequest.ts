import {
  HarnessExecutionRequestSchema,
  type AgentConfigurationVersion,
  type HarnessExecution,
  type HarnessExecutionContext,
} from '@foreman-code/contracts'
import { WorkActivationInputSchema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { currentInitialPrompt } from './currentRouting.js'
import { trustedWorkNoticePrompt } from './workHandoffNotice.js'

export function workflowExecutionRequest(input: {
  execution: HarnessExecution
  version: WorkflowVersionV3
  configuration: AgentConfigurationVersion
  workspaceId: string
  executionContext?: HarnessExecutionContext | undefined
}) {
  const { execution, version, configuration, workspaceId, executionContext } = input
  const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
  if (!node || node.kind === 'job') throw new Error('Native execution requires an Agent workflow node.')
  const initialPrompt = currentInitialPrompt(node,
    version.definition.repeat?.blocks.some(block => block.exitNodeId === node.id) ?? false,
    version.definition.handoffs !== undefined)
  const workInput = version.definition.handoffs ? WorkActivationInputSchema.parse(execution.input) : undefined
  const noticePrompt = workInput ? trustedWorkNoticePrompt(workInput) : undefined
  const returnPrompt = workInput?.work.kind === 'work_request' ? [
    'If you choose routing.kind "return", copy this routing object and add outcome "accepted" or "needs_changes":',
    JSON.stringify({ kind: 'return', requestId: workInput.work.request.requestId }),
    'Copy requestId verbatim, including every character. Check it against the accepted input before responding.',
  ].join('\n') : undefined
  const prompts = [initialPrompt, noticePrompt, returnPrompt].filter(Boolean)
  return HarnessExecutionRequestSchema.parse({
    executionId: execution.id,
    runId: execution.runId,
    workspaceId,
    workflowNodeId: execution.workflowNodeId,
    workingDirectory: execution.workingDirectory,
    runtimeDirectory: execution.runtimeDirectory,
    ...(execution.systemPrompt ? { systemPrompt: execution.systemPrompt } : {}),
    ...(prompts.length ? { initialPrompt: prompts.join('\n\n') } : {}),
    configuration,
    input: execution.input,
    ...(executionContext ? { executionContext } : {}),
  })
}
