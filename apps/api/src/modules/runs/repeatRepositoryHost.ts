import { AgentConfigurationVersionSchema, type HarnessExecution } from '@graphql/contracts'
import {
  AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema, RepeatWorkflowVersionV1Schema,
  SavedRunVersionSnapshotSchema, type AcceptedWorkflowRunV3, type RepeatWorkflowVersionV1,
} from '@graphql/contracts/wave25'
import type pg from 'pg'

import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { RunOwnership } from './ownership.js'
import { resolveExecutionDirectory } from './executionDirectory.js'
import { RepeatRunRepository, type RepeatEffect, type RepeatFact, type RepeatLockedHooks, type RepeatRepositoryHost } from './repeatPostgres.js'
import { requireRepeatNativeHooks, type RepeatNativeBoundaryEvidence, type RepeatNativeChange,
  type RepeatNativeEvidence, type RepeatLaunchClaim } from './repeatNativeRepository.js'
import { assertRepeatExecution, repeatConflict, repeatId, sameRepeatValue, type RepeatNodeRef, type RepeatScope, type RepeatSource } from './repeatResolution.js'

/** Required canonical-publication adapter on the existing Run/head transaction.
 * The central repository binds the real N1 producer; native authority and Run
 * lifecycle services remain mandatory. No v3 -> v2 coercion is permitted. */
export interface RepeatCanonicalPublication {
  readonly sql: GraphTransactionSql
  readonly scope: RepeatScope
  publishEffectLocked(effect: RepeatEffect, facts: readonly RepeatFact[], mutate: () => Promise<void>): Promise<void>
  assertEffectReceiptLocked(effect: RepeatEffect): Promise<void>
  publishNativeLocked(change: RepeatNativeChange, mutate: () => Promise<void>): Promise<void>
  /** Native sources use sourceKind='execution' and the exact supplied source ID,
   * revision and private digest, including when G1 chooses a reset barrier. */
  assertNativeReceiptLocked(change: RepeatNativeChange): Promise<void>
  assertLaunchReceiptLocked(claim: RepeatLaunchClaim, digest: string): Promise<void>
}
export interface RepeatRepositoryServices {
  /** Must open the EXISTING canonical publication on this exact transaction and
   * existing head. It must enlist same-transaction receipt checks before COMMIT. */
  openPublicationLocked(sql: GraphTransactionSql, scope: RepeatScope, owner: RunOwnership): Promise<RepeatCanonicalPublication>
  /** Existing coordinator/manager authority; verifies exact owner/session/lane,
   * generation, possible-submission, command and raw-event provenance. */
  assertNativeBoundaryLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    execution: HarnessExecution, ref: RepeatNodeRef, evidence: RepeatNativeBoundaryEvidence): Promise<void>
  assertNativeUpdateLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    previous: HarnessExecution, incoming: HarnessExecution, ref: RepeatNodeRef, evidence: RepeatNativeEvidence): Promise<void>
  /** Existing engine/lifecycle policy, not a second scheduler or finishRun call. */
  assertSettlementLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, ids: readonly string[], owner: RunOwnership): Promise<void>
  allowTechnicalRetryLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: RepeatWorkflowVersionV1, execution: HarnessExecution): Promise<boolean>
  completeRunLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: RepeatWorkflowVersionV1, terminals: readonly RepeatSource[]): Promise<void>
}

/** The same lexical isolation helper as native runs, with the globally unique
 * execution ID as its leaf identity. node+attempt alone collides across business
 * occurrences. This computes a path only; it allocates no directory. */
export function repeatRuntimeDirectory(root: string, scope: RepeatScope, execution: HarnessExecution): string {
  if (execution.runId !== scope.runId || scope.executionSemanticsVersion !== 3) return repeatConflict('REPEAT_SCOPE_CONFLICT')
  return resolveExecutionDirectory(root, scope.runId, execution.id, execution.attempt, scope.workspaceId)
}

/** One factory/store/ephemeral permit set per EXISTING Run owner. A recovered
 * owner gets a new repository and cannot inherit a prior native launch permit. */
