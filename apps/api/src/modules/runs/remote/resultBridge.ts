import { isDeepStrictEqual } from 'node:util'
import type { DeviceConnectionIdentity } from '@graphql/contracts/device-identity'
import type { DispatchIntent, AcceptedNodePlacement } from '@graphql/contracts/node-placement'
import { RemoteOperationReceiptSchema, type RemoteOperationReceipt, type RemoteNativeIdentity, type RemoteTerminalEvidence } from '@graphql/contracts/remote-execution'

export interface RemoteCommitAuthority {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  originalConnection: DeviceConnectionIdentity
  originalIncarnationId: string
  /** Evaluated by main in the same transaction as canonical acceptance/edge publication. */
  grantIsLive: boolean
  lastSequence: number
  native: RemoteNativeIdentity | null
  terminal: RemoteTerminalEvidence | null
}
export interface RemoteResultTransaction {
  authority(operationId: string): Promise<RemoteCommitAuthority | null>
  /** Bounded audit evidence only; cannot mutate execution state or schedule a node. */
  reject(receipt: RemoteOperationReceipt, reason: string): Promise<void>
  /** Canonical writer receives correlated evidence, never a trusted native capture cast. */
  accept(evidence: VerifiedRemoteEvidence): Promise<void>
}
export interface RemoteResultCommitPort {
  transaction<T>(operationId: string, work: (transaction: RemoteResultTransaction) => Promise<T>): Promise<T>
}
export class VerifiedRemoteEvidence {
  private constructor(readonly receipt: RemoteOperationReceipt, readonly authority: RemoteCommitAuthority) {}
  static async commit(raw: unknown, authenticatedConnection: DeviceConnectionIdentity, port: RemoteResultCommitPort) {
    const receipt = RemoteOperationReceiptSchema.parse(raw)
    return port.transaction(receipt.intent.operationId, async transaction => {
      const authority = await transaction.authority(receipt.intent.operationId)
      const reason = !authority ? 'unknown_operation'
        : !authority.grantIsLive ? 'revoked_grant'
        : !sameRegisteredWorker(receipt.connection, authenticatedConnection) ? 'unauthenticated_connection'
        : !isDeepStrictEqual(receipt.connection, authority.originalConnection) || receipt.workerIncarnationId !== authority.originalIncarnationId ? 'wrong_original_execution'
        : !isDeepStrictEqual(receipt.intent, authority.intent) ? 'stale_binding_or_owner'
        : authority.placement.hostRef.kind !== 'device' || authority.placement.hostRef.deviceId !== receipt.connection.deviceId
          || authority.placement.bindingHash !== receipt.intent.bindingHash
          || authority.placement.registration?.workerInstallationId !== receipt.connection.workerInstallationId
          || authority.placement.registration?.keyRevision !== receipt.connection.keyRevision
          || authority.placement.registration?.authorizationRevision !== receipt.connection.authorizationRevision ? 'wrong_placement'
        : authority.native !== null && !sameOriginalNative(authority.native, receipt.native) ? 'conflicting_native'
        : authority.terminal !== null && !isDeepStrictEqual(receipt.terminal, authority.terminal) ? 'conflicting_terminal'
        : receipt.sequence <= authority.lastSequence ? 'stale_sequence'
        : receipt.phase === 'confirmed_terminal' && (!receipt.terminal || (receipt.terminal.kind !== 'not_started' && !receipt.native)) ? 'missing_native_closure'
        : null
      if (reason) {
        // An identical committed terminal report converges without another publication.
        if (reason === 'stale_sequence' && authority?.terminal != null
          && receipt.phase === 'confirmed_terminal' && isDeepStrictEqual(receipt.terminal, authority.terminal)) return 'duplicate' as const
        await transaction.reject(receipt, reason)
        return 'rejected' as const
      }
      if (!authority) throw new Error('Authority disappeared')
      await transaction.accept(new VerifiedRemoteEvidence(structuredClone(receipt), authority))
      return 'accepted' as const
    })
  }
}

function sameRegisteredWorker(a: DeviceConnectionIdentity, b: DeviceConnectionIdentity) {
  return a.mainId === b.mainId && a.deviceId === b.deviceId && a.workerInstallationId === b.workerInstallationId
    && a.keyRevision === b.keyRevision && a.authorizationRevision === b.authorizationRevision
}

function sameOriginalNative(original: RemoteNativeIdentity, observed: RemoteNativeIdentity | undefined) {
  return !!observed && original.sessionId === observed.sessionId && original.processIdentityDigest === observed.processIdentityDigest
    && (original.turnId === undefined || original.turnId === observed.turnId)
}
