import { NativeExecutionPlacementSchema, type AcceptedNodePlacement, type DispatchIntent, type NativeExecutionPlacement } from '@graphql/contracts/node-placement'
import type { SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@graphql/contracts/source-admission'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { placementDigest, readPlacement } from './binding.js'
import { sourceMaterializationDigest } from '../sources/bindingHash.js'

export function nativePlacementDigest(input: Omit<NativeExecutionPlacement, 'bindingHash'>): string {
  return placementDigest({ ...input, materialization: { ...input.materialization, finalDispatchBindingHash: null } })
}
export function bindNativeExecution(placement: AcceptedNodePlacement, intent: DispatchIntent,
  materialization: SourceMaterializationRecord, workingTree: VerifiedSourceWorkingTree): NativeExecutionPlacement {
  const input = { version: 1 as const, acceptedBindingHash: placement.bindingHash, runId: intent.runId, nodeId: intent.nodeId,
    executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId, materialization, workingTree }
  return readNativeExecutionBinding(placement, intent, { ...input, bindingHash: nativePlacementDigest(input) })
}
export function readNativeExecutionBinding(parent: AcceptedNodePlacement, intent: DispatchIntent, raw: unknown): NativeExecutionPlacement {
  const placement = readPlacement(parent), binding = NativeExecutionPlacementSchema.parse(raw), { bindingHash, ...input } = binding
  const receipt = binding.materialization.receipt
  const source = placement.source
  if (!('kind' in source) || source.kind !== 'pending' || placement.bindingHash !== intent.bindingHash
    || bindingHash !== nativePlacementDigest(input) || binding.acceptedBindingHash !== placement.bindingHash
    || binding.runId !== placement.runId || binding.runId !== intent.runId || binding.nodeId !== placement.nodeId
    || binding.nodeId !== intent.nodeId || binding.executionId !== intent.executionId || binding.attemptId !== intent.attemptId
    || binding.operationId !== intent.operationId || binding.materialization.operationId !== intent.operationId
    || receipt.executionId !== intent.executionId || receipt.attemptId !== intent.attemptId
    || receipt.binding.rootId !== source.rootId || receipt.binding.bindingRevision !== source.bindingRevision
    || receipt.binding.snapshotId !== source.snapshotId || receipt.binding.manifestDigest !== source.manifestDigest
    || receipt.binding.mainId !== placement.mainId
    || receipt.binding.deviceId !== (placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : null)
    || binding.workingTree.materializationId !== receipt.materializationId
    || binding.workingTree.materializationDigest !== sourceMaterializationDigest(binding.materialization)
    || !sameWorkflowValue(binding.workingTree.filesystem, receipt.localTreeIdentity)) {
    throw new DomainError('EXECUTION_PLACEMENT_CONFLICT', 'Native source must be the exact materialized accepted execution.', 409)
  }
  return binding
}