export class RepeatRepositoryFactory {
  private readonly stores = new WeakMap<RunOwnership, { version: RepeatWorkflowVersionV1; store: RepeatRunRepository }>()
  constructor(private readonly locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization'>,
    private readonly runtimeRoot: string, private readonly services: RepeatRepositoryServices) {
    if (!locations || typeof locations.revalidateRunAuthorization !== 'function' || !runtimeRoot
      || !services || ['openPublicationLocked', 'assertNativeBoundaryLocked', 'assertNativeUpdateLocked',
        'assertSettlementLocked', 'allowTechnicalRetryLocked', 'completeRunLocked'].some((key) =>
        typeof services[key as keyof RepeatRepositoryServices] !== 'function')) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
  }
  forOwner(owner: RunOwnership, suppliedVersion: RepeatWorkflowVersionV1): RepeatRunRepository {
    owner.assertOwned()
    const version = RepeatWorkflowVersionV1Schema.parse(suppliedVersion)
    const prior = this.stores.get(owner)
    if (prior) {
      if (!sameRepeatValue(prior.version, version)) return repeatConflict('RUN_PIN_CONFLICT')
      return prior.store
    }
    const host: RepeatRepositoryHost = { openLocked: (sql, scope, record, actualVersion) =>
      this.openLocked(owner, sql, scope, record, actualVersion) }
    const store = new RepeatRunRepository(owner, host, version)
    this.stores.set(owner, { version, store })
    return store
  }

  /** Consumption never constructs a store or recreates a capability from SQL. */
  consumeLaunchPermit(owner: RunOwnership, executionId: string): boolean {
    owner.assertOwned()
    return this.stores.get(owner)?.store.consumeLaunchPermit(executionId) === true
  }

