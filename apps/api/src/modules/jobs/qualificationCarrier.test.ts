import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { JobRuntimeQualificationRpcResponseRecordSchema, JobVerificationRuntimeFingerprintSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresSourceService } from '../sources/service.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'
import { createJobQualificationCarrier } from './qualificationCarrier.js'
import { JobRuntimeMetadataRecovery } from './runtimeMetadataRecovery.js'
import { verificationProfileReadiness } from './runtimeProfiles.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { DomainError } from '../errors.js'

it('invalidates a failed fresh inspection, preserves qualification history and retries metadata recovery', async () => {
  const profile = verificationCapacityFixture('device')
  const saved = structuredClone(profile)
  const fingerprint = profile.measurement!.fingerprint
  if (fingerprint.hostRef.kind !== 'device' || !fingerprint.registration) throw new Error('Expected Worker fixture')
  const binding: DeviceSessionBinding = { mainId: fingerprint.mainInstallationId,
    deviceId: fingerprint.hostRef.deviceId, ...fingerprint.registration, bootId: fingerprint.bootId,
    connectionEpoch: 'epoch', connectionGeneration: 1 }
  const response = JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: 3, operation: 'inspect',
    fingerprint, descriptor: {
      target: { hostRef: fingerprint.hostRef, registration: fingerprint.registration,
        mainInstallationId: fingerprint.mainInstallationId },
      runtimeExecutable: fingerprint.runtimeExecutable, ociExecutable: fingerprint.ociExecutable,
      findmntExecutable: '/usr/bin/findmnt', findmntBinarySha256: 'a'.repeat(64), runtimeRoot: '/ci/runtime',
      backingFile: null, controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000',
        LANG: 'C.UTF-8' }, volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes, quota: fingerprint.quota,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
      runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
      aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest,
      resources: fingerprint.resources, quotaPool: fingerprint.quotaPool, network: fingerprint.network,
      approvalConfig: fingerprint.approvalConfig,
    } })
  const registration = { mainId: binding.mainId, deviceId: binding.deviceId, ...fingerprint.registration,
    status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
  const sql = { query: async (text: string) => {
    if (text.includes('application_installation')) return { rows: [{ id: binding.mainId }] }
    if (text.includes('device_registrations')) return { rows: [{ record: registration }] }
    return { rows: [{ record: profile }] }
  } } as unknown as pg.Pool
  let validInstallation = true
  const request = vi.fn(async () => {
    if (!validInstallation) throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Runtime installation changed.', 409)
    return { payload: response }
  })
  const endpoint = { currentBinding: () => binding, captureRequest: () => ({ binding, request }) }
  const { host } = createJobQualificationCarrier({ pool: sql, sources: {} as PostgresSourceService,
    endpoint: () => endpoint as unknown as DeviceEndpoint, local: {} as InstalledJobRuntimeHost })
  expect(await host.capture!(profile)).toEqual(fingerprint)
  validInstallation = false
  await expect(host.capture!(profile)).rejects.toMatchObject({ code: 'JOB_RUNTIME_CONTEXT_CHANGED' })
  const current = await host.currentMetadata(sql, profile)
  expect(current).toBeNull()
  expect(verificationProfileReadiness({ profile,
    currentFingerprint: current && JobVerificationRuntimeFingerprintSchema.parse(current) })).toMatchObject({
    ready: false, reasons: ['runtime_context_unavailable'],
  })
  expect(profile).toEqual(saved)
  const recovered = vi.fn()
  const recovery = new JobRuntimeMetadataRecovery(sql, host, recovered)
  validInstallation = true
  recovery.request()
  await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce())
  await recovery.close()
  expect(request).toHaveBeenCalledTimes(3)
  expect(await host.currentMetadata(sql, profile)).toEqual(fingerprint)
  expect(profile).toEqual(saved)
})
