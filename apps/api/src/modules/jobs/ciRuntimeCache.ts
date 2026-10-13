import { pathExists } from '../../shared/pathExists.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PreparedCiRuntimeSchema, type PreparedCiRuntime } from '@foreman-code/contracts'
import { anchored, openPrivateRoot } from '../sources/privateFilesystem.js'
import { readProtectedRuntimeFile } from './installedRuntimeConfiguration.js'
import { fingerprintQualificationPath } from './qualification.js'

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const ImageSchema = PreparedCiRuntimeSchema.omit({ commit: true, qualificationSource: true, reusedImage: true })
type CachedCiRuntimeImage = z.infer<typeof ImageSchema>
const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  inputDigest: DigestSchema,
  image: ImageSchema,
  seedReceiptDigest: DigestSchema,
  contextReceiptDigest: DigestSchema,
}).strict()


function cachePath(installer: string, inputDigest: string): string {
  return join(installer, 'runtime-cache', DigestSchema.parse(inputDigest) + '.json')
}

function ownsArtifacts(installer: string, prepared: CachedCiRuntimeImage): boolean {
  const paths = [prepared.seedReceiptPath, prepared.contextReceiptPath]
  if (prepared.unitCodex) paths.push(prepared.unitCodex.sourceExecutable)
  return paths.every(path => path.startsWith(installer + '/')
    && !path.split('/').some(part => part === '.' || part === '..'))
}

async function receiptDigest(path: string): Promise<string> {
  const bytes = await readProtectedRuntimeFile({ path, ownerUid: process.getuid!() }, 16 * 1024 * 1024)
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readCiRuntimeCache(input: {
  installer: string
  inputDigest: string
  imageExists(imageId: string): Promise<boolean>
}): Promise<CachedCiRuntimeImage | null> {
  const path = cachePath(input.installer, input.inputDigest)
  if (!await pathExists(path)) return null
  const bytes = await readProtectedRuntimeFile({ path, ownerUid: process.getuid!() })
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  const cached = CacheSchema.safeParse(value)
  if (!cached.success || cached.data.inputDigest !== input.inputDigest) return null
  const { image: prepared, seedReceiptDigest, contextReceiptDigest } = cached.data
  if (!ownsArtifacts(input.installer, prepared)) return null
  if (!await pathExists(prepared.seedReceiptPath) || !await pathExists(prepared.contextReceiptPath)) return null
  if (await receiptDigest(prepared.seedReceiptPath) !== seedReceiptDigest
    || await receiptDigest(prepared.contextReceiptPath) !== contextReceiptDigest) return null
  if (prepared.unitCodex) {
    if (!await pathExists(prepared.unitCodex.sourceExecutable)) return null
    const binary = await fingerprintQualificationPath(prepared.unitCodex.sourceExecutable, true)
    if (binary.sha256 !== prepared.unitCodex.binarySha256) return null
  }
  if (!await input.imageExists(prepared.imageId)) return null
  return prepared
}

export async function writeCiRuntimeCache(input: {
  installer: string
  inputDigest: string
  prepared: PreparedCiRuntime
}): Promise<void> {
  if (!ownsArtifacts(input.installer, input.prepared)) {
    throw new Error('Cached CI artifacts must belong to the installed runtime.')
  }
  const record = CacheSchema.parse({
    schemaVersion: 1,
    inputDigest: input.inputDigest,
    image: { imageId: input.prepared.imageId, imageManifestDigest: input.prepared.imageManifestDigest,
      seedReceiptPath: input.prepared.seedReceiptPath, contextReceiptPath: input.prepared.contextReceiptPath,
      ...(input.prepared.unitCodex ? { unitCodex: input.prepared.unitCodex } : {}) },
    seedReceiptDigest: await receiptDigest(input.prepared.seedReceiptPath),
    contextReceiptDigest: await receiptDigest(input.prepared.contextReceiptPath),
  })
  const directory = join(input.installer, 'runtime-cache')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await openPrivateRoot(directory)
  const temporary = anchored(root, '.cache-' + randomUUID())
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    await rename(temporary, anchored(root, input.inputDigest + '.json'))
    await root.sync()
  } finally {
    await rm(temporary, { force: true })
    await root.close()
  }
}

/** Drops unused cache artifacts while preserving files referenced by installed configurations. */
export async function pruneCiRuntimeCache(input: {
  installer: string
  imageExists(imageId: string): Promise<boolean>
  keepPaths?: readonly string[]
}): Promise<void> {
  const directory = join(input.installer, 'runtime-cache')
  const used = new Set(input.keepPaths ?? [])
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const digest = /^([a-f0-9]{64})\.json$/u.exec(name)?.[1]
    if (!digest) continue
    const cached = await readCiRuntimeCache({ ...input, inputDigest: digest })
    if (!cached) {
      await rm(join(directory, name), { force: true })
      continue
    }
    for (const path of [cached.seedReceiptPath, cached.contextReceiptPath, cached.unitCodex?.sourceExecutable]) {
      if (path) used.add(path)
    }
  }
  for (const name of await readdir(input.installer)) {
    const path = join(input.installer, name)
    if (/^(?:codex-[a-f0-9]{12}|(?:seed|context)-receipt-(?:[a-f0-9]{12}|[a-f0-9]{64})\.json)$/u.test(name) && !used.has(path)) {
      await rm(path, { force: true })
    }
  }
}
