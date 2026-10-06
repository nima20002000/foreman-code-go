import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APP_MCP_TOKEN, appLauncherPath, appLauncherTokenName, appMcpServerName, installAppLauncher,
  isSupportedAppMcpTokenName,
} from '../../src/modules/harnesses/appMcpLauncher.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { OpenCodeMcpConnections } from '../../src/modules/harnesses/openCodeMcpConnections.js'
import { record } from '../../src/modules/harnesses/nativeMcpCommon.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { ownedTestDatabaseUrl, ownedTestPath, removeFixtureDirectory } from './testResources.js'
import { referenceTestAuthenticationFile } from '../../../../scripts/test-resources.mjs'

/** Use fixture-owned CLI configuration and routes while retaining the provider login. */
export async function configureNativeWorkflowMcp(input: {
  projectDirectory: string
  runtimeDirectory: string
  codexBinary: string
  openCodeBinary?: string
}): Promise<() => Promise<void>> {
  ownedTestDatabaseUrl()
  ownedTestPath(input.projectDirectory)
  ownedTestPath(input.runtimeDirectory)
  const authentication = process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE
  if (!authentication) throw new Error('Native workflow fixtures require explicit test Codex authentication')
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const previous = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  const previousCodexHome = process.env.CODEX_HOME
  const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
  const previousOpenCodeConfigDirectory = process.env.OPENCODE_CONFIG_DIR
  const previousConfigHome = process.env.XDG_CONFIG_HOME
  // Codex's release build refuses helper aliases beneath TMPDIR.
  const codexHomeDirectory = await privateFixtureDirectory('native-cli-codex-')
  let openCodeConfigHome: string | undefined
  const restore = async () => {
    if (previous === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
    else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previous
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = previousOpenCodeConfig
    if (previousOpenCodeConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDirectory
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    await removeFixtureDirectory(codexHomeDirectory)
    if (openCodeConfigHome) await removeFixtureDirectory(openCodeConfigHome)
  }
  try {
    // Inspect copied configuration against its original managed-launcher location.
    const sourceLauncher = process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
    if (sourceLauncher !== undefined) process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = sourceLauncher
    const codex = await new CodexMcpConnections(input.codexBinary, input.projectDirectory)
      .read(AbortSignal.timeout(30_000))
    const codexName = appMcpServerName(codex.effective)
    const entry = record(codex.effective[codexName])
    const reference = appLauncherTokenName('codex', entry) ?? entry.bearer_token_env_var
    const codexToken = typeof reference === 'string' && isSupportedAppMcpTokenName(reference)
      ? reference : APP_MCP_TOKEN
    const openCode = input.openCodeBinary
      ? await new OpenCodeMcpConnections(input.openCodeBinary, input.projectDirectory)
        .read(AbortSignal.timeout(30_000))
      : undefined
    // Reuse only the selected provider login; unrelated native configuration stays outside the fixture.
    referenceTestAuthenticationFile(invocation, authentication, join(codexHomeDirectory, 'auth.json'))
    process.env.CODEX_HOME = codexHomeDirectory
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = ownedTestPath(join(input.runtimeDirectory, 'mcp'))
    await installAppLauncher()
    await writeFile(join(codexHomeDirectory, 'config.toml'), [
      `[mcp_servers.${codexName}]`,
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(appLauncherPath())}]`,
      `env_vars = [${JSON.stringify(codexToken)}]`,
      '',
    ].join('\n'), { mode: 0o600 })
    if (openCode) {
      const name = appMcpServerName(openCode.effective)
      // Disposable storage can change launcher identity before this inspection.
      // Keep the user entry's supported key when constructing the fixture entry;
      // the resulting connection still requires native credential preflight.
      const token = openCode.credentialReferences?.[name]
        ?? appLauncherTokenName('opencode', record(openCode.user[name])) ?? APP_MCP_TOKEN
      openCodeConfigHome = await privateFixtureDirectory('native-cli-opencode-')
      const configurationDirectory = join(openCodeConfigHome, 'opencode')
      await mkdir(configurationDirectory, { mode: 0o700 })
      const configurationFile = join(configurationDirectory, 'opencode.json')
      await writeFile(configurationFile, JSON.stringify({ mcp: { [name]: {
        type: 'local', command: [process.execPath, appLauncherPath()], enabled: true,
        environment: { [token]: `{env:${token}}` },
      } } }), { mode: 0o600 })
      // The native settings manager owns the user entry; every loader selects that same file.
      process.env.XDG_CONFIG_HOME = openCodeConfigHome
      process.env.OPENCODE_CONFIG = configurationFile
      process.env.OPENCODE_CONFIG_DIR = configurationDirectory
    }
    return restore
  } catch (error) {
    try { await restore() }
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native fixture configuration and cleanup failed.', { cause: cleanup })
    }
    throw error
  }
}
