import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type { HostHarnessOverride, HostHarnessProfileEvidence, HostHarnessInstallationDto } from '@graphql/contracts/harness-registry'
import type { AcceptedNodePlacement } from '@graphql/contracts/node-placement'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../harnesses/instanceRegistry.js'
import { qualificationIdentity } from '../harnesses/qualification/identity.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'

function fixture() {
  const hostRef = { kind: 'main' as const, mainId: randomUUID() }
  const instanceId = randomUUID()
  const fingerprint = 'a'.repeat(64)
  const suiteRevision = 'codex-live-fixture'
  const configuration = DEFAULT_HARNESS_DEFAULTS.codex
  const installation: HostHarnessInstallationDto = {
    hostRef, harnessInstallationId: 'installed-codex', installationFingerprint: fingerprint,
    driverId: 'codex', driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
    environmentGeneration: 'environment', connectionGeneration: 'connection', observedVersion: null,
    installed: true, authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex', fingerprint,
      payloadFingerprints: [{ path: '/installed/codex', fingerprint }], status: 'installed', interpreter: null,
      diagnostics: [], checkedAt: new Date().toISOString(),
      environment: { generation: 'environment', provenance: 'systemd', cwd: '/workspace', path: '/usr/bin' } },
  }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId, instanceRevision: '1', driverId: 'codex', enabled: true, configuration }])
  const installations = new HarnessInstallationRegistry(instances)
  installations.refresh([installation])
  const binding = installations.pin({ instanceId, hostRef, harnessInstallationId: installation.harnessInstallationId,
    connectionGeneration: 'connection', environmentGeneration: 'environment' })
  const override: HostHarnessOverride = { instanceId, revision: 1, instanceRevision: '1',
    target: { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: installation.harnessInstallationId,
      installationFingerprint: fingerprint }, presetId: 'local-default:codex', enabled: true, driverId: 'codex',
    configuration, configurationFingerprint: commandInputHash(configuration), qualification: 'qualified' }
  const proof: HostHarnessProfileEvidence = { target: override.target, instanceRevision: '1',
    configurationFingerprint: override.configurationFingerprint, driverId: 'codex', driverRevision: '1',
    protocolRevision: installation.protocolRevision, suiteRevision: 'codex-profile-check-v1',
    environmentGeneration: 'environment', connectionGeneration: 'connection', authenticated: true,
    compatible: true, qualified: true, checkedAt: new Date().toISOString() }
  const evidence = { qualificationIdentity: qualificationIdentity(binding, suiteRevision) }
  const records = [{ harness: 'codex', version: '0.154.0', binary_sha256: fingerprint, suite_revision: suiteRevision,
    profile: 'codex-0.156', checks: [{ id: 'native-fixture-check', passed: true, detail: null }], failure_reason: null,
    started_at: new Date(), checked_at: new Date(), evidence }]
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from harness_instance_settings')) return { rows: [{ record: override }] }
    if (sql.includes('from harness_instance_profile_evidence')) return { rows: [{ record: proof }] }
    return { rows: records }
  })
  const placement: Pick<AcceptedNodePlacement, 'hostRef' | 'payload'> = { hostRef, payload: {
    kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1',
    instanceId, instanceRevision: '1', harnessInstallationId: installation.harnessInstallationId,
    installationFingerprint: fingerprint, runtimeContractVersion: 1, protocolRevision: installation.protocolRevision, credentialScopeRefs: [],
  } }
  const read = () => readPlacementHarnessFacts({ query } as unknown as GraphSqlClient, placement, installations,
    { codex: suiteRevision, opencode: 'unused' })
  return { read, installations, records, proof, evidence }
}

it('admits passive inventory only with its exact measured binary and qualified profile', async () => {
  const f = fixture()
  const facts = await f.read()
  expect(facts.installation.observedVersion).toBe('0.154.0')
  expect(facts.profileProof).toMatchObject({ authenticated: true, compatible: true, qualified: true })
  expect(f.installations.list()[0]?.observedVersion).toBeNull()
})

it.each(['payload', 'generation', 'host', 'missing', 'profile', 'suite-check'] as const)(
  'rejects unconfirmed %s qualification without promoting passive metadata', async failure => {
    const f = fixture()
    if (failure === 'payload') f.evidence.qualificationIdentity.payloadFingerprints = [
      { ...f.evidence.qualificationIdentity.payloadFingerprints[0]!, fingerprint: 'changed' },
    ]
    if (failure === 'generation') f.evidence.qualificationIdentity.connectionGeneration = 'old'
    if (failure === 'host') f.evidence.qualificationIdentity.selection = {
      ...f.evidence.qualificationIdentity.selection, hostRef: { kind: 'main', mainId: randomUUID() },
    }
    if (failure === 'missing') f.records.length = 0
    if (failure === 'profile') f.proof.authenticated = false
    if (failure === 'suite-check') f.records[0]!.checks[0]!.passed = false
    await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
  },
)
