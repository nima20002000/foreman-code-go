import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  REPEAT_READBACK_MAX_BYTES,
  canonicalGraphJson,
  RepeatDecisionMetadataV1Schema,
  RepeatDecisionV1Schema,
  RepeatOccurrenceV1Schema,
  RepeatRunReadInputSchema,
  RepeatRunVersionV1Schema,
  RepeatOccurrenceReadItemSchema,
  RepeatWorkflowReadInputSchema,
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
    workflowVersionId: string
    afterOccurrenceId?: string | undefined
    limit: number
    includeResultData: boolean
  }): Promise<{ items: Array<{ occurrence: unknown; decision: unknown | null }>; nextCursor: string | null }>
}

export class RepeatReadbackService {
  constructor(private readonly pool: pg.Pool, private readonly occurrences?: RepeatOccurrenceReadStore) {}

  async workflow(principal: ManagementPrincipal, raw: RepeatWorkflowReadInput) {
    const input = RepeatWorkflowReadInputSchema.parse(raw)
    requireAuthorization(principal, 'workflows:read', input)
    requireAuthorization(principal, 'graph:read', input)
    const row = await this.pool.query<{
      revision: string
      current_version_id: string | null
      version_record: unknown | null
      execution_semantics_version: number | null
      version: number | null
      entry_node_id: string | null
    }>(
      `select w.revision::text,w.current_version_id,v.record as version_record,v.execution_semantics_version,v.version,v.entry_node_id
       from workflows w left join workflow_versions v on v.id=w.current_version_id
         and v.workspace_id=w.workspace_id and v.workflow_id=w.id
       where w.workspace_id=$1 and w.id=$2`,
      [input.workspaceId, input.workflowId],
    )
    const current = row.rows[0]
    if (!current) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
    if (!current.current_version_id || current.execution_semantics_version !== REPEAT_EXECUTION_SEMANTICS_VERSION) {
      throw new DomainError('REPEAT_NOT_CONFIGURED', 'The current saved workflow is not a bounded-repeat version.', 404)
    }
    const version = RepeatWorkflowVersionV1Schema.safeParse(current.version_record)
    if (!version.success || version.data.id !== current.current_version_id
      || version.data.workspaceId !== input.workspaceId || version.data.workflowId !== input.workflowId
      || version.data.version !== current.version || version.data.entryNodeId !== current.entry_node_id
      || !Number.isSafeInteger(Number(current.revision))) {
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
    const run = await this.pool.query<{
      workflow_version_id: string; record: Record<string, unknown>; version_record: unknown
      version: number | null; entry_node_id: string | null; execution_semantics_version: number | null
    }>(
      `select r.workflow_version_id,r.record,v.record as version_record,v.version,v.entry_node_id,v.execution_semantics_version
       from runs r left join workflow_versions v on v.id=r.workflow_version_id
         and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
       where r.workspace_id=$1 and r.workflow_id=$2 and r.id=$3`,
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
    const pinned = RepeatRunVersionV1Schema.safeParse({ run: saved.record, version: saved.version_record })
    if (!pinned.success || pinned.data.run.id !== input.runId
      || pinned.data.run.workspaceId !== input.workspaceId || pinned.data.run.workflowId !== input.workflowId
      || pinned.data.version.id !== saved.workflow_version_id || pinned.data.version.version !== saved.version
      || pinned.data.version.entryNodeId !== saved.entry_node_id
      || saved.execution_semantics_version !== REPEAT_EXECUTION_SEMANTICS_VERSION) {
      throw new DomainError('REPEAT_RUN_PIN_INVALID', 'The persisted Run does not match its complete immutable version/configuration pins.', 409)
    }
    const page = await this.occurrences.list({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      workflowVersionId: saved.workflow_version_id,
      ...(input.cursor ? { afterOccurrenceId: input.cursor } : {}),
      limit: input.limit,
      includeResultData: input.includeResultData,
    })
    if (page.items.length > input.limit) {
      throw new DomainError('REPEAT_READBACK_PAGE_INVALID', 'Occurrence storage exceeded the requested page size.', 409)
    }
    const items: RepeatOccurrenceReadItem[] = page.items.map((item) => {
      // Validate the full record before removing private result data. Do not
      // rely on every storage adapter to perform the content-free projection.
      let decision = item.decision
      if (decision !== null) {
        if (input.includeResultData) decision = RepeatDecisionV1Schema.parse(decision)
        else {
          const full = RepeatDecisionV1Schema.safeParse(decision)
          if (full.success) {
            const { resultData, ...metadata } = full.data
            void resultData
            decision = RepeatDecisionMetadataV1Schema.parse(metadata)
          } else decision = RepeatDecisionMetadataV1Schema.parse(decision)
        }
      }
      return RepeatOccurrenceReadItemSchema.parse({
        occurrence: RepeatOccurrenceV1Schema.parse(item.occurrence), decision,
      })
    })
    const seen = new Set<string>()
    for (const item of items) {
      const { occurrenceId, scope } = item.occurrence.identity
      if (seen.has(occurrenceId) || occurrenceId === input.cursor) {
        throw new DomainError('REPEAT_READBACK_PAGE_INVALID', 'Occurrence storage repeated an identity or its input cursor.', 409)
      }
      seen.add(occurrenceId)
      if (scope.workspaceId !== input.workspaceId || scope.workflowId !== input.workflowId
        || scope.runId !== input.runId || scope.workflowVersionId !== saved.workflow_version_id
        || scope.executionSemanticsVersion !== REPEAT_EXECUTION_SEMANTICS_VERSION) {
        throw new DomainError('REPEAT_READBACK_SCOPE_INVALID', 'Persisted repeat occurrence escaped the requested Run/version scope.', 409)
      }
    }
    const envelope = (values: RepeatOccurrenceReadItem[], nextCursor: string | null) => ({
      contractVersion: REPEAT_CONTRACT_VERSION,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      items: values,
      pageInfo: { nextCursor },
    })
    if (page.nextCursor !== null && page.nextCursor !== items.at(-1)?.occurrence.identity.occurrenceId) {
      throw new DomainError('REPEAT_READBACK_PAGE_INVALID', 'Occurrence storage returned an invalid continuation cursor.', 409)
    }
    // A caller opting into result data must still receive a bounded response.
    // Trim only the tail, then continue after the last actually returned item.
    // Never truncate a result or silently drop an interior occurrence.
    let nextCursor = page.nextCursor
    while (items.length > 0) {
      try { canonicalGraphJson(envelope(items, nextCursor), REPEAT_READBACK_MAX_BYTES); break }
      catch {
        if (items.length === 1) throw new DomainError('REPEAT_READBACK_ITEM_TOO_LARGE', 'A persisted occurrence exceeds the bounded readback page size.', 409)
        items.pop()
        nextCursor = items.at(-1)!.occurrence.identity.occurrenceId
      }
    }
    return RepeatRunReadbackSchema.parse(envelope(items, nextCursor))
  }
}
