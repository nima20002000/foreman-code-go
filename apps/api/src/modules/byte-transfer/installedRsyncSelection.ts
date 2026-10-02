import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, parse, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DeviceRegistrationSchema } from '@graphql/contracts/device-identity'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { TransferIntentSchema, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { TrustedConnectionCheckSchema } from '@graphql/contracts/trusted-device-connection'
import type { PostgresTrustedConnectionSetup } from '../devices/trustedConnectionSetup.js'
import { DomainError } from '../errors.js'
import { authenticatedTransferAuthority, transferContextForBinding, type AcceptedTransferAuthority } from './carrier.js'
import { assertRsyncBackendSelection, type RsyncBackendSelection } from './rsyncProduction.js'
import { NodeRsyncExecutor, RSYNC_SSH_ARGS, validateRsyncEndpoint, verifyRsyncBinaries, type RsyncExecutor } from './rsync.js'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const PrivateBinary = z.object({ path: z.string().min(1).max(4096), sha256: Hash, version: z.literal('3.5.1') }).strict()
/** Installer-owned local configuration, never a transfer request, UI default or historical evidence import. */
export const InstalledRsyncSelectionSchema = z.object({
  formatVersion: z.literal(1), backend: z.literal('rsync'),
  registration: DeviceRegistrationSchema, consentRevision: z.number().int().positive(),
  endpoint: z.object({ user: z.string(), host: z.string(), localRoot: z.string(), remoteRoot: z.string() }).strict(),
  localBinary: PrivateBinary, remoteBinary: PrivateBinary,
  sourceProvenance: z.object({ sourceSha256: Hash, releaseSignerFingerprint: z.string().regex(/^[A-F0-9]{40}$/) }).strict(),
}).strict()
export type InstalledRsyncSelection = z.infer<typeof InstalledRsyncSelectionSchema>
export interface InstalledRsyncSelectionPorts {
  /** Must read explicit protected installed configuration afresh; undefined means not selected. */
  installed(deviceId: string, signal: AbortSignal): Promise<InstalledRsyncSelection | undefined>
  setup: Pick<PostgresTrustedConnectionSetup, 'checkAcceptedTransfer'>
  accepted: AcceptedTransferAuthority
  /** Actual endpoint.captureRequest(deviceId,'rsync-stage-v1').binding on Main. */
  capture(deviceId: string): Readonly<DeviceSessionBinding> | undefined
  executor?: RsyncExecutor
}
const unavailable = (reason: string): never => { throw new DomainError('RSYNC_SELECTION_UNAVAILABLE', reason, 409) }
async function safeAncestors(path: string): Promise<void> {
  if (!isAbsolute(path) || path.split('/').some(part => part === '.' || part === '..')) unavailable('Protected installed path is not absolute and normalized.')
  let current = parse(path).root
  for (const part of dirname(path).slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 && stat.uid !== process.getuid?.()
      || (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) unavailable('Protected installed path has unsafe ancestors.')
  }
}
/** Reads a server-owned installed path only. Does not create/configure a record or grant. */
export async function readProtectedInstalledRsyncSelection(path: string, signal: AbortSignal): Promise<InstalledRsyncSelection | undefined> {
  signal.throwIfAborted()
  await safeAncestors(path)
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > 32768) unavailable('Explicit installed selection must be a bounded private owner file.')
    const buffer = Buffer.alloc(32769), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8'), after = await file.stat(), named = await lstat(path)
    signal.throwIfAborted()
    if (bytesRead !== before.size || text.length > 32768 || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || named.isSymbolicLink() || named.ino !== after.ino || named.dev !== after.dev) unavailable('Protected installed selection changed during read.')
    return InstalledRsyncSelectionSchema.parse(JSON.parse(text))
  } finally { await file.close() }
}
async function precheckLocalBinary(selection: InstalledRsyncSelection, signal: AbortSignal): Promise<void> {
  const path = selection.localBinary.path
  await safeAncestors(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || !(stat.mode & 0o111) || stat.size > 64 * 1024 * 1024) unavailable('Selected app-private binary is not a protected executable.')
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let offset = 0
    while (offset <= stat.size) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset + 1), offset)
      if (!bytesRead) break
      offset += bytesRead; hash.update(buffer.subarray(0, bytesRead))
    }
    const digest = hash.digest('hex'), after = await file.stat(), named = await lstat(path)
    signal.throwIfAborted()
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || digest !== selection.localBinary.sha256 || named.isSymbolicLink() || named.ino !== stat.ino || named.dev !== stat.dev) unavailable('Selected app-private binary changed before verification.')
  } finally { await file.close() }
}
/** Main-local leaf only. No scheduler, listener, automatic backend, borrowed principal or data grant. */
export function createInstalledRsyncSelectionProvider(ports: InstalledRsyncSelectionPorts) {
  const executor = ports.executor ?? new NodeRsyncExecutor()
  return { async selection(raw: TransferIntent, signal: AbortSignal): Promise<RsyncBackendSelection> {
    const intent = TransferIntentSchema.parse(raw)
    const installed = async () => {
      signal.throwIfAborted()
      const record = await ports.installed(intent.deviceId, signal)
      if (!record) unavailable('Rsync is not explicitly selected in protected installed configuration.')
      return InstalledRsyncSelectionSchema.parse(record)
    }
    const selected = await installed()
    const binding = ports.capture(intent.deviceId)
    if (!binding) unavailable('The original authenticated rsync client capture is unavailable.')
    const pinned = DeviceSessionBindingSchema.parse(binding)
    const check = async () => TrustedConnectionCheckSchema.parse(await ports.setup.checkAcceptedTransfer(intent, {
      accepted: ports.accepted, binding: pinned, current: () => ports.capture(intent.deviceId),
    }, signal))
    const domain = authenticatedTransferAuthority(ports.capture, ports.accepted)
    const fence = async () => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(ports.capture(intent.deviceId), pinned)) unavailable('The original outgoing transfer capture changed.')
      await domain.authorize(intent, transferContextForBinding(pinned), 'start')
      signal.throwIfAborted()
      if (!isDeepStrictEqual(ports.capture(intent.deviceId), pinned) || Date.parse(intent.expiresAt) <= Date.now()) unavailable('Accepted transfer expired or its outgoing capture changed.')
    }
    const qualifiedExecutor: RsyncExecutor = { async run(command, bounded) {
      await fence(); const output = await executor.run(command, bounded); await fence(); return output
    } }
    let checked = await check()
    if (!isDeepStrictEqual(checked.registration, selected.registration) || checked.consent?.revision !== selected.consentRevision) unavailable('Explicit installation selection no longer matches current consent/registration.')
    const suffix = '/.local/share/graphql-tools/rsync/3.5.1/bin/rsync'
    if (!selected.localBinary.path.endsWith(suffix) || !selected.remoteBinary.path.endsWith(suffix)) unavailable('Only explicitly pinned app-private rsync3.5.1 binaries are supported.')
    const endpoint = validateRsyncEndpoint({ ...selected.endpoint, localBinary: selected.localBinary.path, remoteBinary: selected.remoteBinary.path,
      localBinarySha256: selected.localBinary.sha256, remoteBinarySha256: selected.remoteBinary.sha256 })
    const result: RsyncBackendSelection = { backend: selected.backend, check: checked, endpoint }
    assertRsyncBackendSelection(result, intent)
    await precheckLocalBinary(selected, signal)
    const remoteHash = await qualifiedExecutor.run({ executable: '/usr/bin/ssh', args: [...RSYNC_SSH_ARGS, `${endpoint.user}@${endpoint.host}`, `/usr/bin/sha256sum -- ${endpoint.remoteBinary}`] }, signal)
    if (remoteHash !== `${endpoint.remoteBinarySha256}  ${endpoint.remoteBinary}\n`) unavailable('Selected remote app-private binary changed before version verification.')
    signal.throwIfAborted()
    if (!isDeepStrictEqual(ports.capture(intent.deviceId), pinned)) unavailable('Authenticated capture changed during remote binary digest check.')
    const versions = await verifyRsyncBinaries(endpoint, qualifiedExecutor, signal)
    if (![versions.local, versions.remote].every(value => /^rsync\s+version\s+3\.5\.1(?:\s|$)/m.test(value))) unavailable('Current selected binaries differ from the approved rsync3.5.1 package pins.')
    await precheckLocalBinary(selected, signal)
    const latest = await installed()
    if (!isDeepStrictEqual(latest, selected) || !isDeepStrictEqual(ports.capture(intent.deviceId), pinned)) unavailable('Protected backend selection or authenticated capture changed during verification.')
    checked = await check()
    if (!isDeepStrictEqual(checked.registration, selected.registration) || !isDeepStrictEqual(checked.consent, result.check.consent)) unavailable('Current trusted consent changed during binary verification.')
    if (!isDeepStrictEqual(await installed(), selected)) unavailable('Protected backend selection changed during final trusted check.')
    await fence()
    result.check = checked
    assertRsyncBackendSelection(result, intent)
    signal.throwIfAborted()
    return result
  } }
}
