import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HarnessMcpConnection } from '@graphql/contracts/management'

export const OPERATOR_TOKEN = 'GRAPHQL_OPERATOR_MCP_TOKEN'
export const operatorLauncherPath = () => join(homedir(), '.local', 'share', 'graphql', 'operator-mcp', 'launcher.mjs')
export function operatorLauncherConnection(): Extract<HarnessMcpConnection, { transport: 'stdio' }> {
  return { transport: 'stdio', executable: process.execPath, arguments: [operatorLauncherPath()], environmentVariables: [OPERATOR_TOKEN] }
}
interface LauncherInstallation { version: 1; executables: { path: string; realpath: string }[] }
function installationPath(launcher: string): string { return `${launcher}.installation.json` }
function readInstallation(launcher: string): LauncherInstallation | undefined {
  try {
    const value = JSON.parse(readFileSync(installationPath(launcher), 'utf8')) as LauncherInstallation
    if (value.version === 1 && Array.isArray(value.executables)
      && value.executables.every((entry) => typeof entry?.path === 'string' && typeof entry.realpath === 'string')) return value
  } catch { /* Legacy installations have no installation record. */ }
  return undefined
}
/** Only exact installed commands or the current runtime can identify an app launcher.
 * Legacy entries can match the current runtime (including canonical aliases); an
 * unrecorded different runtime needs explicit native removal and managed reinstall.
 * Native configuration ownership and credential-reference proof remain the caller's responsibility.
 */
export function isManagedLauncherCommand(command: unknown, launcher: string): boolean {
  if (!Array.isArray(command) || command.length !== 2 || command[1] !== launcher || typeof command[0] !== 'string') return false
  if (command[0] === process.execPath) return true
  try {
    const executable = realpathSync(command[0])
    if (executable === realpathSync(process.execPath)) return true
    return readInstallation(launcher)?.executables.some((entry) => entry.path === command[0] && entry.realpath === executable) ?? false
  } catch { return false }
}
export function isOperatorLauncher(harness: 'codex' | 'opencode', entry: Record<string, unknown>): boolean {
  const command = harness === 'codex' ? [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])] : entry.command
  if (!isManagedLauncherCommand(command, operatorLauncherPath())) return false
  if (entry.url != null || entry.bearer_token_env_var != null || entry.oauth != null
    || (entry.headers != null && Object.keys(entry.headers as object).length > 0)
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
  await installManagedLauncher(new URL('../../../../../scripts/operator-mcp.mjs', import.meta.url), operatorLauncherPath())
}
export async function installManagedLauncher(sourceUrl: URL, destination: string): Promise<void> {
  const source = await readFile(sourceUrl, 'utf8')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try { await writeFile(temporary, source, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination) }
  finally { await rm(temporary, { force: true }) }
  const executables = (readInstallation(destination)?.executables ?? []).filter((entry) => entry.path !== process.execPath)
  executables.push({ path: process.execPath, realpath: realpathSync(process.execPath) })
  const metadata = installationPath(destination)
  const pending = `${metadata}.${randomUUID()}.tmp`
  try {
    await writeFile(pending, JSON.stringify({ version: 1, executables } satisfies LauncherInstallation), { mode: 0o600, flag: 'wx' })
    await rename(pending, metadata)
  } finally { await rm(pending, { force: true }) }
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
