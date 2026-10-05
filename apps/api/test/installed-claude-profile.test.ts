import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { installedClaudeSdkEntrypoint } from '../src/modules/harnesses/claudeSdk/currentPin.js'
import { installedClaudeProfilePin } from '../src/modules/harnesses/claudeSdk/installedProfilePin.js'
import { inspectInstalledClaude } from '../src/modules/harnesses/installedClaudeInspection.js'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'installed-claude-profile-'))
  directories.push(root)
  const binary = join(root, 'claude')
  // Passive byte fixture only; neither it nor an SDK query runs in these tests.
  await writeFile(binary, 'passive CLI fixture', { mode: 0o700 })
  const lock = join(root, 'lock.yaml')
  const sdk = installedClaudeSdkEntrypoint(lock, binary)
  const manifest = JSON.parse(await readFile(join(dirname(sdk.entrypoint), 'package.json'), 'utf8'))
  const lockText = `packages:\n  '@anthropic-ai/claude-agent-sdk@${manifest.version}':\n    resolution: {integrity: sha512-aGVsbG8=}\n`
  await writeFile(lock, lockText)
  const path = join(root, 'workflow-runtime.json')
  const selected = { schemaVersion: 1, codexBinary: '/installed/codex', appMcpLauncher: '/installed/foreman-code-mcp',
    expectedVersion: '0.154.0', payloadPaths: [], claude: { binary, installedLockPath: lock } }
  await writeFile(path, JSON.stringify(selected), { mode: 0o600 })
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const input = { binding, configuration: { path, ownerUid: process.getuid!() },
    environment: { PATH: '/usr/bin' }, cwd: root, signal: new AbortController().signal }
  return { root, binary, lock, lockText, selected, path, input }
}

describe('installed worker Claude metadata and saved profile admission', () => {
  it('publishes SDK metadata without inventing CLI version, authentication or qualification', async () => {
    const f = await fixture()
    const result = await inspectInstalledClaude(f.input)
    expect(result.inventory.installations).toHaveLength(1)
    expect(result.currentTarget?.installation).toMatchObject({ driverId: 'claude',
      observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: false,
      claudeSdk: { version: '0.3.284', integrity: 'sha512-aGVsbG8=' } })
    const missing = await inspectInstalledClaude({ ...f.input, configuration: null })
    expect(missing.currentTarget).toBeNull()
    expect(missing.inventory.installations).toHaveLength(0)
  })

  it('rejects missing lock integrity, unavailable selected executable and public installer configuration', async () => {
    const f = await fixture()
    await writeFile(f.lock, 'unrelated lock')
    await expect(inspectInstalledClaude(f.input)).rejects.toThrow('integrity')
    await writeFile(f.lock, f.lockText)
    await writeFile(f.path, JSON.stringify({ ...f.selected, claude: { ...f.selected.claude, binary: '/missing-selection' } }), { mode: 0o600 })
    await expect(inspectInstalledClaude(f.input)).rejects.toThrow('launcher')
    await chmod(f.path, 0o644)
    await expect(inspectInstalledClaude(f.input)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
  })

  it('requires the saved native check to match SDK, executable, profile, host and connection', async () => {
    const f = await fixture()
    const target = (await inspectInstalledClaude(f.input)).currentTarget!
    const configuration = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'qualified-model',
      authMode: 'subscription', configDirectory: join(f.root, 'profile'), permissionMode: 'default', sandbox: 'danger-full-access',
      tools: [], permissionRules: [], instructions: '', mcpServers: {} })
    const value: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: 'profile-1',
      target: target.target, presetId: 'claude', enabled: true, driverId: 'claude', configuration,
      configurationFingerprint: commandInputHash(configuration), qualification: 'qualified' }
    const pin = { sdkVersion: target.installation.claudeSdk!.version, sdkIntegrity: target.installation.claudeSdk!.integrity,
      cliVersion: '2.1.284', executableSha256: target.installation.launcher.payloadFingerprints!
        .find(payload => payload.path === target.installation.launcher.resolvedLauncher)!.fingerprint,
      profilePath: configuration.configDirectory, configRevision: value.instanceRevision }
    // This record exercises admission matching, not native qualification.
    const proof: HostHarnessProfileEvidence = { target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: 'claude', driverRevision: '1',
      protocolRevision: target.installation.protocolRevision, suiteRevision: 'claude-profile-check-v1',
      environmentGeneration: target.installation.environmentGeneration,
      connectionGeneration: target.installation.connectionGeneration,
      authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString(),
      claudeProof: { pin, checks: {} } }
    const binding: RegistryHarnessSelection = { inventoryRevision: 1,
      installation: target.installation, instance: { instanceId: value.instanceId, instanceRevision: value.instanceRevision,
        driverId: 'claude', enabled: true, configuration, availability: 'available' },
      selection: { instanceId: value.instanceId, instanceRevision: value.instanceRevision, driverId: 'claude',
        hostRef: value.target.hostRef, harnessInstallationId: value.target.harnessInstallationId,
        installationFingerprint: value.target.installationFingerprint } }
    expect(installedClaudeProfilePin(value, binding, proof)).toEqual(pin)
    for (const change of [
      (record: HostHarnessProfileEvidence) => { record.qualified = false },
      (record: HostHarnessProfileEvidence) => { record.connectionGeneration = 'another-channel' },
      (record: HostHarnessProfileEvidence) => { record.claudeProof!.pin.sdkIntegrity = 'changed' },
      (record: HostHarnessProfileEvidence) => { record.claudeProof!.pin.executableSha256 = 'a'.repeat(64) },
      (record: HostHarnessProfileEvidence) => { record.claudeProof!.pin.profilePath = '/another-profile' },
      (record: HostHarnessProfileEvidence) => { record.target.applicationInstallationId = randomUUID() },
    ]) {
      const changed = structuredClone(proof)
      change(changed)
      expect(() => installedClaudeProfilePin(value, binding, changed)).toThrow('current native check')
    }
    expect(() => installedClaudeProfilePin(value, binding, null)).toThrow('current native check')
  })
})
