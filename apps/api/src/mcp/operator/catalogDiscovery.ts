import { CANONICAL_RUN_GRAPH_MCP_TOOLS, CURRENT_WORKFLOW_TOOLS, RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { operatorTool } from './catalog.js'
import { toolAvailable } from './definition.js'
import type { OperatorRequestContext } from './types.js'
import { hostHarnessToolAvailable, HOST_HARNESS_TOOLS } from '../../modules/harnesses/instanceSettings/management.js'
import { currentWorkflowAvailable } from '../../modules/workflows/currentWorkflowPolicy.js'
import { CI_TOOLS, ciCapabilities } from '../shared/ciTools.js'
import { JOB_TOOLS, jobToolAvailable } from './tools/jobs.js'
import { JOB_RUNTIME_TOOLS, jobRuntimeToolAvailable } from './tools/jobRuntimeProfiles.js'
import { FILE_REFERENCE_TOOL_NAMES, fileReferenceToolAvailable } from './tools/fileReferences.js'
import { FILE_RETENTION_TOOL_NAMES, fileRetentionToolAvailable } from './tools/fileRetention.js'
import { WORKFLOW_SCHEDULE_TOOLS, workflowScheduleToolAvailable } from './tools/workflowSchedules.js'
import { RUN_HISTORY_TOOLS, runHistoryToolsAvailable } from './tools/runHistory.js'
import { runInspectionToolAvailable } from './tools/runInspection.js'
import { runGraphToolAvailable } from './tools/runGraph.js'

/** Uses the registrars' existing discovery predicates with the current authenticated caller. */
export function catalogToolAvailable(context: OperatorRequestContext, name: string): boolean {
  const tool = operatorTool(name)
  if (tool) return toolAvailable(context, tool)
  if (name === 'workspace_root_configuration_adopt') return !!context.services.workspaceRoots
  const host = HOST_HARNESS_TOOLS.find(candidate => candidate === name)
  if (host) return hostHarnessToolAvailable(context.services.harnessInstances, context.principal, host)
  if (CI_TOOLS.some(candidate => candidate === name)) return ciCapabilities(context, {}).some(tool => tool.name === name)
  const job = JOB_TOOLS.find(candidate => candidate === name)
  if (job) return jobToolAvailable(context, job)
  const runtime = JOB_RUNTIME_TOOLS.find(candidate => candidate === name)
  if (runtime) return jobRuntimeToolAvailable(context, runtime)
  const reference = FILE_REFERENCE_TOOL_NAMES.find(candidate => candidate === name)
  if (reference) return fileReferenceToolAvailable(context, reference)
  const retention = FILE_RETENTION_TOOL_NAMES.find(candidate => candidate === name)
  if (retention) return fileRetentionToolAvailable(context, retention)
  const schedule = WORKFLOW_SCHEDULE_TOOLS.find(candidate => candidate === name)
  if (schedule) return workflowScheduleToolAvailable(context, schedule)
  const operation = (Object.keys(CURRENT_WORKFLOW_TOOLS) as Array<keyof typeof CURRENT_WORKFLOW_TOOLS>)
    .find(key => CURRENT_WORKFLOW_TOOLS[key] === name)
  if (operation) return !!context.services.workflows?.current && currentWorkflowAvailable(context.principal, operation)
  if (Object.values(RUN_HISTORY_TOOLS).some(candidate => candidate === name)) return runHistoryToolsAvailable(context)
  const inspection = Object.values(RUN_INSPECTION_TOOLS).find(candidate => candidate === name)
  if (inspection) return runInspectionToolAvailable(context, inspection)
  if (Object.values(CANONICAL_RUN_GRAPH_MCP_TOOLS).some(candidate => candidate === name)) {
    return runGraphToolAvailable(context, name)
  }
  return false
}
