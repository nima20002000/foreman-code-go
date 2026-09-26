import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HarnessMcpConnection } from '@graphql/contracts/management'

export const OPERATOR_TOKEN = 'GRAPHQL_OPERATOR_MCP_TOKEN'
export const operatorLauncherPath = () => join(homedir(), '.local', 'share', 'graphql', 'operator-mcp', 'launcher.mjs')
export function operatorLauncherConnection(): Extract<HarnessMcpConnection, { transport: 'stdio' }> {
  return { transport: 'stdio', executable: process.execPath, arguments: [operatorLauncherPath()], environmentVariables: [OPERATOR_TOKEN] }
}
export function isOperatorLauncher(harness: 'codex' | 'opencode', entry: Record<string, unknown>): boolean {
  const command = harness === 'codex' ? [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])] : entry.command
  if (JSON.stringify(command) !== JSON.stringify([process.execPath, operatorLauncherPath()])) return false
  if (entry.url != null || entry.bearer_token_env_var != null
    || (entry.http_headers != null && Object.keys(entry.http_headers as object).length > 0)
    || (entry.env_http_headers != null && Object.keys(entry.env_http_headers as object).length > 0)) return false
  if (harness === 'codex') return (!entry.env || Object.keys(entry.env as object).length === 0)
    && JSON.stringify(entry.env_vars) === JSON.stringify([OPERATOR_TOKEN])
  const environment = entry.environment as Record<string, unknown> | undefined
  // OpenCode expands the reference in effective configuration. Proven separately by its inspector.
  return entry.type === 'local' && !!environment && Object.keys(environment).length === 1
    && typeof environment[OPERATOR_TOKEN] === 'string'
}
export async function installOperatorLauncher(): Promise<void> {
  const destination = operatorLauncherPath()
  const source = await readFile(new URL('../../../../../scripts/operator-mcp.mjs', import.meta.url), 'utf8')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try { await writeFile(temporary, source, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination) }
  finally { await rm(temporary, { force: true }) }
}
export async function registerOperatorRoute(token: string, endpoint: string, expiresAt: string, launcher = operatorLauncherPath()): Promise<() => Promise<void>> {
  return registerOperatorRouteDigest(createHash('sha256').update(token).digest('hex'), endpoint, expiresAt, launcher)
}
export async function registerOperatorRouteDigest(digest: string, endpoint: string, expiresAt: string, launcher = operatorLauncherPath()): Promise<() => Promise<void>> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid Operator route identity.')
  const directory = join(dirname(launcher), 'routes')
  const file = join(directory, `${digest}.json`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ endpoint, expiresAt, pid: process.pid }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
  return () => rm(file, { force: true })
}
