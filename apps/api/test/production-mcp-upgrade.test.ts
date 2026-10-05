import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  APP_MCP_TOKEN, appLauncherConnection, installManagedLauncher, isAppLauncher,
} from '../src/modules/harnesses/appMcpLauncher.js'
import { upgradeProductionMcpLauncher } from '../src/modules/harnesses/productionMcpUpgrade.js'
import {
  applyMcpEdits, managedChange, managedEnableChange, managedStatus, mcpEdits, nativeConnection,
  type NativeMcpSnapshot,
} from '../src/modules/harnesses/nativeMcpCommon.js'

const directories: string[] = []
const runtime = process.execPath
const source = new URL('../../../scripts/graphql-mcp.mjs', import.meta.url)
afterEach(async () => {
  Object.defineProperty(process, 'execPath', { value: runtime })
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'production-mcp-upgrade-'))
  directories.push(home)
  const previous = join(home, '.local/state/graphql-production/mcp/launcher.mjs')
  const shared = join(home, '.local/share/graphql/mcp/launcher.mjs')
  vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(shared))
  await installManagedLauncher(source, previous)
  return { home, previous, shared }
}

it.each([
  ['codex', 'graphql', 'GRAPHQL_MCP_TOKEN'],
  ['opencode', 'graphql', 'GRAPHQL_MCP_TOKEN'],
  ['codex', 'foreman-code', APP_MCP_TOKEN],
  ['opencode', 'foreman-code', APP_MCP_TOKEN],
] as const)(
  '%s keeps existing %s credentials, disabled flags and policies through the upgrade and managed edits',
  async (harness, serverName, token) => {
    const { home, previous } = await fixture()
    const entry = {
      ...nativeConnection(harness, {
        ...appLauncherConnection(), arguments: [previous], environmentVariables: [token],
      }),
      enabled: false,
      enabled_tools: ['context_get'],
      disabled_tools: ['interaction_respond'],
      default_tools_approval_mode: 'prompt',
      tools: { context_get: { approval_mode: 'prompt' } },
    }
    const permission = { [`${serverName}_*`]: 'ask' }
    const snapshot: NativeMcpSnapshot = {
      harness, revision: 'revision', file: join(home, 'native-config'), version: '1',
      user: { [serverName]: entry }, effective: { [serverName]: entry },
      userConfig: { permission }, effectivePermissions: permission,
      credentialReferences: { [serverName]: token },
    }
    expect(isAppLauncher(harness, entry)).toBe(false)
    await upgradeProductionMcpLauncher(home)
    expect(isAppLauncher(harness, entry)).toBe(true)
    expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
    const managed = { preset: 'graphql' as const, endpoint: 'http://127.0.0.1:3041/mcp' }
    const enabled = applyMcpEdits(snapshot.user, mcpEdits(snapshot, managedEnableChange('graphql', true), managed))
    expect(enabled).toEqual({ [serverName]: { ...entry, enabled: true } })
    expect(applyMcpEdits(snapshot.user, mcpEdits(snapshot, managedChange('graphql', false, managed.endpoint), managed)))
      .toEqual({})
    const inherited = { ...snapshot, ownership: { [serverName]: false } }
    expect(managedStatus(inherited, 'graphql')).toBe('inherited')
    expect(() => mcpEdits(inherited, managedChange('graphql', false, managed.endpoint), managed)).toThrow('matching')
    await upgradeProductionMcpLauncher(home)
    expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
  },
)

it('retains both installed runtimes and its alias when the shared launcher is reinstalled', async () => {
  const { home, previous, shared } = await fixture()
  const installedRuntime = join(home, 'installed-node')
  await writeFile(installedRuntime, 'installed runtime')
  Object.defineProperty(process, 'execPath', { value: installedRuntime })
  await installManagedLauncher(source, previous)
  Object.defineProperty(process, 'execPath', { value: runtime })
  await installManagedLauncher(source, shared)
  await upgradeProductionMcpLauncher(home)
  const entry = { command: installedRuntime, args: [previous], env_vars: [APP_MCP_TOKEN] }
  expect(isAppLauncher('codex', entry)).toBe(true)
  await installManagedLauncher(source, shared)
  expect(isAppLauncher('codex', entry)).toBe(true)
  expect(isAppLauncher('codex', { ...entry, command: runtime })).toBe(true)
  await rm(installedRuntime)
  expect(isAppLauncher('codex', entry)).toBe(false)
})

it('resumes an upgrade interrupted after moving the original directory', async () => {
  const { home, previous } = await fixture()
  await rename(dirname(previous), `${dirname(previous)}.previous`)
  await upgradeProductionMcpLauncher(home)
  expect(isAppLauncher('codex', { command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] })).toBe(true)
  await upgradeProductionMcpLauncher(home)
  expect(isAppLauncher('codex', { command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] })).toBe(true)
})

it('requires a registered directory alias and retains command and authentication validation', async () => {
  const { home, previous, shared } = await fixture()
  await installManagedLauncher(source, shared)
  const unregistered = join(home, 'unregistered')
  await symlink(dirname(shared), unregistered)
  const entry = { command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] }
  expect(isAppLauncher('codex', { ...entry, args: [join(unregistered, 'launcher.mjs')] })).toBe(false)
  await upgradeProductionMcpLauncher(home)
  expect(isAppLauncher('codex', { ...entry, args: [previous, '--custom'] })).toBe(false)
  const customRuntime = join(home, 'custom-node')
  await writeFile(customRuntime, 'custom runtime')
  expect(isAppLauncher('codex', { ...entry, command: customRuntime })).toBe(false)
  expect(isAppLauncher('codex', { ...entry, env: { CUSTOM: 'value' } })).toBe(false)
  expect(isAppLauncher('codex', { ...entry, bearer_token_env_var: 'CUSTOM' })).toBe(false)
  await rm(dirname(previous))
  const custom = join(home, 'custom')
  await mkdir(custom)
  await symlink(shared, join(custom, 'launcher.mjs'))
  await symlink(custom, dirname(previous))
  expect(isAppLauncher('codex', entry)).toBe(false)
  await expect(upgradeProductionMcpLauncher(home)).rejects.toThrow('unmanaged installation')
})

it('does not adopt a production directory without a managed installation record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'production-mcp-custom-'))
  directories.push(home)
  const launcher = join(home, '.local/state/graphql-production/mcp/launcher.mjs')
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, '// custom launcher')
  await expect(upgradeProductionMcpLauncher(home)).rejects.toThrow('valid managed installation record')
})
