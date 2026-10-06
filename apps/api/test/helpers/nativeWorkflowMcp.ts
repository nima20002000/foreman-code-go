import { chmod, copyFile, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_MCP_TOKEN, appLauncherPath, appLauncherTokenName, appMcpServerName, installAppLauncher,
  isSupportedAppMcpTokenName,
} from '../../src/modules/harnesses/appMcpLauncher.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { OpenCodeMcpConnections } from '../../src/modules/harnesses/openCodeMcpConnections.js'
import { record } from '../../src/modules/harnesses/nativeMcpCommon.js'

/** Use fixture-owned CLI configuration and routes while retaining the provider login. */
export async function configureNativeWorkflowMcp(input: {
  projectDirectory: string
  runtimeDirectory: string
  codexBinary: string
  openCodeBinary?: string
}): Promise<() => Promise<void>> {
  const previous = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  const previousCodexHome = process.env.CODEX_HOME
  // Codex's release build refuses helper aliases beneath TMPDIR.
  const profileDirectory = fileURLToPath(new URL('../../../../.logs/native-cli/', import.meta.url))
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  const codexHomeDirectory = await mkdtemp(join(profileDirectory, 'codex-'))
  const restore = async () => {
    if (previous === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
    else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previous
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(codexHomeDirectory, { recursive: true, force: true })
    try { await rmdir(profileDirectory) }
    catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
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
    await copyFile(join(previousCodexHome ?? join(homedir(), '.codex'), 'auth.json'),
      join(codexHomeDirectory, 'auth.json'))
    await chmod(join(codexHomeDirectory, 'auth.json'), 0o600)
    process.env.CODEX_HOME = codexHomeDirectory
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(input.runtimeDirectory, 'mcp')
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
      await writeFile(join(input.projectDirectory, 'opencode.json'), JSON.stringify({ mcp: { [name]: {
        type: 'local', command: [process.execPath, appLauncherPath()], enabled: true,
        environment: { [token]: `{env:${token}}` },
      } } }), { mode: 0o600 })
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
