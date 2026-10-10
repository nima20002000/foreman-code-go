import type pg from 'pg'
import { COMPUTER_GITHUB_NAMESPACE, GitHubLoginRequestSchema, GitHubLoginStateSchema,
  type GitHubLoginRequest, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ComputerAccountsEndpoint } from './accounts.js'
import { GitHubLoginRunner } from './githubLogin.js'
import { assertComputerTarget } from './target.js'

/** Starts, follows and ends GitHub CLI sign-in on Main or a paired computer. Credentials stay on that computer. */
export class ComputerGitHubService {
  private readonly local: Pick<GitHubLoginRunner, 'handle'>
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly options: {
      local?: Pick<GitHubLoginRunner, 'handle'>
      accountChanged?: (target: DeviceProvisioningTarget) => void
    } = {},
  ) {
    this.local = options.local ?? new GitHubLoginRunner()
  }

  async handle(principal: ManagementPrincipal, source: 'http' | 'mcp', target: DeviceProvisioningTarget,
    request: GitHubLoginRequest): Promise<GitHubLoginState> {
    const actions = {
      'login-start': 'computer_github_login_start', 'login-status': 'computer_github_login_status',
      'logout': 'computer_github_logout', 'setup-git': 'computer_github_setup_git',
    }
    const action = actions[request.operation]
    const targetKey = target.hostRef.kind === 'main' ? `main:${this.mainId}` : `device:${target.hostRef.deviceId}`
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, action, targetKey)
      throw error
    }
    await assertCurrentComputer(this.pool, this.mainId, principal, target)
    const parsed = GitHubLoginRequestSchema.parse(request)
    try {
      const state = GitHubLoginStateSchema.parse(target.hostRef.kind === 'main' ? await this.local.handle(parsed)
        : await this.device(target.hostRef.deviceId, parsed))
      if (request.operation !== 'login-status') await this.commands.recordAudit(principal.id, source, action, targetKey, 'succeeded',
        { state: state.state })
      if (request.operation === 'login-status' && state.state !== 'waiting') this.options.accountChanged?.(target)
      return state
    } catch (error) {
      if (request.operation !== 'login-status') await this.commands.recordAudit(principal.id, source, action, targetKey, 'failed',
        { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
      throw error
    } finally {
      if (request.operation !== 'login-status') this.options.accountChanged?.(target)
    }
  }

  private async device(deviceId: string, request: GitHubLoginRequest) {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_GITHUB_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or its app is too old for GitHub sign-in.', 409)
    }
    return (await endpoint.request(deviceId, COMPUTER_GITHUB_NAMESPACE, request, { signal: AbortSignal.timeout(45_000) })).payload
  }
}

/** The caller still holds settings:update and the target is this Main or a currently paired installation. */
export async function assertCurrentComputer(pool: pg.Pool, mainId: string, principal: ManagementPrincipal, target: DeviceProvisioningTarget) {
  const sql = await pool.connect()
  try {
    requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update')
    await assertComputerTarget(sql, mainId, target)
  } finally { sql.release() }
}
