import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APP_MCP_TOKEN, appLauncherPath, appLauncherTokenName, appMcpServerName, installAppLauncher,
  isSupportedAppMcpTokenName,
} from '../../src/modules/harnesses/appMcpLauncher.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { OpenCodeMcpConnections } from '../../src/modules/harnesses/openCodeMcpConnections.js'
import { record } from '../../src/modules/harnesses/nativeMcpCommon.js'

/** Use the fixture's route registry without changing the native user configuration. */
export async function configureNativeWorkflowMcp(input: {
  projectDirectory: string
  runtimeDirectory: string
  codexBinary: string
  openCodeBinary?: string
}): Promise<() => void> {
  const previous = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(input.runtimeDirectory, 'mcp')
  const restore = () => {
    if (previous === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
    else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previous
  }
  try {
    await installAppLauncher()
    const codex = await new CodexMcpConnections(input.codexBinary, input.projectDirectory)
      .read(AbortSignal.timeout(30_000))
    const codexName = appMcpServerName(codex.effective)
    const entry = record(codex.effective[codexName])
    const reference = appLauncherTokenName('codex', entry) ?? entry.bearer_token_env_var
    const codexToken = typeof reference === 'string' && isSupportedAppMcpTokenName(reference)
      ? reference : APP_MCP_TOKEN
    await mkdir(join(input.projectDirectory, '.codex'), { recursive: true })
    await writeFile(join(input.projectDirectory, '.codex', 'config.toml'), [
      `[mcp_servers.${codexName}]`,
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(appLauncherPath())}]`,
      `env_vars = [${JSON.stringify(codexToken)}]`,
      '',
    ].join('\n'), { mode: 0o600 })
    if (input.openCodeBinary) {
      const openCode = await new OpenCodeMcpConnections(input.openCodeBinary, input.projectDirectory)
        .read(AbortSignal.timeout(30_000))
      const name = appMcpServerName(openCode.effective)
      const token = openCode.credentialReferences?.[name] ?? APP_MCP_TOKEN
      await writeFile(join(input.projectDirectory, 'opencode.json'), JSON.stringify({ mcp: { [name]: {
        type: 'local', command: [process.execPath, appLauncherPath()], enabled: true,
        environment: { [token]: `{env:${token}}` },
      } } }), { mode: 0o600 })
    }
    return restore
  } catch (error) {
    restore()
    throw error
  }
}
