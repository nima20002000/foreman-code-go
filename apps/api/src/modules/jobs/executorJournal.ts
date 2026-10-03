import { z } from 'zod'
import { RemoteJobDispatchIntentSchema, RemoteJobConnectionIdentitySchema } from '@graphql/contracts/remote-job-execution'

const process = z.object({ pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootId: z.uuid() }).strict()
const boundary = z.object({ kind: z.literal('cgroup-v2'), path: z.string().startsWith('/sys/fs/cgroup/'), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
export const JobOCICertificateSchema = z.object({
  scope: z.object({ subject: z.object({ kind: z.literal('job'), executionId: z.string().min(1), attemptId: z.string().min(1), operationId: z.string().min(1), bindingHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    leaseId: z.string().min(1), owner: RemoteJobDispatchIntentSchema.shape.owner, observedDeviceId: z.string().min(1).nullable(), observedInstallationId: z.string().min(1), bootId: z.uuid() }).strict(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/), process, boundary,
  helpers: z.array(z.object({ kind: z.enum(['conmon', 'launcher']), process, boundary: boundary.nullable() }).strict()).max(512),
  lifecycle: z.enum(['active', 'closed', 'closure-unconfirmed']),
}).strict()
/** Internal evidence in the existing fsynced worker journal, never a second owner ledger. */
export const JobNativeOwnerSchema = z.object({
  operationId: z.string().min(1), qualificationOperationId: z.string().min(1).nullable().default(null), timedOut: z.boolean().default(false), connection: RemoteJobConnectionIdentitySchema,
  launches: z.array(z.object({ launchId: z.uuid(), processOwner: z.string().min(1).optional(), binary: z.string().startsWith('/'), argv: z.array(z.string()).max(256),
    exit: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict().nullable(), closed: z.boolean() }).strict()).max(512),
  container: z.object({ identity: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(), deadlineAt: z.string().datetime().nullable().default(null), certificate: JobOCICertificateSchema.nullable() }).strict().nullable(),
}).strict()
export type JobNativeOwner = z.infer<typeof JobNativeOwnerSchema>
