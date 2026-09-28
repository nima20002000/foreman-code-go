import { z } from 'zod'
import { UrlSearchSelectionSchema } from '../index.js'
import { GraphIdSchema } from './protocol.js'
import { RepeatGraphScopeV3Schema, sameCanonicalGraphScope, type RepeatGraphScopeV3 } from './repeatGraphMetadata.js'
import { RunActivityPublicKindSchema } from './runActivities.js'

export const WorkspaceBoardInspectionSchema = z.object({
  runNodeId: GraphIdSchema.optional(), runRelationshipId: GraphIdSchema.optional(),
  runExchangeKey: z.string().min(1).max(2048).optional(),
}).strict()
export type WorkspaceBoardInspection = z.infer<typeof WorkspaceBoardInspectionSchema>

/**
 * The existing runExchangeKey travels through both mounted route aliases. Reserve
 * an unambiguous namespace for execution/occurrence inspection; ordinary graph
 * exchange keys retain their meaning. IDs cannot contain '/', and '-' is not an ID.
 * No additional route-local mirror of this linkable state is needed.
 */
export const WorkspaceBoardExecutionSelectionSchema = z.object({
  occurrenceId: GraphIdSchema.optional(), executionId: GraphIdSchema.optional(),
}).strict()
export type WorkspaceBoardExecutionSelection = z.infer<typeof WorkspaceBoardExecutionSelectionSchema>
export function runInspectionKey(selection: WorkspaceBoardExecutionSelection): string | undefined {
  const value = WorkspaceBoardExecutionSelectionSchema.parse(selection)
  return value.occurrenceId || value.executionId
    ? `inspection/${value.occurrenceId ?? '-'}/${value.executionId ?? '-'}` : undefined
}
export function readRunInspectionKey(key?: string): WorkspaceBoardExecutionSelection {
  if (!key?.startsWith('inspection/')) return {}
  const parts = key.split('/')
  if (parts.length !== 3) throw new Error('Invalid execution inspection selection.')
  const value = WorkspaceBoardExecutionSelectionSchema.parse({
    ...(parts[1] !== '-' ? { occurrenceId: parts[1] } : {}),
    ...(parts[2] !== '-' ? { executionId: parts[2] } : {}),
  })
  if (!value.occurrenceId && !value.executionId) throw new Error('Empty execution inspection selection.')
  return value
}

/** Presentation only. A URL requests a Run; it never authorizes or proves its pins. */
export const WorkspaceBoardSearchSchema = UrlSearchSelectionSchema.extend({
  ...WorkspaceBoardInspectionSchema.shape,
  activityKind: RunActivityPublicKindSchema.optional(), activityAgentId: GraphIdSchema.optional(),
  runId: GraphIdSchema.optional(),
  workflowVersionId: GraphIdSchema.optional(),
  executionSemanticsVersion: z.union([
    z.literal(3), z.literal('3').transform(() => 3 as const),
  ]).optional(),
}).strict().superRefine((value, context) => {
  if (value.runNodeId && value.runRelationshipId) context.addIssue({ code: 'custom', message: 'Inspect one Run node or relationship at a time.' })
  try { readRunInspectionKey(value.runExchangeKey) }
  catch { context.addIssue({ code: 'custom', path: ['runExchangeKey'], message: 'Invalid execution or occurrence inspection identity.' }) }
  const pins = [value.runId, value.workflowVersionId, value.executionSemanticsVersion]
  if (pins.some((pin) => pin !== undefined) && (!value.workflowId || pins.some((pin) => pin === undefined))) {
    context.addIssue({ code: 'custom', message: 'A Run selection needs its workflow, Run, immutable version and execution semantics.' })
  }
})
export type WorkspaceBoardSearch = z.infer<typeof WorkspaceBoardSearchSchema>
export type WorkflowBoardLocation = {
  workspaceId: string; workflowId?: string; search: WorkspaceBoardSearch
  run?: RepeatGraphScopeV3; draftAlias: boolean
}

