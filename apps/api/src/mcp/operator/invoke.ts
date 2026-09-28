import type { RunInspectionToolName } from '@graphql/contracts/wave25'
import type { OperatorToolName } from '@graphql/contracts/management'
import type { WorkflowScheduleToolName } from './tools/workflowSchedules.js'

import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from '../shared/results.js'
import type { OperatorRequestContext } from './types.js'

export async function invokeOperatorTool(
  context: OperatorRequestContext,
  name: OperatorToolName | RunInspectionToolName | WorkflowScheduleToolName,
  work: () => Promise<unknown>,
) {
  try { return toolResult(await work()) } catch (error) {
    if (error instanceof DomainError && error.status === 403) {
      await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
    }
    return toolFailure(error)
  }
}
