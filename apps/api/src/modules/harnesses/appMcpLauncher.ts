import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { HarnessMcpConnection } from '@foreman-code/contracts/management'
import { APP_MCP_SERVER_NAMES, APP_MCP_TOKEN_NAMES, PRODUCT_SLUG } from '@foreman-code/contracts/product'

/** One native entry serves every role; the credential decides Operator, Orchestrator or Coder. */
export const APP_MCP_SERVER_NAME = PRODUCT_SLUG
export const APP_MCP_TOKEN = 'FOREMAN_CODE_MCP_TOKEN'
export const isSupportedAppMcpServerName = (name: string): name is (typeof APP_MCP_SERVER_NAMES)[number] =>
  APP_MCP_SERVER_NAMES.some((supported) => supported === name)
export const isSupportedAppMcpTokenName = (name: string | undefined): name is (typeof APP_MCP_TOKEN_NAMES)[number] =>
  name !== undefined && APP_MCP_TOKEN_NAMES.some((supported) => supported === name)
export function appMcpServerName(entries: Readonly<Record<string, unknown>>, requested: string = APP_MCP_SERVER_NAME): string {
  if (!isSupportedAppMcpServerName(requested)) return requested
  const configured = APP_MCP_SERVER_NAMES.filter((name) => Object.hasOwn(entries, name))
  if (configured.length > 1) throw new Error('Both foreman-code and graphql MCP entries are configured. Resolve the naming collision at the native source.')
  return configured[0] ?? requested
}
export function appLauncherTokenName(harness: 'codex' | 'opencode', entry: Record<string, unknown>): string | undefined {
  const names = harness === 'codex' ? entry.env_vars : Object.keys((entry.environment as object | undefined) ?? {})
  if (!Array.isArray(names) || names.length !== 1 || !isSupportedAppMcpTokenName(names[0])) return undefined
  return names[0] as string
}
export const APP_MCP_PATH = '/mcp'
/** Pre-unification entries. Recognized only so they can be reported and removed. */
export const LEGACY_APP_MCP_SERVER_NAMES = ['graphql-app', 'graphql-operator'] as const
export const chatExcludedAppMcpServerNames = (serverName: string): readonly string[] =>
  [...new Set([serverName, ...APP_MCP_SERVER_NAMES, ...LEGACY_APP_MCP_SERVER_NAMES])]
export function appLauncherPath(): string {
  const configured = readProductEnvironment(process.env, 'APP_MCP_DIRECTORY')
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error('FOREMAN_CODE_APP_MCP_DIRECTORY requires an absolute directory.')
  }
  return join(configured ?? join(homedir(), '.local', 'share', 'graphql', 'mcp'), 'launcher.mjs')
}
export function appLauncherConnection(): Extract<HarnessMcpConnection, { transport: 'stdio' }> {
  return { transport: 'stdio', executable: process.execPath, arguments: [appLauncherPath()], environmentVariables: [APP_MCP_TOKEN] }
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
export function isAppLauncher(harness: 'codex' | 'opencode', entry: Record<string, unknown>): boolean {
  const command = harness === 'codex' ? [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])] : entry.command
  if (!isManagedLauncherCommand(command, appLauncherPath())) return false
  if (entry.url != null || entry.bearer_token_env_var != null || entry.oauth != null
    || (entry.headers != null && Object.keys(entry.headers as object).length > 0)
    || (entry.http_headers != null && Object.keys(entry.http_headers as object).length > 0)
    || (entry.env_http_headers != null && Object.keys(entry.env_http_headers as object).length > 0)) return false
  const tokenName = appLauncherTokenName(harness, entry)
  if (harness === 'codex') return (!entry.env || Object.keys(entry.env as object).length === 0)
    && tokenName !== undefined
  const environment = entry.environment as Record<string, unknown> | undefined
  // OpenCode expands the reference in effective configuration. Proven separately by its inspector.
  return entry.type === 'local' && !!environment && Object.keys(environment).length === 1
    && tokenName !== undefined && typeof environment[tokenName] === 'string'
}
export async function installAppLauncher(): Promise<void> {
  await installManagedLauncher(new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url), appLauncherPath())
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
export async function registerAppRoute(token: string, endpoint: string, expiresAt: string, launcher = appLauncherPath()): Promise<() => Promise<void>> {
  return registerAppRouteDigest(createHash('sha256').update(token).digest('hex'), endpoint, expiresAt, launcher)
}
export async function registerAppRouteDigest(digest: string, endpoint: string, expiresAt: string, launcher = appLauncherPath()): Promise<() => Promise<void>> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid Foreman Code MCP route identity.')
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
