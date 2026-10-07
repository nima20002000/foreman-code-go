import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { GitHubLoginStateSchema, type GitHubLoginRequest, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import { DomainError } from '../errors.js'
import { probeComputerAccounts, systemPorts, type AccountProbePorts } from './accountProbe.js'

/** GitHub device codes expire after 15 minutes; the CLI keeps polling until then. */
const LOGIN_LIFETIME_MS = 15 * 60_000
const CODE_WAIT_MS = 20_000

export interface GitHubLoginPorts {
  probe: AccountProbePorts
  spawn(binary: string, args: string[]): Pick<ChildProcess, 'stdout' | 'stderr' | 'stdin' | 'once' | 'kill'>
  now(): number
}

interface Session {
  id: string
  child: Pick<ChildProcess, 'kill'>
  state: GitHubLoginState
}

/** One GitHub CLI sign-in at a time on this computer: start returns the device code, status follows the CLI to completion. */
export class GitHubLoginRunner {
  private session: Session | undefined
  constructor(private readonly ports: GitHubLoginPorts = systemGitHubPorts()) {}

  async handle(request: GitHubLoginRequest): Promise<GitHubLoginState> {
    if (request.operation === 'login-start') return this.start()
    if (request.operation === 'logout') return this.logout()
    return this.status(request.loginId)
  }

  private async start(): Promise<GitHubLoginState> {
    const gh = await this.ports.probe.find('gh')
    if (!gh) throw new DomainError('GITHUB_CLI_MISSING', 'Install the GitHub CLI (gh) on this computer first.', 409)
    this.session?.child.kill('SIGTERM')
    const id = randomUUID()
    const child = this.ports.spawn(gh, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'])
    const expiresAt = new Date(this.ports.now() + LOGIN_LIFETIME_MS).toISOString()
    const session: Session = { id, child, state: { loginId: id, state: 'waiting', code: null, verificationUrl: null,
      expiresAt, account: null, message: null } }
    this.session = session
    const timer = setTimeout(() => {
      if (session.state.state !== 'waiting') return
      session.state = { ...session.state, state: 'expired', message: 'The one-time code expired. Start again.' }
      child.kill('SIGTERM')
    }, LOGIN_LIFETIME_MS)
    timer.unref?.()
    const shown = new Promise<void>((resolve, reject) => {
      let output = ''
      const read = (chunk: Buffer | string) => {
        output = (output + chunk.toString()).slice(-8192)
        const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/u.exec(output)?.[1]
        const url = /(https:\/\/github\.com\/login\/device)/u.exec(output)?.[1]
        if (code && !session.state.code) session.state = { ...session.state, code, verificationUrl: url ?? 'https://github.com/login/device' }
        if (session.state.code) resolve()
      }
      child.stdout?.on('data', read)
      child.stderr?.on('data', read)
      child.once('error', reject)
      child.once('exit', code => {
        clearTimeout(timer)
        if (!session.state.code) reject(new DomainError('GITHUB_LOGIN_FAILED', 'The GitHub CLI did not offer a one-time code.', 502))
        void this.finish(session, code)
      })
      setTimeout(() => reject(new DomainError('GITHUB_LOGIN_FAILED', 'The GitHub CLI did not offer a one-time code in time.', 504)),
        CODE_WAIT_MS).unref?.()
    })
    // The CLI waits for Enter before polling; there is no browser to open here.
    child.stdin?.end('\n')
    try { await shown } catch (error) { child.kill('SIGTERM'); this.session = undefined; throw error }
    return GitHubLoginStateSchema.parse(session.state)
  }

  private async finish(session: Session, code: number | null) {
    if (session.state.state !== 'waiting') return
    if (code !== 0) {
      session.state = { ...session.state, state: 'failed', message: 'GitHub sign-in did not complete.' }
      return
    }
    const gh = await this.ports.probe.find('gh')
    // Let git on this computer use the signed-in account for clone/fetch/push.
    if (gh) await this.ports.probe.run(gh, ['auth', 'setup-git', '--hostname', 'github.com'], AbortSignal.timeout(15_000))
    const account = (await probeComputerAccounts(this.ports.probe)).accounts.find(value => value.tool === 'github')
    session.state = { ...session.state, state: account?.signedIn ? 'signed-in' : 'failed', account: account?.account ?? null,
      code: null, verificationUrl: null, message: account?.signedIn ? null : 'GitHub sign-in did not complete.' }
  }

  private status(loginId: string): GitHubLoginState {
    if (this.session?.id !== loginId) throw new DomainError('GITHUB_LOGIN_NOT_FOUND', 'This sign-in is no longer active on the computer.', 404)
    return GitHubLoginStateSchema.parse(this.session.state)
  }

  private async logout(): Promise<GitHubLoginState> {
    const gh = await this.ports.probe.find('gh')
    if (!gh) throw new DomainError('GITHUB_CLI_MISSING', 'The GitHub CLI (gh) is not installed on this computer.', 409)
    this.session?.child.kill('SIGTERM')
    this.session = undefined
    const account = (await probeComputerAccounts(this.ports.probe)).accounts.find(value => value.tool === 'github')
    if (account?.account) {
      const result = await this.ports.probe.run(gh, ['auth', 'logout', '--hostname', 'github.com', '--user', account.account],
        AbortSignal.timeout(15_000))
      if (result.code !== 0) throw new DomainError('GITHUB_LOGOUT_FAILED', 'The GitHub CLI could not sign out.', 502)
    }
    return GitHubLoginStateSchema.parse({ loginId: null, state: 'signed-out', code: null, verificationUrl: null,
      expiresAt: null, account: null, message: null })
  }

  close() { this.session?.child.kill('SIGTERM'); this.session = undefined }
}

export function systemGitHubPorts(environment: NodeJS.ProcessEnv = process.env): GitHubLoginPorts {
  return {
    probe: systemPorts(environment),
    spawn: (binary, args) => spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment, BROWSER: 'false', NO_COLOR: '1' } }),
    now: Date.now,
  }
}
