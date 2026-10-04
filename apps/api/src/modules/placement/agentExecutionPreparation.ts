import type { HarnessExecution } from '@graphql/contracts'
import type { AcceptedWorkflowRunV3 } from '@graphql/contracts/wave25'
import type { NativeExecutionPlacement } from '@graphql/contracts/node-placement'
import type { SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import { sourceBindingHash } from '../sources/bindingHash.js'
import { posix } from 'node:path'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { RunOwnership } from '../runs/ownership.js'
import { repeatRuntimeDirectory } from '../runs/repeatRepositoryHost.js'
import { DomainError } from '../errors.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement, insertNativePlacement } from './persistence.js'
import { bindNativeExecution } from './executionBinding.js'
import type { AgentPlacementProducer } from './agentProducer.js'

type NativeSourcePort = SourceAdmissionPort & {
  adoptFinalBinding(sql: GraphSqlClient, principal: ManagementPrincipal, record: SourceMaterializationRecord, hash: string): Promise<SourceMaterializationRecord>
}
/** Called only after eligible execution/intent COMMIT. Source copying stays
 * outside G1; final materialized evidence is adopted on the original owner. */
export class AgentExecutionPreparation {
  constructor(private readonly sources: NativeSourcePort, private readonly producer: AgentPlacementProducer) {}
  async prepare(owner: RunOwnership, run: AcceptedWorkflowRunV3, execution: HarnessExecution) {
    const accepted = await owner.oneShotConnection().transaction(async sql => {
      const placement = await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)
      if (!placement) return undefined
      const intent = await readDispatchIntent(sql, execution.id)
      if (!intent || placement.payload.kind !== 'agent' || placement.payload.agentConfigurationVersionId !== execution.agentConfigurationVersionId
        || !('kind' in placement.source) || placement.source.kind !== 'pending') this.conflict()
      const principal = await readLiveManagementPrincipal(sql, run.authorizationPrincipalId)
      await this.producer.assertPinsCurrent(sql, placement, principal, run.workspaceId)
      const source = placement.source as Extract<typeof placement.source, { kind: 'pending' }>
      const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId: run.workspaceId, rootId: source.rootId,
        bindingRevision: source.bindingRevision, source: { approvedSourceId: source.approvedSourceId, snapshotId: source.snapshotId, manifestDigest: source.manifestDigest } })
      return { placement, intent: intent!, principal, root, previous: await readNativePlacement(sql, execution.id) }
    })
    if (!accepted) return undefined
    const { placement, intent, principal, root } = accepted
    const assertCurrent = async () => {
      owner.assertOwned()
      await owner.oneShotConnection().transaction(sql => this.producer.assertPinsCurrent(sql, placement, principal, run.workspaceId))
    }
    const relativeCwd = posix.relative(placement.destination.canonicalProjectRoot, placement.destination.canonicalCwd)
    let native: NativeExecutionPlacement
    if (accepted.previous) {
      // Remote result reads attest the original directories and closed process together.
      // Requiring a live source owner here would prevent reading a completed turn.
      if (placement.hostRef.kind !== 'device' || !execution.nativeSessionId) {
        const tree = await this.sources.verifyWorkingDirectory({ principal, record: accepted.previous.materialization, relativeCwd })
        if (!sameWorkflowValue(tree, accepted.previous.workingTree)) this.conflict()
      }
      native = accepted.previous
    } else {
      const attempt = { executionId: intent.executionId, attemptId: intent.attemptId,
        keyRevision: placement.registration?.keyRevision ?? null, authorizationRevision: placement.registration?.authorizationRevision ?? null }
      const record = await this.sources.prepareExecution({ principal, workspaceId: run.workspaceId, rootId: root.binding.rootId,
        bindingRevision: root.binding.bindingRevision, source: root.source, operationId: intent.operationId,
        attempt: { ...attempt, placementHash: sourceBindingHash(root, attempt, intent.operationId) } })
      owner.assertOwned()
      const tree = await this.sources.verifyWorkingDirectory({ principal, record, relativeCwd })
      const prepared = bindNativeExecution(placement, intent, record, tree)
      native = await owner.oneShotConnection().transaction(async sql => {
        owner.assertOwned(); await owner.readOneShotFence(sql)
        await this.producer.assertPinsCurrent(sql, placement, principal, run.workspaceId)
        const entry = await sql.query("select 1 from workflow_native_entries where execution_id=$1 and run_id=$2 and phase='reserved' for update", [execution.id, run.id])
        if (entry.rowCount !== 1) this.conflict()
        await insertNativePlacement(sql, owner, prepared)
        const adopted = await this.sources.adoptFinalBinding(sql, principal, record, prepared.bindingHash)
        beforeGraphCommit(sql, () => this.producer.assertPinsCurrent(sql, placement, principal, run.workspaceId))
        // Stored clone evidence hashes exclude adoption to avoid a circular digest.
        return { ...prepared, materialization: adopted }
      })
    }
    const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId,
      runId: run.id, executionSemanticsVersion: 3 as const }
    return { workingDirectory: native.workingTree.canonicalCwd,
      runtimeDirectory: repeatRuntimeDirectory(placement.destination.managedRuntimeRoot, scope, execution),
      revalidate: async () => {
        await assertCurrent()
        // The Worker checks directories on native entry and every physical result read.
        if (placement.hostRef.kind === 'device') return
        const tree = await this.sources.verifyWorkingDirectory({ principal, record: native.materialization, relativeCwd })
        if (!sameWorkflowValue(tree, native.workingTree)) this.conflict()
      } }
  }
  private conflict(): never { throw new DomainError('EXECUTION_PLACEMENT_CONFLICT', 'Exact accepted source/attempt preparation is required before native entry.', 409) }
}
