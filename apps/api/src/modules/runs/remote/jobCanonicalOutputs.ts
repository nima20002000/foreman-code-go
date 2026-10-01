import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { JobExecution, JobArtifact } from '@graphql/contracts/jobs'
import type { TransferIntent } from '@graphql/contracts/byte-transfer'
import { readDeclaredJobOutputs } from '../../jobs/executorOutputs.js'
import { projectJobReceiptLocked } from '../../jobs/receiptProjection.js'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { createCanonicalJobArtifactPort } from '../../files/jobs/factory.js'
import { VerifiedJobOutputReader, type AcceptedJobTransferResolver } from '../../files/jobs/transferReader.js'
import type { JobOutputPublicationInput } from '../../files/jobs/port.js'
import type { VerifiedArtifactReader } from '../../files/distributed/publication.js'
import { ResumableByteTransferSender, type TransferSenderConnection } from '../../byte-transfer/sender.js'
import type { ByteTransferPort } from '@graphql/contracts/byte-transfer'
import type { RemoteJobOperationReceipt } from '@graphql/contracts/remote-job-execution'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { JobSql } from '../../jobs/repository.js'

/** Concrete main canonical adapter + verified original transfer reader; no alternate byte store. */
export function createJobCanonicalOutputs(input: { pool: pg.Pool; storageRoot: string; excludedRoots?: readonly string[];
  authority: JobPublicationAuthority; transfers: VerifiedArtifactReader; accepted: AcceptedJobTransferResolver }) {
  const artifacts = createCanonicalJobArtifactPort({ pool: input.pool, storageRoot: input.storageRoot,
    ...(input.excludedRoots ? { excludedRoots: input.excludedRoots } : {}), authority: input.authority,
    reader: new VerifiedJobOutputReader(input.transfers, input.accepted) })
  return { artifacts, projectReceipt: (sql: JobSql, execution: JobExecution, receipt: RemoteJobOperationReceipt) =>
    projectJobReceiptLocked(sql, execution, receipt, artifacts) }
}
export interface JobOutputApplicationPort {
  /** Main mints and persists the output intent under genuine job publication authority. */
  admit(input: JobOutputPublicationInput): Promise<TransferIntent>
  publish(input: JobOutputPublicationInput): Promise<JobArtifact>
}
/** Only called after main's physical closure acknowledgement. Reads real sealed declared bytes. */
export function createRemoteJobOutputCollector(receiver: ByteTransferPort, connection: TransferSenderConnection, main: JobOutputApplicationPort, journal: RemoteOperationJournal) {
  return async (execution: JobExecution) => {
    if (execution.acceptedSpec.target.hostRef.kind !== 'device') throw new Error('Remote job outputs require their actual registered device')
    const outputs = await readDeclaredJobOutputs(execution.acceptedSpec.target.destination.canonicalProjectRoot, execution.acceptedSpec)
    for (const output of outputs) {
      const declared = execution.acceptedSpec.outputs.find(value => value.path === output.path)
      if (!declared) throw new Error('Undeclared job output')
      const bytes = Buffer.from(output.bytes), sha256 = createHash('sha256').update(bytes).digest('hex')
      const input: JobOutputPublicationInput = { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId,
        owner: execution.owner, commandId: await journal.jobOutputCommand(execution.operationId, { path: output.path, mediaType: declared.mediaType, sha256, byteSize: bytes.length }), path: output.path, mediaType: declared.mediaType, sha256, byteSize: bytes.length }
      const intent = await main.admit(input)
      if (intent.executionId !== execution.id || intent.attemptId !== execution.attemptId || intent.direction !== 'to-main' || intent.byteClass !== 'artifact'
        || intent.placementHash !== execution.acceptedSpec.bindingHash || intent.manifestDigest !== execution.acceptedSpec.outputSpecDigest
        || intent.sha256 !== sha256 || intent.byteSize !== bytes.length || intent.mainId !== execution.acceptedSpec.target.mainId) throw new Error('Main output admission does not bind these exact bytes')
      await new ResumableByteTransferSender(receiver, { read: async (accepted, offset, length) => {
        if (accepted.transferId !== intent.transferId || accepted.sha256 !== sha256 || offset < 0 || offset + length > bytes.length) throw new Error('Sealed output transfer binding changed')
        return bytes.subarray(offset, offset + length)
      } }, connection).send(intent)
      const artifact = await main.publish(input)
      if (artifact.executionId !== execution.id || artifact.sha256 !== sha256 || artifact.byteSize !== bytes.length || artifact.path !== output.path
        || artifact.state !== 'available') throw new Error('Canonical output publication readback conflict')
    }
  }
}

/** Main-local jobs use real detached bytes, never invented device/transfer identities. */
export function createLocalJobCanonicalOutputs(input: { pool: pg.Pool; storageRoot: string; authority: JobPublicationAuthority; journal: RemoteOperationJournal }) {
  const sealed = new Map<string, { input: JobOutputPublicationInput; specDigest: string; bytes: Buffer }>()
  const artifacts = createCanonicalJobArtifactPort({ pool: input.pool, storageRoot: input.storageRoot, authority: input.authority,
    reader: { open: async (request, execution) => {
      const snapshot = sealed.get(request.commandId)
      if (!snapshot || !isDeepStrictEqual(snapshot.input, request) || snapshot.specDigest !== execution.acceptedSpec.specDigest
        || execution.acceptedSpec.target.hostRef.kind !== 'main') throw new Error('Original sealed main job output is unavailable')
      return Readable.from(snapshot.bytes)
    } } })
  return { artifacts, projectReceipt: (sql: JobSql, execution: JobExecution, receipt: RemoteJobOperationReceipt) => projectJobReceiptLocked(sql, execution, receipt, artifacts),
    collectOutputs: async (execution: JobExecution) => {
      if (execution.acceptedSpec.target.hostRef.kind !== 'main') throw new Error('Local output reader cannot change the accepted host')
      for (const output of await readDeclaredJobOutputs(execution.acceptedSpec.target.destination.canonicalProjectRoot, execution.acceptedSpec)) {
        const declared = execution.acceptedSpec.outputs.find(value => value.path === output.path)
        if (!declared) throw new Error('Undeclared local job output')
        const bytes = Buffer.from(output.bytes), sha256 = createHash('sha256').update(bytes).digest('hex')
        const commandId = await input.journal.jobOutputCommand(execution.operationId, { path: output.path, mediaType: declared.mediaType, sha256, byteSize: bytes.length })
        const request: JobOutputPublicationInput = { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId,
          owner: execution.owner, commandId, path: output.path, mediaType: declared.mediaType, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }
        if (sealed.size >= 4 || [...sealed.values()].reduce((sum,value) => sum+value.bytes.length,bytes.length) > 64*1024*1024) throw new Error('Main output sealing capacity exhausted')
        sealed.set(commandId, { input: request, specDigest: execution.acceptedSpec.specDigest, bytes })
        try { await artifacts.publishAccepted(request) } finally { sealed.delete(commandId) }
      }
    } }
}
