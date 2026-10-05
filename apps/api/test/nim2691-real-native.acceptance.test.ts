import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, AgentSchema, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  ListInteractionsResponseSchema, WorkspaceSchema } from '@foreman-code/contracts'
import { ManagementActionSchema, RunEventsPageSchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  RunActivitiesPageSchema, RunHandoffsReadSchema, SavedManagedWorkflowCommandResultSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { loadConfig } from '../src/config.js'
import { buildProductionApp } from '../src/production.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { APP_MCP_TOKEN, appLauncherPath, appLauncherTokenName, appMcpServerName,
  installAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { CodexMcpConnections } from '../src/modules/harnesses/codexMcpConnections.js'
import { OpenCodeMcpConnections } from '../src/modules/harnesses/openCodeMcpConnections.js'
import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { record } from '../src/modules/harnesses/nativeMcpCommon.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'

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
    { name: 'single Codex activation', form: 'single', providers: ['codex'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'Codex to OpenCode handoff', form: 'sequential', providers: ['codex', 'opencode'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'Codex conditional final route to OpenCode', form: 'conditional',
      providers: ['codex', 'opencode'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'Codex to OpenCode accepted review return', form: 'sequential', providers: ['codex', 'opencode'],
      review: true, approval: false, capLoop: false, attemptFourth: false },
    { name: 'OpenCode read-only approval before Codex handoff', form: 'sequential',
      providers: ['opencode', 'codex'], review: false, approval: true, capLoop: false, attemptFourth: false },
    { name: 'unequal Codex and OpenCode branches into one all-required join', form: 'parallel',
      providers: ['codex', 'opencode', 'codex', 'opencode'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'third needs-changes review reroutes from C to D', form: 'parallel',
      providers: ['codex', 'opencode', 'codex', 'opencode'], review: false, approval: false, capLoop: true, attemptFourth: false },
    { name: 'attempted fourth C request is denied before D reroute', form: 'parallel',
      providers: ['codex', 'opencode', 'codex', 'opencode'], review: false, approval: false, capLoop: true, attemptFourth: true },
    { name: 'no valid route preserves findings after the third C review', form: 'parallel',
      providers: ['codex', 'opencode', 'codex', 'opencode'], review: false, approval: false,
      capLoop: true, attemptFourth: false, noRoute: true },
    { name: 'accepted third C review needs no B continuation', form: 'parallel',
      providers: ['codex', 'opencode', 'codex', 'opencode'], review: false, approval: false,
      capLoop: true, attemptFourth: false, finalAccepted: true },
  ] as const)('finishes $name with exact accepted results and cleanup', async (scenario) => {
    const noRoute = 'noRoute' in scenario && scenario.noRoute
    const finalAccepted = 'finalAccepted' in scenario && scenario.finalAccepted
    await nim2691TaskDatabase(async (pool, directory, suppliedUrl) => {
      const projectPath = join(directory, 'workspaces')
      const runtimeRoot = join(directory, 'runtime')
      await mkdir(projectPath, { mode: 0o700 })
      await mkdir(runtimeRoot, { mode: 0o700 })
      await installAppLauncher()
      const binaries = harnessBinaries(process.env)
      const codexConnections = await new CodexMcpConnections(binaries.codexBinary, projectPath)
        .read(AbortSignal.timeout(30_000))
      const codexServerName = appMcpServerName(codexConnections.effective)
      const codexTokenName = appLauncherTokenName('codex', record(codexConnections.effective[codexServerName]))
        ?? APP_MCP_TOKEN
      await mkdir(join(projectPath, '.codex'))
      await writeFile(join(projectPath, '.codex', 'config.toml'), [
        `[mcp_servers.${codexServerName}]`,
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(appLauncherPath())}]`,
        `env_vars = [${JSON.stringify(codexTokenName)}]`,
        '',
      ].join('\n'), { mode: 0o600 })
      if (scenario.providers.some((provider) => provider === 'opencode')) {
        const openCodeConnections = await new OpenCodeMcpConnections(binaries.openCodeBinary, projectPath)
          .read(AbortSignal.timeout(30_000))
        const openCodeServerName = appMcpServerName(openCodeConnections.effective)
        // OpenCode merges environment maps across layers; reuse the installed credential reference.
        const openCodeTokenName = openCodeConnections.credentialReferences?.[openCodeServerName] ?? APP_MCP_TOKEN
        await writeFile(join(projectPath, 'opencode.json'), JSON.stringify({ mcp: { [openCodeServerName]: {
          type: 'local', command: [process.execPath, appLauncherPath()], enabled: true,
          environment: { [openCodeTokenName]: `{env:${openCodeTokenName}}` },
        } } }), { mode: 0o600 })
      }
      const port = await taskPort()
      const config = { ...loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: String(port),
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
        const startupErrors: Array<{ code: string; detail?: string }> = []
        const start = production.engine.start.bind(production.engine)
        production.engine.start = async (runId) => {
          try { return await start(runId) }
          catch (error) {
            let code = error instanceof Error ? error.name : 'unknown'
            if (error instanceof DomainError) code = error.code
            else if (error instanceof HarnessExecutionError) code = error.result.error?.code ?? error.name
            const diagnostic: (typeof startupErrors)[number] = { code }
            if (error instanceof DomainError && error.code === 'APP_MCP_PREFLIGHT_FAILED') {
              diagnostic.detail = error.message
            }
            startupErrors.push(diagnostic)
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
            : { harness: 'codex', model: process.env.NIM2691_CODEX_MODEL ?? 'gpt-5.6-luna',
              reasoningEffort: process.env.NIM2691_CODEX_REASONING_EFFORT ?? 'medium',
              sandbox: 'read-only', serviceTier: 'standard' },
          prompt: { system: scenario.capLoop
            ? finalAccepted && index === 1
              ? 'You are requester B. On work_request and needs-changes work_return, always output a new routing.kind request with outcome review_c. Never output routing.kind return. Follow the node initial prompt and the Foreman Code work-handoff output contract. Do not use tools.'
              : 'Follow the node initial prompt and the Foreman Code work-handoff output contract. Do not use tools.'
            : index === 0
            ? scenario.approval
              ? 'Use exactly one read-only shell command: pwd. Wait for the authorized response. Then follow the Foreman Code work-handoff output contract.'
              : 'Follow the Foreman Code work-handoff output contract. Do not use tools.'
            : 'Summarize only the received work. Follow the Foreman Code work-handoff output contract.' },
        }))
        const workspace = WorkspaceSchema.parse({ id: fixture.scope.workspaceId, name: 'NIM-2691 native qualification' })
        const canonicalPath = await realpath(projectPath), details = await stat(projectPath)
        await pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
          values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [workspace.id, JSON.stringify(workspace),
          JSON.stringify({ runnerId: 'runner-local', rootPath: canonicalPath }),
          JSON.stringify({ device: String(details.dev), inode: String(details.ino) })])
        for (const [index, configuration] of configurations.entries()) {
          const agent = AgentSchema.parse({ id: configuration.agentId,
            name: scenario.capLoop ? ['A', 'B', 'C', 'D'][index]! : `NIM-2691 Agent ${index + 1}`,
            productRole: 'coder', harness: configuration.harness.harness,
            model: configuration.harness.model,
            effort: configuration.harness.harness === 'codex' ? configuration.harness.reasoningEffort : 'high',
            fastMode: false,
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
        const capEdges = scenario.capLoop ? [
          { id: `edge-${randomUUID()}`, kind: 'execution' as const,
            source: fixture.version.definition.nodes[0]!.id, target: fixture.version.definition.nodes[1]!.id },
          { id: `edge-${randomUUID()}`, kind: 'execution' as const,
            source: fixture.version.definition.nodes[1]!.id, target: fixture.version.definition.nodes[2]!.id,
            maxWorkHandoffsPerRun: 3 },
          { id: `edge-${randomUUID()}`, kind: 'execution' as const,
            source: fixture.version.definition.nodes[noRoute || finalAccepted ? 0 : 1]!.id,
            target: fixture.version.definition.nodes[3]!.id,
            ...(!noRoute && !finalAccepted ? { maxWorkHandoffsPerRun: 1 } : {}) },
        ] : undefined
        const graph = { ...fixture.version.definition, id: managed.workflow.id,
          version: managed.workflow.version, createdAt: managed.workflow.createdAt,
          updatedAt: managed.workflow.updatedAt, name: managed.workflow.name,
          nodes: fixture.version.definition.nodes.map((node, index) => ({ ...node,
            ...(scenario.capLoop ? { name: ['A', 'B', 'C', 'D'][index] } : {}),
            ...(scenario.capLoop && index === 3 ? { join: undefined } : {}),
            ...(scenario.capLoop && index === 1 ? { choice: { outcomes: [
              { outcome: 'review_c', target: { kind: 'edge', relationshipId: capEdges![1]!.id } },
              ...(!noRoute && !finalAccepted ? [{ outcome: 'review_d', target: { kind: 'edge' as const,
                relationshipId: capEdges![2]!.id } }] : []),
            ] } } : {}),
            ...(scenario.review && index === 0 ? { choice: { outcomes: [{ outcome: 'review',
              target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] } } : {}),
            initialPrompt: scenario.capLoop
              ? [
                'Finish with latestDeliverable {"revision":0} and remainingFindings [].',
                scenario.attemptFourth
                  ? 'This is the admission-denial qualification. Produce a structured routing decision, not prose. If input.work.kind is work_request or work_return, ALWAYS output routing {"kind":"request","outcome":"review_c"}, even when a limit notice is present. That fourth request is a deliberate diagnostic; the backend must deny it locally without starting C. Do not select review_d on a work_return. Only when input.work.kind is limit_denial, output routing {"kind":"request","outcome":"review_d"}, preserving input.work.notice.latestDeliverable and remainingFindings. Never request C again after limit_denial.'
                  : finalAccepted
                  ? 'You are B, the requester, never the reviewer. NEVER output routing.kind return or reuse returned.requestId as routing.requestId. On input.work.kind work_request, submit routing {"kind":"request","outcome":"review_c"} with latestDeliverable {"revision":0} and remainingFindings []. On every input.work.kind work_return with outcome needs_changes, output routing {"kind":"request","outcome":"review_c"} again, preserving input.work.returned.latestDeliverable and remainingFindings. An accepted review creates no continuation turn for you.'
                  : noRoute
                  ? 'If input.work.kind is work_request or a work_return without a notice, submit routing.kind request with outcome review_c, preserving latestDeliverable and remainingFindings. On the third work_return with input.work.notice, there is no connected alternative from B: output routing {"kind":"finish"}, preserve input.work.returned.latestDeliverable and remainingFindings without claiming approval. Never request C after the notice.'
                  : 'If input.work.kind is work_request, submit routing.kind request with outcome review_c and latestDeliverable {"revision":0}. If input.work.kind is work_return and input.work.notice exists, submit a new request with outcome review_d, preserving returned.latestDeliverable and returned.remainingFindings. Otherwise submit a new request with outcome review_c, preserving returned.latestDeliverable and returned.remainingFindings. Never finish before D returns.',
                finalAccepted
                  ? 'Return to the exact input.work.request.requestId. If its acceptedSourceResult.output.data.latestDeliverable.revision is less than 2, use routing.outcome needs_changes, add one to the revision and include one finding. At revision 2, return routing.outcome accepted, preserve the deliverable and set remainingFindings []. Never create a fourth review.'
                  : 'Return to the exact input.work.request.requestId with routing.kind return and outcome needs_changes. Set latestDeliverable.revision to the prior latestDeliverable.revision plus one. Include one remaining finding. Never accept.',
                'Return to the exact input.work.request.requestId with routing.kind return and outcome accepted. Preserve the latest deliverable and set remainingFindings to [].',
              ][index]
              : scenario.approval && index === 0
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
          edges: capEdges ?? fixture.version.definition.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
          handoffs: { contractVersion: 1 }, executionPolicy: { maxParallelism: 1,
            maxNodeExecutions: scenario.capLoop ? 12 : configurations.length } }
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
        const approved = new Set<string>()
        let state: string | undefined, outcome: string | undefined
        for (let attempt = 0; attempt < (scenario.capLoop ? 420 : 180); attempt++) {
          if (scenario.approval) {
            const pendingResponse: { statusCode: number; body: string; json(): unknown } = await app.inject({ method: 'GET',
              url: `/api/user/interactions?workspaceId=${encodeURIComponent(workspace.id)}&workflowId=${encodeURIComponent(managed.workflow.id)}&runId=${encodeURIComponent(runId)}&status=pending&limit=20`,
              headers: { host: 'localhost' } })
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
                headers: { host: 'localhost' },
                payload: { interactionId: interaction.id, optionId: choice.optionId, expectedRevision: interaction.revision } })
              if (response.statusCode === 409 && (response.json() as { error?: { code?: string } }).error?.code === 'REVISION_CONFLICT') {
                continue // The native request changed after the list read; refetch its current revision.
              }
              expect(response.statusCode, response.body).toBe(200)
              approved.add(interaction.id)
            }
          }
          const row = (await pool.query<{ execution_state: string; record: { outcome?: string } }>(
            'select execution_state,record from runs where id=$1', [runId])).rows[0]
          state = row?.execution_state; outcome = row?.record.outcome
          if (state === 'completed' || noRoute && state === 'waiting'
            && (await pool.query('select 1 from run_work_direction_waits where run_id=$1', [runId])).rowCount === 1) break
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        const runError = (await pool.query<{ code: string | null }>(
          `select record #>> '{result,error,code}' as code from runs where id=$1`, [runId])).rows[0]
        const executions = (await pool.query<{ id: string; state: string; outcome: string | null; code: string | null }>(
          `select id,record->>'state' as state,record #>> '{result,outcome}' as outcome,
            record #>> '{result,error,code}' as code from harness_executions where run_id=$1 order by id`, [runId])).rows
        const activityKinds = (await pool.query<{ kind: string }>(
          'select kind from run_activity where run_id=$1 order by sequence', [runId])).rows.map((row) => row.kind)
        const publicEvents = await app.inject({ method: 'GET', headers,
          url: `/api/management/workspaces/${workspace.id}/runs/${runId}/events?limit=500` })
        expect(publicEvents.statusCode, publicEvents.body).toBe(200)
        const publicPage = RunEventsPageSchema.parse(publicEvents.json())
        if (scenario.capLoop) expect(publicPage.items.some((item) => item.kind === 'work_handoff_accepted')).toBe(true)
        expect({ state, outcome }, JSON.stringify({ runError, executions, activityKinds, startupErrors }))
          .toEqual({ state: noRoute ? 'waiting' : 'completed', outcome: noRoute ? 'pending' : 'succeeded' })
        if (noRoute) {
          expect(runError?.code).toBeNull()
          expect(activityKinds).toContain('work_needs_direction')
          expect(activityKinds).toContain('work_direction_wait')
          expect((await pool.query('select 1 from run_work_unresolved where run_id=$1',
            [runId])).rowCount).toBe(1)
        }
        if (scenario.approval) {
          const nativeTypes = (await pool.query<{ type: string }>(`select e.record->>'type' as type
            from harness_native_events e join harness_executions x on x.id=e.execution_id
            where x.run_id=$1 order by e.sequence`, [runId])).rows.map((row) => row.type)
          expect(approved.size, JSON.stringify({ nativeTypes })).toBeGreaterThan(0)
          const approvalEvents = activityKinds.filter((kind) => kind.startsWith('interaction_'))
          expect(approvalEvents).toContain('interaction_decided')
          expect(approvalEvents).toContain('interaction_resolved')
          expect(approvalEvents).toContain('interaction_worker_ack')
          expect(approvalEvents.indexOf('interaction_decided')).toBeLessThan(
            approvalEvents.indexOf('interaction_worker_ack'))
          const approvalActivity = new Map<string, ReturnType<typeof RunActivitiesPageSchema.parse>['items'][number]>()
          let olderCursor: string | null = null
          for (let pageIndex = 0; pageIndex < 11; pageIndex++) {
            const response = await app.inject({ method: 'GET', headers,
              url: `/api/management/workspaces/${workspace.id}/runs/${runId}/activities?limit=100${
                olderCursor ? `&cursor=${encodeURIComponent(olderCursor)}` : ''}` })
            expect(response.statusCode, response.body).toBe(200)
            const page = RunActivitiesPageSchema.parse(response.json())
            for (const item of page.items) if (item.kind === 'approval') approvalActivity.set(item.id, item)
            olderCursor = page.olderCursor
            if (!olderCursor) break
          }
          const approvalStatuses = [...approvalActivity.values()].sort((a, b) =>
            BigInt(a.sequence)<BigInt(b.sequence) ? -1 : 1).map((item) => item.status)
          expect(approvalStatuses).toContain('recorded')
          expect(approvalStatuses).toContain('delivered')
          expect(approvalStatuses).toContain('acknowledged')
          expect(approvalStatuses.indexOf('recorded')).toBeLessThan(approvalStatuses.indexOf('acknowledged'))
        }
        expect((await pool.query('select 1 from run_work_results where run_id=$1', [runId])).rowCount)
          .toBe(scenario.capLoop ? scenario.attemptFourth ? 10 : finalAccepted ? 8 : 9 : configurations.length)
        expect((await pool.query('select 1 from run_repeat_executions where run_id=$1 and work_activation_id is not null',
          [runId])).rowCount).toBe(scenario.capLoop ? scenario.attemptFourth ? 10 : finalAccepted ? 8 : 9 : configurations.length)
        const nativeVersions = (await pool.query<{ harness: string; provider_version: string }>(`
          select s.reference->>'harness' as harness,s.reference->>'providerVersion' as provider_version
            from execution_native_sessions s join harness_executions e on e.id=s.execution_id
            where e.run_id=$1 order by e.workflow_node_id`, [runId])).rows
        if (scenario.capLoop) {
          expect(nativeVersions.map((item) => item.harness).sort())
            .toEqual(['codex', 'codex', 'codex', 'codex', 'opencode', 'opencode', 'opencode', 'opencode',
              ...(!finalAccepted ? ['opencode'] : []), ...(scenario.attemptFourth ? ['opencode'] : [])])
        } else expect(nativeVersions.map((item) => item.harness).sort()).toEqual([...scenario.providers].sort())
        expect(nativeVersions.every((item) => /^(?:codex-cli )?\d+\.\d+\.\d+$/.test(item.provider_version))).toBe(true)
        if (configurations.length > 1) {
          const usage = (await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
            [runId])).rows
          expect(usage).toHaveLength(graph.edges.length)
          expect(usage.map((item) => item.used).sort()).toEqual(scenario.capLoop ? [1, 1, 3] :
            Array(graph.edges.length).fill(1))
          expect((await pool.query('select 1 from run_work_requests where run_id=$1', [runId])).rowCount)
            .toBe(scenario.capLoop ? 5 : graph.edges.length)
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
          expect(lineages).toHaveLength(scenario.capLoop ? 5 : graph.edges.length)
          for (const lineage of lineages) {
            expect(lineage.request_id).toBe(lineage.recipient_request_id)
            expect(lineage.source_digest).toBe(lineage.result_digest)
            expect(lineage.source_digest).toBe(lineage.recipient_digest)
            expect(lineage.destination_activation_id).toBe(lineage.recipient_activation_id)
          }
          if (scenario.form === 'parallel' && !scenario.capLoop) {
            const joins = (await pool.query<{ activation_id: string }>(`select activation_id
              from run_work_activations where run_id=$1 and cause_kind='join'`, [runId])).rows
            expect(joins).toHaveLength(1)
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and work_activation_id=$2',
              [runId, joins[0]!.activation_id])).rowCount).toBe(1)
          }
          if (scenario.capLoop) {
            const capUsage = (await pool.query<{ used: number }>(`select used from run_work_connection_usage
              where run_id=$1 and relationship_id=$2`, [runId, capEdges![1]!.id])).rows[0]
            expect(capUsage?.used).toBe(3)
            const handoffsHttp = await app.inject({ method: 'GET', headers,
              url: `/api/management/workspaces/${workspace.id}/runs/${runId}/handoffs` })
            expect(handoffsHttp.statusCode, handoffsHttp.body).toBe(200)
            const handoffs = RunHandoffsReadSchema.parse(handoffsHttp.json())
            expect(handoffs.connections.find((item) => item.relationshipId === capEdges![1]!.id))
              .toMatchObject({ used: 3, limit: 3, remaining: 0 })
            expect(handoffs.notices).toHaveLength(scenario.attemptFourth ? 2 : finalAccepted ? 0 : 1)
            if (noRoute) expect(handoffs).toMatchObject({ directionWait: true,
              unresolved: [expect.objectContaining({ reason: 'finish_with_findings' })] })
            const activityPath = `/api/management/workspaces/${workspace.id}/runs/${runId}/activities?limit=100`
            const activities = new Map<string, ReturnType<typeof RunActivitiesPageSchema.parse>['items'][number]>()
            let olderCursor: string | null = null
            for (let pageIndex = 0; pageIndex < 11; pageIndex++) {
              const response = await app.inject({ method: 'GET', headers,
                url: `${activityPath}${olderCursor ? `&cursor=${encodeURIComponent(olderCursor)}` : ''}` })
              expect(response.statusCode, response.body).toBe(200)
              const page = RunActivitiesPageSchema.parse(response.json())
              for (const item of page.items) activities.set(item.id, item)
              olderCursor = page.olderCursor
              if (!olderCursor) break
            }
            const activityItems = [...activities.values()]
            expect(activityItems.some((item) => item.kind === 'work_request')).toBe(true)
            expect(activityItems.some((item) => item.kind === 'work_return')).toBe(true)
            if (noRoute) expect(activityItems.some((item) => item.kind === 'needs_direction')).toBe(true)
            else if (!finalAccepted) {
              expect(activityItems.some((item) => item.kind === 'work_notice'
                && item.status === 'delivered')).toBe(true)
              expect(activityItems.some((item) => item.kind === 'reroute')).toBe(true)
            }
            expect((await pool.query('select 1 from run_work_denials where run_id=$1', [runId])).rowCount)
              .toBe(scenario.attemptFourth ? 1 : 0)
            const notice = (await pool.query<{ record: { message: string }; delivery_state: string }>(`
              select record,delivery_state from run_work_notices where run_id=$1`, [runId])).rows
            expect(notice).toHaveLength(scenario.attemptFourth ? 2 : finalAccepted ? 0 : 1)
            expect(notice.every((item) => item.record.message === 'The maximum number of work handoffs to agent C has been reached (3 of 3 for this Run). Choose another available agent or finish with the remaining findings.')).toBe(true)
            expect(notice.every((item) => item.delivery_state === 'delivered')).toBe(true)
            const returns = (await pool.query<{ outcome: string }>(`select outcome from run_work_returns
              where run_id=$1 order by returned_at`, [runId])).rows
            expect(returns.map((item) => item.outcome).sort()).toEqual(
              (finalAccepted ? ['accepted', 'accepted', 'needs_changes', 'needs_changes']
                : ['accepted', 'needs_changes', 'needs_changes', 'needs_changes']).sort())
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
              [runId, fixture.version.definition.nodes[0]!.id])).rowCount).toBe(1)
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
              [runId, fixture.version.definition.nodes[2]!.id])).rowCount).toBe(3)
            if (finalAccepted) expect((await pool.query(`select 1 from harness_executions
              where run_id=$1 and workflow_node_id=$2`,
            [runId, fixture.version.definition.nodes[1]!.id])).rowCount).toBe(3)
            if (scenario.attemptFourth) expect((await pool.query(`select 1 from run_work_activations
              where run_id=$1 and cause_kind='limit_denial'`, [runId])).rowCount).toBe(1)
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
        if (noRoute) {
          expect((await pool.query<{ execution_state: string }>('select execution_state from runs where id=$1',
            [runId])).rows[0]?.execution_state).toBe('waiting')
          const stop = await app.inject({ method: 'POST', headers,
            url: `/api/management/workspaces/${workspace.id}/runs/${runId}/stop`,
            payload: { workspaceId: workspace.id, runId, commandId: randomUUID() } })
          expect(stop.statusCode, stop.body).toBe(200)
          for (let attempt = 0; attempt < 60; attempt++) {
            const row = (await pool.query<{ execution_state: string }>(
              'select execution_state from runs where id=$1', [runId])).rows[0]
            if (row?.execution_state === 'completed') break
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          expect((await pool.query<{ execution_state: string; outcome: string }>(
            `select execution_state,record->>'outcome' as outcome from runs where id=$1`,
            [runId])).rows[0]).toEqual({ execution_state: 'completed', outcome: 'canceled' })
          const stopKinds = (await pool.query<{ kind: string }>(
            `select kind from run_activity where run_id=$1
              and kind in ('run_stop_requested','run_cleanup_checked') order by sequence`,
            [runId])).rows.map((row) => row.kind)
          expect(stopKinds).toContain('run_stop_requested')
          expect(stopKinds).toContain('run_cleanup_checked')
          const stoppedActivities = await app.inject({ method: 'GET', headers,
            url: `/api/management/workspaces/${workspace.id}/runs/${runId}/activities?limit=100` })
          expect(stoppedActivities.statusCode, stoppedActivities.body).toBe(200)
          const stopPage = RunActivitiesPageSchema.parse(stoppedActivities.json())
          expect(stopPage.items.some((item) => item.kind === 'stop')).toBe(true)
          expect(stopPage.items.some((item) => item.kind === 'recovery')).toBe(true)
        }
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
  }, 600000)
})
