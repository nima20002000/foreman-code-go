import { createHash } from 'node:crypto'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat, statfs } from 'node:fs/promises'
import { release, userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { JobRuntimeFingerprintSchema, JobRuntimeMeasurementSchema, type JobRuntimeApproval, type JobRuntimeFingerprint, type JobRuntimeMeasurement, type JobRuntimeProfile } from '@graphql/contracts/job-runtime'
import type { JobSql } from './repository.js'
import { ensureEmptyPodmanHooks, podmanIsolationCreateArgv } from './executorPodman.js'
import type { QualifiedJobProfile } from './executor.js'

export const CI_QUALIFICATION_SUITE = 'rootless-podman-ext4-volume-v1' as const
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Absolute = z.string().startsWith('/').refine(path => !path.includes('\0') && !path.includes('\n') && !path.includes(','))
export const JobQualificationCandidateSchema = z.object({
  qualificationId: z.uuid(), operationId: z.uuid(), approvalId: z.uuid(),
  fingerprint: JobRuntimeFingerprintSchema,
  findmntBinary: Absolute, findmntBinarySha256: Digest,
  backingFile: Absolute, backingBytes: z.number().int().positive(),
  controllerEnvironment: z.object({ PATH: z.string().min(1), XDG_RUNTIME_DIR: Absolute, LANG: z.literal('C.UTF-8') }).strict(),
  sourceParent: Absolute, runtimeRoot: Absolute,
  spoolBytes: z.number().int().min(131072).max(67108864),
  ttlSeconds: z.number().int().positive().max(86400),
}).strict().superRefine((value, context) => {
  if (value.fingerprint.root.binding.accessMode !== 'exclusive-write' || value.sourceParent !== value.fingerprint.root.binding.canonicalPath) {
    context.addIssue({ code: 'custom', message: 'Qualification requires the exact existing exclusive-write root binding.' })
  }
})
export type JobQualificationCandidate = z.infer<typeof JobQualificationCandidateSchema>
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
export function jobQualificationFingerprint(candidate: JobQualificationCandidate): string { return hash(candidate.fingerprint) }
export interface JobQualificationRecord {
  suite: typeof CI_QUALIFICATION_SUITE
  candidate: JobQualificationCandidate
  fingerprint: string
  measuredFingerprint: string | null
  outcome: 'qualified' | 'denied'
  closure: 'not_started' | 'confirmed' | 'unconfirmed'
  reasons: string[]
  checkedAt: string
  expiresAt: string
  measurements: Record<string, unknown> | null
  profile: QualifiedJobProfile | null
}
export interface QualificationNativeOwner {
  /** Existing admission journals the exact native launch before the physical Node spawn. */
  reserveProcess(binary: string, argv: string[]): Promise<string>
  /** HRT's guarded spawn primitive receives original reserved scope BEFORE native entry. */
  spawnProcess(reservationId: string, binary: string, argv: string[], options: SpawnOptions): ChildProcess
  readNativeExit(reservationId: string, child: ChildProcess, wrapperExit: { exitCode: number | null; signal: string | null }): Promise<{ confirmed: boolean; exitCode: number | null }>
  stopProcess(reservationId: string): Promise<boolean>
  registerContainer(identity: string, fingerprint: string): Promise<void>
  /** Bind ID only after validating the original reserved identity/fingerprint labels. */
  observeContainer(identity: string, containerId: string): Promise<void>
  /** True only after all registered controller processes AND owned container descendants stopped. */
  close(): Promise<boolean>
}
export interface JobQualificationAuthority {
  readApproval(id: string): Promise<{ status: 'approved' | 'denied' | 'revoked'; fingerprint: string; expiresAt: string } | null>
  assertCurrent(candidate: JobQualificationCandidate): Promise<void>
  reserve(candidate: JobQualificationCandidate, signal: AbortSignal): Promise<QualificationNativeOwner>
}

/** Protected existing HRT/W07 installation metadata; public profile input admits no paths or ready flag. */
export interface InstalledJobRuntimeDescriptor {
  target: Pick<JobRuntimeFingerprint, 'hostRef' | 'registration' | 'mainInstallationId'>
  runtimeExecutable: string
  ociExecutable: string
  findmntExecutable: string
  runtimeRoot: string
  backingFile: string
  controllerEnvironment: JobQualificationCandidate['controllerEnvironment']
}
export interface PhysicalJobRuntimeProducerDependencies {
  descriptor(profile: JobRuntimeProfile): Promise<InstalledJobRuntimeDescriptor>
  immutableProfile(approval: JobRuntimeApproval): Promise<JobRuntimeProfile>
  /** Bind the original existing qualification operation and actual guarded native authority. */
  admission(approval: JobRuntimeApproval, profile: JobRuntimeProfile): Promise<{ operationId: string; authority: JobQualificationAuthority }>
  /** SQL/HRT/W07 current metadata only; never a probe, install or caller observation. */
  currentMetadata(sql: JobSql, profile: JobRuntimeProfile): Promise<JobRuntimeFingerprint | null>
}

async function installedCandidate(profile: JobRuntimeProfile, descriptor: InstalledJobRuntimeDescriptor) {
  if (hash(descriptor.target.hostRef) !== hash(profile.root.selection.hostRef) || hash(descriptor.target.registration) !== hash(profile.root.registration)) throw new Error('Current installed host/root registration changed.')
  const runtime = await fingerprintQualificationPath(descriptor.runtimeExecutable, true)
  const oci = await fingerprintQualificationPath(descriptor.ociExecutable, true)
  const findmnt = await fingerprintQualificationPath(descriptor.findmntExecutable, true)
  const root = await fingerprintQualificationPath(profile.root.binding.canonicalPath)
  const mountId = qualificationMountId(root.path, await readFile('/proc/self/mountinfo', 'utf8'))
  if (root.device !== profile.root.binding.filesystem.device || root.inode !== profile.root.binding.filesystem.inode || mountId !== profile.root.binding.filesystem.mountId) throw new Error('Current root identity changed.')
  const diagnostics = { findmntBinary: findmnt.path, findmntBinarySha256: findmnt.sha256!, backingFile: descriptor.backingFile, backingBytes: profile.limits.diskBytes }
  const fingerprint = JobRuntimeFingerprintSchema.parse({ schemaVersion: 1, profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest,
    ...descriptor.target, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), root: profile.root,
    runtimeExecutable: runtime.path, runtimeBinarySha256: runtime.sha256, ociExecutable: oci.path, ociBinarySha256: oci.sha256,
    configurationDigest: hash(await captureJobRuntimeConfiguration(descriptor.runtimeRoot, descriptor.controllerEnvironment, diagnostics)),
    imageDigest: profile.policy.imageDigest, toolchainDigest: profile.policy.toolchainDigest, limits: profile.limits })
  return { fingerprint, diagnostics }
}

