import { awaitNativeOutputContext } from './nativeOutputAdmission.js'
import { isDeepStrictEqual as same } from 'node:util'
import type { ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import type { AcceptedMainArtifactPublication } from '../../files/distributed/publication.js'
import type { MainArtifactPublications } from '../../files/distributed/mainPublication.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import type { NativeManagerResolutionContext } from '../../interactions/runtimePorts.js'
import type { RunOwnership } from '../ownership.js'
import { createBufferedNativeOutputs, type NativeOutputMemoryBudget } from './bufferedNativeOutput.js'
import { DomainError } from '../../errors.js'

export function createMainWorkflowNativeOutputs(input: {
  intent: DispatchIntent
  context: NativeManagerResolutionContext
  getOwner(): RunOwnership | undefined
  authority(): PostgresArtifactPublicationAuthority
  publications(): MainArtifactPublications
  budget: NativeOutputMemoryBudget
}) {
  const owner = () => {
    const current = input.getOwner()
    if (!current || current.runId !== input.intent.runId) throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED',
      'The original workflow owner is unavailable.', 403)
    current.assertOwned()
    return current
  }
  const withAttempt = <T>(work: (attempt: ArtifactAttempt, sql: GraphTransactionSql) => Promise<T>) =>
    owner().oneShotConnection().transaction(async sql => {
      const run = (await sql.query<{ workspace_id: string; workflow_id: string }>(
        'select workspace_id,workflow_id from runs where id=$1 for share', [input.intent.runId])).rows[0]
      if (!run || run.workspace_id !== input.context.configuration.workspaceId) throw new DomainError(
        'NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The accepted workflow scope is unavailable.', 403)
      const attempt = { workspaceId: run.workspace_id, workflowId: run.workflow_id, runId: input.intent.runId,
        nodeId: input.intent.nodeId, executionId: input.intent.executionId, attemptId: input.intent.attemptId,
        placementHash: input.intent.bindingHash }
      return work(attempt, sql)
    })
  let accepted: AcceptedMainArtifactPublication | undefined
  return createBufferedNativeOutputs({ budget: input.budget,
    assertCurrent: async signal => {
      signal?.throwIfAborted()
      await withAttempt((attempt, sql) => input.authority().authorizeMainNativeOutputDeclarations(attempt, sql))
      signal?.throwIfAborted()
      owner()
    },
    assertQualified: async (qualification, signal) => {
      signal.throwIfAborted()
      if (!same(qualification.configuration, input.context.configuration.harness)
        || ('directory' in qualification ? qualification.directory : qualification.expectedSandbox.cwd)
          !== input.context.workingDirectory) throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED',
        'Output tools must use the accepted native configuration and directory.', 403)
      await withAttempt((attempt, sql) => input.authority().authorizeMainNativeOutputDeclarations(attempt, sql))
      signal.throwIfAborted()
    },
    authorize: async (pin, operation, signal) => {
      signal?.throwIfAborted()
      pin.assertCurrent()
      const current = await awaitNativeOutputContext(async bounded => {
        bounded.throwIfAborted()
        pin.assertCurrent()
        const context = await withAttempt((attempt, sql) => input.authority().authorizeMainNativeOutput(
          attempt, pin.session.nativeSessionId, pin.nativeTurnId, operation, sql))
        pin.assertCurrent()
        return context
      }, signal)
      pin.assertCurrent()
      if (accepted && !same(accepted, current)) throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED',
        'The original output publication context changed.', 403)
      accepted ??= current
      return current.context.scope
    },
    publish: async (publication, source, callback, signal) => {
      if (!accepted) throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'Output publication has no admitted context.', 403)
      const snapshot = await source.sealed(publication, callback, signal)
      return input.publications().publish(accepted, publication, snapshot, signal)
    },
  })
}
