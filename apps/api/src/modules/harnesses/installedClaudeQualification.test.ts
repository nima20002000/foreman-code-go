import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { InstalledClaudeTarget } from './installedClaudeInspection.js'
import { createInstalledClaudeQualifier } from './installedClaudeQualification.js'

const native = vi.hoisted(() => ({ inspect: vi.fn(), resolve: vi.fn(), qualify: vi.fn() }))
vi.mock('./installedClaudeInspection.js', () => ({ inspectInstalledClaude: native.inspect }))
vi.mock('./claudeSdk/currentPin.js', () => ({ createClaudeCurrentPinResolver: () => native.resolve }))
vi.mock('./claudeSdk/nativeProfileQualification.js', () => ({ qualifyClaudeNativeProfile: native.qualify }))

it.each([true, false])('uses native behavior qualification for newer Claude versions (compatible: %s)', async compatible => {
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: 'connection', connectionGeneration: 1,
    keyRevision: 1, authorizationRevision: 1 }
  const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
    applicationInstallationId: connection.workerInstallationId, harnessInstallationId: 'claude',
    installationFingerprint: 'installed' }
  const configuration = withAdvancedDefaults({ harness: 'claude', model: 'model', authMode: 'subscription',
    configDirectory: '/profile', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} })
  const value: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    target, driverId: 'claude', presetId: 'claude', enabled: true, configuration,
    configurationFingerprint: commandInputHash(configuration), qualification: 'unqualified' }
  const installed: InstalledClaudeTarget = { binding: connection, target,
    sdk: { entrypoint: '/installed/sdk.mjs', installedLockPath: '/installed/pnpm-lock.yaml' }, installation: {
    hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: 'claude', driverRevision: '1',
    protocolRevision: 'sdk', environmentGeneration: 'environment', connectionGeneration: 'connection',
    launcher: { status: 'installed', requested: '/installed/claude', fingerprint: target.installationFingerprint,
      resolvedLauncher: '/installed/claude', interpreter: null, diagnostics: [],
      checkedAt: '2026-01-01T00:00:00.000Z', payloadFingerprints: [],
      environment: { path: '/usr/bin', cwd: '/installed', provenance: 'worker', generation: 'environment' } },
    observedVersion: null, authenticated: null, compatible: null, qualified: false,
    installed: true, claudeSdk: { version: '0.4.0', integrity: 'sha512-fixture' },
  } }
  const pin = { sdkVersion: '0.4.0', cliVersion: '2.2.0' }
  native.inspect.mockResolvedValue({ currentTarget: installed })
  native.resolve.mockResolvedValue({ status: 'available', pin })
  const result = { qualified: compatible, compatible,
    ...(!compatible ? { failure: { code: 'CLAUDE_POLICY_UNQUALIFIED' } } : {}) }
  native.qualify.mockImplementation(async (input: { assertCurrent(): Promise<void> }) => {
    await input.assertCurrent()
    return result
  })
  const registry = { reserveLaunch: async (owner: string) => ({ root: '/unused', owner }),
    abandonReservedLaunch: async () => {}, closeOwner: async () => true }
  const qualifier = createInstalledClaudeQualifier({ stateDirectory: '/unused', configuration: null,
    current: () => connection, registry: registry as never })
  try {
    await expect(qualifier.qualify(value, { checkId: randomUUID(), signal: new AbortController().signal }))
      .resolves.toEqual(result)
    expect(native.qualify).toHaveBeenLastCalledWith(expect.objectContaining({ value, pin }))
  } finally { await qualifier.close() }
})