/** Actual B-compatible catalog producer. Only explicit approved run enters native IO. */
export function createPhysicalJobRuntimeProducer(dependencies: PhysicalJobRuntimeProducerDependencies) {
  return {
    capture: async (profile: JobRuntimeProfile) => (await installedCandidate(profile, await dependencies.descriptor(profile))).fingerprint,
    run: async (approval: JobRuntimeApproval, signal: AbortSignal) => {
      const profile = await dependencies.immutableProfile(approval)
      const descriptor = await dependencies.descriptor(profile)
      const { fingerprint, diagnostics } = await installedCandidate(profile, descriptor)
      if (profile.id !== approval.profileId || profile.revision !== approval.profileRevision || profile.specDigest !== approval.fingerprint.specDigest ||
        hash(fingerprint) !== approval.fingerprintDigest || hash(fingerprint) !== hash(approval.fingerprint)) return { outcome: 'denied' as const, closure: 'not_started' as const, reasons: ['context_changed'] }
      const admitted = await dependencies.admission(approval, profile)
      const candidate = JobQualificationCandidateSchema.parse({ qualificationId: approval.qualificationId, operationId: admitted.operationId, approvalId: approval.id,
        fingerprint: approval.fingerprint, ...diagnostics, controllerEnvironment: descriptor.controllerEnvironment,
        sourceParent: profile.root.binding.canonicalPath, runtimeRoot: descriptor.runtimeRoot, spoolBytes: profile.policy.maxWorkerSpoolBytes, ttlSeconds: 3600 })
      const record = await qualifyJobRuntime(candidate, admitted.authority, signal)
      if (record.outcome !== 'qualified') return { outcome: 'denied' as const, closure: record.closure, reasons: record.reasons }
      return { outcome: 'qualified' as const, measurement: jobRuntimeMeasurement(record) }
    },
    revalidate: async (sql: JobSql, profile: JobRuntimeProfile) => {
      const measurement = profile.measurement
      if (profile.status !== 'qualified' || !measurement || measurement.origin !== 'real-runtime') return { ready: false, reasons: ['unqualified'] }
      if (Date.parse(measurement.expiresAt) <= Date.now()) return { ready: false, reasons: ['expired'] }
      const current = await dependencies.currentMetadata(sql, profile)
      if (!current || hash(current) !== measurement.fingerprintDigest || hash(measurement.fingerprint) !== measurement.fingerprintDigest) return { ready: false, reasons: ['context_changed'] }
      return { ready: true, reasons: [] }
    },
  }
}

