import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JOB_RUNTIME_WORKSPACE_LAYOUT, CurrentJobRuntimeFingerprintSchema, JobQualificationCandidateSchema, JobRuntimeFingerprintSchema, JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import { identity } from '../sources/privateFilesystem.js'
import type { JobSql } from './repository.js'
import { jobSpec } from '../../../test/helpers/jobFixture.js'
import { captureInstalledRuntimeConfiguration, createInstalledJobRuntimeHost, inspectInstalledJobRuntime, inspectInstalledJobRuntimeCandidate, InstalledJobRuntimeCaptureInputSchema, InstalledJobRuntimeConfigurationSchema, readInstalledRuntimeConfiguration } from './installedRuntimeHost.js'
import * as qualification from './qualification.js'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JobVerificationInstalledRuntimeDescriptorSchema } from '@foreman-code/contracts/job-verification-runtime'
import { createVerificationProfile } from './verificationProfiles.js'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { InstalledVerificationRuntimeCaptureInputSchema, captureInstalledVerificationRuntimeConfiguration }
  from './installedVerificationRuntime.js'

const id = '11111111-1111-4111-8111-111111111111'
const digest = '1'.repeat(64)
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ci-installed-reader-')); roots.push(root)
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 })
  const binary = join(root, 'runtime'); await writeFile(binary, 'pinned fixture bytes', { mode: 0o700 })
  const fd = await open(source, constants.O_RDONLY | constants.O_DIRECTORY)
  const filesystem = await identity(fd); await fd.close()
  const sourceRecord = { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
    selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1, locationRevision: 1,
      canonicalPath: source, filesystem, accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest },
    ownerPrincipalId: id, authorizedByPrincipalId: id, registration: null, attestationId: 'attestation', attestationDigest: digest, boundAt: '2026-10-01T00:00:00Z' }
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const configuration = InstalledJobRuntimeConfigurationSchema.parse({ schemaVersion: 1, target: { hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id },
    root: sourceRecord, runtimeExecutable: binary, ociExecutable: binary, findmntExecutable: binary,
    runtimeRoot: join(root, 'managed-runtime'), backingFile: join(root, 'not-provisioned.ext4'),
    controllerEnvironment: { PATH: '/approved/bin', XDG_RUNTIME_DIR: '/approved/runtime', LANG: 'C.UTF-8' },
    pins: { bootId, runtimeBinarySha256: createHash('sha256').update('pinned fixture bytes').digest('hex'), ociBinarySha256: digest, findmntBinarySha256: digest,
      configurationDigest: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest, diskBytes: 1048576 } })
  const configPath = join(root, 'installed.json'); await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 })
  const profile = JobRuntimeProfileSchema.parse({ schemaVersion: 1, id: 'profile', workspaceId: id, revision: 1, name: 'Installed candidate', root: sourceRecord,
    policy: { ...jobSpec().policy, isolationPolicyId: 'profile', imageDigest: configuration.pins.imageDigest, toolchainDigest: configuration.pins.toolchainDigest },
    limits: { cpuLimit: 1, memoryBytes: 1048576, pidsLimit: 64, diskBytes: configuration.pins.diskBytes }, specDigest: digest,
    status: 'unqualified', measurement: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
  const query = vi.fn(async () => ({ rows: [{ id }] })) as unknown as JobSql['query']
  return { root, binary, profile, configuration, location: { path: configPath, ownerUid: process.getuid!() }, sql: { query } as JobSql }
}

describe('protected installed runtime reader, no DB or native runtime execution', () => {
  it('captures verification binaries, seed and approved source; a restarted host restores the same fingerprint', async () => {
    const f = await fixture()
    const measured = verificationRuntimeFixture()
    const directory = join(f.root, 'snapshot')
    const runtimeRoot = join(f.root, 'managed-runtime')
    await mkdir(directory, { mode: 0o700 })
    await mkdir(runtimeRoot, { mode: 0o700 })
    const entries = []
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const bytes = Buffer.from(`approved ${path}`)
      await writeFile(join(directory, path), bytes, { mode: 0o600 })
      entries.push({ path, kind: 'file' as const, executable: false, byteSize: bytes.length, sha256: sourceSha256(bytes) })
    }
    const manifest = createSourceManifest({ version: 1, approvedSourceId: id, snapshotId: id,
      capturePolicy: 'git-tree-v1', executablePolicy: 'strip', deletions: [], entries,
      git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' } })
    const root = { ...f.profile.root, source: { approvedSourceId: id, snapshotId: id, manifestDigest: manifest.manifestDigest },
      binding: { ...f.profile.root.binding, snapshotId: id, manifestDigest: manifest.manifestDigest } }
    const profile = createVerificationProfile({ id: 'verification', workspaceId: id, revision: 1,
      name: 'Protected verification capture', root, sourceCommit: manifest.git!.commit,
      spec: { rootId: id, bindingRevision: 1, resources: measured.measurement.fingerprint.resources,
        policy: jobPolicyRequirementsRecord(measured.spec.policy), suites: ['install'],
        approvalConfig: { approvalLifetimeMs: 24 * 60 * 60 * 1000 } }, previous: null, now: new Date().toISOString() })
    const recorded = measured.measurement.fingerprint
    const descriptor = JobVerificationInstalledRuntimeDescriptorSchema.parse({
      target: f.configuration.target, runtimeExecutable: f.binary, ociExecutable: f.binary,
      findmntExecutable: f.binary, findmntBinarySha256: digest, runtimeRoot, backingFile: null,
      controllerEnvironment: f.configuration.controllerEnvironment, volumeCapacityBytes: recorded.quota.volumeCapacityBytes,
      quota: recorded.quota, quotaPool: recorded.quotaPool, resources: profile.spec.resources,
      network: profile.spec.policy.network, approvalConfig: profile.approvalConfig,
      aggregateCgroupIdentityDigest: recorded.aggregateCgroupIdentityDigest,
      resourcePolicyRevision: recorded.resourcePolicyRevision, resourcePolicyDigest: recorded.resourcePolicyDigest,
      runtimeApprovalId: recorded.runtimeApprovalId, runtimeApprovalRevision: recorded.runtimeApprovalRevision,
    })
    const seedReceiptPath = join(f.root, 'seed-receipt.json')
    await writeFile(seedReceiptPath, JSON.stringify({ schemaVersion: 1, packageManager: 'pnpm@11.27.0',
      platform: { os: 'linux', arch: 'x64', libc: 'glibc' }, minimumReleaseAge: 2880,
      minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false,
      capturedAt: '2026-01-01T00:00:00Z', provenanceDigest: digest,
      review: { reviewedByPrincipalId: 'installer', reviewedAt: '2026-01-01T00:00:00Z', decisionDigest: digest },
      maxBytes: 3, maxInodes: 3, packages: [],
      dependencyInputs: entries.map(({ path, sha256 }) => ({ path, sha256 })),
      files: ['corepack-cache/pinned', 'pnpm-store/pinned', 'registry-cache/pinned']
        .map(path => ({ path, bytes: 1, sha256: digest })) }), { mode: 0o600 })
    const omitted = new Set(['schemaVersion', 'profileId', 'profileRevision', 'specDigest', 'hostRef',
      'registration', 'mainInstallationId', 'root', 'bootId', 'runtimeBinarySha256', 'ociBinarySha256',
      'configurationDigest', 'seedReceiptSha256', 'tools'])
    const machine = Object.fromEntries(Object.entries(recorded).filter(([key]) => !omitted.has(key)))
    const input = InstalledVerificationRuntimeCaptureInputSchema.parse({ schemaVersion: 2, root, descriptor,
      machine: { ...machine, runtimeExecutable: f.binary, ociExecutable: f.binary,
        resources: profile.spec.resources, approvalConfig: profile.approvalConfig, sourceCommit: profile.sourceCommit },
      seedReceiptPath, qualificationSource: { directory, manifest }, toolSources: [
        { kind: 'codex', executable: '/opt/graphql-ci/tools/codex', sourceExecutable: f.binary, version: 'passive fixture' },
      ] })
    const configuration = await captureInstalledVerificationRuntimeConfiguration(input)
    expect(configuration.machine.runtimeBinarySha256).toBe(f.configuration.pins.runtimeBinarySha256)
    expect(configuration.machine.tools[0]?.binarySha256).toBe(f.configuration.pins.runtimeBinarySha256)
    expect(configuration.machine.bootId).toBe(f.configuration.pins.bootId)
    expect('measurement' in configuration).toBe(false)
    await writeFile(f.location.path, JSON.stringify(configuration), { mode: 0o600 })
    const host = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    expect(await host.currentMetadata(f.sql, profile)).toBeNull()
    const fingerprint = await host.capture!(profile)
    expect(fingerprint).toMatchObject({ schemaVersion: 3, sourceCommit: profile.sourceCommit, profileId: profile.id })
    const restarted = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    expect(await restarted.currentMetadata(f.sql, profile)).toBeNull()
    expect(await restarted.capture!(profile)).toEqual(fingerprint)
    expect(await restarted.currentMetadata(f.sql, profile)).toEqual(fingerprint)
    await writeFile(seedReceiptPath, 'changed seed')
    await expect(restarted.capture!(profile)).rejects.toThrow('seed receipt changed')
  })
  it('installer capture computes host pins instead of accepting supplied digests or readiness', async () => {
    const f = await fixture()
    const { pins, ...installation } = f.configuration
    const input = { ...installation, imageDigest: pins.imageDigest, toolchainDigest: pins.toolchainDigest, diskBytes: pins.diskBytes }
    const measuredConfiguration = { actualMetadataFixture: true }
    const capture = vi.spyOn(qualification, 'captureJobRuntimeConfiguration').mockResolvedValue(measuredConfiguration as unknown as Awaited<ReturnType<typeof qualification.captureJobRuntimeConfiguration>>)
    const result = await captureInstalledRuntimeConfiguration(input)
    const binaryDigest = createHash('sha256').update('pinned fixture bytes').digest('hex')
    expect(result.pins).toEqual({ ...pins, runtimeBinarySha256: binaryDigest, ociBinarySha256: binaryDigest, findmntBinarySha256: binaryDigest,
      configurationDigest: createHash('sha256').update(canonicalGraphJson(measuredConfiguration)).digest('hex') })
    expect(capture).toHaveBeenCalledWith(input.runtimeRoot, input.controllerEnvironment, { findmntBinary: input.findmntExecutable,
      findmntBinarySha256: binaryDigest, backingFile: input.backingFile, backingBytes: input.diskBytes })
    expect(InstalledJobRuntimeCaptureInputSchema.safeParse({ ...input, pins }).success).toBe(false)
    expect(InstalledJobRuntimeCaptureInputSchema.safeParse({ ...input, ready: true }).success).toBe(false)
    expect('measurement' in result).toBe(false)
  })
  it('installer capture rejects stale root identities before capturing installation configuration', async () => {
    const f = await fixture()
    const { pins, ...installation } = f.configuration
    installation.root.binding.filesystem.inode = '0'
    const capture = vi.spyOn(qualification, 'captureJobRuntimeConfiguration')
    await expect(captureInstalledRuntimeConfiguration({ ...installation, imageDigest: pins.imageDigest, toolchainDigest: pins.toolchainDigest,
      diskBytes: pins.diskBytes })).rejects.toMatchObject({ details: { reason: 'passive_identity_changed' } })
    expect(capture).not.toHaveBeenCalled()
  })
  it('G1 readback uses captured metadata and SQL authority without opening config or probing files', async () => {
    const f = await fixture(), measuredConfiguration = { actualMetadataFixture: true }
    const capture = vi.spyOn(qualification, 'captureJobRuntimeConfiguration').mockResolvedValue(measuredConfiguration as unknown as Awaited<ReturnType<typeof qualification.captureJobRuntimeConfiguration>>)
    f.configuration.pins.ociBinarySha256 = f.configuration.pins.runtimeBinarySha256
    f.configuration.pins.findmntBinarySha256 = f.configuration.pins.runtimeBinarySha256
    f.configuration.pins.configurationDigest = createHash('sha256').update(canonicalGraphJson(measuredConfiguration)).digest('hex')
    await writeFile(f.location.path, JSON.stringify(f.configuration))
    const host = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    expect(await host.currentMetadata(f.sql, f.profile)).toBeNull()
    const snapshot = await host.inspect(f.profile)
    expect(snapshot.fingerprint.workspaceLayout).toBe(JOB_RUNTIME_WORKSPACE_LAYOUT)
    expect(CurrentJobRuntimeFingerprintSchema.parse(snapshot.fingerprint)).toEqual(snapshot.fingerprint)
    const observed = { ...f.configuration.target, bootId: f.configuration.pins.bootId, connection: null }
    expect(await inspectInstalledJobRuntime({ configuration: f.location, profile: f.profile, host: observed })).toEqual(snapshot)
    await expect(inspectInstalledJobRuntime({ configuration: f.location, profile: f.profile, host: { ...observed, mainInstallationId: 'other-main' } })).rejects.toMatchObject({ details: { reason: 'installation_changed' } })
    await rm(f.location.path)
    expect(await host.currentMetadata(f.sql, f.profile)).toEqual(snapshot.fingerprint)
    expect(capture).toHaveBeenCalledTimes(2)
    const wrongMain = { query: vi.fn(async () => ({ rows: [{ id: 'different-main' }] })) } as unknown as JobSql
    expect(await host.currentMetadata(wrongMain, f.profile)).toBeNull()
    await expect(host.descriptor(f.profile)).rejects.toMatchObject({ details: { reason: 'configuration_unavailable' } })
    const restarted = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    expect(await restarted.currentMetadata(f.sql, f.profile)).toBeNull()
  })
  it.each([undefined, 'source-inputs-v0'])('rejects historical candidate layout %s without upgrading immutable fingerprints', async workspaceLayout => {
    const f = await fixture(), measuredConfiguration = { actualMetadataFixture: true }
    const capture = vi.spyOn(qualification, 'captureJobRuntimeConfiguration').mockResolvedValue(measuredConfiguration as unknown as Awaited<ReturnType<typeof qualification.captureJobRuntimeConfiguration>>)
    f.configuration.pins.ociBinarySha256 = f.configuration.pins.runtimeBinarySha256
    f.configuration.pins.findmntBinarySha256 = f.configuration.pins.runtimeBinarySha256
    f.configuration.pins.configurationDigest = createHash('sha256').update(canonicalGraphJson(measuredConfiguration)).digest('hex')
    await writeFile(f.location.path, JSON.stringify(f.configuration))
    const host = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    const snapshot = await host.inspect(f.profile)
    const historical = { ...snapshot.fingerprint }
    if (workspaceLayout === undefined) delete (historical as { workspaceLayout?: string }).workspaceLayout
    else Object.assign(historical, { workspaceLayout })
    const fingerprint = JobRuntimeFingerprintSchema.parse(historical)
    const candidate = JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id, fingerprint,
      findmntBinary: f.configuration.findmntExecutable, findmntBinarySha256: f.configuration.pins.findmntBinarySha256,
      backingFile: f.configuration.backingFile, backingBytes: fingerprint.limits.diskBytes,
      controllerEnvironment: f.configuration.controllerEnvironment, sourceParent: fingerprint.root.binding.canonicalPath,
      runtimeRoot: f.configuration.runtimeRoot, spoolBytes: 131072, ttlSeconds: 60 })
    const original = structuredClone(candidate)
    await expect(inspectInstalledJobRuntimeCandidate({ configuration: null, candidate,
      host: { ...f.configuration.target, bootId: f.configuration.pins.bootId, connection: null } })).rejects.toMatchObject({ details: { reason: 'unsupported_workspace_layout' } })
    expect(candidate).toEqual(original)
    expect(fingerprint.workspaceLayout).toBe(workspaceLayout)
    expect(capture).toHaveBeenCalledTimes(1)
  })
  it('missing configuration is explicit unavailable, never defaulted or admitted', async () => {
    const f = await fixture(); const reserve = vi.fn()
    const host = createInstalledJobRuntimeHost({ configuration: null, identity: f.sql, reserve })
    await expect(host.descriptor(f.profile)).rejects.toMatchObject({ code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE', details: { reason: 'missing_configuration' } })
    expect(await host.currentMetadata(f.sql, f.profile)).toBeNull()
    expect(reserve).not.toHaveBeenCalled()
  })
  it('read-only protected metadata preserves explicit paths/environment without granting readiness', async () => {
    const f = await fixture(); await chmod(f.location.path, 0o400)
    expect(await readInstalledRuntimeConfiguration(f.location)).toEqual(f.configuration)
    expect('ready' in f.configuration).toBe(false)
    const extra = { ...f.configuration, ready: true }
    await writeFile(f.location.path + '-other', JSON.stringify(extra), { mode: 0o600 })
    await expect(readInstalledRuntimeConfiguration({ ...f.location, path: f.location.path + '-other' })).rejects.toMatchObject({ code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE' })
  })
  it('rejects active installation identity drift before trusting filesystem pins', async () => {
    const f = await fixture(); const query = vi.fn(async () => ({ rows: [{ id: 'other-installed-main' }] })) as unknown as JobSql['query']
    const host = createInstalledJobRuntimeHost({ configuration: f.location, identity: { query } as JobSql, reserve: vi.fn() })
    await expect(host.descriptor(f.profile)).rejects.toMatchObject({ details: { reason: 'installation_changed' } })
    expect(await host.currentMetadata({ query } as JobSql, f.profile)).toBeNull()
  })
  it('unsupported image/toolchain/disk pins do not borrow another installed policy', async () => {
    const f = await fixture(); f.profile.policy.imageDigest = `sha256:${'2'.repeat(64)}`
    const host = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    await expect(host.descriptor(f.profile)).rejects.toMatchObject({ details: { reason: 'pin_unavailable' } })
    expect(await host.currentMetadata(f.sql, f.profile)).toBeNull()
  })
  it('actual binary replacement invalidates retained metadata without probing the executable', async () => {
    const f = await fixture(); await writeFile(f.binary, 'different executable bytes')
    const host = createInstalledJobRuntimeHost({ configuration: f.location, identity: f.sql, reserve: vi.fn() })
    await expect(host.descriptor(f.profile)).rejects.toMatchObject({ details: { reason: 'passive_identity_changed' } })
  })
  it('rejects writable, wrong-owner or symlink-retargeted configuration', async () => {
    const f = await fixture(); await chmod(f.location.path, 0o666)
    await expect(readInstalledRuntimeConfiguration(f.location)).rejects.toMatchObject({ details: { reason: 'configuration_not_protected' } })
    await chmod(f.location.path, 0o600)
    await expect(readInstalledRuntimeConfiguration({ ...f.location, ownerUid: f.location.ownerUid + 1 })).rejects.toMatchObject({ details: { reason: 'configuration_not_protected' } })
    const alias = join(f.root, 'alias'); await symlink(f.location.path, alias)
    await expect(readInstalledRuntimeConfiguration({ ...f.location, path: alias })).rejects.toMatchObject({ details: { reason: 'configuration_retargeted' } })
  })
})
