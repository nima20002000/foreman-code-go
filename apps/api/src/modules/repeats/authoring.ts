import { randomUUID } from 'node:crypto'

import { AgentConfigurationVersionSchema, type AgentConfigurationVersion } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  ExecutableWorkflowV2Schema,
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatCapabilityV1Schema,
  RepeatSaveInputSchema,
  RepeatSavedWorkflowSchema,
  RepeatWorkflowVersionV1Schema,
  WorkflowVersionV2Schema,
  type RepeatCapabilityRequest,
  type RepeatSaveInput,
  type RepeatSavedWorkflow,
} from '@graphql/contracts/wave25'
import type pg from 'pg'

import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { assertMeaningfulSaveAdmitted } from '../graph-drafts/saveAdmission.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

type Source = 'http' | 'mcp'
interface WorkflowRow {
  record: unknown
  revision: string
  current_version_id: string | null
  archived_at: Date | null
}

export class RepeatAuthoringService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  capabilities(principal: ManagementPrincipal, raw: RepeatCapabilityRequest) {
    if (raw.workflowId) {
      requireAuthorization(principal, 'capabilities:read', {})
      const resource = { ...(raw.workspaceId ? { workspaceId: raw.workspaceId } : {}), workflowId: raw.workflowId }
      requireAuthorization(principal, 'workflows:read', resource)
      requireAuthorization(principal, 'graph:read', resource)
    } else if (raw.workspaceId) {
      requireAuthorization(principal, 'capabilities:read', {})
      requireAuthorization(principal, 'workspaces:read', { workspaceId: raw.workspaceId })
    } else {
      requireAuthorization(principal, 'capabilities:read', {})
    }
    return RepeatCapabilityV1Schema.parse({
      contractVersion: REPEAT_CONTRACT_VERSION,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      supported: true,
      authoring: {
        flatScopesOnly: true,
        nesting: false,
        arbitraryCycles: false,
        maxOccurrencesMin: 1,
        maxOccurrencesMax: 2147483647,
        explicitLimitExit: true,
        earlyExitOutcome: true,
      },
    })
  }

  private authorize(principal: ManagementPrincipal, input: Pick<RepeatSaveInput, 'workspaceId' | 'workflowId'>): void {
    const resource = { workspaceId: input.workspaceId, workflowId: input.workflowId }
    requireAuthorization(principal, 'workflows:read', resource)
    requireAuthorization(principal, 'workflows:update', resource)
    requireAuthorization(principal, 'graph:read', resource)
    requireAuthorization(principal, 'graph:edit', resource)
    requireAuthorization(principal, 'graph:save', resource)
  }

  async save(principal: ManagementPrincipal, source: Source, raw: RepeatSaveInput) {
    const input = RepeatSaveInputSchema.parse(raw)
    this.authorize(principal, input)
    return this.commands.execute<RepeatSavedWorkflow>({
      principal,
      source,
      operation: 'repeat.save',
      commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}:repeat`,
      payload: input,
      replayResult: (result) => RepeatSavedWorkflowSchema.parse(result),
      authorize: async (client) => {
        principal = await readLiveManagementPrincipal(client, principal.id)
        this.authorize(principal, input)
      },
      perform: async (client) => this.persist(client, input),
    })
  }

  private async persist(client: pg.PoolClient, input: RepeatSaveInput): Promise<RepeatSavedWorkflow> {
    await lockActiveWorkspace(client, input.workspaceId)
    const current = await client.query<WorkflowRow>(
      `select record, revision::text, current_version_id, archived_at
       from workflows where workspace_id=$1 and id=$2 for update`,
      [input.workspaceId, input.workflowId],
    )
    const workflow = current.rows[0]
    if (!workflow) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
    if (workflow.archived_at) throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.', 409)
    if (Number(workflow.revision) !== input.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'The workflow changed since it was read.', 409, {
        currentRevision: Number(workflow.revision),
      })
    }
    if (!workflow.current_version_id || workflow.current_version_id !== input.expectedWorkflowVersionId) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The current immutable workflow version changed since repeat authoring was read.', 409, {
        currentWorkflowVersionId: workflow.current_version_id,
      })
    }

    const versionRow = await client.query<{ record: unknown; execution_semantics_version: number }>(
      `select record, execution_semantics_version from workflow_versions
       where id=$1 and workspace_id=$2 and workflow_id=$3 for share`,
      [input.expectedWorkflowVersionId, input.workspaceId, input.workflowId],
    )
    const rawVersion = versionRow.rows[0]
    if (!rawVersion) throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The pinned immutable workflow version is unavailable.', 409)
    const base = WorkflowVersionV2Schema.safeParse(rawVersion.record)
    if (!base.success || rawVersion.execution_semantics_version !== 2) {
      throw new DomainError(
        'REPEAT_UNSUPPORTED_BASE_VERSION',
        'Bounded repeat authoring requires an exact saved execution-semantics-2 workflow. Legacy, repeat, and unknown versions are not silently converted.',
        409,
      )
    }

    await assertMeaningfulSaveAdmitted(client, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      stagedAgentIds: [],
    })

    const pins = Object.values(base.data.agentConfigurationVersionIds)
    const rows = await client.query<{ record: unknown }>(
      `select record from agent_configuration_versions
       where workspace_id=$1 and id=any($2::text[]) order by id for share`,
      [input.workspaceId, pins],
    )
    const configurations: AgentConfigurationVersion[] = rows.rows.map((row) => AgentConfigurationVersionSchema.parse(row.record))
    if (configurations.length !== pins.length) {
      throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'Every repeat workflow Agent requires its exact persisted configuration pin.', 409)
    }

    // A0 deliberately has no separate ExecutableRepeat schema. Project only for the
    // existing immutable configuration/role/native checks; never persist this projection.
    const executableBase = {
      ...base.data,
      executionSemanticsVersion: 2 as const,
      definition: { ...base.data.definition, executionSemanticsVersion: 2 as const },
    }
    const executable = ExecutableWorkflowV2Schema.safeParse({ version: executableBase, configurations })
    if (!executable.success) {
      throw new DomainError('REPEAT_CONFIGURATION_INVALID', 'Pinned Agent configuration is not executable for this workflow.', 409, {
        issues: executable.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      })
    }

    const nextVersion = Number((await client.query<{ next: string }>(
      'select coalesce(max(version),0)+1 as next from workflow_versions where workflow_id=$1',
      [input.workflowId],
    )).rows[0]?.next ?? 1)
    const now = new Date().toISOString()
    const candidate = RepeatWorkflowVersionV1Schema.safeParse({
      ...base.data,
      id: `${input.workflowId}-v${nextVersion}-${randomUUID()}`,
      version: nextVersion,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      definition: {
        ...base.data.definition,
        version: nextVersion,
        executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
        repeat: input.repeat,
        updatedAt: now,
      },
      createdAt: now,
    })
    if (!candidate.success) {
      throw new DomainError('REPEAT_INVALID', 'The repeat plan is unsupported or inconsistent with the saved workflow.', 409, {
        issues: candidate.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      })
    }

    await client.query(
      `insert into workflow_versions
        (id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
       values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [candidate.data.id, candidate.data.workspaceId, candidate.data.workflowId, candidate.data.version,
        candidate.data.entryNodeId, JSON.stringify(candidate.data), REPEAT_EXECUTION_SEMANTICS_VERSION],
    )
    const updated = await client.query<{ revision: string }>(
      `update workflows set current_version_id=$3,record=$4::jsonb,revision=revision+1
       where workspace_id=$1 and id=$2 and revision=$5
       returning revision::text`,
      [input.workspaceId, input.workflowId, candidate.data.id, JSON.stringify(candidate.data.definition), input.expectedRevision],
    )
    if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The workflow changed during repeat publication.', 409)

    return RepeatSavedWorkflowSchema.parse({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      revision: Number(updated.rows[0]!.revision),
      currentVersionId: candidate.data.id,
      version: candidate.data,
    })
  }
}
