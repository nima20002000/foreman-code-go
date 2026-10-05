import { constants } from 'node:fs'
import { mkdir, open, readFile, readlink, rm, statfs, writeFile, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { release } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import type { FileHandle } from 'node:fs/promises'
import { JobTargetSchema } from '@foreman-code/contracts/jobs'
import { JobVerificationPassSchema, JobVerificationReportSchema } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import { JOB_INPUT_DIRECTORY, JobBuildInputManifestSchema } from '@foreman-code/contracts/job-inputs'
import { JobVerificationQualificationCandidateSchema, JobVerificationRepositoryContextSchema,
  JobVerificationRuntimeQualificationResultSchema, JobVerificationRuntimeMeasurementSchema,
  JobVerificationOfflineSeedReceiptSchema, JOB_VERIFICATION_BASE_CHECKS,
  type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { InstalledVerificationRuntimeConfigurationSchema } from './installedVerificationRuntime.js'
import { readProtectedRuntimeConfiguration, readProtectedRuntimeFile,
  type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import { podmanIsolationCreateArgv, ensureEmptyPodmanHooks } from './executorPodman.js'
import { assertJobRuntimeEntryContext, jobQualificationFingerprint, runQualificationCommand,
  validateVerificationIsolationObservation, type JobQualificationAuthority }
  from './qualification.js'
import { prepareVerificationQualificationSource } from './verificationQualificationSource.js'
import { JobProjectQuotaReadbackSchema, readVerificationQuotaPool, verifyJobQuotaOwnership,
  type JobQuotaReader } from './quotaOwnership.js'
import { JOB_GIT_ENVIRONMENT } from './privateGitMounts.js'
import { jobDigest } from './service.js'

const reportFiles = ['summary.json', 'junit.xml', 'vitest.json', 'logs.tar.gz']
const idle = 'setInterval(()=>{},1000)'
const quotaProbe = `const fs=require('node:fs');const input=JSON.parse(process.argv[1]);
const file='/job-scratch/quota-bytes';let byteError=null,inodeError=null,inodeCreated=0;
if(input.phase==='bytes'){
try{const fd=fs.openSync(file,'wx',0o600);try{const bytes=Buffer.alloc(1048576,1);
for(let n=0;n<=Math.ceil(input.bytes/bytes.length);n++){fs.writeSync(fd,bytes);fs.fsyncSync(fd)}}finally{fs.closeSync(fd)}}catch(e){byteError=e.code}
}else{
fs.rmSync(file,{force:true});fs.mkdirSync('/job-scratch/quota-inodes',{mode:0o700});
try{for(let n=0;n<=input.inodes;n++){fs.closeSync(fs.openSync('/job-scratch/quota-inodes/'+n,'wx',0o600));inodeCreated++}}catch(e){inodeError=e.code}
fs.rmSync('/job-scratch/quota-inodes',{recursive:true});}
console.log(JSON.stringify({byteError,inodeError,inodeCreated}));`

/** Every pass comes from full ordinary commands in the admitted image and original quota namespace. */
export async function qualifyVerificationRuntime(input: {
  candidate: JobQualificationCandidateRecord
  admission: JobRuntimeNativeAdmissionRecord
  configuration: InstalledRuntimeConfigurationLocation | null
  authority: JobQualificationAuthority
  signal: AbortSignal
}) {
  const candidate = JobVerificationQualificationCandidateSchema.parse(input.candidate)
  const fingerprint = candidate.fingerprint
  const configuration = await readProtectedRuntimeConfiguration(input.configuration,
    InstalledVerificationRuntimeConfigurationSchema)
  const approval = await input.authority.readApproval(candidate.approvalId)
  if (!approval || approval.status !== 'approved' || approval.fingerprint !== jobQualificationFingerprint(candidate)
    || Date.parse(approval.expiresAt) <= Date.now()) {
    return { outcome: 'denied' as const, closure: 'not_started' as const, reasons: ['approval_denied_or_expired'] }
  }
  const pool = fingerprint.quotaPool
  if (!pool || !isDeepStrictEqual(pool, configuration.descriptor.quotaPool)) {
    throw new Error('Protected per-Job quota pool required for physical qualification.')
  }
  await input.authority.assertCurrent(candidate)
  const owner = await input.authority.reserve(candidate, input.signal)
  if (owner.completedResult) return JobVerificationRuntimeQualificationResultSchema.parse(owner.completedResult)
  const run = async (binary: string, argv: string[], timeoutMs = 30000) => {
    input.signal.throwIfAborted()
    await input.authority.assertCurrent(candidate)
    await assertJobRuntimeEntryContext(candidate)
    return runQualificationCommand(owner, binary, argv, candidate.controllerEnvironment, input.signal, timeoutMs)
  }
  const podman = (argv: string[], timeoutMs?: number) => run(fingerprint.runtimeExecutable,
    argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv], timeoutMs)
  const checked = async (argv: string[], timeoutMs?: number) => {
    const result = await podman(argv, timeoutMs)
    if (result.exitCode !== 0) throw new Error('Physical verification runtime command failed.')
    return result.stdout
  }
  const readQuota: JobQuotaReader = async (saved, directory, signal) => {
    signal.throwIfAborted()
    const result = await run(saved.queryExecutable, [directory, saved.blockDevice])
    if (result.exitCode !== 0) throw new Error('Physical quota readback failed.')
    return JobProjectQuotaReadbackSchema.parse(JSON.parse(result.stdout))
  }
  const claims: Array<{ path: string; file: FileHandle; namespace: string }> = []
  let closed = false
  let denial: Error | undefined
  let result: ReturnType<typeof JobVerificationRuntimeQualificationResultSchema.parse> | undefined
  try {
    const quotas = await readVerificationQuotaPool(pool, fingerprint.root.binding, input.signal, readQuota)
    for (const slot of pool.slots) {
      const path = join(candidate.sourceParent, `quota-${slot.namespace}.claim.json`)
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const namespace = join(candidate.sourceParent, slot.namespace, candidate.operationId)
      claims.push({ path, file, namespace })
      await file.writeFile(JSON.stringify({ kind: 'qualification', qualificationId: candidate.qualificationId, operationId: candidate.operationId }))
      await file.sync()
      await mkdir(namespace, { mode: 0o700 })
      await verifyJobQuotaOwnership({ pool, binding: fingerprint.root.binding, slot, directory: namespace,
        signal: input.signal, read: readQuota })
    }
    const namespace = claims[0]!.namespace
    const source = await prepareVerificationQualificationSource({ ...configuration.qualificationSource,
      namespace, signal: input.signal })
    const inputRoot = join(source.sourceRoot, JOB_INPUT_DIRECTORY)
    const scratch = join(namespace, 'job-scratch')
    await mkdir(inputRoot, { mode: 0o700 })
    await mkdir(scratch, { mode: 0o700 })
    await writeFile(join(inputRoot, 'manifest.json'), JSON.stringify(JobBuildInputManifestSchema.parse({ version: 1,
      inputSnapshotDigest: jobDigest({ inputs: [], workflowInput: null }), workflowInput: null, files: [] })), { mode: 0o444 })
    await ensureEmptyPodmanHooks(candidate.runtimeRoot)
    const info = JSON.parse(await checked(['info', '--format=json']))
    if (info.host?.serviceIsRemote !== false || info.host?.security?.rootless !== true
      || info.host.cgroupVersion !== 'v2' || info.host.cgroupManager !== 'systemd'
      || info.host.kernel !== release() || info.host.ociRuntime?.path !== fingerprint.ociExecutable) {
      throw new Error('Local rootless cgroup-v2 runtime required.')
    }
    const images = JSON.parse(await checked(['image', 'inspect', fingerprint.imageDigest]))
    const imageId = images[0]?.Id?.replace(/^sha256:/, '')
    if (images.length !== 1 || !/^[a-f0-9]{64}$/.test(imageId ?? '')
      || `sha256:${imageId}` !== fingerprint.imageDigest) {
      throw new Error('The approved immutable verification image changed.')
    }
    const identity = `graphql-ci-qualification-${candidate.qualificationId}`
    await owner.registerContainer(identity, jobQualificationFingerprint(candidate))
    const containerId = (await checked(podmanIsolationCreateArgv({ identity, ...source,
      runtimeRoot: candidate.runtimeRoot, cwd: source.sourceRoot, argv: ['node', '-e', idle], inputRoot,
      profile: { ...fingerprint.limits, imageDigest: fingerprint.imageDigest }, spoolBytes: candidate.spoolBytes,
      labels: { 'graphql.qualification.identity': identity,
        'graphql.qualification.fingerprint': jobQualificationFingerprint(candidate) },
      verification: { resources: fingerprint.resources, scratchDirectory: scratch },
    }))).trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Original verification container identity missing.')
    await owner.observeContainer(identity, containerId)
    await checked(['start', containerId])
    await owner.enterContainer(identity, containerId)
    const ownerSentinel = join(candidate.runtimeRoot, `qualification-${candidate.operationId}-owner-sentinel`)
    await writeFile(ownerSentinel, 'private controller state', { mode: 0o600, flag: 'wx' })
    let observation: Record<string, unknown>
    try {
      observation = JSON.parse(await checked(['exec', containerId, 'node',
        '/opt/graphql-ci/verification-observation.mjs', JSON.stringify({ ownerSentinelPaths: [ownerSentinel],
          tools: fingerprint.tools })]))
    } finally { await rm(ownerSentinel, { force: true }) }
    validateVerificationIsolationObservation({ observation, resources: fingerprint.resources,
      hostPidNamespace: await readlink('/proc/self/ns/pid'), hostNetworkNamespace: await readlink('/proc/self/ns/net'),
      ownerSentinelPaths: [ownerSentinel] })
    const environment = ['CI', 'FOREMAN_CODE_JOB_INPUT_MANIFEST', 'GRAPHQL_JOB_INPUT_MANIFEST', 'HOME', 'LANG',
      'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', ...Object.keys(JOB_GIT_ENVIRONMENT)]
    if (Array.isArray(observation.environment) && observation.environment.includes('HOSTNAME')) environment.push('HOSTNAME')
    if (!isDeepStrictEqual(observation.environment, environment.sort()) || jobDigest(observation.toolchain) !== fingerprint.toolchainDigest
      || !isDeepStrictEqual(observation.tools, fingerprint.tools) || observation.rootfsWriteError !== 'EROFS'
      || observation.gitWriteErrors !== 'EROFS,EROFS,EROFS' || observation.schedulerWrite !== true
      || !Number.isSafeInteger(observation.detachedChildPid) || Number(observation.detachedChildPid) <= 0) {
      throw new Error('Physical image, tools and private Git isolation changed.')
    }
    const quotaResult = JSON.parse(await checked(['exec', containerId, 'node', '-e', quotaProbe,
      JSON.stringify({ phase: 'bytes', bytes: pool.slots[0]!.hardLimitBytes })],
    Math.min(600000, Date.parse(approval.expiresAt) - Date.now())))
    if (quotaResult.byteError !== 'EDQUOT') {
      throw new Error('Per-Job byte and inode limits did not deny physical writes.')
    }
    const independence = []
    for (const claim of claims.slice(1)) {
      const path = join(claim.namespace, 'independent-quota')
      await writeFile(path, 'independent Job capacity', { mode: 0o600, flag: 'wx' })
      independence.push(await readFile(path, 'utf8'))
    }
    const quotaInodes = JSON.parse(await checked(['exec', containerId, 'node', '-e', quotaProbe,
      JSON.stringify({ phase: 'inodes', inodes: pool.slots[0]!.hardInodes })],
    Math.min(600000, Date.parse(approval.expiresAt) - Date.now())))
    if (quotaInodes.inodeError !== 'EDQUOT') throw new Error('Per-Job inode limit did not deny physical file creation.')
    const seedBytes = await readProtectedRuntimeFile({ path: configuration.seedReceiptPath,
      ownerUid: input.configuration!.ownerUid }, 16 * 1024 * 1024)
    const seed = JobVerificationOfflineSeedReceiptSchema.parse(JSON.parse(seedBytes.toString('utf8')))
    const checkedAt = new Date().toISOString()
    const expiresAt = new Date(Math.min(Date.parse(approval.expiresAt),
      Date.parse(checkedAt) + candidate.ttlSeconds * 1000)).toISOString()
    const profileIdentity = { profileId: fingerprint.profileId, profileRevision: fingerprint.profileRevision,
      qualificationId: candidate.qualificationId, rootId: fingerprint.root.binding.rootId,
      bindingRevision: fingerprint.root.binding.bindingRevision, fingerprintDigest: jobQualificationFingerprint(candidate),
      imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
      approvalId: candidate.approvalId, approvalExpiresAt: approval.expiresAt, qualificationExpiresAt: expiresAt }
    const target = JobTargetSchema.parse({ schemaVersion: 1, mainId: fingerprint.mainInstallationId,
      hostRef: fingerprint.hostRef, registration: fingerprint.registration, mainInstallationId: fingerprint.mainInstallationId,
      destination: { canonicalProjectRoot: source.sourceRoot, canonicalCwd: source.sourceRoot,
        managedRuntimeRoot: candidate.runtimeRoot, directoryIdentityHash: jobDigest(namespace),
        rootPolicyId: fingerprint.root.selection.rootPolicyId,
        rootPolicyRevision: fingerprint.root.selection.rootPolicyRevision,
        locationRevision: fingerprint.root.selection.locationRevision, attestationId: fingerprint.root.attestationId,
        attestationHash: fingerprint.root.attestationDigest } })
    const ownerConcurrency = fingerprint.hostRef.kind === 'main'
      ? JOB_VERIFICATION_OWNER_CONFIGURATION.mainConcurrentJobs : JOB_VERIFICATION_OWNER_CONFIGURATION.laptopConcurrentJobs
    const concurrency = Math.min(ownerConcurrency, pool.slots.length,
      ...Object.keys(fingerprint.limits).map(key => Math.floor(
        Reflect.get(fingerprint.deviceLimits, key) / Reflect.get(fingerprint.limits, key))))
    if (concurrency < 1) throw new Error('Measured device resource headroom cannot reserve one verification Job.')
    const suites = []
    const reports = []
    let failureContext: ReturnType<typeof JobVerificationRepositoryContextSchema.parse> | undefined
    for (const suite of candidate.profile.spec.suites) {
      await resetColdWorkload(source.sourceRoot, scratch, configuration.qualificationSource.manifest.entries.map(file => file.path))
      const before = await statfs(namespace)
      const bytesBefore = (before.blocks - before.bfree) * before.bsize
      const inodesBefore = before.files - before.ffree
      const maxBytes = Math.floor(Math.min(fingerprint.resources.reportBytes,
        candidate.profile.spec.policy.maxOutputBytes) / reportFiles.length)
      const context = JobVerificationRepositoryContextSchema.parse({
        identity: { commit: fingerprint.sourceCommit, manifestDigest: fingerprint.root.source.manifestDigest,
          definitionVersionId: `${fingerprint.profileId}:${fingerprint.profileRevision}`,
          suite, executionId: candidate.operationId, attemptId: `${candidate.qualificationId}:${suite}`, target,
          profile: profileIdentity, resources: fingerprint.resources,
          parameters: { unitWorkers: JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers, integrationShards: 1 } },
        privateGit: source.privateGit, executionTimeoutMs: candidate.profile.spec.policy.executionTimeoutMs,
        cancellationTimeoutMs: Math.max(1, candidate.profile.spec.policy.cancellationGraceMs),
        qualifiedUnitWorkers: JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers,
        limits: { summaryBytes: maxBytes, junitBytes: maxBytes, vitestBytes: maxBytes,
          logsArchiveBytes: maxBytes, logBytes: Math.min(maxBytes, candidate.profile.spec.policy.maxLogBytes) },
        mutableDirectory: '/job-scratch', storeDirectory: '/job-scratch/pnpm-store',
        preseedReceipt: { lockfileSha256: seed.dependencyInputs.find(file => file.path === 'pnpm-lock.yaml')!.sha256,
          pnpmVersion: '11.27.0', platform: 'linux', architecture: 'x64', provenanceDigest: seed.provenanceDigest,
          minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true },
        unitCodex: fingerprint.tools.filter(tool => tool.kind === 'codex').map(({ executable, binarySha256, version }) =>
          ({ executable, binarySha256, version }))[0],
      })
      failureContext = context
      const contextPath = join(inputRoot, 'qualification-context.json')
      await writeFile(contextPath, JSON.stringify({ ...context,
        measurement: { mutableDirectory: '/job-scratch', cgroupDirectory: '/sys/fs/cgroup' } }), { mode: 0o444 })
      const execution = await podman(['exec', containerId, 'node', 'scripts/verify-repository.mjs',
        '--context', `/workspace/${JOB_INPUT_DIRECTORY}/qualification-context.json`],
      context.executionTimeoutMs + context.cancellationTimeoutMs + candidate.profile.spec.policy.publicationTimeoutMs)
      if (execution.exitCode !== 0) throw new Error(`Complete ${suite} qualification failed.`)
      const report = JobVerificationReportSchema.parse(JSON.parse(await readBoundedReport(source.sourceRoot,
        'summary.json', maxBytes)))
      const published = await Promise.all(reportFiles.map(file => readBoundedReport(source.sourceRoot, file, maxBytes)))
      const samples = JSON.parse((await readFile(join(source.sourceRoot, '.logs/verification/parts/resource-samples.json'))).toString())
      if (!samples.samples?.length || samples.samples.some((sample: { error?: string }) => sample.error)) {
        throw new Error('Complete cold-cache resource samples required.')
      }
      const quota = await verifyJobQuotaOwnership({ pool, binding: fingerprint.root.binding,
        slot: pool.slots[0]!, directory: namespace, signal: input.signal, read: readQuota })
      const coldCachePeakBytes = Math.max(quota.usedBytes, samples.sampledPeaks.mutableBytes - bytesBefore, 1)
      const coldCachePeakInodes = Math.max(quota.usedInodes, samples.sampledPeaks.mutableInodes - inodesBefore, 1)
      reports.push({ report, expected: context.identity, published: published.map(bytes => jobDigest(bytes.toString('base64'))) })
      suites.push({ suite, resources: fingerprint.resources, coldCachePeakBytes, coldCachePeakInodes,
        maxConcurrentHeavyJobs: concurrency, maxUnitWorkers: context.identity.parameters.unitWorkers,
        maxIntegrationShards: context.identity.parameters.integrationShards,
        evidenceDigest: jobDigest({ report, samples, quota, published: reports.at(-1)!.published }) })
    }
    if (!failureContext) throw new Error('At least one physical verification suite is required.')
    await resetColdWorkload(source.sourceRoot, scratch, configuration.qualificationSource.manifest.entries.map(file => file.path))
    const interrupted = { ...failureContext, executionTimeoutMs: 1, identity: { ...failureContext.identity,
      attemptId: `${candidate.qualificationId}:interrupted` } }
    await writeFile(join(inputRoot, 'qualification-context.json'), JSON.stringify(interrupted), { mode: 0o444 })
    const failed = await podman(['exec', containerId, 'node', 'scripts/verify-repository.mjs',
      '--context', `/workspace/${JOB_INPUT_DIRECTORY}/qualification-context.json`],
    Math.max(30000, interrupted.cancellationTimeoutMs + candidate.profile.spec.policy.publicationTimeoutMs))
    const failureReport = JobVerificationReportSchema.parse(JSON.parse(await readBoundedReport(source.sourceRoot,
      'summary.json', interrupted.limits.summaryBytes)))
    if (failed.exitCode === 0 || failureReport.outcome === 'passed' || failureReport.attemptId !== interrupted.identity.attemptId) {
      throw new Error('Interrupted physical qualification did not publish an honest failure report.')
    }
    const failureOutputs = await Promise.all(reportFiles.map(file => readBoundedReport(source.sourceRoot, file,
      interrupted.limits.summaryBytes)))
    await checked(['stop', '--time=1', containerId])
    closed = await owner.close()
    if (!closed) throw new Error('Physical verification descendant closure is unconfirmed.')
    for (const report of reports) JobVerificationPassSchema.parse({ report: report.report, expected: report.expected,
      process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
      publication: 'complete', requiredOutputsVerified: true })
    await input.authority.assertCurrent(candidate)
    const runtime = { ...fingerprint.limits, workspaceLayout: fingerprint.workspaceLayout,
      policyId: fingerprint.profileId, policyRevision: fingerprint.profileRevision,
      qualificationId: candidate.qualificationId, imageDigest: fingerprint.imageDigest,
      toolchainDigest: fingerprint.toolchainDigest, runtimeVersion: info.version.Version,
      ociRuntimeVersion: info.host.ociRuntime.version.split('\n')[0], kernelVersion: release(),
      rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true,
      network: fingerprint.network, quota: fingerprint.quota, deviceLimits: fingerprint.deviceLimits,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
      runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
      provisioningSuite: fingerprint.provisioningSuite, aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest,
      imageManifestDigest: fingerprint.imageManifestDigest, imageConfigDigest: fingerprint.imageConfigDigest }
    const evidence = { observation, quotas, quotaResult, quotaInodes, independence, suites, reports, failureReport,
      failureOutputs: failureOutputs.map(bytes => jobDigest(bytes.toString('base64'))), containerId, closed }
    const measurement = JobVerificationRuntimeMeasurementSchema.parse({ schemaVersion: 2, fingerprint,
      identity: profileIdentity, origin: 'real-runtime', approvedAt: candidate.approvedAt, checkedAt, expiresAt, suites,
      checks: [...JOB_VERIFICATION_BASE_CHECKS, 'network-none'].map(id => ({ id, passed: true,
        evidenceDigest: jobDigest({ id, evidence }) })) })
    result = JobVerificationRuntimeQualificationResultSchema.parse({ outcome: 'qualified', measurement, runtime })
  } catch (error) {
    denial = error instanceof Error ? error : new Error('Physical verification qualification failed.')
  } finally {
    if (!closed) closed = await owner.close()
    if (closed) {
      for (const claim of claims.reverse()) {
        await rm(claim.namespace, { recursive: true, force: true })
        const named = await lstat(claim.path)
        const retained = await claim.file.stat()
        if (named.dev !== retained.dev || named.ino !== retained.ino) throw new Error('Original qualification quota claim changed.')
        await rm(claim.path)
        await claim.file.close()
      }
    } else {
      for (const claim of claims) await claim.file.close()
    }
  }
  if (!closed || denial) return { outcome: 'denied' as const, closure: closed ? 'confirmed' as const : 'unconfirmed' as const,
    reasons: [(denial?.message ?? 'Physical verification closure is unconfirmed.').slice(0, 500)] }
  if (!result) throw new Error('Physical qualification produced no result.')
  await owner.recordResult?.(result)
  return result
}

async function readBoundedReport(root: string, name: string, limit: number): Promise<Buffer> {
  const file = await open(join(root, '.logs/verification', name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit) {
      throw new Error('Physical report type or byte limit changed.')
    }
    const bytes = await file.readFile()
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Physical report changed during collection.')
    }
    return bytes
  } finally { await file.close() }
}

async function resetColdWorkload(root: string, scratch: string, paths: string[]): Promise<void> {
  const clean = async (directory: string, prefix: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (!prefix && name === JOB_INPUT_DIRECTORY) continue
      const path = prefix ? `${prefix}/${name}` : name
      const absolute = join(directory, name)
      const stat = await lstat(absolute)
      if (stat.isDirectory() && paths.some(entry => entry.startsWith(`${path}/`))) await clean(absolute, path)
      else if (!paths.includes(path)) await rm(absolute, { recursive: true, force: true })
    }
  }
  await clean(root, '')
  for (const name of await readdir(scratch)) await rm(join(scratch, name), { recursive: true, force: true })
}
