import { z } from 'zod'
import { JobRuntimeNativeAdmissionRecordSchema, JobQualificationCandidateRecordSchema, JobRuntimeQualificationResultRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'

const process = z.object({ pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootId: z.uuid() }).strict()
const boundary = z.object({ kind: z.literal('cgroup-v2'), path: z.string().startsWith('/sys/fs/cgroup/'),
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
const subject = z.object({ kind: z.literal('qualification'), qualificationId: z.uuid(), profileId: z.string().min(1),
  profileRevision: z.number().int().positive(), operationId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const QualificationOCICertificateSchema = z.object({
  scope: z.object({ subject, admission: JobRuntimeNativeAdmissionRecordSchema, bootId: z.uuid() }).strict(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/), process, boundary,
  helpers: z.array(z.object({ kind: z.enum(['conmon', 'launcher']), process, boundary: boundary.nullable() }).strict()).max(512),
  lifecycle: z.enum(['active', 'closed', 'closure-unconfirmed']),
}).strict()
export const QualificationReceiptSchema = z.object({
  admission: JobRuntimeNativeAdmissionRecordSchema, candidate: JobQualificationCandidateRecordSchema,
  result: JobRuntimeQualificationResultRecordSchema.nullable(), sequence: z.number().int().positive(),
  phase: z.enum(['received', 'native_entry_attempted', 'closed', 'uncertain']),
  quotaClaims: z.array(z.object({ path: z.string().startsWith('/'), namespace: z.string().startsWith('/'),
    device: z.number().int().nonnegative(), inode: z.number().int().positive() }).strict()).default([]),
  closedContainers: z.array(QualificationOCICertificateSchema).max(16).default([]),
  launches: z.array(z.object({ launchId: z.uuid(), binary: z.string().startsWith('/'), argv: z.array(z.string()).max(256),
    exit: z.object({ exitCode: z.number().int().min(0).max(255).nullable(), signal: z.string().nullable() }).strict().nullable(),
    closed: z.boolean() }).strict()).max(512),
  container: z.object({ identity: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(), certificate: QualificationOCICertificateSchema.nullable() }).strict().nullable(),
}).strict()
export type QualificationReceipt = z.infer<typeof QualificationReceiptSchema>