  private async openLocked(owner: RunOwnership, sql: GraphTransactionSql, scope: RepeatScope,
    record: unknown, version: RepeatWorkflowVersionV1): Promise<RepeatLockedHooks> {
    assertGraphTransaction(sql)
    owner.assertOwned()
    if (scope.runId !== owner.runId) return repeatConflict('REPEAT_SCOPE_CONFLICT')
    const run = AcceptedWorkflowRunV3Schema.parse(record)
    SavedRunVersionSnapshotSchema.parse({ run, version })
    if (run.id !== scope.runId || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
      || run.workflowVersionId !== scope.workflowVersionId || scope.executionSemanticsVersion !== 3) return repeatConflict('RUN_PIN_CONFLICT')
    // The enclosing RepeatRunRepository has the Run lock already. No new pool,
    // transaction, head initialization, owner or execution is acquired here.
    const physical = (await sql.query<{ workspace_id: string; workflow_id: string; workflow_version_id: string;
      execution_state: string; execution_semantics_version: number }>(`select r.workspace_id,r.workflow_id,r.workflow_version_id,
        r.execution_state,v.execution_semantics_version from runs r join workflow_versions v on v.id=r.workflow_version_id
        where r.id=$1`, [run.id])).rows[0]
    if (!physical || physical.workspace_id !== scope.workspaceId || physical.workflow_id !== scope.workflowId
      || physical.workflow_version_id !== scope.workflowVersionId || physical.execution_semantics_version !== 3
      || physical.execution_state !== run.executionState) return repeatConflict('RUN_PIN_CONFLICT')
    const head = await sql.query<{ protocol_version: number }>(
      'select protocol_version from run_graph_heads where run_id=$1 for update', [run.id])
    if (!head.rows[0] || head.rows[0].protocol_version !== 1) return repeatConflict('GRAPH_NOT_INITIALIZED')
    const publication = await this.services.openPublicationLocked(sql, scope, owner)
    if (publication.sql !== sql || !sameRepeatValue(publication.scope, scope)
      || ['publishEffectLocked', 'assertEffectReceiptLocked', 'publishNativeLocked', 'assertNativeReceiptLocked',
        'assertLaunchReceiptLocked'].some((key) => typeof publication[key as keyof RepeatCanonicalPublication] !== 'function')) {
      return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
    }
    await owner.readOneShotFence(sql)
    const sameTransaction = (transaction: GraphTransactionSql) => {
      assertGraphTransaction(transaction)
      if (transaction !== sql) return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
      owner.assertOwned()
    }
    const configurations = async () => {
      const rows = await sql.query<{ id: string; agent_id: string; workspace_id: string; record: unknown }>(
        'select id,agent_id,workspace_id,record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id for share',
        [scope.workspaceId, Object.values(version.agentConfigurationVersionIds)])
      const parsed = rows.rows.map((item) => {
        const value = AgentConfigurationVersionSchema.parse(item.record)
        if (item.id !== value.id || item.agent_id !== value.agentId || item.workspace_id !== value.workspaceId
          || item.workspace_id !== scope.workspaceId) return repeatConflict('RUN_PIN_CONFLICT')
        return value
      })
      ExecutableWorkflowV3Schema.parse({ version, configurations: parsed })
      for (const value of parsed) assertNativeWorkflowConfiguration(value.harness, run.approval,
        run.approval.handler === 'orchestrator' && value.agentId === run.approval.designatedOrchestratorAgentId)
    }
    const authority = async (transaction: GraphTransactionSql) => {
      sameTransaction(transaction)
      // Require the authenticated accepted Run authority. No uncredentialed-v3
      // fixture exception, inherited new grant, or read-only promotion exists.
      const id = run.authorizationPrincipalId
      await sql.query(`select principal_id from run_authority_principals
        where principal_id=$1 and run_id=$2 for share`, [id, run.id])
      await sql.query(`select p.id from management_principals p where p.id=$1
        or p.id=(select owner_principal_id from run_authority_principals where principal_id=$1 and run_id=$2)
        order by p.id for share`, [id, run.id])
      await this.locations.revalidateRunAuthorization(id, run.workspaceId, run.workflowId,
        sql as unknown as Pick<pg.PoolClient, 'query'>)
      await owner.readOneShotFence(sql)
    }
    const hooks: RepeatLockedHooks = {
      run,
      assertAuthorityLocked: authority,
      assertAdmissionLocked: async (transaction, execution, ref) => {
        sameTransaction(transaction)
        assertRepeatExecution(version, scope, ref, execution)
        await authority(sql)
        await configurations()
      },
      assertSettlementLocked: async (transaction, ids) => {
        sameTransaction(transaction)
        // Concrete per-execution closure proof has already run in the repository.
        // This retains additional existing global/owner obligations, not grants.
        const fence = await owner.readOneShotFence(sql)
        await this.services.assertSettlementLocked(sql, run, ids, owner)
        sameTransaction(transaction)
        if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) return repeatConflict('RUN_OWNERSHIP_LOST')
      },
      allowTechnicalRetryLocked: async (transaction, execution) => {
        sameTransaction(transaction)
        await authority(sql)
        await configurations()
        return this.services.allowTechnicalRetryLocked(sql, run, version, execution)
      },
      publishLocked: async (transaction, effect, facts, mutate) => {
        sameTransaction(transaction)
        await publication.publishEffectLocked(effect, facts, mutate)
      },
      assertPublicationReceiptLocked: async (transaction, effect) => {
        sameTransaction(transaction)
        await publication.assertEffectReceiptLocked(effect)
      },
      completeRunLocked: async (transaction, terminals) => {
        sameTransaction(transaction)
        await this.services.completeRunLocked(sql, run, version, terminals)
      },
      native: {
        assertLaunchLocked: async (transaction, execution, ref, paths) => {
          sameTransaction(transaction)
          assertRepeatExecution(version, scope, ref, execution)
          await authority(sql)
          await configurations()
          if (paths.workingDirectory !== run.executionLocation.rootPath
            || paths.runtimeDirectory !== repeatRuntimeDirectory(this.runtimeRoot, scope, execution)) return repeatConflict('RUN_LOCATION_MISSING')
        },
        assertBoundaryLocked: async (transaction, execution, ref, evidence) => {
          sameTransaction(transaction)
          assertRepeatExecution(version, scope, ref, execution)
          await authority(sql)
          await configurations()
          await this.services.assertNativeBoundaryLocked(sql, run, execution, ref, evidence)
        },
        assertUpdateLocked: async (transaction, previous, incoming, ref, evidence) => {
          sameTransaction(transaction)
          assertRepeatExecution(version, scope, ref, previous)
          assertRepeatExecution(version, scope, ref, incoming)
          await this.services.assertNativeUpdateLocked(sql, run, previous, incoming, ref, evidence)
        },
        publishLocked: async (transaction, change, mutate) => {
          sameTransaction(transaction)
          await publication.publishNativeLocked(change, mutate)
        },
        assertReceiptLocked: async (transaction, change) => {
          sameTransaction(transaction)
          await publication.assertNativeReceiptLocked(change)
          requireRepeatCanonicalReceiptBeforeCommit(sql, {
            scope, evidence: { sourceKind: 'execution', sourceId: change.sourceId, sourceRevision: change.sourceRevision },
            sourceDigest: change.sourceDigest, effect: change.effect,
          })
        },
        assertLaunchReceiptLocked: async (transaction, claim, digest) => {
          sameTransaction(transaction)
          await publication.assertLaunchReceiptLocked(claim, digest)
          requireRepeatCanonicalReceiptBeforeCommit(sql, {
            scope, evidence: { sourceKind: 'execution', sourceId: repeatId('repeat-native', scope.runId,
              claim.ref.occurrence?.occurrenceId ?? 'outside', claim.executionId, 'launch', digest), sourceRevision: '1' },
            sourceDigest: digest, effect: { kind: 'execution.launch', entityId: claim.executionId, digest },
          })
        },
      },
    }
    requireRepeatNativeHooks(hooks.native)
    return hooks
  }
}
