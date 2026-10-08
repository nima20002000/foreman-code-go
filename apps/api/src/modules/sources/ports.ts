import type { SourceManifest, SourceEntry, RootBinding, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'

/** Main persists this exact approved pin; neither worker nor resolver chooses latest. */
export type SourceSnapshotPin = Pick<SourceManifest, 'snapshotId' | 'manifestDigest' | 'approvedSourceId'>
export interface SourceByteReader {
  readGitMetadata?(manifest: SourceManifest, signal: AbortSignal): Promise<Uint8Array>
  read(snapshot: SourceSnapshotPin, entry: SourceEntry, signal: AbortSignal): Promise<Uint8Array>
}
export type MaterializationAttempt = {
  placementHash: string; executionId: string; attemptId: string; keyRevision: number | null; authorizationRevision: number | null
}
export interface SourceMaterializationPort {
  prepare(input: { manifest: SourceManifest; binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal; sharedWritableTree?: true }): Promise<MaterializationReceipt>
  verify(receipt: MaterializationReceipt, expected: { binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<void>
  resolve(receipt: MaterializationReceipt, expected: { binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<string>
}
/** The caller must hold a qualified writer exclusion for explicit/dirty capture. */
export interface ExclusiveSourceCapture {
  readonly approvedSourceId: string
  readonly writerExcluded: true
  read(entry: { path: string; executable: boolean }): Promise<Uint8Array>
  validateExclusion(): Promise<void>
}
