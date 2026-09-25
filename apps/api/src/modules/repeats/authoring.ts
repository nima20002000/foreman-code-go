import { createHash, randomUUID } from 'node:crypto'

import { AgentConfigurationVersionSchema, type AgentConfigurationVersion } from '@graphql/contracts'
import { RepeatCapabilitiesResultSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import {
  ExecutableRepeatWorkflowV1Schema,
  canonicalGraphJson,
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatCapabilityV1Schema,
  RepeatCapabilityRequestSchema,
  RepeatSaveInputSchema,
  RepeatMutationInputSchema,
  RepeatSavedWorkflowSchema,
  RepeatWorkflowVersionV1Schema,
  WorkflowVersionV2Schema,
  preserveWorkflowGeometry,
  sameExecutableWorkflow,
  type RepeatCapabilityRequest,
  type RepeatSaveInput,
  type RepeatMutationInput,
  type RepeatSavedWorkflow,
} from '@graphql/contracts/wave25'
import type pg from 'pg'

import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { RunManagementService } from '../runs/management.js'
import { createRepeatEditIntentService } from '../graph-drafts/repeatEditIntent.js'
import { assertMeaningfulSaveAdmitted } from '../graph-drafts/saveAdmission.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'

type Source = 'http' | 'mcp'
interface WorkflowRow {
  record: unknown
  revision: string
  current_version_id: string | null
  archived_at: Date | null
}

export class RepeatAuthoringService {
  readonly editIntents: ReturnType<typeof createRepeatEditIntentService>
  private editStop: RunManagementService['stop'] | undefined
  private repeatLifecycleReady = false
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly persistedReadback = false) {
    this.editIntents = createRepeatEditIntentService(pool, commands, {
      validate: async (client, principal, input) => {
        this.authorize(principal, input)
        return (await this.prepareVersion(client, principal, input, false)).candidate
      },
      publish: (principal, source, input, intentId) => this.publishEdit(principal, source, input, intentId),
      repeatStopReady: () => this.repeatLifecycleReady,
    })
  }

  /** Trusted application composition only; no request can opt into native v3.
   * The native owner must register support only after its Stop/closure path is
   * wired. This never substitutes for the authoritative settlement read. */
  bindEditStop(stop: RunManagementService['stop'], repeatLifecycleReady = false): void {
    this.editStop = stop
    this.repeatLifecycleReady = repeatLifecycleReady
  }

  async mutate(principal: ManagementPrincipal, source: Source, raw: RepeatMutationInput) {
    const input = RepeatMutationInputSchema.parse(raw)
    if (!('action' in input)) return this.save(principal, source, input)
    switch (input.action) {
      case 'stage_edits': return this.editIntents.stage(principal, source, input)
      case 'discard_edits': return this.editIntents.discard(principal, source, input)
      case 'stop_and_save': return this.editIntents.advance(principal, source, input, async (...args) => {
        if (!this.editStop) throw new DomainError('REPEAT_STOP_UNAVAILABLE',
          'The existing Stop service is not composed. The staged payload and exact commands are retained.', 503)
        return this.editStop(...args)
      })
    }
  }

  private async publishEdit(principal: ManagementPrincipal, source: Source, input: RepeatSaveInput, intentId: string) {
    return this.commands.execute<RepeatSavedWorkflow>({
      principal, source, operation: 'repeat.save', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}:repeat`, payload: input,
      replayResult: (result) => RepeatSavedWorkflowSchema.parse(result),
      authorize: async (client) => {
        principal = await readLiveManagementPrincipal(client, principal.id)
        this.authorize(principal, input)
        await this.editIntents.authorizeSave(client, principal, intentId, input)
      },
      perform: async (client) => {
        await this.editIntents.publication(client, principal, intentId, input)
        const value = await this.persist(client, principal, source, input)
        // Same transaction as the typed witness, immutable version, pointer,
        // command receipt and audit. A lost reply cannot leave a saved gap.
        await this.editIntents.saved(client, principal, intentId, value)
        return value
      },
    })
  }

  capabilities(principal: ManagementPrincipal, value: RepeatCapabilityRequest) {
    const raw = RepeatCapabilityRequestSchema.parse(value)
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
    const contract = RepeatCapabilityV1Schema.parse({
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
    return RepeatCapabilitiesResultSchema.parse({
      ...contract,
      supported: false,
      availability: {
        savedAuthoring: true, persistedReadback: this.persistedReadback,
        runtimeAdmission: false, meaningfulEdit: false,
        reasons: ['NATIVE_START_NOT_READY', 'REPEAT_EDIT_INTENT_NOT_READY'],
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
    requireAuthorization(principal, 'agents:read', resource)
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
        const reserved = await client.query(`select id from graph_edit_intents
          where principal_id=$1 and record->'saveInput'->>'commandId'=$2 limit 1`, [principal.id, input.commandId])
        if (reserved.rows[0]) throw new DomainError('GRAPH_EDIT_USE_INTENT',
          'This save identity belongs to a durable edit intent. Advance/read that exact intent instead of publishing directly.', 409)
      },
      perform: async (client) => this.persist(client, principal, source, input),
    })
  }

  private async prepareVersion(client: pg.PoolClient, principal: ManagementPrincipal, input: Omit<RepeatSaveInput, 'commandId'>, publication: boolean) {
    await lockActiveWorkspace(client, input.workspaceId)
    const current = await client.query<WorkflowRow>(
      `select record, revision::text, current_version_id, archived_at
       from workflows where workspace_id=$1 and id=$2 for update`,
      [input.workspaceId, input.workflowId],
    )
    const workflow = current.rows[0]
    if (!workflow) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
    if (workflow.archived_at) throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.', 409)
    const revision = Number(workflow.revision)
    if (!Number.isSafeInteger(revision) || revision !== input.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'The workflow changed since it was read.', 409, {
        ...(Number.isSafeInteger(revision) ? { currentRevision: revision } : {}),
      })
    }
    if (!workflow.current_version_id || workflow.current_version_id !== input.expectedWorkflowVersionId) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The current immutable workflow version changed since repeat authoring was read.', 409, {
        currentWorkflowVersionId: workflow.current_version_id,
      })
    }

    const versionRow = await client.query<{ record: unknown; execution_semantics_version: number; version: number; entry_node_id: string }>(
      `select record, execution_semantics_version, version, entry_node_id from workflow_versions
       where id=$1 and workspace_id=$2 and workflow_id=$3 for share`,
      [input.expectedWorkflowVersionId, input.workspaceId, input.workflowId],
    )
    const rawVersion = versionRow.rows[0]
    if (!rawVersion) throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The pinned immutable workflow version is unavailable.', 409)
    if (rawVersion.execution_semantics_version !== 2 && rawVersion.execution_semantics_version !== 3) {
      throw new DomainError('REPEAT_UNSUPPORTED_BASE_VERSION',
        'Repeat authoring requires an exact saved semantics-2 or semantics-3 version. Legacy and unknown versions are not converted.', 409)
    }
    const base = rawVersion.execution_semantics_version === 3
      ? RepeatWorkflowVersionV1Schema.safeParse(rawVersion.record)
      : WorkflowVersionV2Schema.safeParse(rawVersion.record)
    if (!base.success || base.data.id !== input.expectedWorkflowVersionId
      || base.data.workspaceId !== input.workspaceId || base.data.workflowId !== input.workflowId
      || base.data.version !== rawVersion.version || base.data.entryNodeId !== rawVersion.entry_node_id) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The immutable version record does not match all of its persisted scope and version pins.', 409)
    }

    // Management may rename a workflow without an executable publication, and
    // layout writes may change geometry. Preserve exactly those current values;
    // never smuggle a different executable topology through repeat-only save.
    const currentGraph = rawVersion.execution_semantics_version === 3
      ? RepeatWorkflowVersionV1Schema.shape.definition.safeParse(workflow.record)
      : WorkflowVersionV2Schema.shape.definition.safeParse(workflow.record)
    const comparableGraph = currentGraph.success
      ? { ...currentGraph.data, name: base.data.definition.name, description: base.data.definition.description }
      : null
    if (!currentGraph.success || currentGraph.data.version !== base.data.version
      || !comparableGraph || !sameExecutableWorkflow(base.data.definition, comparableGraph)) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The current definition no longer matches its immutable executable base.', 409)
    }
    const presented = preserveWorkflowGeometry(base.data.definition, currentGraph.data)

    if (publication) await assertMeaningfulSaveAdmitted(client, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      stagedAgentIds: [],
    })

    const pins = Object.values(base.data.agentConfigurationVersionIds)
    const rows = await client.query<{ id: string; workspace_id: string; agent_id: string; record: unknown }>(
      `select id, workspace_id, agent_id, record from agent_configuration_versions
       where workspace_id=$1 and id=any($2::text[]) order by id for share`,
      [input.workspaceId, pins],
    )
    const configurations: AgentConfigurationVersion[] = rows.rows.map((row) => {
      const configuration = AgentConfigurationVersionSchema.safeParse(row.record)
      if (!configuration.success || configuration.data.id !== row.id
        || configuration.data.workspaceId !== row.workspace_id || configuration.data.agentId !== row.agent_id) {
        throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'An immutable configuration record does not match its persisted identity.', 409)
      }
      return configuration.data
    })
    if (configurations.length !== pins.length) {
      throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'Every repeat workflow Agent requires its exact persisted configuration pin.', 409)
    }

    // Reusing an immutable pin is not a way around current publication authority.
    // No Agent is edited here, so shared-Agent write authority is not requested.
    for (const configuration of configurations) {
      requireAuthorization(principal, 'agents:read', input)
      if (configuration.assignedSkills?.length) requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
      if (configuration.harness.harness === 'codex' && configuration.harness.sandbox === 'danger-full-access') {
        requireAuthorization(principal, 'harnesses:update', input)
      }
      assertNativeWorkflowConfiguration(configuration.harness, base.data.approval,
        base.data.approval.handler === 'orchestrator'
          && configuration.agentId === base.data.approval.designatedOrchestratorAgentId)
    }

    const nextVersion = Number((await client.query<{ next: string }>(
      'select coalesce(max(version),0)+1 as next from workflow_versions where workflow_id=$1',
      [input.workflowId],
    )).rows[0]?.next)
    if (!Number.isSafeInteger(nextVersion) || nextVersion <= base.data.version) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The next immutable version number is invalid.', 409)
    }
    const now = new Date().toISOString()
    const candidate = RepeatWorkflowVersionV1Schema.safeParse(JSON.parse(JSON.stringify({
      ...base.data,
      id: `workflow-version-${randomUUID()}`,
      version: nextVersion,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      definition: {
        ...presented,
        name: currentGraph.data.name,
        description: currentGraph.data.description,
        version: nextVersion,
        executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
        repeat: input.repeat,
        updatedAt: now,
      },
      createdAt: now,
    })))
    if (!candidate.success) {
      throw new DomainError('REPEAT_INVALID', 'The repeat plan is unsupported or inconsistent with the saved workflow.', 409, {
        issues: candidate.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      })
    }

    // Same canonical hash payload as the v2 publisher, with the actual v3
    // definition (including the repeat plan), never the inherited base hash.
    const contentJson = canonicalGraphJson({
      definition: candidate.data.definition,
      configurations: candidate.data.agentConfigurationVersionIds,
      entryNodeId: candidate.data.entryNodeId,
    })
    candidate.data.contentHash = `sha256:${createHash('sha256').update(contentJson).digest('hex')}`

    const executable = ExecutableRepeatWorkflowV1Schema.safeParse({ version: candidate.data, configurations })
    if (!executable.success) {
      throw new DomainError('REPEAT_CONFIGURATION_INVALID', 'Pinned Agent configuration is not executable for this repeat workflow.', 409, {
        issues: executable.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      })
    }

    return { candidate: candidate.data, contentJson }
  }

  private async persist(client: pg.PoolClient, principal: ManagementPrincipal, source: Source, input: RepeatSaveInput): Promise<RepeatSavedWorkflow> {
    const { candidate, contentJson } = await this.prepareVersion(client, principal, input, true)
    await client.query(
      `insert into workflow_versions
        (id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
       values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [candidate.id, candidate.workspaceId, candidate.workflowId, candidate.version,
        candidate.entryNodeId, JSON.stringify(candidate), REPEAT_EXECUTION_SEMANTICS_VERSION],
    )
    const updated = await client.query<{ revision: string }>(
      // The additive writer validates the exact transition and requires this
      // command's receipt/audit at COMMIT. A GUC cannot authorize the upgrade.
      `select eng04_publish_repeat_workflow($1,$2,$3::jsonb,$4,$5,$6)::text as revision`,
      [principal.id, source, JSON.stringify(input), commandInputHash(input), candidate.id, contentJson],
    )
    if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The workflow changed during repeat publication.', 409)

    return RepeatSavedWorkflowSchema.parse({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      revision: Number(updated.rows[0]!.revision),
      currentVersionId: candidate.id,
      version: candidate,
    })
  }
}
