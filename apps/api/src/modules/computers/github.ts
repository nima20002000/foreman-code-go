import type pg from 'pg'
import { COMPUTER_GITHUB_NAMESPACE, GitHubLoginRequestSchema, GitHubLoginStateSchema,
  type GitHubLoginRequest, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ComputerAccountsEndpoint } from './accounts.js'
import { GitHubLoginRunner } from './githubLogin.js'

/** Starts, follows and ends GitHub CLI sign-in on Main or a paired computer. Credentials stay on that computer. */
export class ComputerGitHubService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly local: Pick<GitHubLoginRunner, 'handle'> = new GitHubLoginRunner(),
  ) {}

  async handle(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget,
    request: GitHubLoginRequest): Promise<GitHubLoginState> {
    const action = request.operation === 'login-start' ? 'computer_github_login_start'
      : request.operation === 'logout' ? 'computer_github_logout' : 'computer_github_login_status'
    const targetKey = target.hostRef.kind === 'main' ? `main:${this.mainId}` : `device:${target.hostRef.deviceId}`
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, action, targetKey)
      throw error
    }
    await this.current(principal, target)
    const parsed = GitHubLoginRequestSchema.parse(request)
    try {
      const state = GitHubLoginStateSchema.parse(target.hostRef.kind === 'main' ? await this.local.handle(parsed)
        : await this.device(target.hostRef.deviceId, parsed))
      if (request.operation !== 'login-status') await this.commands.recordAudit(principal.id, source, action, targetKey, 'succeeded',
        { state: state.state })
      return state
    } catch (error) {
      if (request.operation !== 'login-status') await this.commands.recordAudit(principal.id, source, action, targetKey, 'failed',
        { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
  }

  /** The caller still holds settings:update and the target is this Main or a currently paired installation. */
  private async current(principal: ManagementPrincipal, target: DeviceProvisioningTarget) {
    const sql = await this.pool.connect()
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update')
      if (target.hostRef.mainId !== this.mainId) throw new DomainError('COMPUTER_NOT_FOUND', 'This computer belongs to another Main.', 404)
      if (target.hostRef.kind === 'main') {
        if (target.applicationInstallationId !== this.mainId) throw new DomainError('COMPUTER_NOT_FOUND', 'Main installation changed.', 404)
        return
      }
      const row = (await sql.query<{ record: unknown }>(`select record from device_registrations
        where main_id=$1 and record->>'deviceId'=$2 and record->>'status'='paired' limit 1`, [this.mainId, target.hostRef.deviceId])).rows[0]
      const registration = row && DeviceRegistrationSchema.parse(row.record)
      if (!registration || !sameDeviceProvisioningTarget(target, { hostRef: target.hostRef,
        applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
        authorizationRevision: registration.authorizationRevision })) {
        throw new DomainError('COMPUTER_NOT_FOUND', 'This computer is not currently paired with that installation.', 404)
      }
    } finally { sql.release() }
  }

  private async device(deviceId: string, request: GitHubLoginRequest) {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_GITHUB_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or its app is too old for GitHub sign-in.', 409)
    }
    return (await endpoint.request(deviceId, COMPUTER_GITHUB_NAMESPACE, request, { signal: AbortSignal.timeout(45_000) })).payload
  }
}
