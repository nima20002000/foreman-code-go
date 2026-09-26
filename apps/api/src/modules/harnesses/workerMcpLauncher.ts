import { isManagedLauncherCommand, installManagedLauncher } from './operatorMcpLauncher.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HarnessMcpConnection } from '@graphql/contracts/management'

export const WORKER_TOKEN = 'GRAPHQL_APP_MCP_TOKEN'
export const workerLauncherPath = () => join(homedir(), '.local', 'share', 'graphql', 'worker-mcp', 'launcher.mjs')
export function workerLauncherConnection(): Extract<HarnessMcpConnection, { transport: 'stdio' }> {
  return { transport: 'stdio', executable: process.execPath, arguments: [workerLauncherPath()], environmentVariables: [WORKER_TOKEN] }
}
export function isWorkerLauncher(harness: 'codex' | 'opencode', entry: Record<string, unknown>): boolean {
  const command = harness === 'codex' ? [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])] : entry.command
  if (!isManagedLauncherCommand(command, workerLauncherPath())) return false
  if (entry.url != null || entry.bearer_token_env_var != null
    || (entry.http_headers != null && Object.keys(entry.http_headers as object).length > 0)
    || (entry.env_http_headers != null && Object.keys(entry.env_http_headers as object).length > 0)) return false
  if (harness === 'codex') return (!entry.env || Object.keys(entry.env as object).length === 0)
    && JSON.stringify(entry.env_vars) === JSON.stringify([WORKER_TOKEN])
  const environment = entry.environment as Record<string, unknown> | undefined
  // OpenCode expands the reference in effective configuration. Proven separately by its inspector.
  return entry.type === 'local' && !!environment && Object.keys(environment).length === 1
    && typeof environment[WORKER_TOKEN] === 'string'
}
export async function installWorkerLauncher(): Promise<void> {
  await installManagedLauncher(new URL('../../../../../scripts/worker-mcp.mjs', import.meta.url), workerLauncherPath())
}
export async function registerWorkerRoute(token: string, endpoint: string, expiresAt: string, launcher = workerLauncherPath()): Promise<() => Promise<void>> {
  return registerWorkerRouteDigest(createHash('sha256').update(token).digest('hex'), endpoint, expiresAt, launcher)
}
export async function registerWorkerRouteDigest(digest: string, endpoint: string, expiresAt: string, launcher = workerLauncherPath()): Promise<() => Promise<void>> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid Worker route identity.')
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
