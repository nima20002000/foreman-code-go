import { posix } from 'node:path'
import { z } from 'zod'
import { PlacementDigestSchema, type AcceptedNodePlacement, type DispatchIntent } from '@graphql/contracts/node-placement'

export const RuntimeLeafAttestationSchema = z.object({
  executionId: z.string().min(1), attemptId: z.string().min(1), operationId: z.string().min(1), bindingHash: PlacementDigestSchema,
  canonicalRuntimeDirectory: z.string().startsWith('/'), directoryIdentityHash: PlacementDigestSchema,
  materializationId: z.string().min(1), materializationDigest: PlacementDigestSchema,
}).strict()
export type RuntimeLeafAttestation = z.infer<typeof RuntimeLeafAttestationSchema>
export function assertRuntimeLeafPath(runtimeDirectory: string, placement: AcceptedNodePlacement) {
  const base = placement.destination.managedRuntimeRoot, project = placement.destination.canonicalProjectRoot
  if (runtimeDirectory.includes('\0') || !posix.isAbsolute(runtimeDirectory) || posix.normalize(runtimeDirectory) !== runtimeDirectory
    || runtimeDirectory === base || !runtimeDirectory.startsWith(`${base === '/' ? '' : base}/`)
    || runtimeDirectory === project || runtimeDirectory.startsWith(`${project === '/' ? '' : project}/`)) throw new Error('Exact runtime leaf must be a native canonical descendant of the accepted base')
}
export function assertRuntimeLeafBinding(raw: RuntimeLeafAttestation, runtimeDirectory: string, intent: DispatchIntent, placement: AcceptedNodePlacement) {
  assertRuntimeLeafPath(runtimeDirectory, placement)
  const proof = RuntimeLeafAttestationSchema.parse(raw)
  if (proof.canonicalRuntimeDirectory !== runtimeDirectory || proof.executionId !== intent.executionId || proof.attemptId !== intent.attemptId
    || proof.operationId !== intent.operationId || proof.bindingHash !== intent.bindingHash || proof.materializationId !== placement.source.materializationId
    || proof.materializationDigest !== placement.source.materializationDigest) throw new Error('Runtime leaf attestation does not own this immutable operation')
}