/** Concrete physical command runner, never a caller-supplied observation/ready result. */
export async function runQualificationCommand(owner: QualificationNativeOwner, binary: string, argv: string[], environment: Record<string, string>, signal: AbortSignal) {
  const reservation = await owner.reserveProcess(binary, argv)
  signal.throwIfAborted()
  const child = owner.spawnProcess(reservation, binary, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment })
  const { stdout, stderr } = child
  if (!stdout || !stderr) throw new Error('Admitted diagnostic requires stdout/stderr pipes.')
  const completed = new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
    let output = ''; let bytes = 0
    let interrupted = false
    const interrupt = () => {
      if (interrupted) return
      interrupted = true
      void owner.stopProcess(reservation).then(stopped => reject(new Error(stopped ? 'Diagnostic interrupted.' : 'Diagnostic physical stop unconfirmed.')), reject)
    }
    signal.addEventListener('abort', interrupt, { once: true })
    const timeout = setTimeout(interrupt, 30000)
    const read = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length
      if (bytes > 65536) interrupt()
      else if (stdout) output += chunk.toString('utf8')
    }
    stdout.on('data', chunk => read(chunk, true)); stderr.on('data', chunk => read(chunk, false))
    child.once('error', reject)
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timeout); signal.removeEventListener('abort', interrupt)
      if (!interrupted) void owner.readNativeExit(reservation, child, { exitCode, signal: exitSignal }).then(native => {
        if (!native.confirmed || native.exitCode === null) reject(new Error('Exact native exit receipt unavailable.'))
        else resolve({ exitCode: native.exitCode, stdout: output })
      }, reject)
    })
  })
  void completed.catch(() => {})
  return completed
}

/** Pure read/admission verifier. It performs no native or filesystem IO, including for GET. */
export function verifyJobQualification(record: JobQualificationRecord | null, candidate: JobQualificationCandidate, now = Date.now()) {
  if (!record) return { ready: false as const, reason: 'missing' as const, profile: null }
  if (record.outcome !== 'qualified') return { ready: false as const, reason: 'denied' as const, profile: null }
  if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now) return { ready: false as const, reason: 'expired' as const, profile: null }
  if (record.suite !== CI_QUALIFICATION_SUITE || record.fingerprint !== jobQualificationFingerprint(candidate) ||
    record.fingerprint !== jobQualificationFingerprint(record.candidate) || hash(candidate) !== hash(record.candidate)) return { ready: false as const, reason: 'context_changed' as const, profile: null }
  if (record.closure !== 'confirmed' || !record.measurements || !record.measurements.qualifiedRuntime || record.measuredFingerprint !== hash(record.measurements) || !record.profile ||
    hash(record.profile) !== hash(record.measurements.qualifiedRuntime) ||
    record.profile.qualificationId !== candidate.qualificationId || record.profile.policyId !== candidate.fingerprint.profileId ||
    record.profile.policyRevision !== candidate.fingerprint.profileRevision || record.profile.imageDigest !== candidate.fingerprint.imageDigest) return { ready: false as const, reason: 'evidence_invalid' as const, profile: null }
  return { ready: true as const, reason: null, profile: record.profile }
}

/** Only the registered physical producer invokes this conversion; public save admits no evidence. */
export function jobRuntimeMeasurement(record: JobQualificationRecord): JobRuntimeMeasurement {
  const verified = verifyJobQualification(record, record.candidate)
  if (!verified.ready || !record.measurements) throw new Error(`Qualification unavailable: ${verified.reason}`)
  const { candidate, measurements } = record
  const checks = [
    ['rootless', measurements.info], ['cgroup-v2', { info: measurements.info, probe: measurements.probe }],
    ['filesystem-quota', { volume: measurements.volume, context: measurements.context }],
    ['descendant-containment', { containerId: measurements.containerId, cgroup: measurements.cgroup, descendantsStopped: measurements.descendantsStopped }],
    ['network-none', measurements.probe], ['image-toolchain', { image: measurements.image, probe: measurements.probe }],
    ['credential-isolation', { probe: measurements.probe, context: measurements.context }],
  ] as const
  return JobRuntimeMeasurementSchema.parse({ schemaVersion: 1, qualificationId: candidate.qualificationId,
    profileId: candidate.fingerprint.profileId, profileRevision: candidate.fingerprint.profileRevision, specDigest: candidate.fingerprint.specDigest,
    hostRef: candidate.fingerprint.hostRef, registration: candidate.fingerprint.registration, root: candidate.fingerprint.root,
    runtime: verified.profile, runtimeBinarySha256: candidate.fingerprint.runtimeBinarySha256, ociBinarySha256: candidate.fingerprint.ociBinarySha256,
    runtimeExecutable: candidate.fingerprint.runtimeExecutable, environment: candidate.controllerEnvironment,
    fingerprint: candidate.fingerprint, fingerprintDigest: record.fingerprint, approvalId: candidate.approvalId,
    origin: 'real-runtime', checkedAt: record.checkedAt, expiresAt: record.expiresAt,
    checks: checks.map(([id, evidence]) => ({ id, passed: true, evidenceDigest: hash(evidence) })) })
}