/** Pinned deep links resolve in the SAME mounted workspace route. No automatic redirect. */
export function resolveWorkflowBoardLocation(pathname: string, rawSearch: unknown): WorkflowBoardLocation {
  const match = /^\/workspaces\/([^/]+)(?:\/workflows\/([^/]+)\/(draft|runs\/([^/]+)\/graph\/([^/]+)\/(3)))?\/?$/.exec(pathname)
  if (!match) throw new Error('Invalid workflow board URL.')
  const workspaceId = decodeURIComponent(match[1]!)
  const pathWorkflowId = match[2] === undefined ? undefined : decodeURIComponent(match[2])
  const search = WorkspaceBoardSearchSchema.parse(rawSearch)
  if ((search.workspaceId !== undefined && search.workspaceId !== workspaceId)
    || (pathWorkflowId !== undefined && search.workflowId !== undefined && pathWorkflowId !== search.workflowId)) {
    throw new Error('The board URL contains conflicting workspace or workflow identities.')
  }
  const workflowId = pathWorkflowId ?? search.workflowId
  const requested = search.runId === undefined ? undefined : RepeatGraphScopeV3Schema.parse({
    workspaceId, workflowId, runId: search.runId, workflowVersionId: search.workflowVersionId,
    executionSemanticsVersion: search.executionSemanticsVersion,
  })
  const pinned = match[4] === undefined ? undefined : RepeatGraphScopeV3Schema.parse({
    workspaceId, workflowId, runId: decodeURIComponent(match[4]), workflowVersionId: decodeURIComponent(match[5]!),
    executionSemanticsVersion: Number(match[6]),
  })
  if (pinned && requested && !sameCanonicalGraphScope(pinned, requested)) throw new Error('The Run URL contains conflicting immutable pins.')
  if ((search.runNodeId || search.runRelationshipId || search.runExchangeKey) && !pinned && !requested) throw new Error('Run inspection needs a complete Run selection.')
  return { workspaceId, workflowId, search, run: pinned ?? requested, draftAlias: match[3] === 'draft' }
}

export function boardSearchForRun(search: WorkspaceBoardSearch, workflowId: string, run?: RepeatGraphScopeV3): WorkspaceBoardSearch {
  if (run && (run.workflowId !== workflowId || search.workspaceId !== undefined && run.workspaceId !== search.workspaceId)) {
    throw new Error('Cannot select a Run from a different workspace or workflow.')
  }
  if (run) RepeatGraphScopeV3Schema.parse(run)
  const { runId: _run, workflowVersionId: _version, executionSemanticsVersion: _semantics,
    runNodeId: _node, runRelationshipId: _edge, runExchangeKey: _exchange, ...rest } = search
  void _run; void _version; void _semantics; void _node; void _edge; void _exchange
  return WorkspaceBoardSearchSchema.parse({ ...rest, workflowId, ...(run ? {
    runId: run.runId, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: run.executionSemanticsVersion,
  } : {}) })
}

export function boardSearchForInspection(search: WorkspaceBoardSearch, workflowId: string, run: RepeatGraphScopeV3, inspection: WorkspaceBoardInspection): WorkspaceBoardSearch {
  return WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(search, workflowId, run), ...WorkspaceBoardInspectionSchema.parse(inspection) })
}

/** Only Run selection may bypass departure prompts. Authoring selection changes do not. */
export function staysOnWorkflowBoard(current: { pathname: string; search: unknown }, next: { pathname: string; search: unknown }): boolean {
  try {
    const a = resolveWorkflowBoardLocation(current.pathname, current.search)
    const b = resolveWorkflowBoardLocation(next.pathname, next.search)
    if (a.workspaceId !== b.workspaceId || !a.workflowId || a.workflowId !== b.workflowId) return false
    const { activityKind: _leftKind, activityAgentId: _leftAgent, ...left } = boardSearchForRun(a.search, a.workflowId)
    const { activityKind: _rightKind, activityAgentId: _rightAgent, ...right } = boardSearchForRun(b.search, b.workflowId)
    void _leftKind; void _leftAgent; void _rightKind; void _rightAgent
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof typeof left>
    return [...keys].every((key) => left[key] === right[key])
  } catch { return false }
}
