import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { CI_QUALIFICATION_SUITE, JobQualificationCandidateSchema, fingerprintQualificationPath, jobQualificationFingerprint,
  validateBoundedVolumeGeometry, qualificationMountId, qualifyJobRuntime, validateIsolationMeasurement, verifyJobQualification,
  type JobQualificationCandidate, type JobQualificationRecord } from './qualification.js'
import { ensureEmptyPodmanHooks } from './executorPodman.js'

const id = '00000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
function candidate(): JobQualificationCandidate {
  return JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id,
    fingerprint: { schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest,
      hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id, bootId: id,
      runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest,
      imageDigest: `sha256:${digest}`, toolchainDigest: digest, configurationDigest: digest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 },
      root: { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
        selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
        binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
          locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
          accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: id, authorizedByPrincipalId: id,
        registration: null, attestationId: id, attestationDigest: digest, boundAt: '2026-10-01T00:00:00Z' } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152,
    findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest, controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
    sourceParent: '/approved/source', runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 600 })
}

describe('qualification metadata and measured observation verification (no native execution)', () => {
  it('denied, revoked, missing or expired approval performs zero admission/probes', async () => {
    for (const status of ['denied', 'revoked', 'expired', 'missing'] as const) {
      const request = candidate()
      const authority = { readApproval: vi.fn(async () => status === 'missing' ? null : {
        status: status === 'expired' ? 'approved' as const : status,
        fingerprint: jobQualificationFingerprint(request), expiresAt: status === 'expired' ? '2020-01-01T00:00:00Z' : '2100-01-01T00:00:00Z' }),
        assertCurrent: vi.fn(), reserve: vi.fn() }
      const record = await qualifyJobRuntime(request, authority, new AbortController().signal)
      expect(record).toMatchObject({ outcome: 'denied', closure: 'not_started', profile: null })
      expect(authority.reserve).not.toHaveBeenCalled()
      expect(authority.assertCurrent).not.toHaveBeenCalled()
    }
  })
  it('current stored deny supersedes ready history and verifier never probes', () => {
    const request = candidate()
    const record: JobQualificationRecord = { suite: CI_QUALIFICATION_SUITE, candidate: request, fingerprint: jobQualificationFingerprint(request),
      measuredFingerprint: null, outcome: 'denied', closure: 'confirmed', reasons: ['filesystem_quota_unavailable'], checkedAt: '2026-10-01T00:00:00Z', expiresAt: '2100-01-01T00:00:00Z', measurements: null, profile: null }
    expect(verifyJobQualification(null, request).reason).toBe('missing')
    expect(verifyJobQualification(record, request).reason).toBe('denied')
  })
  it('expires or invalidates any changed immutable context before considering evidence', () => {
    const request = candidate()
    const record = { suite: CI_QUALIFICATION_SUITE, candidate: request, fingerprint: jobQualificationFingerprint(request), outcome: 'qualified',
      closure: 'confirmed', checkedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-01T00:10:00Z', profile: null, measurements: null, measuredFingerprint: null, reasons: [] } satisfies JobQualificationRecord
    expect(verifyJobQualification(record, request, Date.parse('2026-10-01T00:11:00Z')).reason).toBe('expired')
    for (const change of ['boot', 'root', 'runtime', 'limits', 'configuration', 'policy'] as const) {
      const changed = structuredClone(request)
      if (change === 'boot') changed.fingerprint.bootId = '00000000-0000-4000-8000-000000000002'
      if (change === 'root') changed.fingerprint.root.binding.filesystem.inode = '35'
      if (change === 'runtime') changed.fingerprint.runtimeBinarySha256 = 'b'.repeat(64)
      if (change === 'limits') changed.fingerprint.limits.pidsLimit++
      if (change === 'configuration') changed.fingerprint.configurationDigest = 'b'.repeat(64)
      if (change === 'policy') changed.fingerprint.profileRevision++
      expect(verifyJobQualification(record, changed, Date.parse('2026-10-01T00:01:00Z')).reason).toBe('context_changed')
    }
    expect(verifyJobQualification(record, request, Date.parse('2026-10-01T00:01:00Z')).reason).toBe('evidence_invalid')
  })
  it('rejects injected controller credentials rather than passing them to a diagnostic', () => {
    expect(() => JobQualificationCandidateSchema.parse({ ...candidate(), controllerEnvironment: { ...candidate().controllerEnvironment, OPENAI_API_KEY: 'forbidden' } })).toThrow()
  })
  it('requires fixed preallocated protected backing storage and exact finite ext4 geometry', () => {
    const observed = { expectedBytes: 2097152n, backingBytes: 2097152n, allocatedBytes: 2097152n, rootOwned: true, writableByWorker: false,
      links: 1n, offset: 0n, sizeLimit: 2097152n, blockDeviceBytes: 2097152n, filesystemBytes: 2000000n, filesystemType: 0xef53n, mountOptions: ['rw', 'nosuid', 'nodev'] }
    expect(() => validateBoundedVolumeGeometry(observed)).not.toThrow()
    for (const weaker of [{ allocatedBytes: 1024n }, { rootOwned: false }, { writableByWorker: true }, { links: 2n }, { offset: 4096n },
      { sizeLimit: 0n }, { backingBytes: 4194304n }, { blockDeviceBytes: 4194304n }, { filesystemBytes: 4194304n }, { filesystemType: 0x58465342n },
      { mountOptions: ['rw'] }, { mountOptions: ['rw', 'nosuid', 'nodev', 'discard'] }]) expect(() => validateBoundedVolumeGeometry({ ...observed, ...weaker })).toThrow()
  })
  it('binds escaped mount paths and rejects prefix lookalikes', () => {
    const mounts = '1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / /approved rw - xfs disk rw\n3 2 0:3 / /approved/space\\040here rw - xfs disk rw\n'
    expect(qualificationMountId('/approved/space here/child', mounts)).toBe('3')
    expect(qualificationMountId('/approved-looking/child', mounts)).toBe('1')
  })
  it('rejects weaker namespace/network/cgroup/toolchain observations', () => {
    const request = candidate()
    const probe = { toolchain: { node: 'v26.5.1', pnpm: '11.27.0', corepack: '0.34.6', git: 'git version 2.45.0', flock: 'flock from util-linux 2.39.3' },
      rootfsWriteError: 'EROFS', sourceWrite: true, proc: true, pidNamespace: 'pid:[300]', networkNamespace: 'net:[301]', interfaces: ['lo'],
      memoryMax: '67108864', swapMax: '0', pidsMax: '64', cpuRatio: 1, detachedChild: true, environment: ['CI', 'HOME', 'LANG', 'PATH'], capabilities: '0000000000000000', noNewPrivileges: '1' }
    const host = { hostPidNamespace: 'pid:[100]', hostNetworkNamespace: 'net:[101]' }
    expect(() => validateIsolationMeasurement(probe, request, host)).not.toThrow()
    for (const weaker of [{ pidNamespace: undefined }, { pidNamespace: host.hostPidNamespace }, { networkNamespace: host.hostNetworkNamespace },
      { interfaces: ['eth0', 'lo'] }, { memoryMax: 'max' }, { swapMax: 'max' }, { pidsMax: 'max' }, { cpuRatio: 2 }, { detachedChild: false }, { environment: ['API_TOKEN'] }]) {
      expect(() => validateIsolationMeasurement({ ...probe, ...weaker }, request, host)).toThrow()
    }
  })
  it('measures actual bytes/identity and rejects symlink or writable executable replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-qualification-file-'))
    try {
      const binary = join(root, 'binary'); await writeFile(binary, 'original bytes', { mode: 0o700 })
      const measured = await fingerprintQualificationPath(binary, true)
      expect(measured.sha256).toBe(createHash('sha256').update('original bytes').digest('hex'))
      await symlink(binary, join(root, 'alias'))
      await expect(fingerprintQualificationPath(join(root, 'alias'), true)).rejects.toThrow('canonical')
      await chmod(binary, 0o777)
      await expect(fingerprintQualificationPath(binary, true)).rejects.toThrow('trust boundary')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('only reuses an actually empty owned hook directory in the approved runtime root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-qualification-hooks-'))
    try {
      const hooks = await ensureEmptyPodmanHooks(root)
      expect(await ensureEmptyPodmanHooks(root)).toBe(hooks)
      await writeFile(join(hooks, 'unexpected.json'), '{}')
      await expect(ensureEmptyPodmanHooks(root)).rejects.toThrow('Empty owned hook directory')
      expect(hash({ path: hooks })).toMatch(/^[a-f0-9]{64}$/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
