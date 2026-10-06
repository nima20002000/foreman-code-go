import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import { DeviceSetupApproveResultSchema } from '@foreman-code/contracts/device-setup'
import { loadWorkerPairing } from '@foreman-code/contracts/device-identity-node'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { loadConfig } from '../../src/config.js'
import { createDatabase } from '../../src/infrastructure/database.js'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.js'
import { buildProductionApp } from '../../src/production.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { InstalledWorkflowConfigurationSchema } from '../../src/modules/runs/remote/installedWorkflowConfiguration.js'
import { codexQualificationSuite } from '../../src/modules/harnesses/qualification/suites/codex.js'
import { opencodeQualificationSuite } from '../../src/modules/harnesses/qualification/suites/opencode.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'

const execute = promisify(execFile)
const actions: ManagementAction[] = ['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update',
  'devices:read', 'capabilities:read', 'operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write',
  'workspaces:read', 'workspaces:create', 'workspace_locations:read', 'workspace_locations:provision',
  'workspace_locations:update', 'workspace_locations:validate', 'source_roots:read', 'source_roots:bind',
  'workflows:read', 'workflows:create', 'workflows:update', 'agents:read', 'agents:create', 'agents:update',
  'graph:read', 'graph:edit', 'graph:save', 'runs:read']

async function copyProfileFile(source: string, destination: string) {
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 })
  try {
    await copyFile(source, destination)
    await chmod(destination, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function workerEnvironment(home: string) {
  const original = process.env.HOME ?? homedir()
  const config = process.env.XDG_CONFIG_HOME ?? join(original, '.config')
  const data = process.env.XDG_DATA_HOME ?? join(original, '.local/share')
  const codexProfile = join(home, '.codex')
  const claudeProfile = join(home, '.claude')
  const openCodeConfig = join(home, '.config/opencode')
  const workerData = join(home, '.local/share')
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexProfile,
    CLAUDE_CONFIG_DIR: claudeProfile, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'),
    OPENCODE_DB: join(home, '.local/share/opencode/opencode.db'),
    FOREMAN_CODE_APP_MCP_DIRECTORY: join(home, '.local/share/graphql/mcp') }
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ENG03_A_TEST_DATABASE_URL', ...APP_MCP_TOKEN_NAMES]) {
    delete environment[name]
  }
  const codex = process.env.CODEX_HOME ?? join(original, '.codex')
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    await copyProfileFile(join(codex, name), join(codexProfile, name))
  }
  await copyProfileFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(original, '.claude'), '.credentials.json'),
    join(claudeProfile, '.credentials.json'))
  await copyProfileFile(join(process.env.OPENCODE_CONFIG_DIR ?? join(config, 'opencode'), 'opencode.json'),
    join(openCodeConfig, 'opencode.json'))
  await copyProfileFile(join(data, 'opencode/auth.json'), join(workerData, 'opencode/auth.json'))
  return { environment, claudeProfile }
}

