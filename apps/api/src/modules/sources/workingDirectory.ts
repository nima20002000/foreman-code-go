import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import type { SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@graphql/contracts/source-admission'
import { PrivateSourceMaterializer } from './materialization.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, sourcePath, sourceSha256 } from './manifest.js'
import { verifiedSourceWorkingTree } from './nativeStamp.js'

export function sourceCwdAttestationDigest(proof: Record<string, unknown>): string {
  const { attestationDigest: _digest, ...fields } = proof
  void _digest
  return commandInputHash(fields).slice('sha256:'.length)
}
/** Reverify retained source bytes, then walk each CWD component through opened
 * directory descriptors. The root receipt remains the full-tree identity. */
export async function verifyMaterializedWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string,
  authorize: () => Promise<void>): Promise<VerifiedSourceWorkingTree> {
  if (relativeCwd.length > 1024) throw new SourceError('SOURCE_PATH_INVALID', 'Working directory exceeds its bound.')
  if (relativeCwd) sourcePath(relativeCwd)
  const receipt = record.receipt
  const materializer = new PrivateSourceMaterializer(null, authorize)
  const canonicalProjectRoot = await materializer.resolve(receipt, { binding: receipt.binding, attempt: { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId, keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision } })
  let directory = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if (!isDeepStrictEqual(await identity(directory), receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Approved source root changed.')
    for (const component of [receipt.materializationId, 'tree']) {
      const child = await openChildDirectory(directory, component)
      await directory.close(); directory = child
    }
    if (!isDeepStrictEqual(await identity(directory), receipt.localTreeIdentity)) throw new SourceError('SOURCE_TREE_CHANGED', 'Verified source tree identity changed.')
    for (const component of relativeCwd ? relativeCwd.split('/') : []) {
      const child = await openChildDirectory(directory, component)
      await directory.close(); directory = child
    }
    const accessFlags = constants.R_OK | constants.X_OK | (receipt.binding.accessMode === 'exclusive-write' ? constants.W_OK : 0)
    await access(anchored(directory), accessFlags)
    const filesystem = await identity(directory), canonicalCwd = join(canonicalProjectRoot, relativeCwd)
    const directoryIdentityHash = sourceSha256(Buffer.from(JSON.stringify(filesystem)))
    const fields = { version: 1 as const, materializationId: receipt.materializationId, executionId: receipt.executionId,
      attemptId: receipt.attemptId, operationId: record.operationId, sourceBindingHash: receipt.placementHash,
      relativeCwd, canonicalCwd, filesystem, directoryIdentityHash, accessMode: receipt.binding.accessMode }
    await authorize()
    // Detect replacement during authorization while retaining the original FD.
    let current = await openPrivateRoot(receipt.binding.canonicalPath)
    try {
      for (const component of [receipt.materializationId, 'tree', ...(relativeCwd ? relativeCwd.split('/') : [])]) {
        const child = await openChildDirectory(current, component); await current.close(); current = child
      }
      await access(anchored(current), accessFlags)
      if (!isDeepStrictEqual(await identity(current), filesystem)) throw new SourceError('SOURCE_CWD_CHANGED', 'Working directory changed during verification.')
    } finally { await current.close() }
    return { ...verifiedSourceWorkingTree(record, canonicalProjectRoot), canonicalCwd, directoryIdentityHash,
      cwdAttestation: { ...fields, attestationDigest: sourceCwdAttestationDigest(fields) } }
  } finally { await directory.close() }
}
