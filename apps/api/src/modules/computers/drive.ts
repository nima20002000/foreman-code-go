import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { COMPUTER_DRIVE_NAMESPACE, DriveComputerStateSchema, DriveLoginStateSchema,
  type DriveComputerRequest, type DriveComputerState, type DriveLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ComputerAccountsEndpoint } from './accounts.js'
import { DriveComputer } from './driveComputer.js'
import { assertCurrentComputer } from './github.js'

const LOGIN_LIFETIME_MS = 10 * 60_000
const URL_WAIT_MS = 30_000

export interface DriveAuthorizer {
  /** rclone's Google sign-in on Main: resolves with the URL to open, then with the authorization token. */
  start(rclone: string): { url: Promise<string>; token: Promise<string>; cancel(): void }
}

interface Session { id: string; target: DeviceProvisioningTarget; cancel(): void; state: DriveLoginState }

/** Connects Google Drive on Main or a paired computer. The owner signs in to Google in a browser on Main; the
 * resulting authorization goes straight to that computer's rclone config, which mounts Drive. Main keeps no token. */
export class ComputerDriveService {
  private session: Session | undefined
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly local: DriveComputer = new DriveComputer(),
    private readonly authorizer: DriveAuthorizer = rcloneAuthorizer(),
    private readonly now: () => number = Date.now,
  ) {}

  async connectStart(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget): Promise<DriveLoginState> {
    return this.audited(principal, source, target, 'computer_drive_connect_start', async () => {
      // rclone on this computer for the sign-in, and on the target for the mount.
      await this.local.install()
      await this.computer(target, { operation: 'install' })
      this.session?.cancel()
      const flow = this.authorizer.start(this.local.rclone)
      const session: Session = { id: randomUUID(), target, cancel: flow.cancel, state: { loginId: null, state: 'waiting',
        authorizationUrl: null, expiresAt: new Date(this.now() + LOGIN_LIFETIME_MS).toISOString(), account: null, mountPath: null, message: null } }
      session.state.loginId = session.id
      this.session = session
      const timer = setTimeout(() => {
        if (session.state.state !== 'waiting') return
        session.state = { ...session.state, state: 'expired', authorizationUrl: null, message: 'Google sign-in expired. Start again.' }
        flow.cancel()
      }, LOGIN_LIFETIME_MS)
      timer.unref?.()
      void flow.token.then(async token => {
        clearTimeout(timer)
        if (session.state.state !== 'waiting') return
        session.state = { ...session.state, state: 'connecting', authorizationUrl: null }
        try {
          const result = await this.computer(target, { operation: 'connect', token })
          session.state = { ...session.state, state: 'connected', account: result.account, mountPath: result.mountPath }
        } catch (error) {
          session.state = { ...session.state, state: 'failed', message: error instanceof DomainError ? error.message.slice(0, 500) : 'Drive could not be connected.' }
        }
      }, () => {
        clearTimeout(timer)
        if (session.state.state === 'waiting') session.state = { ...session.state, state: 'failed', authorizationUrl: null, message: 'Google sign-in did not complete.' }
      })
      const url = await Promise.race([flow.url, new Promise<never>((_, reject) => setTimeout(() =>
        reject(new DomainError('DRIVE_LOGIN_FAILED', 'rclone did not offer a Google sign-in link in time.', 504)), URL_WAIT_MS).unref?.())])
        .catch(error => { flow.cancel(); this.session = undefined; throw error })
      session.state = { ...session.state, authorizationUrl: url }
      return DriveLoginStateSchema.parse(session.state)
    })
  }

  async connectStatus(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget, loginId: string) {
    await assertCurrentComputer(this.pool, this.mainId, principal, target)
    void source
    if (this.session?.id !== loginId || JSON.stringify(this.session.target) !== JSON.stringify(target)) {
      throw new DomainError('DRIVE_LOGIN_NOT_FOUND', 'This Google sign-in is no longer active.', 404)
    }
    return DriveLoginStateSchema.parse(this.session.state)
  }

  async disconnect(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget): Promise<DriveLoginState> {
    return this.audited(principal, source, target, 'computer_drive_disconnect', async () => {
      await this.computer(target, { operation: 'disconnect' })
      return DriveLoginStateSchema.parse({ loginId: null, state: 'disconnected', authorizationUrl: null, expiresAt: null,
        account: null, mountPath: null, message: null })
    })
  }

  private async audited(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget, action: string,
    work: () => Promise<DriveLoginState>) {
    const targetKey = target.hostRef.kind === 'main' ? `main:${this.mainId}` : `device:${target.hostRef.deviceId}`
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
      { signal: AbortSignal.timeout(request.operation === 'install' ? 300_000 : 90_000) })).payload)
  }
}

/** `rclone authorize drive` listens on 127.0.0.1:53682 on Main and prints the token once Google redirects back. */
export function rcloneAuthorizer(environment: NodeJS.ProcessEnv = process.env): DriveAuthorizer {
  return {
    start(rclone) {
      // Only files the app creates (drive.file), not the owner's whole Drive.
      const scope = Buffer.from(JSON.stringify({ scope: 'drive.file' })).toString('base64url')
      const child: ChildProcess = spawn(rclone, ['authorize', 'drive', scope, '--auth-no-open-browser'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment, NO_COLOR: '1' } })
      let output = ''
      let resolveUrl!: (value: string) => void, rejectUrl!: (error: Error) => void
      const url = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject })
      const token = new Promise<string>((resolve, reject) => {
        const read = (chunk: Buffer) => {
          output = (output + chunk.toString('utf8')).slice(-65_536)
          const link = /(http:\/\/127\.0\.0\.1:53682\/auth\?state=[A-Za-z0-9_-]+)/u.exec(output)?.[1]
          if (link) resolveUrl(link)
        }
        child.stdout?.on('data', read)
        child.stderr?.on('data', read)
        child.once('error', error => { rejectUrl(error); reject(error) })
        child.once('exit', code => {
          const pasted = /--->\s*(\{[\s\S]*?\})\s*<---End paste/u.exec(output)?.[1]
          if (code === 0 && pasted) resolve(pasted)
          else { const error = new Error('rclone authorize did not complete.'); rejectUrl(error); reject(error) }
        })
      })
      return { url, token, cancel: () => child.kill('SIGTERM') }
    },
  }
}
