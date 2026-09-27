import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, AgentSchema, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  ListInteractionsResponseSchema, WorkspaceSchema } from '@graphql/contracts'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { loadConfig } from '../src/config.js'
import { buildProductionApp } from '../src/production.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { appLauncherPath, installAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

const enabled = process.env.NIM2691_REAL_NATIVE === '1' && process.env.NIM2691_POSTGRES === '1'

async function taskPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

describe.skipIf(!enabled)('NIM-2691 real native workflow qualification', () => {
  it.each([
    { name: 'single Codex activation', form: 'single', providers: ['codex'], review: false, approval: false },
    { name: 'Codex to OpenCode handoff', form: 'sequential', providers: ['codex', 'opencode'], review: false, approval: false },
    { name: 'Codex conditional final route to OpenCode', form: 'conditional',
      providers: ['codex', 'opencode'], review: false, approval: false },
    { name: 'Codex to OpenCode accepted review return', form: 'sequential', providers: ['codex', 'opencode'],
      review: true, approval: false },
    { name: 'OpenCode read-only approval before Codex handoff', form: 'sequential',
      providers: ['opencode', 'codex'], review: false, approval: true },
    { name: 'unequal Codex and OpenCode branches into one all-required join', form: 'parallel',
      providers: ['codex', 'opencode', 'codex', 'opencode'], review: false, approval: false },
  ] as const)('finishes $name with exact accepted results and cleanup', async (scenario) => {
    await nim2691TaskDatabase(async (pool, directory, suppliedUrl) => {
      const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
      const projectPath = await mkdtemp(join(repositoryRoot, '.nim2691-native-project-'))
      const runtimeRoot = join(directory, 'runtime')
      await mkdir(runtimeRoot)
      await installAppLauncher()
      await mkdir(join(projectPath, '.codex'))
      await writeFile(join(projectPath, '.codex', 'config.toml'), [
        '[mcp_servers.graphql]',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(appLauncherPath())}]`,
        'env_vars = ["GRAPHQL_MCP_TOKEN"]',
        '',
      ].join('\n'), { mode: 0o600 })
      if (scenario.providers.some((provider) => provider === 'opencode')) {
        await writeFile(join(projectPath, 'opencode.json'), JSON.stringify({ mcp: { graphql: {
          type: 'local', command: [process.execPath, appLauncherPath()], enabled: true,
          environment: { GRAPHQL_MCP_TOKEN: '{env:GRAPHQL_MCP_TOKEN}' },
        } } }), { mode: 0o600 })
      }
      const port = await taskPort()
      const config = { ...loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: String(port),
        GRAPHQL_DEV_BROWSER_ACCESS: '0',
        DATABASE_URL: suppliedUrl.replace(/^postgres:/, 'postgresql:'),
        HARNESS_WORKSPACE_ROOT: runtimeRoot, DATABASE_QUERY_TIMEOUT_MS: '10000' }),
        workspaceStorageRoot: projectPath }
      const database = createDatabase(config.database)
      const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
      let app: ReturnType<typeof buildProductionApp>['app'] | undefined
      try {
        await database.migrate()
        await checkpoints.setup()
        const production = buildProductionApp(config, database, checkpoints, false)
        const startupErrors: string[] = []
        const start = production.engine.start.bind(production.engine)
        production.engine.start = async (runId) => {
          try { return await start(runId) }
          catch (error) {
            startupErrors.push(error && typeof error === 'object' && 'code' in error
              ? String(error.code) : error instanceof Error ? error.name : 'unknown')
            throw error
          }
        }
        app = production.app
        await production.initialize()
        await app.listen({ host: config.host, port: config.port })
        const fixture = makeCurrentWorkflowFixture(`nim2691-native-${randomUUID()}`, scenario.form)
        const configurations = fixture.configurations.map((original, index) => AgentConfigurationVersionSchema.parse({
          ...original,
          harness: scenario.providers[index] === 'opencode'
            ? { harness: 'opencode', model: 'opencode-go/gpt-5.6-luna', variant: 'high',
              nativeAgent: 'build', thinking: false, autoApprove: false,
              ...(scenario.approval && index === 0 ? { advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
                permissionRules: [{ permission: 'shell', pattern: 'pwd', effect: 'ask' }] } } : {}) }
            : { harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'high',
              sandbox: 'read-only', serviceTier: 'standard' },
          prompt: { system: index === 0
            ? scenario.approval
              ? 'Use exactly one read-only shell command: pwd. Wait for the authorized response. Then follow the GraphQL work-handoff output contract.'
              : 'Follow the GraphQL work-handoff output contract. Do not use tools.'
            : 'Summarize only the received work. Follow the GraphQL work-handoff output contract.' },
        }))
        const workspace = WorkspaceSchema.parse({ id: fixture.scope.workspaceId, name: 'NIM-2691 native qualification' })
        const canonicalPath = await realpath(projectPath), details = await stat(projectPath)
        await pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
          values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [workspace.id, JSON.stringify(workspace),
          JSON.stringify({ runnerId: 'runner-local', rootPath: canonicalPath }),
          JSON.stringify({ device: String(details.dev), inode: String(details.ino) })])
        for (const [index, configuration] of configurations.entries()) {
          const agent = AgentSchema.parse({ id: configuration.agentId, name: `NIM-2691 Agent ${index + 1}`,
            productRole: 'coder', harness: configuration.harness.harness,
            model: configuration.harness.model, effort: 'high', fastMode: false,
            harnessConfiguration: configuration.harness, prompt: configuration.prompt,
            assignedSkills: [], configurationVersionId: configuration.id })
          await pool.query(`insert into agents(id,workspace_id,record)
            values($1,$2,$3::jsonb)`, [agent.id, workspace.id, JSON.stringify(agent)])
          await pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`,
          [configuration.id, workspace.id, agent.id, JSON.stringify(configuration)])
          await pool.query('update agents set current_configuration_version_id=$2 where id=$1',
            [agent.id, configuration.id])
        }
        const access = new PostgresAccessService(pool)
        const writer = await access.issue({ name: 'NIM-2691 native test owner', audience: 'operator',
          expiresAt: new Date(Date.now() + 10 * 60_000), grants: [
            { actions: ['capabilities:read'], scope: {} },
            { actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'),
              scope: { workspaceIds: [workspace.id] } },
          ] })
        const headers = { host: 'localhost', authorization: `Bearer ${writer.token}` }
        const created = await app.inject({ method: 'POST',
          url: `/api/management/workspaces/${workspace.id}/workflows`, headers,
          payload: { workspaceId: workspace.id, commandId: randomUUID(), name: 'NIM-2691 single native turn' } })
        expect(created.statusCode, created.body).toBe(201)
        const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
        const graph = { ...fixture.version.definition, id: managed.workflow.id,
          version: managed.workflow.version, createdAt: managed.workflow.createdAt,
          updatedAt: managed.workflow.updatedAt, name: managed.workflow.name,
          nodes: fixture.version.definition.nodes.map((node, index) => ({ ...node,
            ...(scenario.review && index === 0 ? { choice: { outcomes: [{ outcome: 'review',
              target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] } } : {}),
            initialPrompt: scenario.approval && index === 0
              ? 'First call the shell tool with exactly pwd. After its approval and result, return a short greeting in latestDeliverable and finish.'
              : scenario.review
              ? index === 0
                ? 'Submit one review request using routing.kind request and routing.outcome review. Put a short greeting in latestDeliverable.'
                : 'Return to the exact requestId in input.work.request using routing.kind return and routing.outcome accepted. Keep latestDeliverable non-null and remainingFindings empty.'
              : scenario.form === 'conditional' && index === 0
                ? 'Return a short greeting in latestDeliverable, use routing.kind finish, and select routing.outcome go.'
              : index === 0
                ? 'Return a short greeting as latestDeliverable and finish.'
                : 'Summarize only the received work in latestDeliverable and finish.' })),
          edges: fixture.version.definition.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
          handoffs: { contractVersion: 1 }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: configurations.length } }
        const saveInput = CurrentWorkflowSaveInputSchema.parse({ workspaceId: workspace.id,
          workflowId: managed.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
          expectedRevision: managed.revision, expectedWorkflowVersionId: null,
          expectedAgentConfigurationVersionIds: Object.fromEntries(configurations.map((configuration) => [configuration.agentId, configuration.id])),
          expectedLocationRevision: 1, graph })
        const savedResponse = await app.inject({ method: 'PUT', headers,
          url: `/api/management/workspaces/${workspace.id}/workflows/${managed.workflow.id}/definition`,
          payload: saveInput })
        expect(savedResponse.statusCode, savedResponse.body).toBe(200)
        const saved = CurrentWorkflowSaveResultSchema.parse(savedResponse.json())
        const started = await app.inject({ method: 'POST', headers,
          url: `/api/management/workspaces/${workspace.id}/workflows/${managed.workflow.id}/runs`,
          payload: { workspaceId: workspace.id, workflowId: managed.workflow.id,
            workflowVersionId: saved.value.version.id, executionSemanticsVersion: 3,
            commandId: randomUUID(), expectedWorkflowRevision: saved.value.revision,
            expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
            expectedLocationRevision: 1, input: { task: 'Say hello once.' } } })
        expect(started.statusCode, started.body).toBe(202)
        const runId = started.json().run.id as string
        const user = scenario.approval ? await access.issue({ name: 'NIM-2691 read-only approval tester',
          audience: 'user', expiresAt: new Date(Date.now() + 10 * 60_000), grants: [{
            actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: [workspace.id] },
          }] }) : undefined
        const approved = new Set<string>()
        let state: string | undefined, outcome: string | undefined
        for (let attempt = 0; attempt < 180; attempt++) {
          if (user) {
            const pendingResponse: { statusCode: number; body: string; json(): unknown } = await app.inject({ method: 'GET',
              url: `/api/user/interactions?workspaceId=${encodeURIComponent(workspace.id)}&workflowId=${encodeURIComponent(managed.workflow.id)}&runId=${encodeURIComponent(runId)}&status=pending&limit=20`,
              headers: { host: 'localhost', authorization: `Bearer ${user.token}` } })
            expect(pendingResponse.statusCode, pendingResponse.body).toBe(200)
            const pending: ReturnType<typeof ListInteractionsResponseSchema.parse>['items'] =
              ListInteractionsResponseSchema.parse(pendingResponse.json()).items
            for (const interaction of pending) {
              if (approved.has(interaction.id)) continue
              const request = interaction.request as { permission?: unknown; patterns?: unknown }
              if (interaction.nativeRequestType !== 'permission.asked' || request.permission !== 'bash'
                || !Array.isArray(request.patterns) || request.patterns.length !== 1 || request.patterns[0] !== 'pwd') {
                throw new Error('The native provider asked for a permission other than the exact read-only pwd command.')
              }
              const choice = interaction.responseOptions.find((option) => option.semantic === 'approve_once')
              assert.ok(choice)
              const response = await app.inject({ method: 'POST',
                url: `/api/user/interactions/${interaction.id}/respond`,
                headers: { host: 'localhost', authorization: `Bearer ${user.token}` },
                payload: { interactionId: interaction.id, optionId: choice.optionId, expectedRevision: interaction.revision } })
              expect(response.statusCode, response.body).toBe(200)
              approved.add(interaction.id)
            }
          }
          const row = (await pool.query<{ execution_state: string; record: { outcome?: string } }>(
            'select execution_state,record from runs where id=$1', [runId])).rows[0]
          state = row?.execution_state; outcome = row?.record.outcome
          if (state === 'completed') break
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        const runError = (await pool.query<{ code: string | null }>(
          `select record #>> '{result,error,code}' as code from runs where id=$1`, [runId])).rows[0]
        const executions = (await pool.query<{ id: string; state: string; outcome: string | null; code: string | null }>(
          `select id,record->>'state' as state,record #>> '{result,outcome}' as outcome,
            record #>> '{result,error,code}' as code from harness_executions where run_id=$1 order by id`, [runId])).rows
        const activityKinds = (await pool.query<{ kind: string }>(
          'select kind from run_activity where run_id=$1 order by sequence', [runId])).rows.map((row) => row.kind)
        expect({ state, outcome }, JSON.stringify({ runError, executions, activityKinds, startupErrors }))
          .toEqual({ state: 'completed', outcome: 'succeeded' })
        if (scenario.approval) {
          const nativeTypes = (await pool.query<{ type: string }>(`select e.record->>'type' as type
            from harness_native_events e join harness_executions x on x.id=e.execution_id
            where x.run_id=$1 order by e.sequence`, [runId])).rows.map((row) => row.type)
          expect(approved.size, JSON.stringify({ nativeTypes })).toBeGreaterThan(0)
        }
        expect((await pool.query('select 1 from run_work_results where run_id=$1', [runId])).rowCount).toBe(configurations.length)
        expect((await pool.query('select 1 from run_repeat_executions where run_id=$1 and work_activation_id is not null',
          [runId])).rowCount).toBe(configurations.length)
        const nativeVersions = (await pool.query<{ harness: string; provider_version: string }>(`
          select s.reference->>'harness' as harness,s.reference->>'providerVersion' as provider_version
            from execution_native_sessions s join harness_executions e on e.id=s.execution_id
            where e.run_id=$1 order by e.workflow_node_id`, [runId])).rows
        expect(nativeVersions.map((item) => item.harness).sort()).toEqual([...scenario.providers].sort())
        expect(nativeVersions.every((item) => /^(?:codex-cli )?\d+\.\d+\.\d+$/.test(item.provider_version))).toBe(true)
        if (configurations.length > 1) {
          const usage = (await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
            [runId])).rows
          expect(usage).toHaveLength(fixture.version.definition.edges.length)
          expect(usage.every((item) => item.used === 1)).toBe(true)
          expect((await pool.query('select 1 from run_work_requests where run_id=$1', [runId])).rowCount)
            .toBe(fixture.version.definition.edges.length)
          expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
            [runId, fixture.version.definition.nodes[0]!.id])).rowCount).toBe(1)
          const lineages = (await pool.query<{ request_id: string; source_digest: string; result_digest: string;
            recipient_request_id: string; recipient_digest: string; recipient_activation_id: string; destination_activation_id: string }>(`
              select r.request_id,r.payload_digest as source_digest,x.result_digest,
                coalesce(e.record #>> '{input,work,request,requestId}',
                  (select item #>> '{request,requestId}' from jsonb_array_elements(e.record #> '{input,work,sources}') item
                    where item #>> '{request,requestId}'=r.request_id)) as recipient_request_id,
                coalesce(e.record #>> '{input,work,request,payloadDigest}',
                  (select item #>> '{request,payloadDigest}' from jsonb_array_elements(e.record #> '{input,work,sources}') item
                    where item #>> '{request,requestId}'=r.request_id)) as recipient_digest,
                e.work_activation_id as recipient_activation_id,
                r.destination_activation_id
              from run_work_requests r join run_work_results x on x.execution_id=r.requester_execution_id
                join harness_executions e on e.work_activation_id=r.destination_activation_id
              where r.run_id=$1 order by r.request_id`, [runId])).rows
          expect(lineages).toHaveLength(fixture.version.definition.edges.length)
          for (const lineage of lineages) {
            expect(lineage.request_id).toBe(lineage.recipient_request_id)
            expect(lineage.source_digest).toBe(lineage.result_digest)
            expect(lineage.source_digest).toBe(lineage.recipient_digest)
            expect(lineage.destination_activation_id).toBe(lineage.recipient_activation_id)
          }
          if (scenario.form === 'parallel') {
            const joins = (await pool.query<{ activation_id: string }>(`select activation_id
              from run_work_activations where run_id=$1 and cause_kind='join'`, [runId])).rows
            expect(joins).toHaveLength(1)
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and work_activation_id=$2',
              [runId, joins[0]!.activation_id])).rowCount).toBe(1)
          }
          if (scenario.review) {
            const returned = (await pool.query<{ outcome: string; continuation: string | null }>(
              'select outcome,requester_continuation_activation_id as continuation from run_work_returns where run_id=$1',
              [runId])).rows
            expect(returned).toEqual([{ outcome: 'accepted', continuation: null }])
            expect((await pool.query('select 1 from run_work_activations where run_id=$1 and workflow_node_id=$2',
              [runId, fixture.version.definition.nodes[0]!.id])).rowCount).toBe(1)
          }
        }
        await production.reconcile((error) => { throw error })
        let cleanupPending = true
        for (let attempt = 0; attempt < 30; attempt++) {
          cleanupPending = (await pool.query<{ pending: boolean }>(
            'select pending from run_cleanup_intents where run_id=$1', [runId])).rows[0]?.pending ?? true
          if (!cleanupPending) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        expect(cleanupPending).toBe(false)
        const liveCredentials = (await pool.query<{ count: string }>(`select count(*)::text as count
          from worker_credential_bindings b join management_principals p on p.id=b.principal_id
          where b.run_id=$1 and p.revoked_at is null`, [runId])).rows[0]
        expect(Number(liveCredentials?.count)).toBe(0)
      } finally {
        await app?.close().catch(() => undefined)
        await Promise.allSettled([checkpoints.close(), database.close()])
        await rm(projectPath, { recursive: true, force: true })
      }
    })
  }, 240000)
})
