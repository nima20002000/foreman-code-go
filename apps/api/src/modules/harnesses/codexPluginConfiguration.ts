import { DomainError } from '../errors.js'
import { assertCodexUnchanged, qualifyCodex } from './codexProtocol.js'
import { CodexStdioTransport } from './codexStdioTransport.js'
import { runCommand } from './process.js'
import { pluginHash } from './codexPluginIdentity.js'
import type { PluginConfiguration } from './codexPluginCatalog.js'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function pluginCommandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(environment)) if (/^(?:GRAPHQL_|FOREMAN_CODE_|OPERATOR_|DATABASE_URL$|TEST_DATABASE_URL$|PGPASSWORD$)/.test(key)) delete environment[key]
  return environment
}
/** Only config/read and plugin list: do not couple discovery to unrelated MCP connection health. */
export async function inspectCodexPluginCatalog(binary: string, directory: string, signal: AbortSignal) {
  const environment = pluginCommandEnvironment()
  const qualified = await qualifyCodex(binary, directory, environment, true, signal)
  await assertCodexUnchanged(qualified)
  const transport = new CodexStdioTransport(qualified.binary, directory, environment, qualified.protocol,
    async () => { throw new DomainError('CODEX_PLUGIN_UNEXPECTED_INTERACTION', 'Plugin inspection requested an unexpected interaction.', 409) },
    () => undefined, () => undefined, 30_000)
  try {
    await transport.start(signal)
    const before = record(await transport.request('config/read', { includeLayers: true, cwd: directory }, signal))
    const result = await runCommand(qualified.binary, ['plugin', 'list', '--available', '--json'], directory, signal, environment, { maxOutputBytes: 8_000_000 })
    const after = record(await transport.request('config/read', { includeLayers: true, cwd: directory }, signal))
    if (!Array.isArray(before.layers) || !Array.isArray(after.layers)) throw new DomainError('CODEX_PLUGIN_CONFIG_UNAVAILABLE', 'Codex did not expose its configuration layers.', 503)
    if (pluginHash(before.layers) !== pluginHash(after.layers)) throw new DomainError('REVISION_CONFLICT', 'Codex configuration changed during plugin inspection. Refresh the reviewed snapshot.', 409)
    const user = before.layers.map(record).find((layer) => record(layer.name).type === 'user')
    const file = user && record(user.name).file
    const configuration: PluginConfiguration = user && typeof file === 'string' && file.length > 0 && typeof user.version === 'string'
      && user.config !== null && typeof user.config === 'object' && !Array.isArray(user.config)
      ? { file, userConfig: record(user.config), verified: true }
      : { file: '', userConfig: {}, verified: false }
    return { result, configuration }
  } finally { await transport.close() }
}