export async function fingerprintQualificationPath(path: string, executable = false) {
  const canonical = await realpath(path)
  if (canonical !== path) throw new Error('Qualification paths must be canonical, without symlink retargeting.')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (executable && (!before.isFile() || before.size > 67108864n || (before.mode & 0o022n) || !(before.mode & 0o111n))) throw new Error('Executable trust boundary rejected.')
    if (!executable && !before.isDirectory()) throw new Error('Canonical directory required.')
    const digest = executable ? createHash('sha256').update(await boundedFile(handle, 67108864)).digest('hex') : null
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Path changed during qualification.')
    return { path: canonical, device: String(before.dev), inode: String(before.ino), mode: String(before.mode), uid: String(before.uid), gid: String(before.gid), sha256: digest }
  } finally { await handle.close() }
}

/** Geometry proof is actual kernel/file metadata, not a caller ready/limit declaration. */
export function validateBoundedVolumeGeometry(value: {
  expectedBytes: bigint; backingBytes: bigint; allocatedBytes: bigint; rootOwned: boolean; writableByWorker: boolean;
  links: bigint; offset: bigint; sizeLimit: bigint; blockDeviceBytes: bigint; filesystemBytes: bigint;
  filesystemType: bigint; mountOptions: string[];
}) {
  if (value.expectedBytes <= 0n || value.backingBytes !== value.expectedBytes || value.allocatedBytes < value.expectedBytes ||
    !value.rootOwned || value.writableByWorker || value.links !== 1n || value.offset !== 0n || value.sizeLimit !== value.expectedBytes ||
    value.blockDeviceBytes !== value.expectedBytes || value.filesystemType !== 0xef53n || value.filesystemBytes <= 0n || value.filesystemBytes > value.expectedBytes ||
    !['rw', 'nosuid', 'nodev'].every(option => value.mountOptions.includes(option)) || value.mountOptions.includes('discard')) throw new Error('Fixed, reserved, root-owned ext4 volume boundary unavailable.')
}

async function measureBackingFile(path: string, bytes: number) {
  if (await realpath(path) !== path) throw new Error('Backing file must be canonical.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const details = await file.stat({ bigint: true })
    if (!details.isFile() || details.uid !== 0n || details.mode & 0o222n || details.nlink !== 1n || details.size !== BigInt(bytes) || details.blocks * 512n < details.size) throw new Error('Backing file must be fixed-size, fully allocated, root-owned and unwritable by the worker.')
    return { path, device: String(details.dev), inode: String(details.ino), bytes: String(details.size), allocatedBytes: String(details.blocks * 512n),
      mode: String(details.mode), uid: String(details.uid), links: String(details.nlink) }
  } finally { await file.close() }
}

async function measureBoundedExt4Volume(candidate: JobQualificationCandidate, mount: { filesystems?: Array<{ target: string; source: string; fstype: string; options: string; 'maj:min': string }> }) {
  const selected = mount.filesystems?.[0]
  if (mount.filesystems?.length !== 1 || !selected || selected.fstype !== 'ext4' || !/^\/dev\/loop\d+$/.test(selected.source) || !/^7:\d+$/.test(selected['maj:min'])) throw new Error('Approved dedicated loop-backed ext4 volume unavailable.')
  const backing = await measureBackingFile(candidate.backingFile, candidate.backingBytes)
  const sysfs = `/sys/dev/block/${selected['maj:min']}`
  const actualBacking = (await readFile(`${sysfs}/loop/backing_file`, 'utf8')).trim()
  if (await realpath(actualBacking.startsWith('/') ? actualBacking : `/${actualBacking}`) !== candidate.backingFile) throw new Error('Loop device backing file changed.')
  const source = await stat(candidate.sourceParent, { bigint: true })
  const runtime = await stat(candidate.runtimeRoot, { bigint: true })
  if (source.dev !== runtime.dev || candidate.backingBytes !== candidate.fingerprint.limits.diskBytes) throw new Error('Source and logs must share the exact approved finite filesystem.')
  const fs = await statfs(candidate.sourceParent, { bigint: true })
  const offset = BigInt((await readFile(`${sysfs}/loop/offset`, 'utf8')).trim())
  const sizeLimit = BigInt((await readFile(`${sysfs}/loop/sizelimit`, 'utf8')).trim())
  const blockDeviceBytes = BigInt((await readFile(`${sysfs}/size`, 'utf8')).trim()) * 512n
  validateBoundedVolumeGeometry({ expectedBytes: BigInt(candidate.backingBytes), backingBytes: BigInt(backing.bytes), allocatedBytes: BigInt(backing.allocatedBytes),
    rootOwned: true, writableByWorker: false, links: BigInt(backing.links), offset, sizeLimit, blockDeviceBytes,
    filesystemBytes: fs.blocks * fs.bsize, filesystemType: fs.type, mountOptions: selected.options.split(',') })
  return { backing, device: String(source.dev), mount: selected, offset: String(offset), sizeLimit: String(sizeLimit), blockDeviceBytes: String(blockDeviceBytes), filesystemBytes: String(fs.blocks * fs.bsize), filesystemType: String(fs.type) }
}

