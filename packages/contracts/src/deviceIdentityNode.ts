import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WorkerLocalIdentity {
  formatVersion: 1
  workerInstallationId: string
  publicKey: string
  privateKey: string
  publicKeyFingerprint: string
  keyRevision: number
}
export function publicKeyFingerprint(publicKey: string): string {
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Worker identity requires an Ed25519 key.')
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}
export async function loadOrCreateWorkerIdentity(directory: string): Promise<WorkerLocalIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'identity.json')
  async function read(): Promise<WorkerLocalIdentity> {
    const identity = JSON.parse(await readFile(file, 'utf8')) as WorkerLocalIdentity
    if (identity.formatVersion !== 1 || !/^[0-9a-f-]{36}$/.test(identity.workerInstallationId)
      || !Number.isSafeInteger(identity.keyRevision) || identity.keyRevision < 1 || publicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint
      || publicKeyFingerprint(createPublicKey(createPrivateKey(identity.privateKey)).export({ type: 'spki', format: 'pem' }).toString()) !== identity.publicKeyFingerprint) {
      throw new Error('Worker identity is corrupt; explicit recovery is required.')
    }
    return identity
  }
  try { return await read() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await stat(join(directory, 'pairing.json'))
    throw new Error('Paired worker identity is missing; explicit recovery is required.')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity: WorkerLocalIdentity = { formatVersion: 1, workerInstallationId: randomUUID(), publicKey,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: publicKeyFingerprint(publicKey), keyRevision: 1 }
  const temporary = join(directory, `.identity-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(identity), { mode: 0o600, flag: 'wx' })
  const handle = await open(temporary, 'r')
  try { await handle.sync() } finally { await handle.close() }
  try {
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally { await unlink(temporary) }
  const directoryHandle = await open(directory, 'r')
  try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  return read()
}

/** Explicit pairing writes once. Switching main requires explicit unpairing, never an overwrite. */
export async function persistWorkerPairing(directory: string, configuration: import('./deviceIdentity.js').WorkerPairingConfiguration): Promise<void> {
  const { WorkerPairingConfigurationSchema } = await import('./deviceIdentity.js')
  const parsed = WorkerPairingConfigurationSchema.parse(configuration)
  const identity = await loadOrCreateWorkerIdentity(directory)
  if (parsed.workerInstallationId !== identity.workerInstallationId || parsed.keyRevision !== identity.keyRevision) throw new Error('Pairing does not match local identity.')
  const file = join(directory, 'pairing.json'), temporary = join(directory, `.pairing-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: 'wx' })
  try { await link(temporary, file) } finally { await unlink(temporary) }
}
export async function loadWorkerPairing(directory: string): Promise<import('./deviceIdentity.js').WorkerPairingConfiguration> {
  const { WorkerPairingConfigurationSchema } = await import('./deviceIdentity.js')
  const parsed = WorkerPairingConfigurationSchema.parse(JSON.parse(await readFile(join(directory, 'pairing.json'), 'utf8')))
  const identity = await loadOrCreateWorkerIdentity(directory)
  if (parsed.workerInstallationId !== identity.workerInstallationId || parsed.keyRevision !== identity.keyRevision) throw new Error('Pairing does not match local identity.')
  return parsed
}

/** Endpoint edits retain the selected authority and credential; the carrier must still authenticate the pinned main. */
export async function updateWorkerEndpoint(directory: string, endpoint: string): Promise<void> {
  const { WorkerPairingConfigurationSchema } = await import('./deviceIdentity.js')
  const configuration = WorkerPairingConfigurationSchema.parse({ ...await loadWorkerPairing(directory), endpoint })
  const temporary = join(directory, `.pairing-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' })
  const { rename } = await import('node:fs/promises')
  try { await rename(temporary, join(directory, 'pairing.json')) }
  catch (error) { await unlink(temporary); throw error }
}
