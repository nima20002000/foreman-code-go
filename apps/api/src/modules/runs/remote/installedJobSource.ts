import { join } from 'node:path'
import { isDeepStrictEqual as same } from 'node:util'
import type { JobSourcePort } from '../../jobs/executor.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { WorkerJobApplicationSink } from './workerJobApplicationSink.js'
import { PrivateSourceMaterializer } from '../../sources/materialization.js'
import { verifyPrivateSourceRepository } from '../../sources/repository.js'
import { verifyMaterializedWorkingDirectory } from '../../sources/workingDirectory.js'
import { verifyApprovedRootAllowlist } from '../../sources/rootAttestation.js'
import type { ApprovedRootAllowlist } from '@graphql/contracts/workspace-root-policies'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'

/** Main metadata and physical verification remain distinct. No source is created. */
export function createInstalledJobSource(input: { journal: RemoteOperationJournal; application: WorkerJobApplicationSink;
  currentBinding(): Readonly<DeviceSessionBinding>; approvedRoots(): Promise<ApprovedRootAllowlist> }): JobSourcePort {
  return { async verify(spec, signal) {
    signal.throwIfAborted()
    const matches = (await input.journal.jobOperations()).filter(receipt => same(receipt.execution.acceptedSpec, spec))
    if (matches.length !== 1) throw new Error('Unique original Job source owner missing')
    const original = matches[0]!, binding = input.currentBinding()
    const accepted = await input.application.resolveAcceptedSource(original.intent)
    if (!same(accepted.execution.acceptedSpec, original.execution.acceptedSpec) || accepted.execution.workspaceId !== original.execution.workspaceId
      || !same(accepted.execution.workflow, original.execution.workflow)) throw new Error('Original accepted Job execution changed')
    const roots = await input.approvedRoots(), record = accepted.materialization, receipt = record.receipt
    if (roots.hostRef.kind !== 'device' || roots.hostRef.mainId !== binding.mainId || roots.hostRef.deviceId !== binding.deviceId
      || roots.applicationInstallationId !== binding.workerInstallationId
      || roots.managedRuntimeRoot !== spec.target.destination.managedRuntimeRoot
      || receipt.binding.canonicalPath !== join(roots.managedRuntimeRoot, 'source-materializations', accepted.root.selection.rootPolicyId))
      throw new Error('Original Job source is outside its human-approved runtime root')
    await verifyApprovedRootAllowlist(roots)
    const recheck = async () => {
      signal.throwIfAborted()
      const refreshed = await input.application.resolveAcceptedSource(original.intent)
      if (!same(refreshed.materialization, accepted.materialization) || !same(refreshed.root, accepted.root) || refreshed.diskQuotaBytes !== accepted.diskQuotaBytes
        || !same(input.currentBinding(), binding) || !same(await input.approvedRoots(), roots)
        || !same(refreshed.execution.acceptedSpec, accepted.execution.acceptedSpec)) throw new Error('Original Job source authority changed')
      signal.throwIfAborted()
    }
    const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId,
      keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    const repository = await verifyPrivateSourceRepository({ receipt, attempt, materializer: new PrivateSourceMaterializer(null, recheck) })
    const working = await verifyMaterializedWorkingDirectory(record, spec.relativeCwd ?? '', recheck)
    if (repository.workTree !== spec.target.destination.canonicalProjectRoot || repository.sourceCommit !== spec.source.commit
      || working.canonicalCwd !== spec.target.destination.canonicalCwd)
      throw new Error('Original private Job repository or working directory changed')
    await recheck()
    return { privateRepositoryRoot: repository.workTree, directoryIdentityHash: spec.target.destination.directoryIdentityHash,
      privateGit: true, diskQuotaBytes: accepted.diskQuotaBytes }
  } }
}