async function boundedFile(handle: Awaited<ReturnType<typeof open>>, maximum: number) {
  const before = await handle.stat()
  if (!before.isFile() || before.size > maximum) throw new Error('Fingerprint file exceeds its bound.')
  const bytes = Buffer.alloc(before.size)
  let offset = 0
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, Math.min(bytes.length - offset, 65536), offset)
    if (!read.bytesRead) throw new Error('Fingerprint file changed during read.')
    offset += read.bytesRead
  }
  const after = await handle.stat()
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Fingerprint file changed during read.')
  return bytes
}

/** Explicit POST capture may read metadata; GET never calls this helper. No native probe. */
export async function captureJobRuntimeConfiguration(runtimeRoot: string, environment: JobQualificationCandidate['controllerEnvironment'],
  diagnostics: Pick<JobQualificationCandidate, 'findmntBinary' | 'findmntBinarySha256' | 'backingFile' | 'backingBytes'>) {
  const userConfig = join(userInfo().homedir, '.config/containers')
  const files = ['/usr/share/containers/containers.conf', '/etc/containers/containers.conf', join(userConfig, 'containers.conf'),
    '/etc/containers/storage.conf', join(userConfig, 'storage.conf'), '/usr/share/containers/mounts.conf', '/etc/containers/mounts.conf', join(userConfig, 'mounts.conf')]
  for (const directory of ['/etc/containers/containers.conf.d', join(userConfig, 'containers.conf.d')]) {
    try {
      const names = await readdir(directory)
      if (names.length > 64) throw new Error('Runtime configuration directory exceeds its bound.')
      files.push(...names.filter(name => name.endsWith('.conf')).sort().map(name => join(directory, name)))
    } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  const configuration = []
  for (const path of files) {
    try {
      const canonical = await realpath(path)
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const details = await handle.stat({ bigint: true })
        if (!details.isFile() || details.size > 1048576n) throw new Error('Runtime configuration file exceeds its bound.')
        configuration.push({ path, canonical, sha256: createHash('sha256').update(await boundedFile(handle, 1048576)).digest('hex'), mode: String(details.mode), uid: String(details.uid), gid: String(details.gid) })
      } finally { await handle.close() }
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') configuration.push({ path, absent: true }); else throw error }
  }
  const binary = await fingerprintQualificationPath(diagnostics.findmntBinary, true)
  if (binary.sha256 !== diagnostics.findmntBinarySha256) throw new Error('Approved diagnostic binary changed.')
  return { suite: CI_QUALIFICATION_SUITE, probeDigest: hash(QUALIFICATION_PROBE), environment,
    runtimeRoot: await fingerprintQualificationPath(runtimeRoot), hooksDirectory: join(runtimeRoot, 'ci-empty-oci-hooks'), configuration,
    diagnosticBinary: binary, backingFile: await measureBackingFile(diagnostics.backingFile, diagnostics.backingBytes) }

}

export function qualificationMountId(path: string, mountInfo: string): string {
  const mounts = mountInfo.split('\n').filter(Boolean).map(line => {
    const columns = line.split(' ')
    return { id: columns[0]!, path: (columns[4] ?? '').replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))) }
  }).filter(mount => /^\d+$/.test(mount.id) && (mount.path === '/' || path === mount.path || path.startsWith(`${mount.path}/`))).sort((a, b) => b.path.length - a.path.length)
  if (!mounts[0]) throw new Error('Canonical filesystem mount identity unavailable.')
  return mounts[0].id
}

