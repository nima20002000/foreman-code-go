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
  const accounts = await Promise.all([codex(ports), claude(ports, signal), opencode(ports, signal), github(ports, signal), drive(ports, signal)]
    .map(probe => probe.catch((): null => null)))
  const tools = ['codex', 'claude', 'opencode', 'github', 'drive'] as const
  return ComputerAccountsSchema.parse({ observedAt: new Date().toISOString(),
    accounts: accounts.map((value, index) => value ?? unknown(tools[index]!)) })
}

const unknown = (tool: ComputerAccount['tool']): ComputerAccount => ({ tool, installed: true, signedIn: null, account: null, details: [] })
const missing = (tool: ComputerAccount['tool']): ComputerAccount => ({ tool, installed: false, signedIn: null, account: null, details: [] })

async function codex(ports: AccountProbePorts): Promise<ComputerAccount> {
  if (!await ports.find('codex')) return missing('codex')
  const home = ports.environment.CODEX_HOME ?? join(ports.environment.HOME ?? homedir(), '.codex')
  const text = await ports.readText(join(home, 'auth.json'))
  if (text === null) return { tool: 'codex', installed: true, signedIn: false, account: null, details: [] }
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
  const status = JSON.parse(result.stdout) as { loggedIn?: unknown; email?: unknown; authMethod?: unknown }
  return { tool: 'claude', installed: true, signedIn: status.loggedIn === true,
    account: typeof status.email === 'string' ? status.email.slice(0, 320) : null,
    details: typeof status.authMethod === 'string' ? [status.authMethod.slice(0, 200)] : [] }
}

async function opencode(ports: AccountProbePorts, signal: AbortSignal): Promise<ComputerAccount> {
  const binary = await ports.find('opencode')
  if (!binary) return missing('opencode')
  const result = await ports.run(binary, ['auth', 'list'], signal)
  // Lines look like "●  OpenCode Go api"; only provider names are kept.
  const providers = plain(result.stdout).split('\n').map(line => /^[●•]\s+(.+?)\s+(?:api|oauth|wellknown)\s*$/u.exec(line.trim())?.[1])
    .filter((name): name is string => Boolean(name)).slice(0, 16)
  return { tool: 'opencode', installed: true, signedIn: providers.length > 0, account: null, details: providers }
}

async function github(ports: AccountProbePorts, signal: AbortSignal): Promise<ComputerAccount> {
  const binary = await ports.find('gh')
  if (!binary) return missing('github')
  const result = await ports.run(binary, ['auth', 'status', '--hostname', 'github.com'], signal)
  const output = plain(`${result.stdout}\n${result.stderr}`)
  const user = /Logged in to github\.com account (\S+)/u.exec(output)?.[1] ?? null
  return { tool: 'github', installed: true, signedIn: user !== null, account: user, details: [] }
}

async function drive(ports: AccountProbePorts, signal: AbortSignal): Promise<ComputerAccount> {
  const binary = await ports.find('rclone')
  if (!binary) return missing('drive')
  const remotes = plain((await ports.run(binary, ['listremotes', '--long'], signal)).stdout).split('\n')
    .map(line => /^(\S+):\s+drive\s*$/u.exec(line.trim())?.[1]).filter((name): name is string => Boolean(name))
  if (!remotes.length) return { tool: 'drive', installed: true, signedIn: false, account: null, details: [] }
  const info = await ports.run(binary, ['config', 'userinfo', `${remotes[0]}:`, '--json'], signal)
  let email: string | null = null
  try { const parsed = JSON.parse(info.stdout) as { Email?: unknown }; if (typeof parsed.Email === 'string') email = parsed.Email.slice(0, 320) }
  catch { email = null }
  return { tool: 'drive', installed: true, signedIn: info.code === 0 ? true : null, account: email, details: [`${remotes[0]}:`] }
}

export function systemPorts(environment: NodeJS.ProcessEnv = process.env): AccountProbePorts {
  const home = environment.HOME ?? homedir()
  const directories = [...(environment.PATH ?? '').split(delimiter), join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((value, index, all) => value.startsWith('/') && all.indexOf(value) === index)
  return {
    environment,
    async find(name) {
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