async function waitForWorkerExit(closed: Promise<void>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([closed, new Promise<never>((_done, fail) => {
      timer = setTimeout(() => fail(new Error('The owned Worker shutdown timed out.')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  return address.port
}

async function certificates(root: string) {
  const ca = join(root, 'ca.pem')
  const key = join(root, 'listener.key')
  const certificate = join(root, 'listener.pem')
  const request = join(root, 'listener.csr')
  const extensions = join(root, 'listener.extensions')
  await writeFile(extensions, 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\n', { mode: 0o600 })
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Native controls fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', join(root, 'ca.key'), '-out', ca])
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
    '-keyout', key, '-out', request])
  await execute('openssl', ['x509', '-req', '-in', request, '-CA', ca, '-CAkey', join(root, 'ca.key'),
    '-set_serial', '1', '-days', '1', '-extfile', extensions, '-out', certificate])
  return { certificateFile: certificate, privateKeyFile: key, trustCertificateFile: ca }
}

async function installerCommand(file: string, args: string[], environment: NodeJS.ProcessEnv, input?: string) {
  const child = spawn(process.execPath, [file, ...args], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let bytes = 0
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 1024 * 1024) child.kill('SIGTERM')
    else output += chunk.toString('utf8')
  })
  child.stderr.resume()
  child.stdin.end(input)
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
  try {
    await new Promise<void>((done, fail) => {
      child.once('error', fail)
      child.once('close', code => code === 0 ? done() : fail(new Error('The owned Worker installer command failed.')))
    })
    assert.ok(bytes <= 1024 * 1024)
    return output.trim()
  } finally { clearTimeout(timer) }
}

/** Real production composition and an installed Worker; no execution domains or SDK outputs are substituted. */
export async function pairedWorkerApplication() {
  const databaseUrl = process.env.ENG03_A_TEST_DATABASE_URL
  assert.ok(databaseUrl, 'Run through the disposable native acceptance database driver.')
  const url = new URL(databaseUrl)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_test'))
  const artifact = process.env.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY
  assert.ok(artifact, 'Build the committed Worker artifact before this acceptance case.')
  const root = await privateFixtureDirectory('paired-native-controls-')
  let database: ReturnType<typeof createDatabase> | undefined
  let checkpoints: ReturnType<typeof createCheckpointStore> | undefined
  let production: ReturnType<typeof buildProductionApp> | undefined
  let worker: ChildProcess | undefined
  let workerClosed: Promise<void> | undefined
  let workerExit: number | null | undefined
  let client: Client | undefined
  let removed = false
  const close = async () => {
    const failures: unknown[] = []
    const release = async (operation: () => Promise<unknown>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (worker && workerExit === undefined) worker.kill('SIGTERM')
    if (workerClosed) await release(async () => {
      try { await waitForWorkerExit(workerClosed!, 60000) }
      catch (error) {
        worker?.kill('SIGKILL')
        await waitForWorkerExit(workerClosed!, 10000)
        const processes = new NativeProcessRegistry(join(root, 'worker-home/.local/state/graphql-worker/workflow-native-processes'))
        for (const owner of new Set(processes.snapshot().launches.map(launch => launch.owner))) {
          if (!await processes.closeOwner(owner)) throw new Error('The original Worker native processes remain unconfirmed.')
        }
        throw error
      }
    })
    if (worker && workerExit !== 0) failures.push(new Error('The owned Worker did not close successfully.'))
    if (client) await release(() => client!.close())
    if (production) await release(() => production!.app.close())
    if (checkpoints) await release(() => checkpoints!.close())
    if (database) await release(() => database!.close())
    if (!failures.length && !removed) {
      await rm(root, { recursive: true, force: true })
      removed = true
    }
    if (failures.length) throw new AggregateError(failures, `Paired native fixture cleanup remains incomplete: ${root}`)
  }
  try {
    const port = await availablePort()
    const devicePort = await availablePort()
    const browserPort = await availablePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const browserOrigin = `http://127.0.0.1:${browserPort}`
    const endpoint = `wss://127.0.0.1:${devicePort}/device/connect`
    const applicationEnvironment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port),
      DATABASE_QUERY_TIMEOUT_MS: '10000', FOREMAN_CODE_BROWSER_ORIGIN: browserOrigin,
      FOREMAN_CODE_WEB_PORT: String(browserPort),
      FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1', WORKSPACE_STORAGE_ROOT: join(root, 'main-projects'),
      FILE_STORAGE_ROOT: join(root, 'main-files'), HARNESS_WORKSPACE_ROOT: join(root, 'main-runtime') }
    delete applicationEnvironment.FOREMAN_CODE_DEV_BROWSER_ORIGIN
    delete applicationEnvironment.GRAPHQL_DEV_BROWSER_ORIGIN
    const config = loadConfig(applicationEnvironment)
    database = createDatabase(config.database)
    checkpoints = createCheckpointStore(databaseUrl, config.checkpoints.schema, config.database)
    for (const path of [config.workspaceStorageRoot!, config.fileStorageRoot!, config.harnesses.workspaceRoot]) {
      await mkdir(path, { mode: 0o700 })
    }
    await database.migrate()
    await checkpoints.setup()
    const tls = await certificates(root)
    production = buildProductionApp(config, database, checkpoints, false, undefined, undefined,
      { codex: codexQualificationSuite, opencode: opencodeQualificationSuite },
      { mode: 'native', deviceListener: { host: '127.0.0.1', port: devicePort, advertisedEndpoint: endpoint, ...tls } })
    production.app.addHook('onClose', () => production!.drainShutdown())
    production.registerFileStorage()
    await production.initialize()
    await production.app.listen({ host: '127.0.0.1', port })
    await production.startDeviceListener()
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Native controls fixture', audience: 'operator',
      grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 6 * 60 * 60_000) })
    client = new Client({ name: 'Paired native controls fixture', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      authProvider: { token: async () => writer.token },
    }))
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args }, { timeout: 180000 })
      assert.ok(!result.isError, `Product tool ${name} failed.`)
      return result.structuredContent
    }
    const identity = RuntimeIdentitySchema.parse(await fetch(new URL('/health/identity', baseUrl))
      .then(response => response.json()))
    const main = HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', {
      kind: 'main', mainId: identity.installationId,
    }))
    const home = join(root, 'worker-home')
    await mkdir(home, { mode: 0o700 })
    const { environment, claudeProfile } = await workerEnvironment(home)
    const manifestBytes = await readFile(join(artifact, 'manifest.json'))
    const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'))
    assert.ok(manifest && typeof manifest === 'object' && 'commit' in manifest)
    const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim()
    assert.equal(manifest.commit, sourceCommit, 'The installed Worker must contain this committed source.')
    await installerCommand(join(artifact, 'src/install-cli.mjs'), ['setup', '--artifact', resolve(artifact),
      '--manifest-sha256', createHash('sha256').update(manifestBytes).digest('hex')], environment)
    const state = join(home, '.local/state/graphql-worker')
    const installed = join(home, '.local/lib/graphql-worker/current')
    const cli = join(installed, 'src/cli.mjs')
    const code = await installerCommand(cli, ['identity-request', '--state', state], environment)
    const approval = DeviceSetupApproveResultSchema.parse(await tool('device_setup_code_create', {
      commandId: randomUUID(), identityRequestCode: code, endpoint, scopes: ['connect', 'heartbeat', 'metrics:report'],
    }))
    await installerCommand(cli, ['pair', '--state', state, '--enrollment-stdin'], environment, approval.enrollmentCode)
    const pairing = await loadWorkerPairing(state)
    assert.equal(pairing.mainId, identity.installationId)
    assert.equal(pairing.deviceId, approval.registration.deviceId)
    const project = join(root, 'worker-projects')
    const runtime = join(root, 'worker-runtime')
    await mkdir(project, { mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const hostRef = { kind: 'device' as const, mainId: pairing.mainId, deviceId: pairing.deviceId }
    const roots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1', managedRuntimeRoot: runtime,
      bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only'] }] })
    await writeFile(join(state, 'approved-roots.json'), JSON.stringify(roots), { mode: 0o600, flag: 'wx' })
    const installedHarness = (driver: string) => {
      const value = main.installations.find(entry => entry.driverId === driver && entry.installed)
      assert.ok(value?.launcher.resolvedLauncher, `The selected ${driver} installation is unavailable.`)
      return value.launcher.resolvedLauncher
    }
    const selection = InstalledWorkflowConfigurationSchema.parse({ schemaVersion: 1,
      codexBinary: installedHarness('codex'), expectedVersion: '0.154.0', payloadPaths: [],
      appMcpLauncher: join(home, '.local/share/graphql/mcp/launcher.mjs'),
      opencode: { binary: installedHarness('opencode'), expectedVersion: '1.18.31', payloadPaths: [] },
      claude: { binary: installedHarness('claude'),
        sdkEntrypoint: createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
        installedLockPath: fileURLToPath(new URL('../../../../pnpm-lock.yaml', import.meta.url)) } })
    await writeFile(join(state, 'workflow-runtime.json'), JSON.stringify(selection), { mode: 0o600, flag: 'wx' })
    await installerCommand(cli, ['initialize-native-runtime', '--state', state], environment)
    worker = spawn(process.execPath, [cli, 'run', '--state', state], { env: environment, stdio: 'ignore' })
    workerClosed = new Promise<void>((done, fail) => {
      worker!.once('error', fail)
      worker!.once('close', code => { workerExit = code; done() })
    })
    const deadline = Date.now() + 60000
    let inventory: ReturnType<typeof HarnessRegistryReadbackSchema.parse> | undefined
    while (Date.now() < deadline && workerExit === undefined) {
      inventory = HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', hostRef))
      if (inventory.hostMetadata?.connection?.phase === 'ready') break
      await delay(250)
    }
    assert.equal(inventory?.hostMetadata?.connection?.phase, 'ready', 'The installed Worker did not connect.')
    assert.equal(inventory.hostMetadata.applicationInstallationId, pairing.workerInstallationId)
    return { root, baseUrl, browserOrigin, identity, hostRef, roots, inventory, tool, close, sourceCommit,
      workerProfile: claudeProfile }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Paired native fixture setup and cleanup failed.', { cause: error })
    }
    throw error
  }
}
