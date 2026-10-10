import type pg from 'pg'
import { COMPUTER_GITHUB_NAMESPACE, GitHubLoginRequestSchema, GitHubLoginStateSchema,
  type GitHubLoginRequest, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { GitHubLoginRunner } from './githubLogin.js'
import { assertComputerTarget } from './target.js'

/** Starts, follows and ends GitHub CLI sign-in on Main or a paired computer. Credentials stay on that computer. */
export class ComputerGitHubService {
  private readonly local: Pick<GitHubLoginRunner, 'handle'>
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => Pick<DeviceEndpoint, 'captureRequest'> | undefined,
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
    const parsed = GitHubLoginRequestSchema.parse(request)
    const remote = target.hostRef.kind === 'device' ? this.device(target) : undefined
    await assertCurrentComputer(this.pool, this.mainId, principal, target)
    try {
      let state: GitHubLoginState
      try {
        const result = remote ? (await remote.request(parsed, { signal: AbortSignal.timeout(45_000) })).payload
          : await this.local.handle(parsed)
        state = GitHubLoginStateSchema.parse(result)
      } catch (caught) {
        let error = caught
        if (error instanceof DeviceApplicationError && error.code === 'GITHUB_ACCOUNT_CHANGED') {
          error = new DomainError('GITHUB_ACCOUNT_CHANGED',
            'The active GitHub account changed. Read account status before requesting another sign-out.', 409)
        }
        if (request.operation !== 'login-status') {
          const confirmedFailure = error instanceof DomainError && error.code !== 'GITHUB_STATUS_UNKNOWN'
            && (!remote || error.code === 'GITHUB_ACCOUNT_CHANGED')
          await this.commands.recordAudit(principal.id, source, action, targetKey,
            confirmedFailure ? 'failed' : 'uncertain',
            { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
        }
        throw error
      }
      if (request.operation !== 'login-status') {
        await this.commands.recordAudit(principal.id, source, action, targetKey, 'succeeded', { state: state.state })
      }
      if (request.operation === 'login-status' && state.state !== 'waiting') this.options.accountChanged?.(target)
      return state
    } finally {
      if (request.operation !== 'login-status') this.options.accountChanged?.(target)
    }
  }

  private device(target: DeviceProvisioningTarget) {
    if (target.hostRef.kind !== 'device') throw new Error('A paired computer is required.')
    const remote = this.endpoint()?.captureRequest(target.hostRef.deviceId, COMPUTER_GITHUB_NAMESPACE)
    if (!remote) {
      throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or its app is too old for GitHub sign-in.', 409)
    }
    const binding = remote.binding
    const matches = sameDeviceProvisioningTarget(target, {
      hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId,
      keyRevision: binding.keyRevision,
      authorizationRevision: binding.authorizationRevision,
    })
    if (!matches) {
      throw new DomainError('COMPUTER_NOT_FOUND', 'The connected computer installation changed.', 409)
    }
    return remote
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
