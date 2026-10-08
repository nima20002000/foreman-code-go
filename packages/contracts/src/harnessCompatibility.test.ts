import { describe, expect, it } from 'vitest'
import { HarnessCompatibilityListSchema, HarnessReleaseProvenanceSchema, HarnessCompatibilityRetryParamsSchema } from './harnessCompatibility.js'

describe('compatibility diagnostic contracts', () => {
  it('does not accept caller-selected commands or binary paths on retries', () => {
    expect(HarnessCompatibilityRetryParamsSchema.safeParse({ harness: 'codex' }).success).toBe(true)
    const selectedBinary = { harness: 'codex', binary: '/arbitrary', forceQualification: true }
    expect(HarnessCompatibilityRetryParamsSchema.safeParse(selectedBinary).success).toBe(false)
  })
  it('only links to the official Codex release repository', () => {
    const release = { version: '0.154.0', repository: 'openai/codex', tag: 'rust-v0.154.0',
      releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.154.0',
      commit: 'a'.repeat(40), recordedAt: '2026-09-19T00:00:00.000Z' }
    expect(HarnessReleaseProvenanceSchema.safeParse(release).success).toBe(true)
    expect(HarnessReleaseProvenanceSchema.safeParse({ ...release, releaseUrl: 'https://example.invalid/install' }).success).toBe(false)
  })
  it('does not accept an incomplete catalog as an empty success', () => {
    expect(HarnessCompatibilityListSchema.safeParse({ canRetry: false, harnesses: [] }).success).toBe(false)
  })
  it('accepts the supported diagnostic report and rejects duplicate entries', () => {
    const release = { version: '0.154.0', repository: 'openai/codex', tag: 'rust-v0.154.0',
      releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.154.0',
      commit: 'a'.repeat(40), recordedAt: '2026-09-19T00:00:00.000Z' }
    const report = {
      harness: 'codex', checkId: '11111111-1111-4111-8111-111111111111', installedVersion: null,
      status: 'not-checked', checkedAt: null, source: 'none', checkerRevision: 'diagnostic-revision',
      qualifiedRelease: release, knownRelease: null, matchesQualifiedVersion: false,
      reason: null, schemaSha256: null, cacheWarning: null, scope: 'protocol-settings-diagnostic-only',
    }
    const response = { canRetry: false, harnesses: [report] }
    expect(HarnessCompatibilityListSchema.parse(response)).toEqual(response)
    expect(HarnessCompatibilityListSchema.safeParse({ ...response, harnesses: [report, report] }).success).toBe(false)
    expect(HarnessCompatibilityListSchema.safeParse({
      ...response, harnesses: [{ ...report, harness: 'opencode' }],
    }).success).toBe(false)
  })
})
