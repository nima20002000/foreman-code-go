import { describe, expect, it } from 'vitest'
import { HarnessCompatibilityListSchema, HarnessReleaseProvenanceSchema, HarnessCompatibilityRetryBodySchema } from './harnessCompatibility.js'

describe('compatibility diagnostic contracts', () => {
  it('does not accept caller-selected commands or binary paths on retries', () => {
    expect(HarnessCompatibilityRetryBodySchema.safeParse({}).success).toBe(true)
    expect(HarnessCompatibilityRetryBodySchema.safeParse({ binary: '/arbitrary', forceQualification: true }).success).toBe(false)
  })
  it('only links to the two official release repositories', () => {
    const release = { version: '0.154.0', repository: 'openai/codex', tag: 'rust-v0.154.0',
      releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.154.0',
      commit: 'a'.repeat(40), recordedAt: '2026-09-19T00:00:00.000Z' }
    expect(HarnessReleaseProvenanceSchema.safeParse(release).success).toBe(true)
    expect(HarnessReleaseProvenanceSchema.safeParse({ ...release, releaseUrl: 'https://example.invalid/install' }).success).toBe(false)
  })
  it('does not accept an incomplete catalog as an empty success', () => {
    expect(HarnessCompatibilityListSchema.safeParse({ canRetry: false, harnesses: [] }).success).toBe(false)
  })
})
