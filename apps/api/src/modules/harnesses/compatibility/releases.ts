import { createHash } from 'node:crypto'
import { HarnessReleaseProvenanceSchema, type CompatibilityHarness, type HarnessReleaseProvenance } from '@foreman-code/contracts'

/** Historical release provenance for readback. Every installed release still undergoes contract verification. */
export const COMPATIBILITY_CHECKER_REVISION = 'runtime-contracts-v2'
export const QUALIFIED_RELEASES: Record<CompatibilityHarness, HarnessReleaseProvenance> = {
  codex: HarnessReleaseProvenanceSchema.parse({
    version: '0.154.0', repository: 'openai/codex', tag: 'rust-v0.154.0',
    releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.154.0',
    commit: '6b9826e3aa83b1a5947db50f4332cb9c65f1b340', recordedAt: '2026-09-19T00:00:00.000Z',
  }),

}
const QUALIFIED_CODEX_156_RELEASE = HarnessReleaseProvenanceSchema.parse({
  version: '0.156.1', repository: 'openai/codex', tag: 'rust-v0.156.1',
  releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.156.1',
  commit: 'b412ff32c417f855c2b2d1581b77058eed87c84b', recordedAt: '2026-09-23T12:32:33.000Z',
})
export const RELEASE_MANIFEST_SHA256 = createHash('sha256')
  .update(JSON.stringify([QUALIFIED_RELEASES, QUALIFIED_CODEX_156_RELEASE])).digest('hex')
export function knownRelease(harness: CompatibilityHarness, version: string): HarnessReleaseProvenance | null {
  if (harness === 'codex' && version === QUALIFIED_CODEX_156_RELEASE.version) return QUALIFIED_CODEX_156_RELEASE
  const release = QUALIFIED_RELEASES[harness]
  return release.version === version ? release : null
}
