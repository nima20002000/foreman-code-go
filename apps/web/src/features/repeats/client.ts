import { z } from 'zod'
import {
  RepeatDecisionMetadataV1Schema,
  RepeatOccurrenceV1Schema,
  RepeatPlanV1Schema,
  type RepeatDecisionMetadataV1,
  type RepeatOccurrenceV1,
  type RepeatPlanV1,
} from '@graphql/contracts/wave25'

/**
 * ENG-04-C narrow transport adapter. These URLs/envelopes are intentionally isolated here because
 * B owns the final HTTP contract. Shell must reconcile this file with B before integration; the
 * components only consume A0 shared repeat types and this small UI-facing adapter.
 */
export type RepeatAuthoringSnapshot = {
  plan: RepeatPlanV1 | null
  revision: number
  workflowVersionId: string | null
  updatedAt?: string
}

export type RepeatSaveRequest = {
  workspaceId: string
  workflowId: string
  expectedRevision: number
  commandId: string
  mode: 'save' | 'stop_and_save'
  plan: RepeatPlanV1 | null
}

export type RepeatOccurrenceRead = {
  occurrence: RepeatOccurrenceV1
  /** Authoritative lifecycle label supplied by B/A. C never derives it from time or decisions. */
  status: string
  /** Technical retry counter, when the read model exposes it. It never changes occurrenceIndex. */
  technicalAttempt?: number
  decision?: RepeatDecisionMetadataV1
  startedAt?: string
  settledAt?: string
}

export type RepeatRunReadback = {
  headRevision: number
  complete: boolean
  stale?: boolean
  resetRequired?: boolean
  occurrences: RepeatOccurrenceRead[]
}

export type RepeatRunScope = RepeatOccurrenceV1['identity']['scope']

export interface RepeatClient {
  authoring(workspaceId: string, workflowId: string, options?: { signal?: AbortSignal }): Promise<RepeatAuthoringSnapshot>
  save(request: RepeatSaveRequest, options?: { signal?: AbortSignal }): Promise<RepeatAuthoringSnapshot>
  run(scope: RepeatRunScope, options?: { signal?: AbortSignal }): Promise<RepeatRunReadback>
}

export class RepeatClientError extends Error {
  readonly uncertain: boolean
  readonly status?: number
  constructor(message: string, options: { uncertain?: boolean; status?: number } = {}) {
    super(message)
    this.name = 'RepeatClientError'
    this.uncertain = options.uncertain ?? false
    this.status = options.status
  }
}

const AuthoringSchema = z.object({
  plan: RepeatPlanV1Schema.nullable(),
  revision: z.number().int().nonnegative(),
  workflowVersionId: z.string().min(1).nullable(),
  updatedAt: z.string().optional(),
}).strict()

const OccurrenceReadSchema = z.object({
  occurrence: RepeatOccurrenceV1Schema,
  status: z.string().min(1),
  technicalAttempt: z.number().int().min(1).optional(),
  decision: RepeatDecisionMetadataV1Schema.optional(),
  startedAt: z.string().optional(),
  settledAt: z.string().optional(),
}).strict()

const RunReadbackSchema = z.object({
  headRevision: z.number().int().nonnegative(),
  complete: z.boolean(),
  stale: z.boolean().optional(),
  resetRequired: z.boolean().optional(),
  occurrences: z.array(OccurrenceReadSchema),
}).strict()

const path = (value: string) => encodeURIComponent(value)

async function jsonRequest<T>(url: string, schema: z.ZodType<T>, init: RequestInit, uncertainOnNetwork = false): Promise<T> {
  let response: Response
  try { response = await fetch(url, { credentials: 'same-origin', ...init }) }
  catch (error) {
    throw new RepeatClientError(error instanceof Error ? error.message : 'The repeat request could not be sent.', { uncertain: uncertainOnNetwork })
  }
  if (!response.ok) {
    let message = `Repeat request failed (${response.status}).`
    try {
      const body = await response.json() as { error?: { message?: string }; message?: string }
      message = body.error?.message ?? body.message ?? message
    } catch { /* Preserve the status-backed message. */ }
    throw new RepeatClientError(message, { status: response.status })
  }
  const body = await response.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new RepeatClientError('The repeat response did not match the shared contract.')
  return parsed.data
}

export function createRepeatClient(): RepeatClient {
  return {
    authoring: (workspaceId, workflowId, options) => jsonRequest(
      `/api/management/workspaces/${path(workspaceId)}/workflows/${path(workflowId)}/repeat`,
      AuthoringSchema, { signal: options?.signal }, false,
    ),
    save: (request, options) => jsonRequest(
      `/api/management/workspaces/${path(request.workspaceId)}/workflows/${path(request.workflowId)}/repeat`,
      AuthoringSchema,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: options?.signal },
      true,
    ),
    run: (scope, options) => jsonRequest(
      `/api/management/workspaces/${path(scope.workspaceId)}/runs/${path(scope.runId)}/repeat`,
      RunReadbackSchema, { signal: options?.signal }, false,
    ),
  }
}

export const repeatClient = createRepeatClient()
