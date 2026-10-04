import { inflateSync } from 'node:zlib'
import { JOB_PRIVATE_GIT_LAYOUT, JOB_GIT_ENVIRONMENT } from './privateGitMounts.js'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'
import { CI_QUALIFICATION_SUITE, JobQualificationCandidateSchema, fingerprintQualificationPath, jobQualificationFingerprint,
  validateBoundedVolumeGeometry, qualificationMountId, qualifyJobRuntime, validateIsolationMeasurement, verifyJobQualification,
  validateJobQualificationMounts, prepareQualificationPrivateGit, createPhysicalJobRuntimeProducer, type JobQualificationCandidate, type JobQualificationRecord } from './qualification.js'
import { ensureEmptyPodmanHooks } from './executorPodman.js'

const id = '00000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
function candidate(): JobQualificationCandidate {
  return JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id,
    fingerprint: { workspaceLayout:JOB_PRIVATE_GIT_LAYOUT,schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest,
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
      memoryMax: '67108864', swapMax: '0', pidsMax: '64', cpuRatio: 1, detachedChild: true, environment: ['CI', 'FOREMAN_CODE_JOB_INPUT_MANIFEST', 'GRAPHQL_JOB_INPUT_MANIFEST', 'HOME', 'LANG', 'PATH',...Object.keys(JOB_GIT_ENVIRONMENT)].sort(),gitCommon:'/graphql-job-git',gitRead:true,gitConfigWriteError:'EROFS',gitIndexWriteError:'EROFS',gitHeadWriteError:'EROFS',gitObjectWriteError:'EROFS',schedulerWrite:true, inputRead: true, inputWriteError: 'EROFS', capabilities: '0000000000000000', noNewPrivileges: '1' }
    const host = { hostPidNamespace: 'pid:[100]', hostNetworkNamespace: 'net:[101]' }
    expect(() => validateIsolationMeasurement(probe, request, host)).not.toThrow()
    for (const weaker of [{ pidNamespace: undefined }, { pidNamespace: host.hostPidNamespace }, { networkNamespace: host.hostNetworkNamespace },
      { interfaces: ['eth0', 'lo'] }, { memoryMax: 'max' }, { swapMax: 'max' }, { pidsMax: 'max' }, { cpuRatio: 2 }, { detachedChild: false }, { environment: ['API_TOKEN'] },{gitRead:false},{gitConfigWriteError:null},{gitIndexWriteError:null},{gitHeadWriteError:null},{gitObjectWriteError:null},{schedulerWrite:false}]) {
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

async function retainedPodmanProbe() {
  const observed=JSON.parse(await readFile(new URL('../../../test/fixtures/podman-qualification-probe.json',import.meta.url),'utf8')) as {containerId:string;probe:Record<string,unknown>}
  const original=candidate(),request=JobQualificationCandidateSchema.parse({...original,backingBytes:34359738368,
    fingerprint:{...original.fingerprint,limits:{cpuLimit:4,memoryBytes:6442450944,pidsLimit:256,diskBytes:34359738368}}})
  const host={hostPidNamespace:'pid:[1]',hostNetworkNamespace:'net:[2]',containerId:observed.containerId,containerHostname:observed.containerId.slice(0,12)}
  return {observed,request,host}
}
it('accepts only the managed HOSTNAME bound to original inspection and rejects missing/mismatched values and every other extra variable',async()=>{
  const {observed,request,host}=await retainedPodmanProbe()
  // The retained old stdout lists HOSTNAME without its value. These controlled values test the new actual-value binding.
  const probe:Record<string,unknown>={...observed.probe,hostname:host.containerHostname}
  expect(()=>validateIsolationMeasurement(probe,request,host)).not.toThrow()
  for(const change of [{hostname:undefined},{hostname:''},{hostname:'parent-host'},{hostname:'other-container'},
    {environment:[...(probe.environment as string[]),'API_TOKEN'].sort()},
    {environment:[...(probe.environment as string[]),'HOSTNAME'].sort()},
  ])expect(()=>validateIsolationMeasurement({...probe,...change},request,host)).toThrow()
  expect(()=>validateIsolationMeasurement(probe,request,{...host,containerId:'unowned',containerHostname:host.containerHostname})).toThrow()
})
it('matches every other retained physical stdout guard with selected limits and keeps environment/namespace/resource refusals',async()=>{
  const {observed,request,host}=await retainedPodmanProbe()
  const original={...observed.probe,environment:(observed.probe.environment as string[]).filter(name=>name!=='HOSTNAME')}
  expect(()=>validateIsolationMeasurement(original,request,host)).not.toThrow()
  for(const change of [{gitIndexWriteError:null},{memoryMax:'max'},{interfaces:['lo','eth0']},{environment:['API_TOKEN']}])
    expect(()=>validateIsolationMeasurement({...original,...change},request,host)).toThrow()
})

it('requires exactly four original binds with measured RO/RW modes and rejects old two-mount layout',()=>{
  const paths={sourceRoot:'/owned/tree',inputRoot:'/owned/tree/.graphql-job-inputs',gitDirectory:'/owned/repository',schedulerDirectory:'/owned/job-heavy-jobs'}
  const mounts=[{Type:'bind',Source:paths.sourceRoot,Destination:'/workspace',RW:true},
    {Type:'bind',Source:paths.inputRoot,Destination:'/workspace/.graphql-job-inputs',RW:false},
    {Type:'bind',Source:paths.gitDirectory,Destination:'/graphql-job-git',RW:false},
    {Type:'bind',Source:paths.schedulerDirectory,Destination:'/graphql-job-git/graphql-heavy-jobs',RW:true}]
  const tmpfs={'/tmp':'rw,nosuid,nodev,noexec,size=131072,rprivate,tmpcopyup'}
  expect(()=>validateJobQualificationMounts(mounts,paths,tmpfs,131072)).not.toThrow()
  expect(()=>validateJobQualificationMounts([mounts[0]!,mounts[1]!],paths,tmpfs,131072)).toThrow()
  expect(()=>validateJobQualificationMounts(mounts.map((item,index)=>index===2?{...item,RW:true}:item),paths,tmpfs,131072)).toThrow()
  expect(()=>validateJobQualificationMounts(mounts.map((item,index)=>index===3?{...item,Source:'/arbitrary/state'}:item),paths,tmpfs,131072)).toThrow()
})
it('invalidates historical two-mount qualification for the new layout without granting new capability',()=>{
  const request=candidate(),record={suite:'rootless-podman-ext4-volume-v1',candidate:request,fingerprint:jobQualificationFingerprint(request),outcome:'qualified',expiresAt:'2100-01-01T00:00:00Z'} as unknown as JobQualificationRecord
  expect(verifyJobQualification(record,request).reason).toBe('context_changed')
})

it('builds only qualifier-owned diagnostic Git objects, references and empty scheduler mountpoint without native entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-qualification-private-git-'))
  try {
    const tree = join(root, 'tree'), git = join(root, 'repository')
    await mkdir(tree, { mode: 0o700 })
    await prepareQualificationPrivateGit(git, tree)
    expect(await readdir(join(git, 'refs'))).toEqual([])
    expect(await readdir(join(git, 'graphql-heavy-jobs'))).toEqual([])
    const head = (await readFile(join(git, 'HEAD'), 'utf8')).trim()
    const commit = inflateSync(await readFile(join(git, 'objects', head.slice(0, 2), head.slice(2))))
    expect(createHash('sha1').update(commit).digest('hex')).toBe(head)
    expect(commit.toString()).toContain('Private Git mount qualification')
    const index = await readFile(join(git, 'index'))
    expect(index.subarray(0, 4).toString()).toBe('DIRC')
    expect(index.readUInt32BE(4)).toBe(2)
    expect(index.readUInt32BE(8)).toBe(0)
    expect(index.subarray(12)).toEqual(createHash('sha1').update(index.subarray(0, 12)).digest())
    expect(await readFile(join(tree, 'qualification.txt'), 'utf8')).toBe('original qualification snapshot')
    expect(await readFile(join(git, 'config'), 'utf8')).toContain(`worktree = ${tree}`)
    await expect(prepareQualificationPrivateGit(git, tree)).rejects.toMatchObject({ code: 'EEXIST' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps a historical fingerprint readable but denies new qualification before admission or probes', async () => {
  const request = candidate()
  delete request.fingerprint.workspaceLayout
  const authority = { readApproval: vi.fn(async () => ({ status: 'approved' as const,
    fingerprint: jobQualificationFingerprint(request), expiresAt: '2100-01-01T00:00:00Z' })),
    assertCurrent: vi.fn(), reserve: vi.fn() }
  expect((await qualifyJobRuntime(request, authority, new AbortController().signal)).reasons).toEqual(['workspace_layout_unqualified'])
  expect(authority.assertCurrent).not.toHaveBeenCalled()
  expect(authority.reserve).not.toHaveBeenCalled()
})
it('denies historical readiness without probing or silently upgrading immutable facts', async () => {
  const request = candidate(), runtime = { workspaceLayout: JOB_PRIVATE_GIT_LAYOUT }
  delete request.fingerprint.workspaceLayout
  const measurement = { origin: 'real-runtime', expiresAt: '2100-01-01T00:00:00Z', runtime, fingerprint: request.fingerprint }
  const profile = { status: 'qualified', measurement } as unknown as JobRuntimeProfile
  const dependencies = { descriptor: vi.fn(), immutableProfile: vi.fn(), admission: vi.fn(), currentMetadata: vi.fn() }
  const producer = createPhysicalJobRuntimeProducer(dependencies)
  expect(await producer.revalidate({ query: vi.fn() }, profile)).toEqual({ ready: false, reasons: ['unsupported_workspace_layout'] })
  expect(dependencies.currentMetadata).not.toHaveBeenCalled()
  expect(profile.status).toBe('qualified')
  expect('workspaceLayout' in measurement.fingerprint).toBe(false)
})