/** Executes only after persisted exact human approval and existing native admission. */
export async function qualifyJobRuntime(raw: JobQualificationCandidate, authority: JobQualificationAuthority, callerSignal: AbortSignal): Promise<JobQualificationRecord> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(120000)])
  const candidate = JobQualificationCandidateSchema.parse(raw)
  const fingerprint = jobQualificationFingerprint(candidate)
  const checkedAt = new Date().toISOString()
  const record: JobQualificationRecord = { suite: CI_QUALIFICATION_SUITE, candidate, fingerprint, measuredFingerprint: null,
    outcome: 'denied', closure: 'not_started', reasons: [], checkedAt, expiresAt: new Date(Date.parse(checkedAt) + candidate.ttlSeconds * 1000).toISOString(), measurements: null, profile: null }
  const approval = await authority.readApproval(candidate.approvalId)
  if (!approval || approval.status !== 'approved' || approval.fingerprint !== fingerprint || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) {
    return { ...record, reasons: ['approval_denied_or_expired'] }
  }
  record.expiresAt = new Date(Math.min(Date.parse(record.expiresAt), Date.parse(approval.expiresAt))).toISOString()
  if (signal.aborted) return { ...record, reasons: ['cancelled_before_admission'] }
  try { await authority.assertCurrent(candidate) } catch { return { ...record, reasons: ['context_changed'] } }
  let owner: QualificationNativeOwner
  try { owner = await authority.reserve(candidate, signal) }
  catch { return { ...record, closure: 'unconfirmed', reasons: ['admission_recovery_required'] } }
  const identity = `graphql-ci-qualification-${candidate.qualificationId}`
  let scratch: string | undefined
  let physicallyClosed = false
  const run = async (binary: string, argv: string[]) => {
    signal.throwIfAborted()
    const reply = await runQualificationCommand(owner, binary, argv, candidate.controllerEnvironment, signal)
    if (reply.exitCode !== 0 || Buffer.byteLength(reply.stdout) > 65536) throw new Error('Qualification command failed or exceeded its output budget.')
    return reply.stdout
  }
  const podman = (argv: string[]) => run(candidate.fingerprint.runtimeExecutable, argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv])
  try {
    await ensureEmptyPodmanHooks(candidate.runtimeRoot)
    const before = await measureContext(candidate)
    const info = JSON.parse(await podman(['--remote=false', 'info', '--format=json'])) as { host?: { serviceIsRemote?: boolean; security?: { rootless?: boolean }; cgroupVersion?: string; cgroupManager?: string; kernel?: string; ociRuntime?: { path?: string; version?: string } }; version?: { Version?: string } }
    if (info.host?.serviceIsRemote !== false || info.host.security?.rootless !== true || info.host.cgroupVersion !== 'v2' || info.host.cgroupManager !== 'systemd' || info.host.kernel !== before.kernel ||
      !info.version?.Version || !info.host.ociRuntime?.path || !info.host.ociRuntime.version) throw new Error('Local rootless cgroup-v2 runtime unavailable.')
    const ociBinary = await fingerprintQualificationPath(info.host.ociRuntime.path, true)
    if (ociBinary.path !== candidate.fingerprint.ociExecutable || ociBinary.sha256 !== candidate.fingerprint.ociBinarySha256) throw new Error('Approved OCI executable changed.')
    const images = JSON.parse(await podman(['image', 'inspect', candidate.fingerprint.imageDigest])) as Array<{ Id?: string; Digest?: string }>
    const immutableImageId = images[0]?.Id?.replace(/^sha256:/, '')
    if (images.length !== 1 || !immutableImageId || !/^[a-f0-9]{64}$/.test(immutableImageId) || `sha256:${immutableImageId}` !== candidate.fingerprint.imageDigest) throw new Error('Exact approved existing immutable image ID unavailable.')
    const mount = JSON.parse(await run(candidate.findmntBinary, ['--json', '--target', candidate.sourceParent, '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN'])) as { filesystems?: Array<{ target: string; source: string; fstype: string; options: string; 'maj:min': string }> }
    const volume = await measureBoundedExt4Volume(candidate, mount)
    scratch = await mkdtemp(join(candidate.sourceParent, '.ci-qualification-'))
    if ((await stat(scratch, { bigint: true })).dev.toString() !== volume.device) throw new Error('Scratch left the approved bounded filesystem.')
    await owner.registerContainer(identity, fingerprint) // Cleanup ownership before create/possible lost acknowledgement.
    const argv = podmanIsolationCreateArgv({ identity, sourceRoot: scratch, runtimeRoot: candidate.runtimeRoot, cwd: scratch,
      argv: ['node', '-e', QUALIFICATION_PROBE], profile: { ...candidate.fingerprint.limits, imageDigest: candidate.fingerprint.imageDigest },
      spoolBytes: candidate.spoolBytes, labels: { 'graphql.qualification.identity': identity, 'graphql.qualification.fingerprint': fingerprint } })
    const id = (await podman(argv)).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Container creation identity unknown.')
    await owner.observeContainer(identity, id)
    await podman(['start', id])
    let measurement: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      const logs = await podman(['logs', id])
      const line = logs.split('\n').find(value => value.startsWith('GRAPHQL_CI_QUALIFICATION '))
      if (line) { measurement = JSON.parse(line.slice('GRAPHQL_CI_QUALIFICATION '.length)) as Record<string, unknown>; break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!measurement) throw new Error('Bounded model-free isolation probe did not return.')
    const rows = JSON.parse(await podman(['container', 'inspect', id])) as Array<{ Id: string; State: { Pid: number; Running: boolean }; Config: { Labels: Record<string, string> }; Mounts: Array<{ Type: string; Source: string; Destination: string }> }>
    const row = rows[0]
    if (rows.length !== 1 || row?.Id !== id || row.Config.Labels['graphql.qualification.fingerprint'] !== fingerprint || !row.State.Running || row.State.Pid <= 0) throw new Error('Qualification container ownership mismatch.')
    if (row.Mounts.filter(item => item.Type === 'bind').length !== 1 || row.Mounts.some(item =>
      item.Type === 'bind' ? item.Source !== scratch || item.Destination !== '/workspace' : item.Type !== 'tmpfs' || item.Destination !== '/tmp')) throw new Error('Unexpected container mount rejected.')
    const cgroup = (await readFile(`/proc/${row.State.Pid}/cgroup`, 'utf8')).trim()
    const relative = /^0::(\/[^\n]*)$/.exec(cgroup)?.[1]
    if (!relative || relative.split('/').includes('..') || !relative.includes(`libpod-${id}.scope`)) throw new Error('Owned cgroup identity unavailable.')
    const cgroupPath = `/sys/fs/cgroup${relative}`
    validateIsolationMeasurement(measurement, candidate, before)
    await podman(['stop', '--time=1', id])
    const stopped = JSON.parse(await podman(['container', 'inspect', id])) as Array<{ Id: string; State: { Pid: number; Running: boolean; Status: string } }>
    if (stopped.length !== 1 || stopped[0]?.Id !== id || stopped[0].State.Running || stopped[0].State.Pid !== 0 || stopped[0].State.Status !== 'exited') throw new Error('Container stop proof unavailable.')
    try { if (!/^populated 0$/m.test(await readFile(`${cgroupPath}/cgroup.events`, 'utf8'))) throw new Error('Descendants remain in owned cgroup.') }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
    const after = await measureContext(candidate)
    if (hash(before) !== hash(after)) throw new Error('Qualification context changed during the probe.')
    if (hash(ociBinary) !== hash(await fingerprintQualificationPath(candidate.fingerprint.ociExecutable, true))) throw new Error('OCI executable changed during qualification.')
    if (hash(volume) !== hash(await measureBoundedExt4Volume(candidate, mount))) throw new Error('Bounded volume context changed during qualification.')
    physicallyClosed = await owner.close()
    if (!physicallyClosed) throw new Error('Native ownership physical closure incomplete.')
    await authority.assertCurrent(candidate)
    const finalApproval = await authority.readApproval(candidate.approvalId)
    if (!finalApproval || finalApproval.status !== 'approved' || finalApproval.fingerprint !== fingerprint || !Number.isFinite(Date.parse(finalApproval.expiresAt)) || Date.parse(finalApproval.expiresAt) <= Date.now()) throw new Error('Human approval changed during qualification.')
    const toolchainDigest = hash(measurement.toolchain)
    if (toolchainDigest !== candidate.fingerprint.toolchainDigest) throw new Error('Approved toolchain fingerprint changed.')
    const profile: QualifiedJobProfile = {
      policyId: candidate.fingerprint.profileId, policyRevision: candidate.fingerprint.profileRevision, imageDigest: candidate.fingerprint.imageDigest, toolchainDigest,
      runtimeVersion: info.version.Version, ociRuntimeVersion: info.host.ociRuntime.version.split('\n')[0]!, kernelVersion: before.kernel,
      qualificationId: candidate.qualificationId, rootless: true, cgroupV2: true, filesystemBounded: true,
      descendantContainment: true, network: 'none', ...candidate.fingerprint.limits }
    const measurements = { context: before, info, ociBinary, image: images[0], mount, volume,
      probe: measurement, containerId: id, cgroup, descendantsStopped: true, qualifiedRuntime: profile }
    return { ...record, outcome: 'qualified', closure: 'confirmed', measurements, measuredFingerprint: hash(measurements), profile }
  } catch (error) {
    record.reasons = [error instanceof Error ? error.message : 'Qualification failed.']
    return record
  } finally {
    if (!physicallyClosed) physicallyClosed = await owner.close().catch(() => false)
    record.closure = physicallyClosed ? 'confirmed' : 'unconfirmed'
    if (physicallyClosed && scratch) await rm(scratch, { recursive: true, force: true })
    if (!physicallyClosed) { record.reasons.push('native_closure_incomplete'); record.outcome = 'denied' }
  }
}

