import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { SyncComputerRequestSchema, SyncComputerStateSchema, SyncIdentitySchema,
  type SyncComputerRequest, type SyncComputerState, type SyncIdentity } from '@foreman-code/contracts/computer-accounts'
import { systemSyncthingPorts, type SyncthingPorts } from './syncthingSystem.js'

export function sharedFolderId(workspaceId: string): string {
  return `workspace-${createHash('sha256').update(workspaceId).digest('hex')}`
}
const FolderSchema = z.object({ id: z.string(), label: z.string(), path: z.string(),
  devices: z.array(z.object({ deviceID: z.string() })) }).passthrough()
const StatusSchema = z.object({ state: z.string(), pullErrors: z.number().optional(), error: z.string().optional() })
const ConnectionsSchema = z.object({ connections: z.record(z.string(), z.object({ connected: z.boolean() })) })

/** One app-managed instance. Its keys and REST endpoint remain on this computer. */
export class SyncthingComputer {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly ports: SyncthingPorts = systemSyncthingPorts()) {}

  handle(raw: unknown, options: { assertCurrent?: () => void; signal?: AbortSignal } = {}):
    Promise<SyncIdentity | SyncComputerState> {
    const request = SyncComputerRequestSchema.parse(raw)
    const assertCurrent = options.assertCurrent ?? (() => {})
    assertCurrent()
    options.signal?.throwIfAborted()
    if (request.operation === 'status') return this.status(options.signal)
    const task = this.pending.then(async () => {
      assertCurrent()
      if (request.operation === 'configure' && !request.enabled
        && !(await this.ports.available()).running) return this.status()
      const identity = await this.ports.prepare()
      assertCurrent()
      if (request.operation === 'identity') return identity
      await this.configure(identity, request, assertCurrent)
      return this.status()
    })
    this.pending = task.then(() => undefined, () => undefined)
    return task
  }

  private async configure(identity: SyncIdentity, input: Extract<SyncComputerRequest, { operation: 'configure' }>,
    assertCurrent: () => void) {
    const { workspaceId, enabled, peers } = input
    const id = sharedFolderId(workspaceId)
    const folders = z.array(FolderSchema).parse(await this.ports.rest('GET', '/rest/config/folders'))
    if (!enabled) {
      if (folders.some(folder => folder.id === id)) {
        assertCurrent()
        await this.ports.rest('DELETE', `/rest/config/folders/${id}`)
      }
      return
    }
    for (const peer of peers) {
      const template = z.record(z.string(), z.unknown()).parse(await this.ports.rest('GET', '/rest/config/defaults/device'))
      assertCurrent()
      await this.ports.rest('POST', '/rest/config/devices', { ...template, deviceID: peer.deviceId,
        addresses: [`tcp://${peer.address}:22001`], introducer: false, autoAcceptFolders: false, paused: false })
    }
    const path = join(identity.rootPath, id)
    assertCurrent()
    await this.ports.mkdir(path)
    const template = folders.find(folder => folder.id === id)
      ?? z.record(z.string(), z.unknown()).parse(await this.ports.rest('GET', '/rest/config/defaults/folder'))
    assertCurrent()
    await this.ports.rest('POST', '/rest/config/folders', {
      ...template, id, label: workspaceId, path, type: 'sendreceive', paused: false,
      devices: [...new Set([identity.deviceId, ...peers.map(peer => peer.deviceId)])].map(deviceID => ({ deviceID })),
      versioning: { type: 'simple', params: { keep: '5' }, cleanupIntervalS: 3600 },
    })
  }

  async status(signal?: AbortSignal): Promise<SyncComputerState> {
    signal?.throwIfAborted()
    if (!signal) return this.readStatus()
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void this.readStatus(signal).then(value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      }, error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      })
    })
  }

  private async readStatus(signal?: AbortSignal): Promise<SyncComputerState> {
    const available = await this.ports.available(signal)
    signal?.throwIfAborted()
    if (!available.installed || !available.running) {
      return SyncComputerStateSchema.parse({ ...available, deviceId: null, folders: [], message: null })
    }
    const identity = z.object({ myID: SyncIdentitySchema.shape.deviceId }).parse(
      await this.ports.rest('GET', '/rest/system/status', undefined, signal))
    signal?.throwIfAborted()
    const folders = z.array(FolderSchema).parse(
      await this.ports.rest('GET', '/rest/config/folders', undefined, signal))
    signal?.throwIfAborted()
    const connections = ConnectionsSchema.parse(
      await this.ports.rest('GET', '/rest/system/connections', undefined, signal)).connections
    signal?.throwIfAborted()
    const states = await Promise.all(folders.filter(folder => /^workspace-[a-f0-9]{64}$/u.test(folder.id))
      .map(async folder => {
        signal?.throwIfAborted()
        const status = StatusSchema.parse(
          await this.ports.rest('GET', `/rest/db/status?folder=${folder.id}`, undefined, signal))
        signal?.throwIfAborted()
        const peers = folder.devices.filter(device => device.deviceID !== identity.myID)
        const conflicts = (await this.ports.conflicts(folder.path, signal)).slice(0, 100)
        signal?.throwIfAborted()
        let state: 'idle' | 'syncing' | 'error' = status.state === 'idle' ? 'idle' : 'syncing'
        if (status.state === 'error' || status.pullErrors || status.error) state = 'error'
        return { workspaceId: folder.label, path: folder.path, state, conflicts,
          connected: peers.length > 0 && peers.every(peer => connections[peer.deviceID]?.connected === true),
          message: status.error?.slice(0, 500) ?? (status.pullErrors ? `${status.pullErrors} files failed to sync.` : null) }
      }))
    return SyncComputerStateSchema.parse({ installed: true, running: true, deviceId: identity.myID,
      folders: states, message: null })
  }
}
