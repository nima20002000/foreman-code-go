import type { FileReferenceToolName } from './tools/fileReferences.js'
import type { RunHistoryToolName } from './tools/runHistory.js'
import type { RunInspectionToolName } from '@foreman-code/contracts/wave25'
import type { OperatorToolName } from '@foreman-code/contracts/management'
import type { WorkflowScheduleToolName } from './tools/workflowSchedules.js'

import { DomainError, databaseReadFailure } from '../../modules/errors.js'
import { componentLogger } from '../../infrastructure/logger.js'
import { toolFailure, toolResult } from '../shared/results.js'
import type { OperatorRequestContext } from './types.js'
import { OPERATOR_TOOL_ACTIONS } from './catalog.js'

export function logOperatorToolFailure(name: string, error: unknown): void {
  if (error instanceof DomainError) return
  const diagnostic = error as { code?: unknown; stack?: unknown } | null
  const code = diagnostic?.code
  componentLogger('engine').error({
    tool: name,
    errorType: error instanceof Error ? error.constructor.name : typeof error,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? { errorCode: code } : {}),
    ...(typeof diagnostic?.stack === 'string'
      ? { stackFrames: diagnostic.stack.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 8) } : {}),
  }, 'Operator tool failed')
}

export async function invokeOperatorTool(
  context: OperatorRequestContext,
  name: OperatorToolName | RunInspectionToolName | FileReferenceToolName | WorkflowScheduleToolName | RunHistoryToolName,
  work: () => Promise<unknown>,
) {
  try { return toolResult(await work()) } catch (error) {
    logOperatorToolFailure(name, error)
    const action = OPERATOR_TOOL_ACTIONS.find(tool => tool.name === name)?.action
    if (action?.endsWith(':read')) error = databaseReadFailure(error)
    if (error instanceof DomainError && error.status === 403 && !error.denialAudited) {
      await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
    }
    return toolFailure(error)
  }
}
