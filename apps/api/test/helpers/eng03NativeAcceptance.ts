import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import {
  AgentConfigurationVersionSchema, HarnessExecutionSchema, type AgentConfigurationVersion,
  type HarnessExecution, type HarnessNativeEvent,
} from '@graphql/contracts'
import {
  ExecutableWorkflowV2Schema, RunNodeInputV2Schema, WorkflowRunV2Schema, makeWave25Fixture,
} from '@graphql/contracts/wave25'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService as WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../../src/modules/harnesses/opencodeServer.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from '../../src/modules/harnesses/mcpDetection.js'
import { codexMcpInspectorAdapter } from '../../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { openCodeMcpInspectorAdapter } from '../../src/modules/harnesses/opencodeMcpInspectorAdapter.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../../src/modules/interactions/postgres.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { insertOneShotRun } from '../../src/modules/runs/oneShotAdmission.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { seedAgent3 } from './wave25Agent3.js'

const runCommand = promisify(execFile)
type Harness = 'codex' | 'opencode'
type Scenario = 'E03-P01' | 'E03-P02' | 'E03-P03' | 'E03-L01' | 'E03-L02' | 'E03-L03' | 'E03-L04' | 'E03-A01'
const codexBinary = process.env.ENG03_A_CODEX_BINARY ?? '/home/nima/.local/bin/codex'
const openCodeBinary = process.env.ENG03_A_OPENCODE_BINARY ?? '/home/nima/.local/bin/opencode'

export interface Eng03NativeControl {
  pool: pg.Pool
  runId: string
  nodeIds: readonly string[]
  projectDirectory: string
  runtimeDirectory: string
  engine: LangGraphWorkflowEngine
  runs: PostgresRunRepository
  registry: NativeProcessRegistry
  startTask: Promise<void>
}

export interface Eng03NativeOptions {
  prompts?: Partial<Record<'Entry' | 'A' | 'B' | 'Reviewer', string>>
  control?: (context: Eng03NativeControl) => Promise<void>
}

interface NativeInterval {
  executionId: string
  nativeSessionId: string
  providerVersion: string
  start: { type: string; occurredAt: string; sequence: number }
  finish: { type: string; occurredAt: string; sequence: number }
}

function nativeInterval(execution: HarnessExecution, harness: Harness, providerVersion: string,
  events: HarnessNativeEvent[]): NativeInterval | undefined {
  const session = execution.nativeSessionId
  if (!session) return undefined
  const own = events.filter((event) => event.executionId === execution.id)
  const started = own.find((event) => harness === 'codex'
    ? event.type === 'turn.started' && event.payload.threadId === session
    : event.type === 'message.updated' && (event.payload.info as { role?: string } | undefined)?.role === 'assistant'
      && event.connectionId?.startsWith('history-') !== true)
  const finished = [...own].reverse().find((event) => harness === 'codex'
    ? event.type === 'turn.completed' && event.payload.threadId === session
    : event.type === 'session.idle' && event.payload.sessionID === session)
  if (!started || !finished || Date.parse(started.occurredAt) >= Date.parse(finished.occurredAt)) return undefined
  return { executionId: execution.id, nativeSessionId: session, providerVersion,
    start: { type: started.type, occurredAt: started.occurredAt, sequence: started.sequence },
    finish: { type: finished.type, occurredAt: finished.occurredAt, sequence: finished.sequence } }
}

function resultText(execution: HarnessExecution | undefined): string {
  const output = execution?.result?.output
  return typeof output === 'string' ? output : output && typeof output === 'object' && 'text' in output
    && typeof output.text === 'string' ? output.text : ''
}

async function version(binary: string): Promise<string> {
  const { stdout } = await runCommand(binary, ['--version'], { timeout: 10_000 })
  return stdout.trim()
}

