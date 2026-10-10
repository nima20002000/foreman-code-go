import { spawn, type ChildProcess } from 'node:child_process'
import type { AccountProvider, ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import { DomainError } from '../errors.js'
import { providerAccountEnvironment } from './environment.js'

export interface ProviderAccountNativeInput {
  account: ProviderAccount
  homePath: string
  userHome: string
}
export interface AccountLoginState {
  status: ProviderAccount['status']
  identity: string | null
}
export interface ProviderAccountNativePort {
  status(input: ProviderAccountNativeInput): Promise<AccountLoginState>
  login(input: ProviderAccountNativeInput): Promise<void>
  cancelLogin(accountId: string): Promise<void>
  logout(input: ProviderAccountNativeInput): Promise<void>
  close(): Promise<void>
}
export interface AccountCommandInvocation {
  binary: string
  args: string[]
  environment: NodeJS.ProcessEnv
  workingDirectory: string
  timeoutMs: number
}
export interface AccountCommandProcess {
  completion: Promise<{ code: number | null; stdout: string }>
  stop(): Promise<void>
}
export type AccountCommandLauncher = (input: AccountCommandInvocation) => AccountCommandProcess

export const launchAccountCommand: AccountCommandLauncher = input => {
  const child: ChildProcess = spawn(input.binary, input.args, {
    cwd: input.workingDirectory, env: input.environment, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const capture = (bytes: Buffer) => {
    if (output.length < 32_768) output += bytes.toString().slice(0, 32_768 - output.length)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs)
  const completion = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    child.once('error', () => {
      clearTimeout(timer)
      reject(new DomainError('PROVIDER_COMMAND_UNAVAILABLE', 'The provider login command could not start.', 409))
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout: output })
    })
  })
  return { completion, async stop() { child.kill('SIGKILL'); await completion } }
}

function safeIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null
  return value
}

/** Provider output is inspected here and only its whitelisted status fields escape. */
export class NativeProviderAccountCommands implements ProviderAccountNativePort {
  private readonly logins = new Map<string, AccountCommandProcess>()
  private readonly failures = new Set<string>()

  constructor(
    private readonly binaries: Record<AccountProvider, string | (() => string)>,
    private readonly launcher: AccountCommandLauncher = launchAccountCommand,
  ) {}

  private command(input: ProviderAccountNativeInput, action: 'login' | 'logout' | 'status') {
    const provider = input.account.provider
    const binary = this.binaries[provider]
    let args: string[]
    if (provider === 'codex') {
      args = ['-c', 'cli_auth_credentials_store="file"', action === 'status' ? 'login' : action]
      if (action === 'status') args.push('status')
    } else {
      if (process.platform !== 'linux') {
        throw new DomainError('PROVIDER_LOGIN_PLATFORM_UNSUPPORTED', 'Managed Claude subscription sign-in requires Linux.', 409)
      }
      args = ['auth', action]
      if (action === 'status') args.push('--json')
    }
    return this.launcher({ binary: typeof binary === 'string' ? binary : binary(), args,
      environment: providerAccountEnvironment(provider, input.homePath, input.userHome),
      workingDirectory: input.userHome, timeoutMs: action === 'login' ? 600_000 : 15_000 })
  }

  async status(input: ProviderAccountNativeInput): Promise<AccountLoginState> {
    if (this.logins.has(input.account.id)) return { status: 'login-pending', identity: null }
    if (this.failures.has(input.account.id)) return { status: 'unavailable', identity: null }
    const result = await this.command(input, 'status').completion
    if (input.account.provider === 'codex') {
      const signedIn = result.code === 0 && /logged in using chatgpt/i.test(result.stdout)
      return { status: signedIn ? 'signed-in' : 'signed-out', identity: null }
    }
    let data: unknown
    try { data = JSON.parse(result.stdout) } catch {
      return { status: 'unavailable', identity: null }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'unavailable', identity: null }
    const observation = data as { loggedIn?: unknown; email?: unknown; authMethod?: unknown }
    const signedIn = result.code === 0 && observation.loggedIn === true
      && observation.authMethod !== 'api_key' && observation.authMethod !== 'api-key'
    return { status: signedIn ? 'signed-in' : 'signed-out', identity: safeIdentity(observation.email) }
  }

  async login(input: ProviderAccountNativeInput): Promise<void> {
    if (this.logins.has(input.account.id)) {
      throw new DomainError('PROVIDER_LOGIN_PENDING', 'This account already has a sign-in in progress.', 409)
    }
    const process = this.command(input, 'login')
    this.failures.delete(input.account.id)
    this.logins.set(input.account.id, process)
    void process.completion.then(result => {
      if (result.code !== 0) this.failures.add(input.account.id)
    }, () => this.failures.add(input.account.id)).finally(() => {
      if (this.logins.get(input.account.id) === process) this.logins.delete(input.account.id)
    })
  }

  async cancelLogin(accountId: string): Promise<void> {
    const process = this.logins.get(accountId)
    if (process) await process.stop()
    this.logins.delete(accountId)
    this.failures.delete(accountId)
  }

  async logout(input: ProviderAccountNativeInput): Promise<void> {
    await this.cancelLogin(input.account.id)
    const result = await this.command(input, 'logout').completion
    if (result.code !== 0) throw new DomainError('PROVIDER_LOGOUT_FAILED', 'The provider could not sign this account out.', 409)
  }

  async close(): Promise<void> {
    for (const accountId of this.logins.keys()) await this.cancelLogin(accountId)
  }
}
