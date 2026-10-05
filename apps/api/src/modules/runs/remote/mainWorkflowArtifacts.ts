import { isDeepStrictEqual as same } from 'node:util'
import { parseWorkflowArtifactResult } from '@graphql/contracts/workflow-artifact-result'
import type { WorkflowArtifactTerminalPorts } from './workflowArtifactResultProduction.js'
import { readAcceptedPlacement, readDispatchIntent } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { readNativeArtifactOutput, assertNativeArtifactOutputLive } from './nativeArtifactOutputPostgres.js'
import { readAcceptedRepeatRunLocked } from '../repeatStartRead.js'
import { DomainError } from '../../errors.js'

const unavailable = () => new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
  'The original Main terminal and native owner are unavailable.', 409)

export function createMainWorkflowArtifactTerminals(mainId: string): WorkflowArtifactTerminalPorts {
  const terminals: WorkflowArtifactTerminalPorts = {
    async artifactTerminalContext(sql, owner, capture, proof) {
      await terminals.assertArtifactTerminal(sql, owner, capture, proof)
      return { kind: 'main', mainId }
    },
    async assertArtifactTerminal(sql, owner, capture, proof) {
      owner.assertOwned()
      const placement = await readAcceptedPlacement(sql, capture.execution.runId, capture.execution.workflowNodeId)
      if (placement?.hostRef.kind !== 'main' || placement.hostRef.mainId !== mainId
        || !same(capture.source, proof.original) || !same(capture.session, proof.session)
        || proof.original.type !== 'history' || proof.original.history.terminalTurn?.result.outcome !== 'succeeded'
        || proof.lane?.providerId !== proof.original.history.terminalTurn.providerId
        || !capture.closureGeneration) throw unavailable()
      const closure = (await sql.query<{ expected_reference: unknown; closed: boolean }>(
        `select expected_reference,closed_at is not null as closed from execution_native_closures
          where execution_id=$1 and generation=$2 for share`,
        [capture.execution.id, capture.closureGeneration])).rows[0]
      if (!closure || !same(closure.expected_reference, capture.session)) throw unavailable()
      if (!closure.closed) capture.assertCurrent()
      owner.assertOwned()
    },
    async assertAdoptedArtifacts(sql, owner, capture) {
      owner.assertOwned()
      const snapshot = await readAcceptedRepeatRunLocked(sql, capture.execution.runId)
      const node = snapshot.version.definition.nodes.find(item => item.id === capture.execution.workflowNodeId)
      const original = await readDispatchIntent(sql, capture.execution.id)
      const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
      if (!node || node.kind === 'job' || !node.artifactOutputs || !intent
        || capture.source.type !== 'history' || !capture.source.history.terminalTurn) throw unavailable()
      const attempt = { workspaceId: snapshot.version.workspaceId, workflowId: snapshot.version.workflowId,
        runId: capture.execution.runId, nodeId: node.id, executionId: capture.execution.id,
        attemptId: intent.attemptId, placementHash: intent.bindingHash }
      const result = capture.source.history.terminalTurn.result
      const envelope = node.choice ? parseWorkflowArtifactResult(result, node.artifactOutputs, node.choice)
        : parseWorkflowArtifactResult(result, node.artifactOutputs)
      for (const mapping of envelope.artifactOutputs.outputs) {
        const output = await readNativeArtifactOutput(sql, mainId, attempt, mapping.outputKey)
        if (!output || !('mainPublication' in output) || output.commandId !== mapping.commandId
          || output.nativeIdentity.nativeSessionId !== capture.session.nativeSessionId
          || output.nativeIdentity.turnId !== capture.source.history.terminalTurn.providerId) throw unavailable()
        await assertNativeArtifactOutputLive(sql, mainId, output)
      }
      owner.assertOwned()
    },
  }
  return terminals
}
