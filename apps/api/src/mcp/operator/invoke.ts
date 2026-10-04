import type { FileReferenceToolName } from './tools/fileReferences.js'
import type { RunHistoryToolName } from './tools/runHistory.js'
import type { RunInspectionToolName } from '@foreman-code/contracts/wave25'
import type { OperatorToolName } from '@foreman-code/contracts/management'
import type { WorkflowScheduleToolName } from './tools/workflowSchedules.js'

import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from '../shared/results.js'
import type { OperatorRequestContext } from './types.js'

export async function invokeOperatorTool(
  context: OperatorRequestContext,
  name: OperatorToolName | RunInspectionToolName | FileReferenceToolName | WorkflowScheduleToolName | RunHistoryToolName,
  work: () => Promise<unknown>,
) {
  try { return toolResult(await work()) } catch (error) {
    if (error instanceof DomainError && error.status === 403) {
      await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
    }
    return toolFailure(error)
  }
}
