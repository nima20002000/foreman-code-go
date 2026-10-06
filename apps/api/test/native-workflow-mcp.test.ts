import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { appLauncherPath, isAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { configureNativeWorkflowMcp } from './helpers/nativeWorkflowMcp.js'

const source = vi.hoisted(() => ({ name: '', token: '', command: [] as string[] }))

vi.mock('../src/modules/harnesses/codexMcpConnections.js', () => ({
  CodexMcpConnections: class {
    async read() {
      return { effective: { [source.name]: {
        command: source.command[0], args: [source.command[1]], env_vars: [source.token],
      } } }
    }
  },
}))

vi.mock('../src/modules/harnesses/openCodeMcpConnections.js', () => ({
  OpenCodeMcpConnections: class {
    async read() {
      const { isAppLauncher } = await import('../src/modules/harnesses/appMcpLauncher.js')
      const entry = { type: 'local', command: source.command, environment: { [source.token]: '' } }
      return {
        effective: { [source.name]: entry },
        user: { [source.name]: { ...entry, environment: { [source.token]: `{env:${source.token}}` } } },
        credentialReferences: isAppLauncher('opencode', entry) ? { [source.name]: source.token } : {},
      }
    }
  },
}))

const storageFixtures = [
  { name: 'graphql', token: 'GRAPHQL_MCP_TOKEN' },
  { name: 'foreman-code', token: 'FOREMAN_CODE_MCP_TOKEN' },
].flatMap(identity => ['direct', 'isolated', 'relocated'].map(storage => ({ ...identity, storage })))

it.each(storageFixtures)('keeps the $token reference in $storage native storage', async (identity) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-workflow-source-'))
  const previousHome = process.env.CODEX_HOME
  const previousLauncherDirectory = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  const previousSourceLauncher = process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
  let restore: (() => Promise<void>) | undefined
  try {
    const home = join(directory, 'source-home')
    const projectDirectory = join(directory, 'project')
    await mkdir(home, { mode: 0o700 })
    await mkdir(projectDirectory, { mode: 0o700 })
    await writeFile(join(home, 'auth.json'), JSON.stringify({ fixture: true }), { mode: 0o600 })
    process.env.CODEX_HOME = home
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'source-launcher')
    source.name = identity.name
    source.token = identity.token
    source.command = [process.execPath, appLauncherPath()]
    if (identity.storage === 'isolated') {
      process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
      process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'outer-storage-mcp')
    } else {
      delete process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
    }
    if (identity.storage === 'relocated') {
      process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'relocated-launcher')
    }
    const restoredLauncherDirectory = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY

    restore = await configureNativeWorkflowMcp({ projectDirectory,
      runtimeDirectory: join(directory, 'runtime'), codexBinary: 'recorded', openCodeBinary: 'recorded' })
    const ownedHome = process.env.CODEX_HOME!
    const configured = JSON.parse(await readFile(join(projectDirectory, 'opencode.json'), 'utf8')) as {
      mcp: Record<string, { type: string; command: string[]; environment: Record<string, string> }>
    }
    const entry = configured.mcp[identity.name]!
    // OpenCode merges environment maps from user and project configuration.
    const effective = { ...entry, environment: { [identity.token]: '', ...entry.environment } }
    expect(entry.environment).toEqual({ [identity.token]: `{env:${identity.token}}` })
    expect(isAppLauncher('opencode', effective)).toBe(true)
    expect(JSON.parse(await readFile(join(ownedHome, 'auth.json'), 'utf8'))).toEqual({ fixture: true })
    await restore()
    restore = undefined
    expect(process.env.CODEX_HOME).toBe(home)
    expect(process.env.FOREMAN_CODE_APP_MCP_DIRECTORY).toBe(restoredLauncherDirectory)
    await expect(access(ownedHome)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    try { await restore?.() }
    finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousHome
      if (previousLauncherDirectory === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
      else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previousLauncherDirectory
      if (previousSourceLauncher === undefined) delete process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
      else process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY = previousSourceLauncher
      await rm(directory, { recursive: true, force: true })
    }
  }
})