async function measureContext(candidate: JobQualificationCandidate) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Qualification requires the approved non-root Linux worker account.')
  const paths = await Promise.all([candidate.fingerprint.runtimeExecutable, candidate.findmntBinary].map(path => fingerprintQualificationPath(path, true)))
  for (const [index, expected] of [candidate.fingerprint.runtimeBinarySha256, candidate.findmntBinarySha256].entries()) if (paths[index]!.sha256 !== expected) throw new Error('Approved binary fingerprint changed.')
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (bootId !== candidate.fingerprint.bootId) throw new Error('Worker boot context changed.')
  if (candidate.sourceParent !== candidate.fingerprint.root.binding.canonicalPath) throw new Error('Approved canonical root changed.')
  const source = await fingerprintQualificationPath(candidate.sourceParent)
  const binding = candidate.fingerprint.root.binding.filesystem
  if (String(source.device) !== binding.device || String(source.inode) !== binding.inode) throw new Error('Approved root filesystem identity changed.')
  const mountId = qualificationMountId(candidate.sourceParent, await readFile('/proc/self/mountinfo', 'utf8'))
  if (mountId !== binding.mountId) throw new Error('Approved root mount identity changed.')
  const runtime = await fingerprintQualificationPath(candidate.runtimeRoot)
  if (!(await stat(candidate.sourceParent)).isDirectory() || !(await stat(candidate.runtimeRoot)).isDirectory() || candidate.runtimeRoot.startsWith(`${candidate.sourceParent}/`)) throw new Error('Separate approved source/runtime directories required.')
  const configuration = await captureJobRuntimeConfiguration(candidate.runtimeRoot, candidate.controllerEnvironment, candidate)
  if (hash(configuration) !== candidate.fingerprint.configurationDigest) throw new Error('Approved runtime configuration/environment changed.')
  return { paths, source, runtime, mountId, configuration, kernel: release(), bootId, uid: process.getuid!(),
    hostPidNamespace: await readlink('/proc/self/ns/pid'), hostNetworkNamespace: await readlink('/proc/self/ns/net') }
}

