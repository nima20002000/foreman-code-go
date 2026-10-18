import { chmod, copyFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appMcpDirectory } from '@foreman-code/contracts/product-environment-node'
import { APP_MCP_SERVER_NAMES, APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { createDeviceTls } from './tls.js'
import { installCodexExecutable } from './nativeCodex.js'

export interface FixtureSetupOptions {
  directory: string
  environment: NodeJS.ProcessEnv
  apiOrigin: string
  devicePort: number
}

export type HarnessFixtures = Awaited<ReturnType<typeof setupFixtures>>

/** Only fresh, caller-owned state is populated; installed SDKs are never changed. */
export async function setupFixtures(options: FixtureSetupOptions) {
  if (!isAbsolute(options.directory)) throw new Error('The fixture directory must be absolute.')
  const api = new URL(options.apiOrigin)
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(api.hostname)) {
    throw new Error('Conformance fixtures require an isolated loopback API.')
  }
  const root = join(options.directory, 'harnesses')
  const bin = join(root, 'bin')
  const codex = join(root, 'codex')
  const claude = join(root, 'claude-sdk')
  const claudeProfileDirectory = join(root, 'claude-profile')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await mkdir(codex, { mode: 0o700 })
  await mkdir(claudeProfileDirectory, { mode: 0o700 })
  const source = new URL('../../fixtures/harnesses/', import.meta.url)
  await cp(fileURLToPath(new URL('claude-sdk/', source)), claude, { recursive: true, errorOnExist: true })
  const codexSource = new URL('../../../apps/api/test/fixtures/', import.meta.url)
  await copyFile(fileURLToPath(new URL('codex-app-server.cjs', codexSource)), join(codex, 'app-server.cjs'))
  await copyFile(fileURLToPath(new URL('codex-protocol.schemas.json', codexSource)), join(codex, 'schema.json'))
  for (const filename of ['scripted-turns.cjs', 'scripted-plans.cjs', 'scripted-input.cjs',
    'scripted-mcp.cjs', 'scripted-mcp-configuration.cjs']) {
    await copyFile(fileURLToPath(new URL(filename, source)), join(codex, filename))
  }
  const conformanceRequire = createRequire(new URL('../../package.json', import.meta.url))
  const imageMetadataModule = conformanceRequire.resolve('sharp')
  const mcpModules = { client: conformanceRequire.resolve('@modelcontextprotocol/sdk/client/index.js'),
    streamableHttp: conformanceRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    stdio: conformanceRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js') }
  const appMcpLauncher = join(appMcpDirectory(options.environment), 'launcher.mjs')
  const launcherRelative = relative(options.directory, appMcpLauncher)
  if (!launcherRelative || launcherRelative === '..' || launcherRelative.startsWith('../') || isAbsolute(launcherRelative)) {
    throw new Error('The managed App MCP launcher must belong to this isolated target directory.')
  }
  const fixtureScope = JSON.stringify({ directory: options.directory, imageMetadataModule,
    mcpModules, apiOrigin: api.origin, appMcpLauncher,
    appMcpServerNames: APP_MCP_SERVER_NAMES, appMcpTokenNames: APP_MCP_TOKEN_NAMES })
  await writeFile(join(codex, 'fixture-scope.json'), fixtureScope, { mode: 0o600, flag: 'wx' })
  await writeFile(join(claude, 'fixture-scope.json'), fixtureScope, { mode: 0o600, flag: 'wx' })
  const codexBinary = join(bin, 'codex')
  await installCodexExecutable(codexBinary, join(codex, 'app-server.cjs'), options.environment)
  const claudeBinary = join(bin, 'claude')
  const cliPath = fileURLToPath(new URL('claude-cli.cjs', source))
  await copyFile(cliPath, claudeBinary)
  await chmod(claudeBinary, 0o700)
  const model = DEFAULT_HARNESS_DEFAULTS.codex.model
  await writeFile(join(codex, 'models.json'), JSON.stringify({ models: [{ slug: model,
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })),
    additional_speed_tiers: ['fast'] }] }), { mode: 0o600, flag: 'wx' })
  await writeFile(join(codex, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: true, required: true,
    transport: { type: 'streamable_http', url: new URL('/mcp', api).href, bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' },
  }), { mode: 0o600, flag: 'wx' })
  const device = await createDeviceTls(join(options.directory, 'device-tls'), options.environment)
  const deviceEndpoint = `wss://127.0.0.1:${options.devicePort}/device/connect`
  const claudeSdkEntrypoint = join(claude, 'sdk.mjs')
  const environment = resolveProductEnvironment({ ...options.environment,
    PATH: [bin, options.environment.PATH].filter(Boolean).join(delimiter),
    CODEX_BINARY: codexBinary,
    CLAUDE_CONFIG_DIR: claudeProfileDirectory,
    FOREMAN_CODE_DEVICE_LISTENER_ENABLED: '1',
    DEVICE_LISTENER_HOST: '127.0.0.1', DEVICE_LISTENER_PORT: String(options.devicePort),
    DEVICE_LISTENER_TLS_CERT_FILE: device.certificate,
    DEVICE_LISTENER_TLS_KEY_FILE: device.privateKey,
    DEVICE_LISTENER_TLS_TRUST_CERT_FILE: device.caCertificate,
    DEVICE_LISTENER_ADVERTISED_ENDPOINT: deviceEndpoint,
  })
  return { environment, codexBinary, codexDirectory: codex, codexModel: model,
    claudeBinary, claudeSdkEntrypoint, claudeProfileDirectory, deviceEndpoint, deviceTlsTrust: device.trust }
}
