import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readdir, lstat, realpath, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { JobRuntimeNativeAdmissionSchema, type JobRuntimeNativeAdmission } from '@foreman-code/contracts/job-runtime'
import { nativeAgentEnvironment } from '../harnesses/secrets.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry, spawnNativeProcess, nativeProcessExit, type NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { inspectInstalledJobRuntimeCandidate, type InstalledRuntimeHostDependencies, type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import type { OCIContainerOwnership, OCIHostCertificate } from './executorContainerOwner.js'
import type { z } from 'zod'
import { VerificationJobExecutionSchema } from '@graphql/contracts/job-verification'
import { jobSupervisorIdentity } from './executor.js'
import { JobQualificationCandidateSchema, jobQualificationFingerprint, createQualificationNativeOwner,
  qualifyJobRuntime, jobRuntimeMeasurement, type JobQualificationCandidate, type JobQualificationAuthority } from './qualification.js'
import type { JobRuntimeQualificationResult } from './runtimeProfilePorts.js'

/** Samples the original Job boundary; no host-wide memory/CPU estimate is substituted for its cgroup. */
export async function measureVerificationResourceUsage(input: {
  execution: z.infer<typeof VerificationJobExecutionSchema>
  certificate: OCIHostCertificate
}): Promise<{
  sampledAt: string; allocatedBytes: number; mutableInodes: number; memoryPeakBytes: number;
  pids: number; cpuUsageMicroseconds: number; pressure: boolean; evidenceDigest: string
}> {
  const execution = VerificationJobExecutionSchema.parse(input.execution)
  const subject = input.certificate.scope.subject
  if (subject.kind !== 'job' || subject.executionId !== execution.id || subject.attemptId !== execution.attemptId
    || subject.operationId !== execution.operationId || subject.bindingHash !== execution.acceptedSpec.bindingHash
    || input.certificate.lifecycle !== 'active' || !('owner' in input.certificate.scope)
    || !same(input.certificate.scope.owner, execution.owner)
    || input.certificate.scope.bootId !== bootIdentity()
    || input.certificate.process.bootId !== input.certificate.scope.bootId) {
    throw new Error('Original active Job boundary required for measurement.')
  }
  const boundary = input.certificate.boundary
  const cgroup = await open(boundary.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let memoryPeakBytes: number
  let pids: number
  let cpuUsageMicroseconds: number
  try {
    const info = await cgroup.stat()
    if (await realpath(boundary.path) !== boundary.path || String(info.dev) !== boundary.device || String(info.ino) !== boundary.inode
      || (await statfs(`/proc/self/fd/${cgroup.fd}`)).type !== 0x63677270) throw new Error('Original cgroup identity changed.')
    const read = async (name: string) => {
      const file = await open(`/proc/self/fd/${cgroup.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = await file.readFile()
        if (bytes.length > 65536) throw new Error('Cgroup measurement exceeds its reply bound.')
        return bytes.toString('utf8')
      } finally { await file.close() }
    }
    memoryPeakBytes = Number((await read('memory.peak')).trim())
    pids = Number((await read('pids.current')).trim())
    cpuUsageMicroseconds = Number(/^usage_usec (\d+)$/m.exec(await read('cpu.stat'))?.[1])
    if (![memoryPeakBytes, pids, cpuUsageMicroseconds].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Finite measured cgroup counters required.')
    }
  } finally { await cgroup.close() }
  const namespace = dirname(execution.acceptedSpec.target.destination.canonicalProjectRoot)
  const roots = [namespace, join(execution.acceptedSpec.target.destination.managedRuntimeRoot,
    `${jobSupervisorIdentity(execution)}.oci.log`)]
  const seen = new Set<string>()
  let allocatedBytes = 0
  let mutableInodes = 0
  let device: number | undefined
  const resources = execution.acceptedSpec.verification.resources
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    device ??= info.dev
    if (info.dev !== device) throw new Error('Job accounting escaped its original workload filesystem.')
    const identity = `${info.dev}:${info.ino}`
    if (seen.has(identity)) return
    seen.add(identity)
    mutableInodes++
    allocatedBytes += info.blocks * 512
    if (mutableInodes > resources.mutableInodes || allocatedBytes > resources.limits.diskBytes) return
    if (info.isDirectory()) {
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const pinned = await directory.stat()
        if (pinned.dev !== info.dev || pinned.ino !== info.ino) throw new Error('Job accounting directory changed.')
        for (const entry of await readdir(`/proc/self/fd/${directory.fd}`)) {
          await walk(`/proc/self/fd/${directory.fd}/${entry}`)
          if (mutableInodes > resources.mutableInodes || allocatedBytes > resources.limits.diskBytes) break
        }
      } finally { await directory.close() }
    }
  }
  for (const path of roots) await walk(path)
  const sample = { sampledAt: new Date().toISOString(), allocatedBytes, mutableInodes,
    memoryPeakBytes, pids, cpuUsageMicroseconds,
    pressure: allocatedBytes >= resources.limits.diskBytes || mutableInodes >= resources.mutableInodes
      || pids >= resources.limits.pidsLimit || memoryPeakBytes >= resources.limits.memoryBytes }
  return { ...sample, evidenceDigest: createHash('sha256').update(JSON.stringify(sample)).digest('hex') }
}

export interface InstalledJobQualificationReservation {
  admission: JobRuntimeNativeAdmission
  candidate: JobQualificationCandidate
  /** Current protected installation and actual authenticated connection, not copied caller authority. */
  host: Pick<JobRuntimeNativeAdmission, 'hostRef' | 'registration' | 'mainInstallationId' | 'bootId' | 'connection'>
  journal: RemoteOperationJournal
  registry: NativeProcessRegistry
  authority: JobQualificationAuthority
  /** Main's persisted admission/live-scope assertion, via W07 on a device. */
  assertAdmission(admission: JobRuntimeNativeAdmission): Promise<void>
  signal: AbortSignal
}
/** Entire physical diagnostic stays on its original host. The carrier returns
 * measured result JSON only, never a ChildProcess or a fabricated ready flag. */
export async function runInstalledJobRuntimeQualification(input: InstalledJobQualificationReservation & {
  configuration: InstalledRuntimeConfigurationLocation | null
}): Promise<JobRuntimeQualificationResult> {
  const candidate = JobQualificationCandidateSchema.parse(input.candidate)
  await input.assertAdmission(JobRuntimeNativeAdmissionSchema.parse(input.admission))
  await inspectInstalledJobRuntimeCandidate({ ...input, candidate })
  const prior = await input.journal.qualificationStatus(input.admission.operationId)
  if (prior && (!same(prior.admission, input.admission) || !same(prior.candidate, candidate))) throw new Error('Original diagnostic candidate or admission changed.')
  if (prior?.result) return prior.result
  const authority: JobQualificationAuthority = { ...input.authority, async reserve(original, signal) {
    if (!same(original, candidate)) throw new Error('Original diagnostic candidate changed.')
    const reserved = await reserveInstalledJobQualification({ ...input, candidate, authority: input.authority, signal })
    return createQualificationNativeOwner(candidate, reserved.native, reserved.ownership, reserved.authority)
  } }
  const record = await qualifyJobRuntime(candidate, authority, input.signal)
  const result: JobRuntimeQualificationResult = record.outcome === 'qualified' ? { outcome: 'qualified', measurement: jobRuntimeMeasurement(record) }
    : { outcome: 'denied', closure: record.closure, reasons: record.reasons.map(reason => reason.slice(0, 500)) }
  if (await input.journal.qualificationStatus(input.admission.operationId)) await input.journal.qualificationResult(input.admission.operationId, result)
  return result
}

/** Genuine human-approved diagnostic. Its single entry and exact process/OCI
 * identities remain in the existing worker journal and native registry. */
export async function reserveInstalledJobQualification(input: InstalledJobQualificationReservation): Promise<Awaited<ReturnType<InstalledRuntimeHostDependencies['reserve']>>> {
  const admission = JobRuntimeNativeAdmissionSchema.parse(input.admission), candidate = JobQualificationCandidateSchema.parse(input.candidate)
  const { authority, journal, registry, signal } = input
  const operationId = admission.operationId
  const host = { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: admission.mainInstallationId,
    bootId: admission.bootId, connection: admission.connection }
  if (process.platform !== 'linux' || bootIdentity() !== admission.bootId || !same(input.host, host) || admission.approvalId !== candidate.approvalId ||
    admission.qualificationId !== candidate.qualificationId || operationId !== candidate.operationId || admission.profileId !== candidate.fingerprint.profileId ||
    admission.profileRevision !== candidate.fingerprint.profileRevision || admission.workspaceId !== candidate.fingerprint.root.binding.workspaceId ||
    admission.fingerprintDigest !== jobQualificationFingerprint(candidate) || !same(admission.hostRef, candidate.fingerprint.hostRef) ||
    !same(admission.registration, candidate.fingerprint.registration) || admission.mainInstallationId !== candidate.fingerprint.mainInstallationId ||
    admission.bootId !== candidate.fingerprint.bootId) throw new Error('Original installed qualification admission context changed.')
  const assertCurrent = async () => {
    signal.throwIfAborted()
    if (bootIdentity() !== admission.bootId || Date.parse(admission.expiresAt) <= Date.now()) throw new Error('Original installed qualification admission expired or boot changed.')
    await input.assertAdmission(admission)
    await authority.assertCurrent(candidate)
    const approval = await authority.readApproval(admission.approvalId)
    if (!approval || approval.status !== 'approved' || approval.fingerprint !== admission.fingerprintDigest || Date.parse(approval.expiresAt) <= Date.now() ||
      Date.parse(admission.expiresAt) > Date.parse(approval.expiresAt)) throw new Error('Original human qualification approval changed.')
  }
  await assertCurrent()
  await journal.qualificationAccept(admission, candidate)
  const entry = await journal.qualificationReserveEntry(operationId)
  if (!entry.reserved) throw new Error('Original qualification already entered; reconcile without rerunning.')
  const owner = `qualification:${operationId}:${admission.leaseId}`
  const launches = new Map<string, { scope: NativeProcessRecovery; binary: string; argv: string[]; child?: ChildProcess; closed: boolean }>()
  let closed = false
  const ownership: OCIContainerOwnership = {
    scope: { subject: { kind: 'qualification', qualificationId: admission.qualificationId, profileId: admission.profileId,
      profileRevision: admission.profileRevision, operationId, fingerprint: admission.fingerprintDigest }, admission, bootId: admission.bootId },
    assertCurrent,
    async reserveContainerIntent(identity, fingerprint) { await assertCurrent(); await journal.qualificationContainerIntent(operationId, identity, fingerprint) },
    async bindContainer(identity, containerId) { await assertCurrent(); await journal.qualificationBindContainer(operationId, identity, containerId) },
    async launchHelpers() {
      const rows = registry.snapshot().launches.filter(row => row.owner === owner && row.lifecycle === 'active')
      if (rows.some(row => !row.guardian || !row.boundary || row.bootId !== admission.bootId || !launches.has(row.launchId))) throw new Error('Original launcher boundary unavailable.')
      return rows.map(row => ({ kind: 'launcher' as const, process: { ...row.guardian!, bootId: row.bootId }, boundary: row.boundary! }))
    },
    async readCertificate(containerId) {
      const receipt = await journal.qualificationStatus(operationId)
      if (!receipt || !same(receipt.admission, admission) || receipt.container?.containerId !== containerId) throw new Error('Original qualification container receipt unavailable.')
      return receipt.container.certificate
    },
    async publish(certificate) { await journal.qualificationCertificate(operationId, certificate) },
  }
  async function closeLaunch(id: string) {
    const launch = launches.get(id)
    if (!launch) throw new Error('Original native launch reservation missing.')
    if (launch.closed) return true
    if (!launch.child) {
      if (!await registry.abandonReservedLaunch(launch.scope)) return false
    } else await registry.closeRegistration(launch.scope, id)
    await journal.qualificationProcessClosed(operationId, id)
    launch.closed = true; return true
  }
  return { authority, ownership, native: {
    async reserveProcess(binary, argv) {
      if (closed || ![candidate.fingerprint.runtimeExecutable, candidate.findmntBinary].includes(binary) || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Installed diagnostic executable/argv changed.')
      await assertCurrent()
      const scope = registry.reserveLaunch(owner)
      if (!scope.launchId) throw new Error('Original guarded native reservation unavailable.')
      const launch = { scope, binary, argv: [...argv], closed: false }
      launches.set(scope.launchId, launch)
      try { await journal.qualificationReserveProcess(operationId, { launchId: scope.launchId, binary, argv: [...argv] }) }
      catch (error) { await registry.abandonReservedLaunch(scope).catch(() => false); throw error }
      return scope.launchId
    },
    spawnProcess(id, binary, argv, options) {
      const launch = launches.get(id)
      signal.throwIfAborted()
      if (closed || !launch || launch.child || launch.closed || launch.binary !== binary || !same(launch.argv, argv) || bootIdentity() !== admission.bootId ||
        Date.parse(admission.expiresAt) <= Date.now() || options.shell !== false || !same(options.stdio, ['ignore', 'pipe', 'pipe']) ||
        !same(options.env, candidate.controllerEnvironment) || !same(nativeAgentEnvironment(binary, candidate.runtimeRoot, candidate.controllerEnvironment), candidate.controllerEnvironment)) throw new Error('Original noninteractive guarded native entry changed.')
      const child = spawnNativeProcess(binary, argv, { cwd: candidate.runtimeRoot, env: candidate.controllerEnvironment, recovery: launch.scope })
      launch.child = child
      child.stdin.end()
      return child
    },
    async readNativeExit(id, child) {
      const launch = launches.get(id)
      if (!launch || launch.child !== child) throw new Error('Original native exit target changed.')
      const exit = nativeProcessExit(child, { exitCode: null, exitSignal: null })
      if (exit.exitCode === null && exit.exitSignal === null) return { confirmed: false, exitCode: null }
      await journal.qualificationProcessExit(operationId, id, { exitCode: exit.exitCode, signal: exit.exitSignal })
      await closeLaunch(id)
      return { confirmed: true, exitCode: exit.exitCode }
    },
    stopProcess: closeLaunch,
    async close() {
      if (closed) return true
      for (const id of launches.keys()) if (!await closeLaunch(id)) return false
      if (launches.size && !await registry.closeOwner(owner)) return false
      await journal.qualificationClose(operationId)
      closed = true; return true
    },
  } }
}
