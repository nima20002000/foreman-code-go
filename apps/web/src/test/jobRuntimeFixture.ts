import { JobRuntimeProfileSchema, JobRuntimeFingerprintSchema, JobRuntimeApprovalSchema } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
const uuid='11111111-1111-4111-8111-111111111111',digest='1'.repeat(64)
const principal={id:'runtime-reader',name:'Runtime reader',audience:'operator',grants:[{actions:['job_definitions:read','job_definitions:write'],scope:{workspaceIds:['workspace-fixture']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
const root=SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:uuid,snapshotId:uuid,manifestDigest:digest},selection:{hostRef:{kind:'main',mainId:uuid},rootPolicyId:'root-policy',rootPolicyRevision:'1',locationRevision:'1'},binding:{version:1,mainId:uuid,deviceId:null,workerInstallationId:null,workspaceId:'workspace-fixture',rootId:uuid,bindingRevision:1,locationRevision:1,canonicalPath:'/approved',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write',snapshotId:uuid,manifestDigest:digest},ownerPrincipalId:principal.id,authorizedByPrincipalId:principal.id,registration:null,attestationId:'actual-test-attestation',attestationDigest:digest,boundAt:'2026-10-01T00:00:00.000Z'})
export const profile=JobRuntimeProfileSchema.parse({schemaVersion:1,id:'runtime-profile',workspaceId:'workspace-fixture',revision:1,name:'Runtime metadata',root,policy:{isolationPolicyId:'runtime-profile',isolationPolicyRevision:1,imageDigest:`sha256:${digest}`,toolchainDigest:digest,environmentScopeRefs:[],network:'none',queueTimeoutMs:10000,preparationTimeoutMs:10000,executionTimeoutMs:10000,cancellationGraceMs:1000,maxLogChunkBytes:1024,maxLogBytes:4096,maxWorkerSpoolBytes:4096,logOverflow:'stop',maxOutputBytes:4096,retentionSeconds:3600},limits:{cpuLimit:1,memoryBytes:1024,pidsLimit:32,diskBytes:8192},specDigest:digest,status:'unqualified',measurement:null,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'})
export const fingerprint=JobRuntimeFingerprintSchema.parse({schemaVersion:1,profileId:profile.id,profileRevision:1,specDigest:digest,hostRef:root.selection.hostRef,registration:null,mainInstallationId:'main-installation',bootId:uuid,root,runtimeExecutable:'/usr/bin/podman',runtimeBinarySha256:digest,ociExecutable:'/usr/bin/crun',ociBinarySha256:digest,configurationDigest:digest,imageDigest:profile.policy.imageDigest,toolchainDigest:digest,limits:profile.limits})
export const approval=JobRuntimeApprovalSchema.parse({schemaVersion:1,id:uuid,qualificationId:uuid,workspaceId:profile.workspaceId,profileId:profile.id,profileRevision:1,fingerprint,fingerprintDigest:digest,requestedByPrincipalId:principal.id,status:'captured',expiresAt:'2099-01-01T00:00:00.000Z'})
export const verificationProfile = JobVerificationProfileSchema.parse({
  schemaVersion: 2, id: 'verification-profile', workspaceId: profile.workspaceId, revision: 1,
  name: 'Ordinary verification', root, specDigest: digest,
  spec: { rootId: uuid, bindingRevision: 1, suites: ['install', 'unit'],
    resources: { schemaVersion: 1,
      limits: { cpuLimit: 1, memoryBytes: 2 ** 30, pidsLimit: 128, diskBytes: 8 * 2 ** 30 },
      mutableInodes: 100000, controlTempBytes: 2 ** 20, scratchBytes: 2 ** 30, scratchExecutable: true,
      shmBytes: 64 * 2 ** 20, spoolBytes: 2 ** 20, reportBytes: 2 ** 20 },
    policy: { imageDigest: profile.policy.imageDigest, toolchainDigest: digest, environmentScopeRefs: [],
      schemaVersion: 2, network: { schemaVersion: 2, mode: 'none' },
      queueTimeoutMs: 10000, preparationTimeoutMs: 10000, executionTimeoutMs: 10000, cancellationGraceMs: 1000,
      maxLogChunkBytes: 1024, maxLogBytes: 4096, maxWorkerSpoolBytes: 4096, logOverflow: 'stop',
      maxOutputBytes: 4096, retentionSeconds: 3600, serviceStartupTimeoutMs: 1000,
      publicationTimeoutMs: 1000, cleanupTimeoutMs: 1000 },
    approvalConfig: { approvalLifetimeMs: 3_600_000 } },
  approvalConfig: { schemaVersion: 1, revision: 1, approvalLifetimeMs: 3_600_000, review: null },
  status: 'unqualified', measurement: null, createdAt: profile.createdAt, updatedAt: profile.updatedAt,
})