/** Internal-service qualification while normal v2 admission remains closed. */
export async function runEng03NativeScenario(scenario: Scenario, first: Harness, second: Harness,
  options: Eng03NativeOptions = {}) {
  const baseUrl = process.env.ENG03_A_TEST_DATABASE_URL
  if (!baseUrl) throw new Error('ENG03_A_TEST_DATABASE_URL must name a task-owned loopback test database.')
  const parsed = new URL(baseUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.includes('test')) {
    throw new Error('ENG03_A_TEST_DATABASE_URL must use a loopback database named for tests.')
  }
  const suffix = randomUUID().replaceAll('-', '')
  const schema = `eng03_a_${suffix}`
  const root = await mkdtemp(join(tmpdir(), `eng03-a-${scenario.toLowerCase()}-`))
  const projectDirectory = join(root, 'project')
  const runtimeDirectory = join(root, 'runtime')
  const artifactPath = join(process.env.ENG03_A_EVIDENCE_DIR ?? join(tmpdir(), 'eng03-a-evidence'), `${scenario}-${suffix}.json`)
  await Promise.all([mkdir(projectDirectory), mkdir(runtimeDirectory), mkdir(join(artifactPath, '..'), { recursive: true })])
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 })
  let pool: pg.Pool | undefined
  let checkpoints: ReturnType<typeof createCheckpointStore> | undefined
  let engine: LangGraphWorkflowEngine | undefined
  let runId: string | undefined
  const evidence: Record<string, unknown> = { scenario, mode: 'native internal preliminary', artifactPath,
    sourceSha: (await runCommand('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    binaries: { codex: { path: codexBinary, version: await version(codexBinary) },
      opencode: { path: openCodeBinary, version: await version(openCodeBinary) } },
    models: { codex: process.env.ENG03_CODEX_MODEL ?? 'gpt-5.6-luna',
      opencode: process.env.ENG03_OPENCODE_MODEL ?? 'opencode-go/gpt-5.6-luna' },
    expected: { overlap: true, joinedInputs: 2, outcome: 'succeeded' } }
  try {
    await admin.query(`create schema ${schema}`)
    const url = new URL(baseUrl)
    url.searchParams.set('options', `-c search_path=${schema},public`)
    pool = new pg.Pool({ connectionString: url.toString(), max: 12, connectionTimeoutMillis: 5000 })
    await applyApplicationMigrations(pool)
    checkpoints = createCheckpointStore(url.toString(), schema)
    await checkpoints.setup()
    const fixture = makeWave25Fixture(suffix)
    const nodeNames = ['Entry', 'A', 'B', 'Reviewer'] as const
    const harnesses: Harness[] = ['codex', first, second, 'codex']
    const tokens = [`ENTRY-${suffix.slice(0, 6)}`, `A-${suffix.slice(0, 6)}`, `B-${suffix.slice(0, 6)}`]
    const prompts = [
      `Reply with exactly ${tokens[0]}.`,
      `Read the accepted Entry result. Without tools or files, list n and n squared modulo 97 for n=1 through 120, one row per n. Finish with exactly ${tokens[1]}. Keep the response under 3000 characters.`,
      `Read the accepted Entry result. Without tools or files, list n and n cubed modulo 101 for n=1 through 120, one row per n. Finish with exactly ${tokens[2]}. Keep the response under 3000 characters.`,
      'Read only the two accepted predecessor results. Find each final A-/B- marker and return exactly A:<A marker>|B:<B marker>. Do not read or write files.',
    ]
    const configuredPrompts = prompts.map((prompt, index) => options.prompts?.[nodeNames[index]!] ?? prompt)
    const configurations: AgentConfigurationVersion[] = nodeNames.map((name, index) => AgentConfigurationVersionSchema.parse({
      id: `cfg-${suffix}-${index}`, workspaceId: fixture.scope.workspaceId, agentId: `agent-${suffix}-${index}`,
      productRole: 'coder', version: 1, prompt: { system: configuredPrompts[index] }, assignedSkills: [],
      harness: harnesses[index] === 'codex'
        ? { harness: 'codex', model: evidence.models && (evidence.models as { codex: string }).codex,
          reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }
        : { harness: 'opencode', model: (evidence.models as { opencode: string }).opencode,
          variant: 'high', nativeAgent: 'build', thinking: false, autoApprove: false },
      contentHash: `sha256:${'0'.repeat(64)}`, createdAt: new Date().toISOString(),
    }))
    const nodes = nodeNames.map((name, index) => ({ id: `node-${suffix}-${index}`, name,
      agentId: configurations[index]!.agentId, ...(index === 0 ? {} : { join: { mode: 'all' as const } }) }))
    const edges = ([[0, 1], [0, 2], [1, 3], [2, 3]] as const).map(([source, target], index) => ({
      id: `edge-${suffix}-${index}`, kind: 'execution' as const, source: nodes[source]!.id, target: nodes[target]!.id,
    }))
    const { version: workflowVersion } = ExecutableWorkflowV2Schema.parse({
      version: { ...fixture.version, entryNodeId: nodes[0]!.id,
        agentConfigurationVersionIds: Object.fromEntries(configurations.map((item) => [item.agentId, item.id])),
        definition: { ...fixture.version.definition, entryNodeId: nodes[0]!.id, nodes, edges,
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 4 }, requiredAgentCount: 4 } },
      configurations,
    })
    fixture.configurations = configurations
    fixture.version = workflowVersion
    await seedAgent3(pool, projectDirectory, fixture, { run: false })
    const directory = await realpath(projectDirectory)
    const identity = await stat(directory, { bigint: true })
    const locationIdentity = { device: String(identity.dev), inode: String(identity.ino) }
    const identityHash = `sha256:${createHash('sha256').update(`${locationIdentity.device}:${locationIdentity.inode}`).digest('hex')}`
    await pool.query(`update workspaces set execution_location=$2::jsonb, execution_location_identity=$3::jsonb,
      location_revision=1 where id=$1`, [fixture.scope.workspaceId,
      JSON.stringify({ runnerId: 'runner-local', rootPath: directory }), JSON.stringify(locationIdentity)])
    const run = WorkflowRunV2Schema.parse({ ...fixture.run,
      agentConfigurationVersionIds: workflowVersion.agentConfigurationVersionIds,
      executionLocation: {
      runnerId: 'runner-local', rootPath: directory, locationRevision: 1, identityHash }, createdAt: new Date().toISOString() })
    fixture.run = run
    runId = run.id
    await withExclusiveGraphConnection(pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, run)))
    const commands = new PostgresCommandCoordinator(pool)
    const locations = new WorkspaceLocationService(pool, commands, runtimeDirectory)
    const workflows = new PostgresWorkflowRepository(pool)
    const runs = new PostgresRunRepository(pool, workflows, locations)
    const interactions = new PostgresInteractionRepository(pool)
    const registry = new NativeProcessRegistry(join(runtimeDirectory, 'native-process-registry'))
    const endpoint = process.env.APP_MCP_ENDPOINT ?? 'http://127.0.0.1:3000/mcp/tools'
    const managers = new ExecutionScopedNativeSessionManagerResolver((context) => {
      const config = context.configuration.harness
      if (config.harness !== context.harness) throw new Error('Pinned harness mismatch')
      return config.harness === 'codex'
        ? new CodexAppServerSessionManager(codexBinary, undefined, undefined, registry.scope(`execution:${context.executionId}`))
        : new OpenCodeNativeSessionManager({ server: new ManagedOpenCodeServer({ binary: openCodeBinary,
          processRecovery: registry.scope(`execution:${context.executionId}`), workingDirectory: context.workingDirectory,
          ownerAgentId: context.agentId, ...(config.advanced ? { advancedConfiguration: config.advanced } : {}) }),
          ownerAgentId: context.agentId, expectedAppMcpEndpoint: endpoint })
    })
    const workerCredentials = new WorkerCredentialService(pool, new PostgresAccessService(pool))
    const credentials: ExecutionCredentialProvider = {
      async prepare(input) {
        const execution = await runs.getExecution(input.executionId)
        const configuration = execution && await runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
        if (!execution || !configuration) throw new Error('Native execution identity is missing')
        const { manager } = managers.resolve({ executionId: execution.id, agentId: execution.agentId,
          harness: input.harness, workingDirectory: input.workingDirectory, configuration })
        const inspector = manager instanceof CodexAppServerSessionManager ? codexMcpInspectorAdapter(manager)
          : openCodeMcpInspectorAdapter(manager as OpenCodeNativeSessionManager)
        return new WorkerLaunchCredentialService(new McpDetectionService(inspector, endpoint), workerCredentials, 'runner-local').prepare(input)
      },
      revoke: (credential) => workerCredentials.revoke(credential),
      revokeForExecution: (id) => workerCredentials.revokeForExecution(id),
      revokeForRun: (id, client) => workerCredentials.revokeForRun(id, client),
      renew: (id, credential) => workerCredentials.renewForExecution(id, credential),
    }
    const approvals = new ApprovalExecutionCoordinator(runs, interactions, new PostgresApprovalBudgetRepository(pool),
      managers, 180_000, credentials, undefined, (id, signal) => registry.closeOwner(`execution:${id}`, signal))
    engine = new LangGraphWorkflowEngine(runs, workflows, approvals, checkpoints.saver, runtimeDirectory, locations,
      credentials, interactions, undefined, { workerParallelism: 2 })
    const startTask = engine.start(run.id)
    if (options.control) void startTask.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = options.control
        ? options.control({ pool, runId: run.id, nodeIds: nodes.map((node) => node.id), projectDirectory,
          runtimeDirectory, engine, runs, registry, startTask }).then(() => startTask.catch(() => undefined))
        : startTask
      await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ENG03_NATIVE_TIMEOUT')), 180_000)
      })])
    } finally { clearTimeout(timer) }
    const final = await runs.get(run.id)
    const executionRows = await pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1', [run.id])
    const executions = executionRows.rows.map((row) => HarnessExecutionSchema.parse(row.record))
    const byNode = (index: number) => executions.find((execution) => execution.workflowNodeId === nodes[index]!.id)
    const nativeRows = await pool.query<{ record: HarnessNativeEvent }>(
      'select record from harness_native_events where execution_id=any($1::text[]) order by execution_id,sequence',
      [executions.map((execution) => execution.id)])
    const nativeEvents = nativeRows.rows.map((row) => row.record)
    const sessionRows = await pool.query<{ execution_id: string; reference: { providerVersion: string } }>(
      'select execution_id,reference from execution_native_sessions where execution_id=any($1::text[])',
      [executions.map((execution) => execution.id)])
    const nativeSessions = new Map(sessionRows.rows.map((row) => [row.execution_id, row.reference]))
    const intervals = [1, 2].map((index) => {
      const execution = byNode(index)
      return execution && nativeInterval(execution, harnesses[index]!,
        nativeSessions.get(execution.id)?.providerVersion ?? '', nativeEvents)
    })
    const overlap = intervals.every(Boolean) && Math.max(...intervals.map((item) => Date.parse(item!.start.occurredAt)))
      < Math.min(...intervals.map((item) => Date.parse(item!.finish.occurredAt)))
    const reviewer = byNode(3)
    const reviewerInput = reviewer && RunNodeInputV2Schema.safeParse(reviewer.input)
    const accepted = reviewerInput?.success ? reviewerInput.data.predecessors : []
    const bindings = (await pool.query<{ record: { relationshipId: string; sender: { executionId: string };
      recipient: { executionId: string }; inputOrdinal: number; acceptedResultDigest: string; recipientInputDigest: string } }>(
      'select record from run_input_bindings where run_id=$1 and recipient_node_id=$2 order by input_ordinal',
      [run.id, nodes[3]!.id])).rows.map((row) => row.record)
    const joined = Boolean(reviewer && reviewerInput?.success && accepted.length === 2 && bindings.length === 2
      && accepted.map((item) => item.relationshipId).join('|') === [edges[2]!.id, edges[3]!.id].sort().join('|')
      && accepted.every((item) => {
        const sender = executions.find((execution) => execution.id === item.senderExecutionId)
        const binding = bindings.find((candidate) => candidate.relationshipId === item.relationshipId)
        return sender?.result?.outcome === 'succeeded' && JSON.stringify(item.acceptedResult) === JSON.stringify(sender.result)
          && binding?.sender.executionId === sender.id && binding.recipient.executionId === reviewer.id
          && binding.inputOrdinal === accepted.indexOf(item)
          && binding.acceptedResultDigest === graphSourceDigest(sender.result)
          && binding.recipientInputDigest === graphSourceDigest(reviewer.input)
      }) && reviewer.createdAt && intervals.every((item) => item && Date.parse(reviewer.createdAt) > Date.parse(item.finish.occurredAt)))
    const finalText = resultText(reviewer)
    const branchTexts = [resultText(byNode(1)), resultText(byNode(2))]
    const outcome = final?.outcome === 'succeeded' && JSON.stringify(final.result?.output) === JSON.stringify(reviewer?.result?.output)
      && branchTexts.every((text, index) => text.includes(tokens[index + 1]!))
      && finalText.includes(tokens[1]!) && finalText.includes(tokens[2]!) ? 'succeeded' : 'failed'
    const identitiesDistinct = [1, 2].every((index) => Boolean(byNode(index)?.nativeSessionId && byNode(index)?.runtimeDirectory))
      && new Set([1, 2].map((index) => byNode(index)?.agentId)).size === 2
      && new Set([1, 2].map((index) => byNode(index)?.agentConfigurationVersionId)).size === 2
      && new Set([1, 2].map((index) => byNode(index)?.nativeSessionId)).size === 2
      && new Set([1, 2].map((index) => byNode(index)?.runtimeDirectory)).size === 2
    const activeCredentials = await pool.query<{ count: string }>(`select count(*) from worker_credential_bindings b
      join management_principals p on p.id=b.principal_id where b.run_id=$1 and p.revoked_at is null`, [run.id])
    const cleanup = Number(activeCredentials.rows[0]?.count) === 0
      && (await Promise.all(executions.map((execution) => registry.closeOwner(`execution:${execution.id}`)))).every(Boolean)
    Object.assign(evidence, { runId: run.id, workflowVersionId: workflowVersion.id, sourceGraph: { nodes, edges },
      outcome, runOutcome: final?.outcome, runResult: final?.result, executions: executions.map((execution) => ({
        id: execution.id, nodeId: execution.workflowNodeId, agentId: execution.agentId,
        nativeSessionId: execution.nativeSessionId, runtimeDirectory: execution.runtimeDirectory,
        state: execution.state, result: execution.result, input: execution.input,
      })), intervals, overlap, identitiesDistinct, accepted, bindings, joinExact: joined, finalText, cleanup,
      activeCredentialCount: Number(activeCredentials.rows[0]?.count),
      nativeEventSummary: executions.map((execution) => ({ id: execution.id,
        events: nativeEvents.filter((event) => event.executionId === execution.id)
          .map(({ type, occurredAt, sequence }) => ({ type, occurredAt, sequence })) })) })
    return { artifactPath, outcome, overlap, identitiesDistinct, joinExact: joined, cleanup }
  } catch (error) {
    evidence.error = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    if (runId && pool) {
      const rows = await pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1', [runId]).catch(() => undefined)
      evidence.failureExecutions = rows?.rows.map((row) => {
        const execution = HarnessExecutionSchema.parse(row.record)
        return { id: execution.id, nodeId: execution.workflowNodeId, state: execution.state,
          result: execution.result, nativeSessionId: execution.nativeSessionId }
      })
      const events = await pool.query<{ execution_id: string; type: string; occurred_at: string }>(
        `select execution_id, record->>'type' as type, record->>'occurredAt' as occurred_at
         from harness_native_events where execution_id in (select id from harness_executions where run_id=$1)
         order by execution_id,sequence`, [runId]).catch(() => undefined)
      evidence.failureNativeEvents = events?.rows
    }
    if (runId && engine) await engine.cancel(runId).catch(() => undefined)
    throw error
  } finally {
    await engine?.shutdown().catch(() => undefined)
    if (runId) await checkpoints?.saver.deleteThread(runId).catch(() => undefined)
    await checkpoints?.close().catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await admin.query(`drop schema if exists ${schema} cascade`).catch(() => undefined)
    await admin.end()
    await writeFile(artifactPath, JSON.stringify(evidence, null, 2))
    if (!process.env.ENG03_A_KEEP_RUNTIME) await rm(root, { recursive: true, force: true })
    process.stdout.write(`ENG03 evidence ${artifactPath}\n`)
  }
}
