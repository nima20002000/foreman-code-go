import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { COMPUTER_DRIVE_NAMESPACE, DriveComputerStateSchema, DriveLoginStateSchema,
  type DriveComputerRequest, type DriveComputerState, type DriveLoginState } from '@foreman-code/contracts/computer-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ComputerAccountsEndpoint } from './accounts.js'
import { DriveComputer } from './driveComputer.js'
import { assertCurrentComputer } from './github.js'

const LOGIN_LIFETIME_MS = 10 * 60_000
const SCOPE = Buffer.from(JSON.stringify({ scope: 'drive.file' })).toString('base64url')

interface Intent { id: string; sequence: number }

interface Session {
  id: string
  principalId: string
  target: DeviceProvisioningTarget
  state: DriveLoginState
}

/** rclone authorization runs beside the owner's browser. Main forwards the pasted token to the selected computer. */
export class ComputerDriveService {
  private readonly sessions = new Map<string, Session>()
  private readonly current = new Map<string, Intent>()
  private sequence = 0
  private pending: Promise<unknown> = Promise.resolve()
  private readonly local: Pick<DriveComputer, 'handle'>
  private readonly now: () => number
  private readonly changed: (target: DeviceProvisioningTarget) => void

  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    options: {
      local?: Pick<DriveComputer, 'handle'>
      now?: () => number
      changed?: (target: DeviceProvisioningTarget) => void
    } = {},
  ) {
    this.local = options.local ?? new DriveComputer()
    this.now = options.now ?? Date.now
    this.changed = options.changed ?? (() => {})
  }

  async connectStart(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget): Promise<DriveLoginState> {
    const intent = this.reserveIntent()
    return this.audited(principal, source, target, 'computer_drive_connect_start', async () => {
      this.prune()
      if (!this.activate(target, intent, 'This sign-in was replaced. Start again.')) return this.cancelled()
      const id = intent.id
      const session: Session = { id, principalId: principal.id, target: structuredClone(target), state: {
        loginId: id, state: 'waiting', authorizationUrl: null, authorizationCommand: `rclone authorize drive ${SCOPE}`,
        expiresAt: new Date(this.now() + LOGIN_LIFETIME_MS).toISOString(), account: null, mountPath: null, message: null,
      } }
      this.sessions.set(id, session)
      try {
        await this.computer(target, { operation: 'intent', operationId: id })
        if (!this.isCurrent(target, id)) return session.state
        const existing = await this.computer(target, { operation: 'install' })
        if (this.isCurrent(target, id)) {
          session.state = { ...session.state, account: existing.connected && existing.mounted
            ? existing.account ?? 'Google Drive' : null, mountPath: existing.mounted ? existing.mountPath : null }
        }
      } catch (error) {
        if (this.isCurrent(target, session.id)) {
          this.current.delete(this.key(target))
          session.state = { ...session.state, state: 'failed', message: 'Drive setup failed. Start again.' }
        }
        throw error
      }
      return DriveLoginStateSchema.parse(session.state)
    })
  }

  async connectStatus(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget, loginId: string) {
    await assertCurrentComputer(this.pool, this.mainId, principal, target)
    void source
    return DriveLoginStateSchema.parse(this.session(principal, target, loginId).state)
  }

  async connectComplete(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget,
    loginId: string, pasted: string): Promise<DriveLoginState> {
    return this.audited(principal, source, target, 'computer_drive_connect_complete', () => this.exclusive(async () => {
      const session = this.session(principal, target, loginId)
      if (session.state.state === 'connected') return session.state
      if (session.state.state !== 'waiting' || !this.isCurrent(target, session.id)) {
        throw new DomainError('DRIVE_LOGIN_INACTIVE', 'This Google sign-in is no longer active. Start again.', 409)
      }
      const token = rcloneToken(pasted)
      if (!token) throw new DomainError('DRIVE_TOKEN_INVALID', 'Paste the authorization result printed by rclone.', 400)
      // Pairing and access may have changed while authorization or another mount was in progress.
      await assertCurrentComputer(this.pool, this.mainId, principal, target)
      if (!this.isCurrent(target, session.id)) {
        throw new DomainError('DRIVE_LOGIN_INACTIVE', 'This Google sign-in was cancelled. Start again.', 409)
      }
      session.state = { ...session.state, state: 'connecting' }
      try {
        const result = await this.computer(target, { operation: 'connect', operationId: session.id, token })
        if (!result.connected || !result.mounted) {
          throw new DomainError('DRIVE_MOUNT_FAILED', 'Google Drive did not mount on this computer.', 502)
        }
        if (this.isCurrent(target, session.id)) {
          session.state = { ...session.state, state: 'connected', account: result.account, mountPath: result.mountPath }
        }
        return DriveLoginStateSchema.parse(session.state)
      } catch (error) {
        if (this.isCurrent(target, session.id)) {
          session.state = { ...session.state, state: 'failed',
            message: error instanceof Error ? error.message.slice(0, 500) : 'Drive could not be connected.' }
        }
        throw error
      } finally {
        this.changed(target)
      }
    }))
  }

  async cancel(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget,
    loginId: string): Promise<DriveLoginState> {
    const intent = this.reserveIntent()
    return this.audited(principal, source, target, 'computer_drive_connect_cancel', async () => {
      const session = this.session(principal, target, loginId)
      if (!this.isCurrent(target, loginId) || session.state.state === 'connected') return session.state
      if (this.activate(target, intent, 'Google sign-in was cancelled.')) {
        await this.computer(target, { operation: 'intent', operationId: intent.id })
      }
      return session.state
    })
  }

  async disconnect(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget): Promise<DriveLoginState> {
    const intent = this.reserveIntent()
    return this.audited(principal, source, target, 'computer_drive_disconnect', async () => {
      if (!this.activate(target, intent, 'Sign-in was cancelled by disconnecting Drive.')) return this.cancelled()
      await this.computer(target, { operation: 'intent', operationId: intent.id })
      return this.exclusive(async () => {
        await assertCurrentComputer(this.pool, this.mainId, principal, target)
        if (!this.isCurrent(target, intent.id)) return this.cancelled()
        try {
          const result = await this.computer(target, { operation: 'disconnect', operationId: intent.id })
          if (!this.isCurrent(target, intent.id)) return this.cancelled()
          if (result.connected || result.mounted) {
            throw new DomainError('DRIVE_DISCONNECT_FAILED', 'Google Drive is still connected on this computer.', 502)
          }
          return DriveLoginStateSchema.parse({ ...this.cancelled(), state: 'disconnected', message: null })
        } finally {
          this.changed(target)
        }
      })
    })
  }

  private reserveIntent(): Intent {
    return { id: randomUUID(), sequence: ++this.sequence }
  }

  private isCurrent(target: DeviceProvisioningTarget, id: string): boolean {
    return this.current.get(this.key(target))?.id === id
  }

  private activate(target: DeviceProvisioningTarget, intent: Intent, message: string): boolean {
    const previous = this.current.get(this.key(target))
    if (previous && previous.sequence > intent.sequence) return false
    const session = previous && this.sessions.get(previous.id)
    if (session) session.state = { ...session.state, state: 'cancelled', message }
    this.current.set(this.key(target), intent)
    return true
  }

  private cancelled(): DriveLoginState {
    return { loginId: null, state: 'cancelled', authorizationUrl: null, authorizationCommand: null,
      expiresAt: null, account: null, mountPath: null, message: 'A newer Drive request replaced this request.' }
  }

  private key(target: DeviceProvisioningTarget): string {
    return target.hostRef.kind === 'main' ? `main:${this.mainId}` : `device:${target.hostRef.deviceId}`
  }

  private session(principal: ManagementPrincipal, target: DeviceProvisioningTarget, id: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.principalId !== principal.id || !sameDeviceProvisioningTarget(session.target, target)) {
      throw new DomainError('DRIVE_LOGIN_NOT_FOUND', 'This Google sign-in is no longer active. Start again.', 404)
    }
    if (session.state.state === 'waiting' && Date.parse(session.state.expiresAt!) <= this.now()) {
      session.state = { ...session.state, state: 'expired', message: 'Google sign-in expired. Start again.' }
    }
    return session
  }

  private prune() {
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.state.expiresAt!) > this.now() || session.state.state === 'connecting') continue
      this.sessions.delete(id)
      if (this.isCurrent(session.target, session.id)) this.current.delete(this.key(session.target))
    }
  }

  /** Main serializes folder lookup/creation across its computers, and disconnect waits for any active switch. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async audited(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget, action: string,
    work: () => Promise<DriveLoginState>) {
    const targetKey = this.key(target)
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, action, targetKey)
      throw error
    }
    await assertCurrentComputer(this.pool, this.mainId, principal, target)
    try {
      const state = await work()
      await this.commands.recordAudit(principal.id, source, action, targetKey, 'succeeded', { state: state.state })
      return state
    } catch (error) {
      await this.commands.recordAudit(principal.id, source, action, targetKey, 'failed',
        { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
  }

  private async computer(target: DeviceProvisioningTarget, request: DriveComputerRequest): Promise<DriveComputerState> {
    if (target.hostRef.kind === 'main') return this.local.handle(request)
    const endpoint = this.endpoint()
    const deviceId = target.hostRef.deviceId
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_DRIVE_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or its app is too old for Google Drive.', 409)
    }
    return DriveComputerStateSchema.parse((await endpoint.request(deviceId, COMPUTER_DRIVE_NAMESPACE, request,
      { signal: AbortSignal.timeout(request.operation === 'install' ? 300_000 : request.operation === 'connect' ? 240_000 : 90_000) })).payload)
  }
}

/** rclone prints JSON, or base64url JSON carrying the token under `token`. */
export function rcloneToken(pasted: string | undefined): string | undefined {
  if (!pasted) return undefined
  const parse = (text: string): unknown => {
    try { return JSON.parse(text) as unknown } catch { return undefined }
  }
  const value = parse(pasted) ?? parse(Buffer.from(pasted.trim(), 'base64url').toString('utf8'))
  if (!value || typeof value !== 'object') return undefined
  const record = value as { token?: unknown; access_token?: unknown }
  if (typeof record.access_token === 'string') return JSON.stringify(record)
  return typeof record.token === 'string' && parse(record.token) ? record.token : undefined
}
