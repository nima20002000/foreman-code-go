import { createHash } from 'node:crypto'
import { HarnessReleaseProvenanceSchema, type CompatibilityHarness, type HarnessReleaseProvenance } from '@graphql/contracts'

/**
 * Existing qualification pins, NOT new qualifications performed by this checker.
 * Official release/tag records inspected 2026-09-19. No startup network lookup.
 * Adding a release here must follow the native qualification/review process.
 */
export const COMPATIBILITY_CHECKER_REVISION = 'protocol-settings-v1'
export const QUALIFIED_RELEASES: Record<CompatibilityHarness, HarnessReleaseProvenance> = {
  codex: HarnessReleaseProvenanceSchema.parse({
    version: '0.154.0', repository: 'openai/codex', tag: 'rust-v0.154.0',
    releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.154.0',
    commit: '6b9826e3aa83b1a5947db50f4332cb9c65f1b340', recordedAt: '2026-09-19T00:00:00.000Z',
  }),
  opencode: HarnessReleaseProvenanceSchema.parse({
    version: '1.18.31', repository: 'anomalyco/opencode', tag: 'v1.18.31',
    releaseUrl: 'https://github.com/anomalyco/opencode/releases/tag/v1.18.31',
    commit: '014614d35b397775e5d397a490fc72368c894ec2', recordedAt: '2026-09-19T00:00:00.000Z',
  }),
}
export const RELEASE_MANIFEST_SHA256 = createHash('sha256').update(JSON.stringify(QUALIFIED_RELEASES)).digest('hex')
export function knownRelease(harness: CompatibilityHarness, version: string): HarnessReleaseProvenance | null {
  const release = QUALIFIED_RELEASES[harness]
  return release.version === version ? release : null
}
