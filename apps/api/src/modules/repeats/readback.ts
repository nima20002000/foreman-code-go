import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatDecisionMetadataV1Schema,
  RepeatDecisionV1Schema,
  RepeatOccurrenceV1Schema,
  RepeatRunReadInputSchema,
  RepeatRunReadbackSchema,
  RepeatWorkflowReadbackSchema,
  RepeatWorkflowVersionV1Schema,
  type RepeatOccurrenceReadItem,
  type RepeatRunReadInput,
  type RepeatWorkflowReadInput,
} from '@graphql/contracts/wave25'
import type pg from 'pg'

import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

export interface RepeatOccurrenceReadStore {
  list(input: {
    workspaceId: string
    workflowId: string
    runId: string
    afterOccurrenceId?: string | undefined
    limit: number
    includeResultData: boolean
  }): Promise<{ items: Array<{ occurrence: unknown; decision: unknown | null }>; nextCursor: string | null }>
}

export class RepeatReadbackService {
  constructor(private readonly pool: pg.Pool, private readonly occurrences?: RepeatOccurrenceReadStore) {}

  async workflow(principal: ManagementPrincipal, input: RepeatWorkflowReadInput) {
    requireAuthorization(principal, 'workflows:read', input)
    requireAuthorization(principal, 'graph:read', input)
    const row = await this.pool.query<{
      revision: string
      current_version_id: string | null
      version_record: unknown | null
      execution_semantics_version: number | null
    }>(
      `select w.revision::text,w.current_version_id,v.record as version_record,v.execution_semantics_version
       from workflows w left join workflow_versions v on v.id=w.current_version_id
       where w.workspace_id=$1 and w.id=$2`,
      [input.workspaceId, input.workflowId],
    )
    const current = row.rows[0]
    if (!current) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
    if (!current.current_version_id || current.execution_semantics_version !== REPEAT_EXECUTION_SEMANTICS_VERSION) {
      throw new DomainError('REPEAT_NOT_CONFIGURED', 'The current saved workflow is not a bounded-repeat version.', 404)
    }
    const version = RepeatWorkflowVersionV1Schema.safeParse(current.version_record)
    if (!version.success) {
      throw new DomainError('REPEAT_SAVED_VERSION_INVALID', 'The persisted repeat version does not match the supported contract.', 409)
    }
    return RepeatWorkflowReadbackSchema.parse({
      contractVersion: REPEAT_CONTRACT_VERSION,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      revision: Number(current.revision),
      currentVersionId: current.current_version_id,
      version: version.data,
    })
  }

  async run(principal: ManagementPrincipal, raw: RepeatRunReadInput) {
    const input = RepeatRunReadInputSchema.parse(raw)
    requireAuthorization(principal, 'workflows:read', input)
    requireAuthorization(principal, 'graph:read', input)
    requireAuthorization(principal, 'runs:read', input)
    const run = await this.pool.query<{ workflow_version_id: string; record: Record<string, unknown> }>(
      'select workflow_version_id,record from runs where workspace_id=$1 and workflow_id=$2 and id=$3',
      [input.workspaceId, input.workflowId, input.runId],
    )
    const saved = run.rows[0]
    if (!saved) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workflow scope.', 404)
    if (saved.record.executionSemanticsVersion !== REPEAT_EXECUTION_SEMANTICS_VERSION) {
      throw new DomainError('REPEAT_UNSUPPORTED_RUN_VERSION', 'This Run is not a bounded-repeat execution-semantics-3 Run.', 409)
    }
    if (!this.occurrences) {
      throw new DomainError('REPEAT_RUNTIME_READBACK_UNAVAILABLE', 'Repeat occurrence storage is not wired into this API build.', 503)
    }
    const page = await this.occurrences.list({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      ...(input.cursor ? { afterOccurrenceId: input.cursor } : {}),
      limit: input.limit,
      includeResultData: input.includeResultData,
    })
    const items: RepeatOccurrenceReadItem[] = page.items.map((item) => ({
      occurrence: RepeatOccurrenceV1Schema.parse(item.occurrence),
      decision: item.decision === null ? null : input.includeResultData
        ? RepeatDecisionV1Schema.parse(item.decision)
        : RepeatDecisionMetadataV1Schema.parse(item.decision),
    }))
    for (const item of items) {
      const scope = item.occurrence.identity.scope
      if (scope.workspaceId !== input.workspaceId || scope.workflowId !== input.workflowId
        || scope.runId !== input.runId || scope.workflowVersionId !== saved.workflow_version_id
        || scope.executionSemanticsVersion !== REPEAT_EXECUTION_SEMANTICS_VERSION) {
        throw new DomainError('REPEAT_READBACK_SCOPE_INVALID', 'Persisted repeat occurrence escaped the requested Run/version scope.', 409)
      }
    }
    return RepeatRunReadbackSchema.parse({
      contractVersion: REPEAT_CONTRACT_VERSION,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      items,
      pageInfo: { nextCursor: page.nextCursor },
    })
  }
}
