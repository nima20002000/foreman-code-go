import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { CompatibilityHarness } from '@graphql/contracts'
import { HarnessExecutionError } from '../errors.js'
import { baselineProfile, normalizeHarnessVersion } from './profiles.js'
import type { HarnessQualificationRegistry } from './registry.js'
import type { HarnessQualificationService } from './service.js'

let active: { registry: HarnessQualificationRegistry; service: HarnessQualificationService } | undefined
export function installQualificationGate(registry: HarnessQualificationRegistry, service: HarnessQualificationService): void {
  active = { registry, service }
}

export function clearQualificationGate(): void { active = undefined }

/** The binary a qualification suite is currently testing; admitted only inside that run. */
const candidate = new AsyncLocalStorage<{ harness: CompatibilityHarness; sha256: string }>()
export function runAsQualificationCandidate<T>(harness: CompatibilityHarness, sha256: string, work: () => Promise<T>): Promise<T> {
  return candidate.run({ harness, sha256 }, work)
}

export async function requireHarnessQualification(harness: CompatibilityHarness, version: string, binary: string): Promise<void> {
  const normalized = normalizeHarnessVersion(harness, version)
  if (baselineProfile(harness, normalized)) return
  const testing = candidate.getStore()
  if (testing?.harness === harness
    && createHash('sha256').update(await readFile(await realpath(binary))).digest('hex') === testing.sha256) return
  if (!active) throw new HarnessExecutionError('HARNESS_UNQUALIFIED', 'This harness version has no qualification registry.')
  const { sha256 } = await active.registry.inspectBinary(binary)
  if (await active.registry.trusted(harness, normalized, sha256)) return
  const state = await active.service.begin(harness)
  throw new HarnessExecutionError(state.status === 'failed' ? 'HARNESS_UNQUALIFIED' : 'HARNESS_QUALIFYING',
    state.status === 'failed' ? 'The installed harness failed qualification.' : 'The installed harness is being qualified; retry shortly.',
    state.status !== 'failed')
}
