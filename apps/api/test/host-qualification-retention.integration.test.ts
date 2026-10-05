import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { HarnessQualificationRepository, readHostHarnessMeasurements } from '../src/modules/harnesses/qualification/repository.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('keeps a Main measurement when a Worker qualifies the same native binary', async () => {
  const db = await agent3Database()
  try {
    const repository = new HarnessQualificationRepository(db.pool)
    const record: HarnessQualification = { harness: 'codex', version: '0.154.0', binarySha256: 'a'.repeat(64),
      suiteRevision: 'codex-live-fixture', profile: 'codex-0.156', status: 'qualified',
      checks: [{ id: 'native-turn', passed: true, detail: null }], failureReason: null,
      startedAt: '2026-10-05T00:00:00.000Z', checkedAt: '2026-10-05T00:00:01.000Z' }
    const identity = { schemaVersion: 1, selection: { instanceId: 'main-profile', instanceRevision: '1',
      driverId: 'codex', hostRef: { kind: 'main', mainId: randomUUID() },
      harnessInstallationId: 'codex', installationFingerprint: 'a'.repeat(64),
      }, environmentGeneration: 'environment', connectionGeneration: '1',
    driverRevision: '1', protocolRevision: 'protocol', suiteRevision: record.suiteRevision,
    launcher: '/codex', payloadFingerprints: [{ path: '/codex', fingerprint: 'a'.repeat(64) }] }
    await repository.save(record, { qualificationIdentity: identity })
    const workerRecord = { ...record, checkedAt: '2026-10-05T00:00:02.000Z' }
    await repository.save(workerRecord, { purpose: 'explicit-host-qualification', target: { deviceId: 'worker' } })
    expect(await readHostHarnessMeasurements(db.pool, 'codex', record.binarySha256!, record.suiteRevision))
      .toEqual([{ qualification: record, evidence: { qualificationIdentity: identity } }])
    expect(await repository.find('codex', record.version, record.binarySha256!, record.suiteRevision)).toEqual(workerRecord)
    const replacement = { ...record, status: 'failed' as const, failureReason: 'Native check failed',
      checks: [{ id: 'native-turn', passed: false, detail: null }], checkedAt: '2026-10-05T00:00:03.000Z' }
    await repository.save(replacement, { qualificationIdentity: identity })
    expect(await readHostHarnessMeasurements(db.pool, 'codex', record.binarySha256!, record.suiteRevision))
      .toEqual([{ qualification: replacement, evidence: { qualificationIdentity: identity } }])
  } finally { await db.close() }
})
