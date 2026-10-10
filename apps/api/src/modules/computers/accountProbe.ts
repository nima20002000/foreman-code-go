import { z } from 'zod'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ComputerAccountsSchema, type ComputerAccount, type ComputerAccounts } from '@foreman-code/contracts/computer-accounts'

export interface AccountProbePorts {
  /** Absolute executable path, or null when the tool is not installed. */
  find(name: string): Promise<string | null>
  run(binary: string, args: string[], signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }>
  readText(path: string): Promise<string | null>
  environment: NodeJS.ProcessEnv
}

const ansi = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')
const plain = (value: string) => value.replace(ansi, '')

/** Passive sign-in facts for this computer. Reads identity only; tokens never leave the probe. */
export async function probeComputerAccounts(ports: AccountProbePorts = systemPorts(), signal = AbortSignal.timeout(20_000)): Promise<ComputerAccounts> {
  const accounts = await Promise.all([codex(ports), claude(ports, signal), probeGitHubAccount(ports, signal)]
    .map(probe => probe.catch((): null => null)))
  const tools = ['codex', 'claude', 'github'] as const
  return ComputerAccountsSchema.parse({ observedAt: new Date().toISOString(),
    accounts: accounts.map((value, index) => value ?? unknown(tools[index]!)) })
}

const unknown = (tool: ComputerAccount['tool']): ComputerAccount => ({ tool, installed: true, signedIn: null, account: null, details: [] })
const missing = (tool: ComputerAccount['tool']): ComputerAccount => ({ tool, installed: false, signedIn: null, account: null, details: [] })

async function codex(ports: AccountProbePorts): Promise<ComputerAccount> {
  if (!await ports.find('codex')) return missing('codex')
  const home = ports.environment.CODEX_HOME ?? join(ports.environment.HOME ?? homedir(), '.codex')
  const text = await ports.readText(join(home, 'auth.json'))
  // Codex can store credentials in the keyring without an auth.json file.
  if (text === null) return unknown('codex')
  const auth = JSON.parse(text) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown } | null }
  const email = typeof auth.tokens?.id_token === 'string' ? jwtEmail(auth.tokens.id_token) : null
  const apiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0
  return { tool: 'codex', installed: true, signedIn: Boolean(email || auth.tokens || apiKey), account: email,
    details: [apiKey && !auth.tokens ? 'API key' : auth.tokens ? 'ChatGPT' : null].filter((value): value is string => Boolean(value)) }
}

function jwtEmail(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
  return typeof claims.email === 'string' ? claims.email.slice(0, 320) : null
}

async function claude(ports: AccountProbePorts, signal: AbortSignal): Promise<ComputerAccount> {
  const binary = await ports.find('claude')
  if (!binary) return missing('claude')
  const result = await ports.run(binary, ['auth', 'status'], signal)
  // An install whose executable cannot start (for example a missing loader) says nothing at all.
  if (result.code === null && !result.stdout && !result.stderr) {
    return { tool: 'claude', installed: true, signedIn: null, account: null, details: ['cannot start'] }
  }
  let status: { loggedIn?: unknown; email?: unknown; authMethod?: unknown }
  try { status = JSON.parse(result.stdout) as typeof status } catch {
    // Signed-out releases print a login prompt instead of JSON.
    if (result.code !== 0 && /\/login|not logged in|invalid api key/iu.test(`${result.stdout}\n${result.stderr}`)) {
      return { tool: 'claude', installed: true, signedIn: false, account: null, details: [] }
    }
    throw new Error('Unreadable Claude sign-in status.')
  }
  return { tool: 'claude', installed: true, signedIn: status.loggedIn === true,
    account: typeof status.email === 'string' ? status.email.slice(0, 320) : null,
    details: typeof status.authMethod === 'string' ? [status.authMethod.slice(0, 200)] : [] }
}

const githubStatusSchema = z.object({
  hosts: z.record(z.string(), z.array(z.object({
    active: z.boolean(), login: z.string().min(1).max(320), state: z.enum(['success', 'error', 'timeout']),
  }))),
})
const githubSignedOut = /You are not logged into (?:any GitHub hosts|any accounts on github\.com)/iu

export async function probeGitHubAccount(ports: AccountProbePorts, signal = AbortSignal.timeout(20_000)): Promise<ComputerAccount> {
  const binary = await ports.find('gh')
  if (!binary) return missing('github')
  const args = ['auth', 'status', '--active', '--hostname', 'github.com']
  let result = await ports.run(binary, [...args, '--json', 'hosts'], signal)
  const unsupported = (flag: string) => new RegExp(`unknown flag: --${flag}\\b`, 'u').test(result.stderr)
  if (!unsupported('json') && !unsupported('active')) {
    const parsed = githubStatusSchema.safeParse(parseJson(result.stdout))
    if (result.code === 0 && parsed.success) {
      const entries = parsed.data.hosts['github.com'] ?? []
      if (!entries.length) return { ...unknown('github'), signedIn: false }
      const active = entries.filter(entry => entry.active)
      if (active.length !== 1) return unknown('github')
      return { ...unknown('github'), signedIn: active[0]!.state === 'success' ? true : null, account: active[0]!.login }
    }
    if (result.code === 1 && githubSignedOut.test(result.stderr)) {
      return { ...unknown('github'), signedIn: false }
    }
    return unknown('github')
  }
  result = await ports.run(binary, args, signal)
  if (unsupported('active')) result = await ports.run(binary, ['auth', 'status', '--hostname', 'github.com'], signal)
  const output = plain(`${result.stdout}\n${result.stderr}`)
  if (result.code === 1 && githubSignedOut.test(output)) {
    return { ...unknown('github'), signedIn: false }
  }
  const accounts = [...output.matchAll(/Logged in to github\.com account (\S+)([\s\S]*?)(?=Logged in to github\.com account|$)/gu)]
  const active = accounts.filter(match => /Active account:\s*true/u.test(match[2]!))
  let user = active.length === 1 ? active[0]?.[1] : undefined
  if (active.length === 0 && accounts.length === 1 && !/Active account:\s*false/u.test(output)) user = accounts[0]?.[1]
  if (result.code !== 0 || !user) return unknown('github')
  return { ...unknown('github'), signedIn: true, account: user }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return null }
}

/** `binaries` holds installer-selected executables (for example a Worker's configured Codex) checked before PATH. */
export function systemPorts(environment: NodeJS.ProcessEnv = process.env,
  binaries: Readonly<Partial<Record<string, string>>> = {}): AccountProbePorts {
  const home = environment.HOME ?? homedir()
  const directories = [...(environment.PATH ?? '').split(delimiter), join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((value, index, all) => value.startsWith('/') && all.indexOf(value) === index)
  return {
    environment,
    async find(name) {
      const selected = binaries[name]
      if (selected) {
        try { await access(selected, constants.X_OK); return selected } catch { /* fall back to PATH */ }
      }
      for (const directory of directories) {
        const candidate = join(directory, name)
        try { await access(candidate, constants.X_OK); return candidate } catch { continue }
      }
      return null
    },
    run: (binary, args, signal) => new Promise(resolve => {
      execFile(binary, args, { signal, timeout: 15_000, maxBuffer: 256 * 1024, encoding: 'utf8',
        env: { ...environment, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0
        resolve({ code, stdout, stderr })
      })
    }),
    readText: path => readFile(path, 'utf8').catch(() => null),
  }
}
