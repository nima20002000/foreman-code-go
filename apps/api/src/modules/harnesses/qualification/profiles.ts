import type { CompatibilityHarness, HarnessProfileId } from '@foreman-code/contracts'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'

/**
 * Behavior profiles replace exact-version branches. Baselines are the upstream
 * releases reviewed by hand; any other version is usable only after the app's
 * qualification suite passes against that exact binary (see registry.ts).
 */
export interface BaselineRelease { harness: CompatibilityHarness; version: string; profile: HarnessProfileId }

export const BASELINE_RELEASES: readonly BaselineRelease[] = [
  { harness: 'codex', version: '0.154.0', profile: 'codex-0.154' },
  { harness: 'codex', version: '0.156.1', profile: 'codex-0.156' },
  { harness: 'opencode', version: '1.18.31', profile: 'opencode-1.18.31' },
]

/** The profile a newly qualified version is tested and run against: the newest baseline. */
export const QUALIFICATION_TARGET_PROFILE: Record<CompatibilityHarness, HarnessProfileId> = {
  codex: 'codex-0.156',
  opencode: 'opencode-1.18.31',
}

/** `codex-cli 0.158.0` and `0.158.0` both normalize to `0.158.0`. */
export function normalizeHarnessVersion(harness: CompatibilityHarness, value: string): string {
  const trimmed = value.trim()
  return harness === 'codex' ? trimmed.replace(/^codex-cli\s+/, '') : trimmed
}

export function baselineProfile(harness: CompatibilityHarness, version: string): HarnessProfileId | null {
  const normalized = normalizeHarnessVersion(harness, version)
  return BASELINE_RELEASES.find((release) => release.harness === harness && release.version === normalized)?.profile ?? null
}

/** Qualified (non-baseline) versions, loaded from PostgreSQL at startup and after each passing run. */
const qualified = new Map<string, HarnessProfileId>()
const checkingProfile = new AsyncLocalStorage<{ harness: CompatibilityHarness; version: string; profile: HarnessProfileId }>()
const key = (harness: CompatibilityHarness, version: string) => `${harness}\u0000${normalizeHarnessVersion(harness, version)}`

export function rememberQualifiedProfile(harness: CompatibilityHarness, version: string, profile: HarnessProfileId): void {
  qualified.set(key(harness, version), profile)
}
export function forgetQualifiedProfile(harness: CompatibilityHarness, version: string): void {
  qualified.delete(key(harness, version))
}

/** A passed native suite can check its selected settings before final qualification is persisted. */
export function runWithQualificationProfile<T>(input: {
  harness: CompatibilityHarness
  version: string
  binarySha256: string
  target: HostHarnessOverride['target']
  profile: HarnessProfileId
  checks: HarnessQualification['checks']
}, work: () => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(input.binarySha256) || !input.target.installationFingerprint
    || input.profile !== QUALIFICATION_TARGET_PROFILE[input.harness]
    || !input.checks.length || input.checks.some(check => !check.passed)) {
    throw new Error('The native suite has not qualified this installation for a profile check.')
  }
  return checkingProfile.run({ harness: input.harness,
    version: normalizeHarnessVersion(input.harness, input.version), profile: input.profile }, work)
}

/**
 * The single lookup every version-dependent branch uses. Returns null for a version
 * that is neither a baseline nor qualified; callers must fail closed on null.
 * Binary-level trust (exact sha256) is enforced at launch by the registry, not here:
 * this answers "how does this version behave" for already-admitted sessions.
 */
export function harnessProfile(harness: CompatibilityHarness, version: string): HarnessProfileId | null {
  const checking = checkingProfile.getStore()
  const profile = checking?.harness === harness && checking.version === normalizeHarnessVersion(harness, version)
    ? checking.profile : undefined
  return baselineProfile(harness, version) ?? profile ?? qualified.get(key(harness, version)) ?? null
}
