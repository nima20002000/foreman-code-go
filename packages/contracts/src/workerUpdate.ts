import { z } from 'zod'

export const WORKER_UPDATE_NAMESPACE = 'worker-update-v1'
export const WORKER_UPDATE_VERSION = 1
export const WORKER_UPDATE_MAX_JSON_BYTES = 1_048_576
export const WORKER_UPDATE_MAX_BINARY_BYTES = 262_144

export const WorkerUpdateStatusSchema = z.object({
  currentVersion: z.string().min(1).max(128),
  /** Hash of the running release, independently of a pending or failed update target. */
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  targetVersion: z.string().min(1).max(128).nullable(),
  state: z.enum(['current', 'pending', 'draining', 'downloading', 'installing', 'restarting', 'rolled-back', 'failed']),
  lastError: z.string().max(2000).nullable(),
}).strict()
export type WorkerUpdateStatus = z.infer<typeof WorkerUpdateStatusSchema>

const WorkerArtifactTargetSchema = z.object({
  os: z.string().min(1).max(100),
  osRelease: z.string().min(1).max(100),
  arch: z.string().min(1).max(100),
  libc: z.string().min(1).max(100),
  node: z.string().min(1).max(100),
}).strict()
export type WorkerArtifactTarget = z.infer<typeof WorkerArtifactTargetSchema>

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const artifactPath = z.string().min(1).max(1024).regex(/^[a-zA-Z0-9_@./-]+$/u)
  .refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const offset = z.number().int().nonnegative().max(64 * 1024 * 1024)

export const WorkerArtifactManifestSchema = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  lockfileSha256: digest,
  packageManager: z.literal('pnpm@11.27.0'),
  protocolVersion: z.literal(1),
  identityFormat: z.literal(1),
  target: WorkerArtifactTargetSchema,
  files: z.array(z.object({
    path: artifactPath,
    sha256: digest,
    size: offset,
  }).strict()).min(1).max(512),
}).passthrough().refine(manifest => {
  const paths = new Set(manifest.files.map(file => file.path))
  return paths.size === manifest.files.length && paths.has('src/cli.mjs') && !paths.has('manifest.json')
}, 'Invalid artifact file list')
export type WorkerArtifactManifest = z.infer<typeof WorkerArtifactManifestSchema>

/** Where Workers download a release: a GitHub release asset per artifact, named <manifestSha256>.tar.gz. */
const WorkerArtifactGitHubSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u),
  tag: z.string().regex(/^worker-[a-f0-9]{12,64}$/u),
}).strict()
export const WorkerArtifactIndexSchema = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  github: WorkerArtifactGitHubSchema.optional(),
  artifacts: z.array(z.object({
    target: WorkerArtifactTargetSchema,
    manifestSha256: digest,
  }).strict()).max(100),
}).strict()

export const WorkerArtifactRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('release'), target: WorkerArtifactTargetSchema }).strict(),
  z.object({ operation: z.literal('chunk'), manifestSha256: digest, path: artifactPath, offset }).strict(),
  z.object({ operation: z.literal('ci-smoke'), manifestSha256: digest }).strict(),
])

export const WorkerCiSmokeSchema = z.object({ repository: WorkerArtifactGitHubSchema.shape.repository,
  commit: z.string().regex(/^[a-f0-9]{40}$/u) }).strict()

export const WorkerArtifactReplySchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('release'),
    release: z.object({
      version: z.string().regex(/^\d+\.\d+\.\d+$/u),
      manifestSha256: digest,
      manifest: z.unknown(),
      github: WorkerArtifactGitHubSchema.optional(),
    }).strict().nullable(),
  }).strict(),
  z.object({ operation: z.literal('ci-smoke'), ciSmoke: WorkerCiSmokeSchema.nullable() }).strict(),
  z.object({
    operation: z.literal('chunk'),
    manifestSha256: digest,
    path: artifactPath,
    offset,
    byteSize: z.number().int().nonnegative().max(WORKER_UPDATE_MAX_BINARY_BYTES),
  }).strict(),
])
