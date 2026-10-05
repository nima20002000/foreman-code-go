import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { preserveOperatorConfiguration, publish, readEnvironment, readProductionIdentity,
  renderEnvironment, waitForProductionReady,
  withInstallationLock } from './local-production-runtime.mjs'

const execute = promisify(execFile)
const home = homedir()
const app = join(home, '.local/lib/graphql-production')
const config = join(home, '.config/graphql-production')
const unit = 'graphql-operator-api.service'
const databaseUnit = 'graphql-production-db.service'
const origin = 'http://127.0.0.1:3041'

async function systemctl(...args) {
  const { stdout } = await execute('/usr/bin/systemctl', ['--user', ...args], { timeout: 120_000 })
  return stdout.trim()
}

async function waitUntil(read, accept, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function recoverFailedDatabaseStartup(environment, ready) {
  const directory = await mkdtemp(join(config, 'database-startup-regression-'))
  const faultEnvironment = join(directory, 'database.env')
  const dropIn = join(home, '.config/systemd/user', `${databaseUnit}.d`, `regression-${randomUUID()}.conf`)
  let recovered = false
  try {
    await systemctl('stop', unit, databaseUnit)
    // Compose's required password check fails the real database activation before touching its volume.
    await publish(faultEnvironment, renderEnvironment({ GRAPHQL_PRODUCTION_DB_PASSWORD: '' }))
    await publish(dropIn, `[Service]\nEnvironmentFile=${faultEnvironment}\n`)
    await systemctl('daemon-reload')
    await systemctl('start', '--no-block', unit)
    await waitUntil(() => systemctl('show', '--property=Result', '--value', databaseUnit),
      value => value === 'exit-code', 'failed first database activation', 30_000)
    await publish(faultEnvironment, renderEnvironment({
      GRAPHQL_PRODUCTION_DB_PASSWORD: readProductEnvironment(environment, 'PRODUCTION_DB_PASSWORD'),
    }))
    await ready()
    assert.ok(Number(await systemctl('show', '--property=NRestarts', '--value', databaseUnit)) >= 1,
      'The database must recover by automatic retry')
    assert.equal(await systemctl('is-active', databaseUnit), 'active')
    recovered = true
  } finally {
    await rm(dropIn, { force: true })
    await rm(directory, { recursive: true, force: true })
    await systemctl('daemon-reload')
    if (!recovered) await systemctl('start', databaseUnit, unit)
  }
}

async function qualifyEnvironmentMigration(release) {
  const directory = await mkdtemp(join(config, 'environment-regression-'))
  const envFile = join(directory, 'production.env')
  const operatorFile = join(directory, 'operator.json')
  const settings = {
    CODEX_BINARY: '/opt/native "qualified"/codex',
    OPENCODE_BINARY: "/opt/native\\tools/'qualified'/opencode",
    OPENAI_API_KEY: "test-only\\secret\"quote'single$literal`tick\nsecond line\\",
    OPENROUTER_API_KEY: 'test-only-provider-credential',
    HARNESS_TIMEOUT_MS: '600000',
  }
  const owned = { NODE_ENV: 'production', FOREMAN_CODE_LOCAL_PRODUCTION: '1', HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://owner:password@127.0.0.1:55440/graphql_production',
    GRAPHQL_PRODUCTION_DB_PASSWORD: 'test-only-database-credential' }
  const { loadConfig } = await import(pathToFileURL(join(release, 'apps/api/dist/config.js')))
  const readEffective = async () => {
    const code = 'const keys = JSON.parse(process.argv[1]); '
      + 'console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));'
    const { stdout } = await execute('/usr/bin/systemd-run', ['--user', '--wait', '--pipe', '--collect', '--quiet',
      `--unit=graphql-environment-regression-${randomUUID()}`, `--property=EnvironmentFile=${envFile}`,
      join(release, 'node'), '-e', code, JSON.stringify(Object.keys(settings))], { timeout: 30_000 })
    return JSON.parse(stdout)
  }
  try {
    await publish(envFile, renderEnvironment({ ...settings, ...owned }))
    assert.deepEqual(await readEffective(), settings, 'Initial settings must match the actual systemd environment')
    const migrated = await preserveOperatorConfiguration(operatorFile, await readEnvironment(envFile), owned, loadConfig)
    assert.equal(loadConfig(migrated).harnesses.codexBinary, settings.CODEX_BINARY)
    assert.equal(loadConfig(migrated).harnesses.openCodeBinary, settings.OPENCODE_BINARY)
    assert.deepEqual(JSON.parse(await readFile(operatorFile, 'utf8')), settings)
    await publish(envFile, renderEnvironment(migrated))
    assert.deepEqual(await readEffective(), settings, 'Migration must preserve effective settings')
    const updated = await preserveOperatorConfiguration(operatorFile, await readEnvironment(envFile), owned, loadConfig)
    await publish(envFile, renderEnvironment(updated))
    assert.deepEqual(await readEffective(), settings, 'Update must preserve effective settings')
    const module = pathToFileURL(join(release, 'apps/api/dist/modules/harnesses/secrets.js')).href
    const code = `const { inheritedAgentEnvironment } = await import(${JSON.stringify(module)});\n`
      + 'const native = inheritedAgentEnvironment();\n'
      + 'console.log(JSON.stringify({ providerCredentialDelivered: !!process.env.OPENROUTER_API_KEY\n'
      + '&& native.OPENROUTER_API_KEY === process.env.OPENROUTER_API_KEY,\n'
      + 'databaseCredentialRemoved: !Object.hasOwn(native, "GRAPHQL_PRODUCTION_DB_PASSWORD")\n'
      + '&& !Object.hasOwn(native, "DATABASE_URL") }));'
    const { stdout } = await execute('/usr/bin/systemd-run', ['--user', '--wait', '--pipe', '--collect', '--quiet',
      '--expand-environment=no', `--unit=graphql-native-environment-regression-${randomUUID()}`,
      `--property=EnvironmentFile=${envFile}`, join(release, 'node'), '--input-type=module', '-e', code],
    { timeout: 30_000 })
    assert.deepEqual(JSON.parse(stdout), { providerCredentialDelivered: true, databaseCredentialRemoved: true })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  const environment = await readEnvironment(join(config, 'production.env'))
  assert.equal(readProductEnvironment(environment ?? {}, 'LOCAL_PRODUCTION'), '1', 'Install the compiled local production release first')
  assert.equal(environment.HOST, '127.0.0.1')
  assert.equal(new URL(environment.DATABASE_URL).port, '55440')
  const release = await realpath(join(app, 'current'))
  await import(pathToFileURL(join(release, 'apps/api/dist/app.js')).href)
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  const contracts = join(release, 'apps/api/node_modules/@foreman-code/contracts/dist')
  const { ManagementActionSchema } = await import(pathToFileURL(join(contracts, 'management/index.js')))
  const { makeCurrentWorkflowFixture } = await import(pathToFileURL(join(contracts, 'wave25/index.js')))
  const { PostgresAccessService } = await import(pathToFileURL(join(release, 'apps/api/dist/modules/access/postgres.js')))
  const recoveryModules = join(release, 'apps/api/dist/modules/harnesses/recovery')
  const { NativeProcessRegistry } = await import(pathToFileURL(join(recoveryModules, 'processRegistry.js')))
  const { cgroupRemoved } = await import(pathToFileURL(join(recoveryModules, 'cgroupBoundary.js')))
  const registry = new NativeProcessRegistry(join(environment.HARNESS_WORKSPACE_ROOT, 'native-process-registry'))
  const expected = await readProductionIdentity(release, environment.DATABASE_URL)
  const ready = () => waitForProductionReady({ origin, expected })
  await ready()
  await qualifyEnvironmentMigration(release)
  assert.equal(await systemctl('show', '--property=Delegate', '--value', unit), 'yes')
  assert.equal(await systemctl('show', '--property=Restart', '--value', unit), 'always')
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, query_timeout: 10_000 })
  pool.on('error', error => console.error('Regression database connection closed:', error.message))
  const access = new PostgresAccessService(pool)
  const clients = []
  const credentials = []
  const runScopes = []
  let workspaceId
  let conversationId
  const issue = async grants => {
    const issued = await access.issue({ name: 'Installed production regression', audience: 'operator', grants,
      expiresAt: new Date(Date.now() + 30 * 60_000) })
    credentials.push(issued.principal.id)
    return issued
  }
  const connect = async issued => {
    const client = new Client({ name: 'local-production-regression', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return client
  }
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
    assert.ok(result.structuredContent, `${name} did not return structured content`)
    return result.structuredContent
  }
  let writer
  let writerCredential
  let failure
  try {
    writerCredential = await issue([{ actions: ManagementActionSchema.options, scope: {} }])
    const deniedCredential = await issue([{ actions: ['operator_chat:read', 'harnesses:read'], scope: {} }])
    writer = await connect(writerCredential)
    let denied = await connect(deniedCredential)
    await assert.rejects(call(denied, 'operator_chat_create'), /not found|ACCESS_DENIED/)
    const created = await call(writer, 'workspace_create', { commandId: randomUUID(),
      name: `Production regression ${randomUUID()}`, parentPath: environment.WORKSPACE_STORAGE_ROOT })
    workspaceId = created.value.workspace.id
    const workspace = await call(writer, 'workspace_get', { workspaceId })
    const conversation = await call(writer, 'operator_chat_create', { title: 'Production regression' })
    conversationId = conversation.conversation.id
    const beforeChat = await call(writer, 'operator_chat_get', { conversationId: conversation.conversation.id })
    await call(writer, 'operator_chat_send', { conversationId: conversation.conversation.id, request: {
      requestId: randomUUID(), configurationVersionId: beforeChat.conversation.operatorConfigurationVersionId,
      content: 'Do not use tools. Reply with exactly LOCAL_PRODUCTION_OPERATOR.',
    } })
    const chat = await waitUntil(() => call(writer, 'operator_chat_get', { conversationId: conversation.conversation.id }),
      state => state.turnState === 'idle' || state.turnState === 'error', 'native Operator reply')
    assert.equal(chat.turnState, 'idle', chat.error)
    assert.ok(chat.messages.some(message => message.role === 'assistant'
      && message.content.includes('LOCAL_PRODUCTION_OPERATOR')), 'Missing real native Operator reply')

    const startWorkflow = async (harness, task) => {
      const catalog = await call(writer, 'harness_get', { harness })
      assert.equal(catalog.discoveryError, null, `${harness} must pass native qualification`)
      const agent = (await call(writer, 'agent_create', { workspaceId, commandId: randomUUID(),
        agentId: randomUUID(), name: `Production ${harness}`, configuration: catalog.defaults,
        prompt: { system: 'Follow the Foreman Code work-handoff output contract. Do not use tools.' } })).value.agent
      const managed = (await call(writer, 'workflow_create', { workspaceId, commandId: randomUUID(),
        name: `Production ${harness}` })).value
      const definition = makeCurrentWorkflowFixture(randomUUID(), 'single').version.definition
      const graph = { ...managed.workflow, workspaceId, entryNodeId: definition.entryNodeId,
        executionPolicy: definition.executionPolicy, approval: { handler: 'user' }, edges: [],
        nodes: [{ ...definition.nodes[0], agentId: agent.id, initialPrompt: task }] }
      const saved = await call(writer, 'workflow_save_v3', { workspaceId, workflowId: managed.workflow.id,
        commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
        expectedWorkflowVersionId: null, expectedLocationRevision: workspace.locationRevision,
        expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId }, graph })
      const input = { workspaceId, workflowId: managed.workflow.id, commandId: randomUUID(),
        executionSemanticsVersion: 3, workflowVersionId: saved.value.version.id,
        expectedWorkflowRevision: saved.value.revision, expectedLocationRevision: workspace.locationRevision,
        expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds, input: {} }
      await assert.rejects(call(denied, 'run_start', input), /not found|ACCESS_DENIED/)
      const started = await call(writer, 'run_start', input)
      const scope = { workspaceId, runId: started.run.id }
      runScopes.push(scope)
      return scope
    }
    const settled = scope => waitUntil(() => call(writer, 'run_record_get', scope),
      record => record.run.executionState === 'completed' && !record.cleanupPending, 'native run settlement')
    const nativeSessions = async scope => (await pool.query(
      `select id,record->>'nativeSessionId' as session from harness_executions
       where run_id=$1 and record->>'nativeSessionId' is not null order by id`, [scope.runId])).rows
    const positivelyStarted = scope => waitUntil(async () => (await pool.query(
      `select 1 from harness_native_events ne join harness_executions he on he.id=ne.execution_id
       where he.run_id=$1 and ne.record->>'type'='turn.started'`, [scope.runId])).rowCount,
    count => count > 0, 'native turn.started')
    for (const harness of ['codex', 'opencode']) {
      const scope = await startWorkflow(harness,
        'Finish with routing.kind finish, latestDeliverable {"marker":"LOCAL_PRODUCTION_WORKFLOW"}, remainingFindings [].')
      const record = await settled(scope)
      assert.equal(record.run.outcome, 'succeeded')
      assert.equal((await nativeSessions(scope)).length, 1, 'Workflow must bind a real native session')
    }
    const longTask = 'Write every integer from 1 to 10000 and its square in latestDeliverable.rows. '
      + 'Compute it yourself without tools. Follow the work-handoff output contract.'
    const canceled = await startWorkflow('codex', longTask)
    await positivelyStarted(canceled)
    await call(writer, 'run_stop', { ...canceled, commandId: randomUUID() })
    assert.equal((await settled(canceled)).run.outcome, 'canceled')

    await recoverFailedDatabaseStartup(environment, ready)
    await Promise.all(clients.map(client => client.close()))
    clients.length = 0
    writer = await connect(writerCredential)
    denied = await connect(deniedCredential)
    await assert.rejects(call(denied, 'workspace_get', { workspaceId }), /not found|ACCESS_DENIED/)
    assert.equal((await call(writer, 'workspace_get', { workspaceId })).workspace.id, workspaceId)
    const afterStartup = await call(writer, 'run_record_get', canceled)
    assert.equal(afterStartup.run.outcome, 'canceled')
    assert.equal(afterStartup.cleanupPending, false)
    assert.ok((await call(writer, 'operator_chat_get', { conversationId })).messages
      .some(message => message.content.includes('LOCAL_PRODUCTION_OPERATOR')))

    const pid = await systemctl('show', '--property=MainPID', '--value', unit)
    await execute('/usr/bin/docker', ['compose', '--project-name', 'graphql-local-production',
      '--file', join(app, 'compose.production.yaml'), 'restart', 'postgres'], { timeout: 90_000,
      env: { ...process.env, ...environment } })
    await waitUntil(() => systemctl('show', '--property=MainPID', '--value', unit),
      value => value !== '0' && value !== pid, 'API restart after PostgreSQL ownership loss', 120_000)
    await ready()
    await Promise.all(clients.map(client => client.close()))
    clients.length = 0
    writer = await connect(writerCredential)
    denied = await connect(deniedCredential)
    assert.equal((await call(writer, 'run_record_get', canceled)).run.outcome, 'canceled')
    const persistedChat = await call(writer, 'operator_chat_get', { conversationId: conversation.conversation.id })
    assert.ok(persistedChat.messages.some(message => message.content.includes('LOCAL_PRODUCTION_OPERATOR')))

    const recovering = await startWorkflow('opencode', longTask)
    await positivelyStarted(recovering)
    const sessions = await nativeSessions(recovering)
    const beforeCrash = await systemctl('show', '--property=MainPID', '--value', unit)
    await systemctl('kill', '--kill-whom=main', '--signal=KILL', unit)
    await waitUntil(() => systemctl('show', '--property=MainPID', '--value', unit),
      value => value !== '0' && value !== beforeCrash, 'API crash restart', 120_000)
    await ready()
    await Promise.all(clients.map(client => client.close()))
    clients.length = 0
    writer = await connect(writerCredential)
    await settled(recovering)
    assert.deepEqual(await nativeSessions(recovering), sessions, 'Recovery must retain original execution/session bindings')

    for (const harness of ['codex', 'opencode']) {
      denied = await connect(deniedCredential)
      const killed = await startWorkflow(harness, longTask)
      await positivelyStarted(killed)
      const bindings = await nativeSessions(killed)
      const owners = new Set(bindings.map(binding => `execution:${binding.id}`))
      const launches = registry.snapshot().launches
        .filter(launch => owners.has(launch.owner) && launch.lifecycle === 'active')
      assert.ok(launches.length > 0, 'Native work must have registered launch boundaries')
      for (const launch of launches) assert.ok(launch.boundary, 'Native work must be contained before the crash')
      const beforeKill = await systemctl('show', '--property=MainPID', '--value', unit)
      await systemctl('kill', '--kill-whom=all', '--signal=KILL', unit)
      await waitUntil(() => systemctl('show', '--property=MainPID', '--value', unit),
        value => value !== '0' && value !== beforeKill, 'service-wide SIGKILL restart', 120_000)
      await ready()
      for (const launch of launches) {
        assert.equal(cgroupRemoved(launch.boundary), true, 'Systemd must have pruned the killed native tree')
      }
      await Promise.all(clients.map(client => client.close()))
      clients.length = 0
      writer = await connect(writerCredential)
      denied = await connect(deniedCredential)
      await assert.rejects(call(denied, 'run_stop', { ...killed, commandId: randomUUID() }), /not found|ACCESS_DENIED/)
      await call(writer, 'run_stop', { ...killed, commandId: randomUUID() })
      const stopped = await settled(killed)
      assert.notEqual(stopped.run.outcome, 'pending')
      assert.deepEqual(await nativeSessions(killed), bindings, 'Stop must retain the killed execution/session bindings')
      await systemctl('restart', unit)
      await ready()
      await Promise.all(clients.map(client => client.close()))
      clients.length = 0
      writer = await connect(writerCredential)
      const persisted = await call(writer, 'run_record_get', killed)
      assert.equal(persisted.cleanupPending, false, 'Confirmed cleanup must survive another API restart')
      assert.equal(persisted.run.outcome, stopped.run.outcome)
      assert.deepEqual(await nativeSessions(killed), bindings)
    }
  } catch (error) {
    failure = error
  } finally {
    const errors = failure ? [failure] : []
    try {
      if (writerCredential) {
        const cleanupClient = await connect(writerCredential)
        if (conversationId) {
          const chat = await call(cleanupClient, 'operator_chat_get', { conversationId })
          if (chat.activeRequestId) {
            await call(cleanupClient, 'operator_chat_cancel', { conversationId,
              request: { requestId: chat.activeRequestId, commandId: randomUUID() } })
            await waitUntil(() => call(cleanupClient, 'operator_chat_get', { conversationId }),
              value => !value.activeRequestId, 'test-owned Operator cleanup')
          }
        }
        for (const scope of runScopes) {
          const record = await call(cleanupClient, 'run_record_get', scope)
          if (record.run.executionState !== 'completed' || record.cleanupPending) {
            await call(cleanupClient, 'run_stop', { ...scope, commandId: randomUUID() })
            await waitUntil(() => call(cleanupClient, 'run_record_get', scope),
              value => value.run.executionState === 'completed' && !value.cleanupPending, 'test-owned run cleanup')
          }
        }
        if (workspaceId) {
          const workspace = await call(cleanupClient, 'workspace_get', { workspaceId })
          await call(cleanupClient, 'workspace_archive', { workspaceId, commandId: randomUUID(),
            expectedRevision: workspace.revision })
        }
      }
    } catch (error) {
      errors.push(error)
    }
    try {
      const closed = await Promise.allSettled(clients.map(client => client.close()))
      const revoked = await Promise.allSettled(credentials.map(id => access.revoke(id)))
      for (const result of [...closed, ...revoked]) if (result.status === 'rejected') errors.push(result.reason)
    } finally {
      await pool.end()
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'))
  }
  console.log('Installed production passed: native execution, grants, cancellation, database startup/restart and crash recovery.')
}

withInstallationLock(join(config, 'install.lock'), main).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
