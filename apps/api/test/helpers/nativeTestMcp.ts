import { chmod, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { APP_MCP_SERVER_NAME, APP_MCP_TOKEN, LEGACY_APP_MCP_SERVER_NAMES } from '../../src/modules/harnesses/appMcpLauncher.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { qualifyCodex } from '../../src/modules/harnesses/codexProtocol.js'
import { CodexStdioTransport } from '../../src/modules/harnesses/codexStdioTransport.js'
import { editJsoncMcp } from '../../src/modules/harnesses/jsoncMcpEditor.js'
import { nativeConnection, record, type NativeMcpSnapshot } from '../../src/modules/harnesses/nativeMcpCommon.js'
import { OpenCodeMcpConnections } from '../../src/modules/harnesses/openCodeMcpConnections.js'
import type { NativeProcessRecovery } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { inheritedAgentEnvironment } from '../../src/modules/harnesses/secrets.js'

async function requireOwnedConfiguration(file: string) {
  const root = process.env.FOREMAN_CODE_NATIVE_TEST_ROOT
  if (!root) throw new Error('Native fixture configuration requires task-owned provider storage.')
  let target: string
  try {
    target = await realpath(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    target = join(await realpath(dirname(file)), basename(file))
  }
  const path = relative(await realpath(root), target)
  if (isAbsolute(path) || path === '..' || path.startsWith('../')) {
    throw new Error('Native fixture configuration cannot edit shared provider settings.')
  }
}

function requireConnection(snapshot: NativeMcpSnapshot, endpoint: string) {
  const configured = record(snapshot.user[APP_MCP_SERVER_NAME])
  const reference = snapshot.harness === 'codex'
    ? configured.bearer_token_env_var === APP_MCP_TOKEN
    : record(configured.headers).Authorization === `Bearer {env:${APP_MCP_TOKEN}}`
  if (configured.url !== endpoint || configured.enabled !== true || !reference) {
    throw new Error('The native fixture MCP endpoint and scoped credential reference were not persisted.')
  }
}

/** Human fixture setup uses the native configuration API; workers retain only their scoped MCP credential. */
export async function prepareNativeTestMcp(input: {
  harness: 'codex' | 'opencode'; binary: string; directory: string; endpoint: string; recovery: NativeProcessRecovery
}) {
  const signal = AbortSignal.timeout(60_000)
  const connection = nativeConnection(input.harness, { transport: 'remote', url: input.endpoint,
    bearerTokenEnvironmentVariable: APP_MCP_TOKEN })
  const names = [...APP_MCP_SERVER_NAMES, ...LEGACY_APP_MCP_SERVER_NAMES]
  if (input.harness === 'opencode') {
    const adapter = new OpenCodeMcpConnections(input.binary, input.directory, input.recovery)
    const snapshot = await adapter.read(signal)
    await requireOwnedConfiguration(snapshot.file)
    const before = await readFile(snapshot.file, 'utf8')
    let updated = before
    for (const name of names) updated = editJsoncMcp(updated, name,
      name === APP_MCP_SERVER_NAME ? connection : undefined)
    signal.throwIfAborted()
    await writeFile(snapshot.file, updated)
    await chmod(snapshot.file, 0o600)
    requireConnection(await adapter.read(signal), input.endpoint)
    return
  }
  const adapter = new CodexMcpConnections(input.binary, input.directory, input.recovery)
  const snapshot = await adapter.read(signal)
  await requireOwnedConfiguration(snapshot.file)
  const environment = inheritedAgentEnvironment()
  const qualified = await qualifyCodex(input.binary, undefined, input.directory, environment, true, signal,
    input.recovery)
  const transport = new CodexStdioTransport(qualified.binary, input.directory, environment, qualified.protocol,
    async request => { await transport.reject(request.id, -32601, 'Configuration setup does not answer native interactions.') },
    () => undefined, () => undefined, 30_000, input.recovery)
  try {
    await transport.start(signal)
    await transport.request('config/batchWrite', {
      edits: names.map(name => ({ keyPath: `mcp_servers.${name}`, mergeStrategy: 'replace',
        value: name === APP_MCP_SERVER_NAME ? connection : null })),
      filePath: snapshot.file, expectedVersion: snapshot.version, reloadUserConfig: true,
    }, signal)
  } finally {
    await transport.close()
  }
  requireConnection(await adapter.read(signal), input.endpoint)
}
