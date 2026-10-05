import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { readPlacementHarnessFacts } from '../src/modules/placement/harnessFacts.js'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { HarnessQualificationRepository } from '../src/modules/harnesses/qualification/repository.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('keeps a Main measurement when a Worker qualifies the same native binary', async () => {
  const db = await agent3Database()
  try {
    const repository = new HarnessQualificationRepository(db.pool)
    const principal = await new PostgresAccessService(db.pool).issue({ name: 'Host qualification test',
      audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000) })
    const record: HarnessQualification = { harness: 'codex', version: '0.154.0', binarySha256: 'a'.repeat(64),
      suiteRevision: 'codex-live-fixture', profile: 'codex-0.156', status: 'qualified',
      checks: [{ id: 'native-turn', passed: true, detail: null }], failureReason: null,
      startedAt: '2026-10-05T00:00:00.000Z', checkedAt: '2026-10-05T00:00:01.000Z' }
    const hostRef = { kind: 'main' as const, mainId: randomUUID() }
    const instanceId = randomUUID()
    const fingerprint = record.binarySha256!
    const configuration = DEFAULT_HARNESS_DEFAULTS.codex
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId, instanceRevision: '1', driverId: 'codex', enabled: true, configuration }])
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh([{ hostRef, harnessInstallationId: 'codex', installationFingerprint: fingerprint,
      driverId: 'codex', driverRevision: '1', protocolRevision: 'protocol', environmentGeneration: 'environment',
      connectionGeneration: '1', observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: '/codex', resolvedLauncher: '/codex', fingerprint, status: 'installed', interpreter: null,
        diagnostics: [], checkedAt: record.checkedAt!, payloadFingerprints: [{ path: '/codex', fingerprint }],
        environment: { generation: 'environment', provenance: 'systemd', cwd: '/project', path: '/usr/bin' } } }])
    const identity = { schemaVersion: 1, selection: { instanceId, instanceRevision: '1', driverId: 'codex', hostRef,
      harnessInstallationId: 'codex', installationFingerprint: fingerprint }, environmentGeneration: 'environment',
    connectionGeneration: '1', driverRevision: '1', protocolRevision: 'protocol', suiteRevision: record.suiteRevision,
    launcher: '/codex', payloadFingerprints: [{ path: '/codex', fingerprint }] }
    const override: HostHarnessOverride = { instanceId, revision: 1, instanceRevision: '1',
      target: { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: 'codex',
        installationFingerprint: fingerprint }, presetId: 'local-default:codex', enabled: true, driverId: 'codex',
      configuration, configurationFingerprint: commandInputHash(configuration), qualification: 'qualified' }
    const proof: HostHarnessProfileEvidence = { target: override.target, instanceRevision: '1',
      configurationFingerprint: override.configurationFingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'protocol', suiteRevision: 'codex-profile-check-v1', environmentGeneration: 'environment',
      connectionGeneration: '1', authenticated: true, compatible: true, qualified: true, checkedAt: record.checkedAt! }
    await db.pool.query(`insert into harness_instance_settings(instance_id,revision,host_key,application_installation_id,
      record,configuration_fingerprint,created_by) values($1,1,$2,$3,$4::jsonb,$5,$6)`,
    [instanceId, `main:${hostRef.mainId}`, hostRef.mainId, JSON.stringify(override), override.configurationFingerprint, principal.principal.id])
    await db.pool.query(`insert into harness_instance_profile_evidence(check_id,instance_id,instance_revision,record)
      values($1,$2,1,$3::jsonb)`, [randomUUID(), instanceId, JSON.stringify(proof)])
    const placement: Pick<AcceptedNodePlacement, 'hostRef' | 'payload'> = { hostRef, payload: {
      kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1',
      instanceId, instanceRevision: '1', harnessInstallationId: 'codex', installationFingerprint: fingerprint,
      protocolRevision: 'protocol', runtimeContractVersion: 1, credentialScopeRefs: [],
    } }
    const read = () => readPlacementHarnessFacts(db.pool, placement, installations,
      { codex: record.suiteRevision, opencode: 'unused' })
    await repository.save(record, { qualificationIdentity: identity })
    expect((await read()).qualification).toEqual(record)
    const workerRecord = { ...record, checkedAt: '2026-10-05T00:00:02.000Z' }
    await repository.save(workerRecord, { purpose: 'explicit-host-qualification', target: { deviceId: 'worker' } })
    expect((await read()).qualification).toEqual(record)
    expect(await repository.find('codex', record.version, record.binarySha256!, record.suiteRevision)).toEqual(workerRecord)
    const replacement = { ...record, status: 'failed' as const, failureReason: 'Native check failed',
      checks: [{ id: 'native-turn', passed: false, detail: null }], checkedAt: '2026-10-05T00:00:03.000Z' }
    await repository.save(replacement, { purpose: 'explicit-host-qualification', target: { deviceId: 'worker' } })
    expect((await read()).qualification).toEqual(record)
    await repository.save(replacement, { qualificationIdentity: identity })
    await expect(read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE',
      details: { reason: 'main_qualification_identity_missing' } })
  } finally { await db.close() }
})