export function validateIsolationMeasurement(probe: Record<string, unknown>, candidate: JobQualificationCandidate, host: { hostPidNamespace: string; hostNetworkNamespace: string }) {
  const toolchain = probe.toolchain as Record<string, unknown> | undefined
  if (!toolchain || !/^v(?:2[2-9]|[3-9]\d)\./.test(String(toolchain.node)) || toolchain.pnpm !== '11.27.0' || !/^git version \d/.test(String(toolchain.git)) ||
    !/^flock from util-linux \d/.test(String(toolchain.flock)) || !/^\d+\.\d+\.\d+/.test(String(toolchain.corepack)) ||
    typeof probe.pidNamespace !== 'string' || !/^pid:\[\d+\]$/.test(probe.pidNamespace) ||
    typeof probe.networkNamespace !== 'string' || !/^net:\[\d+\]$/.test(probe.networkNamespace) ||
    probe.rootfsWriteError !== 'EROFS' || probe.sourceWrite !== true || probe.proc !== true || probe.pidNamespace === host.hostPidNamespace ||
    probe.networkNamespace === host.hostNetworkNamespace || JSON.stringify(probe.interfaces) !== '["lo"]' ||
    probe.memoryMax !== String(candidate.fingerprint.limits.memoryBytes) || probe.swapMax !== '0' || probe.pidsMax !== String(candidate.fingerprint.limits.pidsLimit) ||
    probe.cpuRatio !== candidate.fingerprint.limits.cpuLimit || probe.detachedChild !== true ||
    probe.capabilities !== '0000000000000000' || probe.noNewPrivileges !== '1' ||
    JSON.stringify(probe.environment) !== '["CI","HOME","LANG","PATH"]') throw new Error('Measured isolation/toolchain/resource controls rejected.')
}

const QUALIFICATION_PROBE = `const fs=require('node:fs'),cp=require('node:child_process');
const version=(argv)=>{const p=cp.spawnSync(argv[0],argv.slice(1),{encoding:'utf8',timeout:5000});if(p.status!==0)throw Error('required tool unavailable');return p.stdout.trim()};
fs.mkdirSync(process.env.HOME,{recursive:true});let rootfsWriteError=null;try{fs.writeFileSync('/ci-qualification-outside','x')}catch(e){rootfsWriteError=e.code}
fs.writeFileSync('/workspace/probe','bounded qualification write');const cpu=fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(' ');
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}),status=fs.readFileSync('/proc/self/status','utf8');
console.log('GRAPHQL_CI_QUALIFICATION '+JSON.stringify({toolchain:{node:process.version,corepack:version(['corepack','--version']),pnpm:version(['corepack','pnpm','--version']),git:version(['git','--version']),flock:version(['flock','--version'])},rootfsWriteError,sourceWrite:true,proc:fs.existsSync('/proc/self/stat'),pidNamespace:fs.readlinkSync('/proc/self/ns/pid'),networkNamespace:fs.readlinkSync('/proc/self/ns/net'),interfaces:fs.readdirSync('/sys/class/net').sort(),memoryMax:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),swapMax:fs.readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim(),pidsMax:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),cpuRatio:Number(cpu[0])/Number(cpu[1]),environment:Object.keys(process.env).sort(),detachedChild:!!child.pid,capabilities:status.match(/^CapEff:\\s*(.*)$/m)?.[1],noNewPrivileges:status.match(/^NoNewPrivs:\\s*(.*)$/m)?.[1]}));setInterval(()=>{},1000);`
