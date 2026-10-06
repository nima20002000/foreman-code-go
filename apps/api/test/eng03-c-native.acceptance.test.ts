import { timeRuntimeOperation } from '../src/infrastructure/runtimeTiming.js'
import { readCurrentExecutions } from './helpers/wave25Agent3.js'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, DurableInteractionSchema, HarnessExecutionSchema,
  type NativeSessionReference } from '@foreman-code/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { cgroupBoundary, killCgroup } from '../src/modules/harnesses/recovery/cgroupBoundary.js'
import { bootIdentity, identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import type { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { repeatDigest, type RepeatNodeInput, type RepeatInputBinding } from '../src/modules/runs/repeatResolution.js'
import { registerApprovalCheckpointResume } from '../src/modules/runs/approvalCheckpointRegistration.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { runEng03NativeScenario, type Eng03NativeControl } from './helpers/eng03NativeAcceptance.js'
import { qualifyEng03OpenCode } from './helpers/eng03OpenCodeQualification.js'
import { configureNativeWorkflowMcp } from './helpers/nativeWorkflowMcp.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'

async function startedBranches({ pool, runId, nodeIds, runs, publicationChanged }: Eng03NativeControl) {
  const deadline = Date.now() + 120_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, 120_000) })
  let started: Array<{ execution_id: string; native_session_id: string }> = []
  try {
    while (Date.now() < deadline) {
      const changed = publicationChanged()
      started = (await pool.query<{ execution_id: string; native_session_id: string }>(
        `select distinct he.id as execution_id,he.record->>'nativeSessionId' as native_session_id
         from harness_executions he join harness_native_events ne on ne.execution_id=he.id
         where he.run_id=$1 and he.workflow_node_id=any($2::text[])
           and ne.record->>'type'='turn.started' and he.record->>'nativeSessionId' is not null`,
        [runId, [nodeIds[1], nodeIds[2]]],
      )).rows
      if (started.length === 2 || (await runs.get(runId))?.executionState === 'completed') break
      await timeRuntimeOperation('engine', 'acceptance.publication_wait', () => Promise.race([changed, expired]),
        { runId })
    }
  } finally { clearTimeout(timer) }
  expect(started).toHaveLength(2)
  expect(new Set(started.map((item) => item.native_session_id)).size).toBe(2)
  return started
}

/** Paid-provider, task-owned internal qualification. Public app acceptance is separate. */
describe.skipIf(process.env.RUN_ENG03_C_NATIVE_TESTS !== '1')('ENG-03 C live native lifecycle', () => {
  it('uses the fixture MCP launcher and rejects an unmanaged replacement before credential delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-workflow-mcp-'))
    const codexBinary = process.env.ENG03_A_CODEX_BINARY ?? harnessBinaries(process.env).codexBinary
    const manager = new CodexAppServerSessionManager(codexBinary)
    let restore: (() => Promise<void>) | undefined
    try {
      restore = await configureNativeWorkflowMcp({ projectDirectory: directory,
        runtimeDirectory: directory, codexBinary })
      const configured = await manager.inspectMcpConfiguration(directory)
      expect(configured.configured.automaticEndpoint).toBe(true)
      const detection = new McpDetectionService(codexMcpInspectorAdapter(manager), 'http://127.0.0.1:1/mcp')
      const input = { harness: 'codex' as const, runnerId: 'fixture', workingDirectory: directory }
      expect((await detection.preflight(input)).detection.state).toBe('status_unavailable')
      await writeFile(join(process.env.CODEX_HOME!, 'config.toml'), [
        `[mcp_servers.${configured.serverName}]`,
        `command = ${JSON.stringify(process.execPath)}`,
        'args = ["--version"]',
        `env_vars = [${JSON.stringify(configured.configured.bearerTokenEnvironmentVariable)}]`,
        '',
      ].join('\n'), { mode: 0o600 })
      await expect(detection.preflight(input)).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    } finally {
      try { await manager.dispose() }
      finally {
        try { await restore?.() }
        finally { await rm(directory, { recursive: true, force: true }) }
      }
    }
  }, 90_000)

  it('E03-L01 stops two positively started Codex branches without starting Reviewer', async () => {
    let started: Array<{ execution_id: string; native_session_id: string }> = []
    const result = await runEng03NativeScenario('E03-L01', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, stop, runs, startTask } = context
        started = await startedBranches(context)
        await stop()
        await startTask.catch(() => undefined)
        expect((await runs.get(runId))?.outcome).toBe('canceled')
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(0)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; nativeEventSummary: Array<{ id: string; events: Array<{ type: string }> }>
    }
    expect(artifact.runOutcome).toBe('canceled')
    expect(artifact.cleanup).toBe(true)
    expect(started).toHaveLength(2)
  }, 180_000)

  it('E03-L02 fails the Run when one active task-owned process closes, then settles its sibling', async () => {
    let interruptedExecutionId = ''
    let originalBranches: Array<{ execution_id: string; native_session_id: string }> = []
    const result = await runEng03NativeScenario('E03-L02', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, registry, runs, startTask } = context
        const started = await startedBranches(context)
        originalBranches = started
        interruptedExecutionId = started[0]!.execution_id
        await registry.closeOwner(`execution:${interruptedExecutionId}`)
        await startTask.catch(() => undefined)
        expect((await runs.get(runId))?.outcome).toBe('failed')
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(0)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; activeCredentialCount: number
      executions: Array<{ id: string; nativeSessionId?: string; result?: { outcome: string; error?: { code: string; retryable: boolean } } }>
    }
    expect(artifact.runOutcome).toBe('failed')
    expect(artifact.cleanup).toBe(true)
    // The interrupted turn has a genuine native canceled source. Without a
    // persisted Stop, closure without an accepted terminal is EXECUTION_INTERRUPTED.
    expect(artifact.executions.find((item) => item.id === interruptedExecutionId)?.result?.outcome).toBe('canceled')
    const sibling = originalBranches.find((item) => item.execution_id !== interruptedExecutionId)!
    expect(artifact.executions.find((item) => item.id === sibling.execution_id)?.result).toMatchObject({
      outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false },
    })
    for (const original of originalBranches) expect(artifact.executions.find((item) => item.id === original.execution_id)?.nativeSessionId).toBe(original.native_session_id)
    expect(artifact.activeCredentialCount).toBe(0)
  }, 180_000)

  it('E03-L02 fails after an exact task-owned native cgroup exits abnormally', async () => {
    let interruptedExecutionId = ''
    let originalBranches: Array<{ execution_id: string; native_session_id: string }> = []
    let fault: { registrationId: string; guardianPid: number; guardianStartTicks: string; cgroup: string; at: string } | undefined
    const result = await runEng03NativeScenario('E03-L02', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, runtimeDirectory, registry, runs, startTask } = context
        const started = await startedBranches(context)
        originalBranches = started
        interruptedExecutionId = started[0]!.execution_id
        const owner = `execution:${interruptedExecutionId}`
        const scope = registry.scope(owner)
        expect(scope.root).toBe(join(runtimeDirectory, 'native-process-registry'))
        const ownerDirectory = join(scope.root, createHash('sha256').update(owner).digest('hex'))
        const registrations = (await readdir(ownerDirectory)).filter((item) => /^[0-9a-f-]{36}$/.test(item))
        expect(registrations).toHaveLength(1)
        const id = registrations[0]!
        const intent = JSON.parse(await readFile(join(ownerDirectory, id, 'intent.json'), 'utf8')) as {
          id: string; owner: string; boot: string
        }
        const birth = JSON.parse(await readFile(join(ownerDirectory, id, 'birth.json'), 'utf8')) as {
          id: string; owner: string; boot: string; guardian: { pid: number; startTicks: string }; containment: unknown
        }
        expect(intent).toMatchObject({ id, owner, boot: bootIdentity() })
        expect(birth).toMatchObject({ id, owner, boot: intent.boot })
        expect(identityAlive(birth.guardian)).toBe(true)
        const boundary = cgroupBoundary(birth.containment, id)
        fault = { registrationId: id, guardianPid: birth.guardian.pid,
          guardianStartTicks: birth.guardian.startTicks, cgroup: boundary.path, at: new Date().toISOString() }
        killCgroup(boundary)
        await startTask.catch(() => undefined)
        expect((await runs.get(runId))?.outcome).toBe('failed')
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(0)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runId: string; runOutcome: string; cleanup: boolean; activeCredentialCount: number
      executions: Array<{ id: string; nativeSessionId?: string; result?: { outcome: string; error?: { code: string; retryable: boolean } } }>
    }
    expect(artifact.runOutcome).toBe('failed')
    expect(artifact.cleanup).toBe(true)
    expect(artifact.activeCredentialCount).toBe(0)
    // Native canceled is distinct from closure without an accepted terminal.
    // The latter stays failed/nonretryable unless the Run has a persisted Stop.
    expect(artifact.executions.find((item) => item.id === interruptedExecutionId)?.result?.outcome).toBe('canceled')
    const sibling = originalBranches.find((item) => item.execution_id !== interruptedExecutionId)!
    expect(artifact.executions.find((item) => item.id === sibling.execution_id)?.result).toMatchObject({
      outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false },
    })
    for (const original of originalBranches) expect(artifact.executions.find((item) => item.id === original.execution_id)?.nativeSessionId).toBe(original.native_session_id)
    expect(fault).toBeDefined()
    await writeFile(result.artifactPath.replace('.json', '-fault.json'), JSON.stringify({
      scenario: 'E03-L02', mode: 'native internal abnormal task-owned cgroup exit',
      runId: artifact.runId, interruptedExecutionId, fault, providerEvidence: result.artifactPath,
      expected: { runOutcome: 'failed', reviewerStarted: false, cleanup: true },
      actual: { runOutcome: artifact.runOutcome, interruptedOutcome: 'canceled', cleanup: artifact.cleanup,
        activeCredentialCount: artifact.activeCredentialCount },
    }, null, 2))
  }, 180_000)

  it('E03-L03 repeats Start and reconcile during two live turns without extra native submissions', async () => {
    let submissionCounts: number[] = []
    const result = await runEng03NativeScenario('E03-L03', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, engine, startTask } = context
        await startedBranches(context)
        expect(engine.start(runId)).toBe(startTask)
        await engine.reconcile()
        expect(engine.start(runId)).toBe(startTask)
        await startTask
        submissionCounts = (await pool.query<{ workflow_node_id: string; turns: number }>(
          `select he.workflow_node_id,count(distinct ne.record->'payload'->>'turnId')::int as turns
           from harness_executions he join harness_native_events ne on ne.execution_id=he.id
           where he.run_id=$1 and he.workflow_node_id=any($2::text[]) and ne.record->>'type'='turn.started'
           group by he.workflow_node_id order by he.workflow_node_id`,
          [runId, [nodeIds[1], nodeIds[2]]],
        )).rows.map((row) => row.turns)
        expect(submissionCounts).toEqual([1, 1])
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; executions: Array<{ nodeId: string; nativeSessionId?: string }>
    }
    expect(artifact.runOutcome).toBe('succeeded')
    expect(artifact.cleanup).toBe(true)
    expect(submissionCounts).toEqual([1, 1])
    expect(artifact.executions).toHaveLength(4)
    expect(new Set(artifact.executions.map((item) => item.nativeSessionId)).size).toBe(4)
  }, 180_000)

  it('E03-L04 reobserves one active native turn on its exact session without another submission', async () => {
    let observed: { executionId: string; nativeSessionId: string; nativeTurnId: string } | undefined
    const result = await runEng03NativeScenario('E03-L04', 'codex', 'codex', {
      prompts: {
        A: 'Read the accepted Entry result. Without tools or files, list n and n squared modulo 97 for n=1 through 60. End with A-OBSERVED.',
        B: 'Read the accepted Entry result. Without tools or files, list n and n cubed modulo 101 for n=1 through 60. End with B-OBSERVED.',
        Reviewer: 'Read both accepted predecessor results and return exactly OBSERVATION-COMPLETE. Do not use tools or files.',
      },
      control: async (context) => {
        const { pool, runId, nodeIds, runs, approvals, startTask } = context
        const started = await startedBranches(context)
        const execution = (await readCurrentExecutions(runs, runId)).find((item) => item.id === started[0]!.execution_id)!
        const sessions = Reflect.get(approvals, 'ownedSessions') as Map<string, {
          session?: NativeSessionReference; manager: SingleWriterSessionManager
        }>
        const owned = sessions.get(execution.id)
        expect(owned?.session?.nativeSessionId).toBe(execution.nativeSessionId)
        expect(owned!.manager.isActive(owned!.session!)).toBe(true)
        const correlationId = `execution:${execution.id}`
        const history = await owned!.manager.reconcile(owned!.session!, correlationId, AbortSignal.timeout(20_000))
        expect(history.correlationId).toBe(correlationId)
        expect(history.nativeTurnId).toBeTruthy()
        observed = { executionId: execution.id, nativeSessionId: owned!.session!.nativeSessionId,
          nativeTurnId: history.nativeTurnId! }
        await startTask
        const turns = await pool.query<{ count: number }>(
          `select count(distinct record->'payload'->>'turnId')::int as count from harness_native_events
           where execution_id=$1 and record->>'type'='turn.started'`, [execution.id],
        )
        expect(turns.rows[0]?.count).toBe(1)
        expect((await runs.getExecution(execution.id))?.nativeSessionId).toBe(observed.nativeSessionId)
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(1)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as { runOutcome: string; cleanup: boolean }
    expect(artifact.runOutcome).toBe('succeeded')
    expect(artifact.cleanup).toBe(true)
    expect(observed).toBeDefined()
    await writeFile(result.artifactPath.replace('.json', '-observation.json'), JSON.stringify({
      scenario: 'E03-L04', mode: 'native internal active same-session reobservation',
      providerEvidence: result.artifactPath, observed, distinctNativeTurns: 1,
      runOutcome: artifact.runOutcome, cleanup: artifact.cleanup,
    }, null, 2))
  }, 180_000)

  describe('OpenCode approval lifecycle', () => {
    let closeQualification: (() => Promise<void>) | undefined
    beforeAll(async () => { closeQualification = await qualifyEng03OpenCode() }, 360_000)
    afterAll(async () => { await closeQualification?.() }, 30_000)

  it('E03-A01 isolates a native approval wait from its progressing sibling', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'eng03-c-approval-'))
    const target = join(outside, 'approved.txt')
    const command = `echo APPROVED > '${target}'`
    let interactionId = '', sessionId = '', siblingActiveAtWait = false
    let approvalEvidence: unknown
    try {
      const result = await runEng03NativeScenario('E03-A01', 'opencode', 'codex', {
        harnessOverrides: { A: { harness: 'opencode', model: process.env.ENG03_OPENCODE_MODEL ?? 'opencode-go/gpt-5.6-luna',
          variant: 'high', nativeAgent: 'build', thinking: false, autoApprove: false,
          advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
            permissionRules: [{ permission: 'bash', pattern: '*', effect: 'ask' }] } } },
        prompts: { A: [
          `Use the shell tool once to run exactly: ${command}.`,
          'Leave workdir unset so the shell uses the accepted project directory.',
          'Do not inspect directories, read files, or run any other commands.',
          'This is a task-owned output path outside your project.',
          'Wait for the User approval, finish the command, and end with A-APPROVED.',
        ].join(' '),
          B: 'Read the accepted Entry result. Without tools or files, list n and n squared modulo 97 for n=1 through 120, one row per n. End with B-PROGRESSED.' },
        control: async ({ pool, runId, nodeIds, runs, approvals, interactions, budgets, engine, startTask }) => {
          const controlStarted = Date.now()
          const progress = (stage: string) => process.stdout.write(`ENG03 A01 progress ${JSON.stringify({
            runId, stage, elapsedMs: Date.now() - controlStarted,
          })}\n`)
          progress('control started')
          const deadline = Date.now() + 120_000
          let pending: ReturnType<typeof DurableInteractionSchema.parse> | undefined
          let observedInterruptId: string | undefined
          while (Date.now() < deadline) {
            const row = (await pool.query<{ record: unknown }>(
              `select record from durable_interactions where run_id=$1 order by created_at limit 1`, [runId],
            )).rows[0]
            if (row) {
              pending = DurableInteractionSchema.parse(row.record)
              interactionId = pending.id; sessionId = pending.nativeSessionId
              if (pending.graphInterruptId && pending.graphInterruptId !== observedInterruptId) {
                observedInterruptId = pending.graphInterruptId
                progress('approval bound')
              }
              const sibling = (await readCurrentExecutions(runs, runId)).find((item) => item.workflowNodeId === nodeIds[2])
              const nativeStarted = (await pool.query(`select 1 from harness_native_events where execution_id=$1
                and record->>'type'='turn.started' limit 1`, [sibling?.id ?? ''])).rowCount === 1
              if (nativeStarted && sibling?.state !== 'completed') siblingActiveAtWait = true
              if (pending.graphInterruptId && (await runs.get(runId))?.executionState === 'waiting'
                && sibling?.result?.outcome === 'succeeded') break
            }
            if ((await runs.get(runId))?.executionState === 'completed') break
            await delay(250)
          }
          expect(pending?.graphInterruptId).toBeTruthy()
          progress('approval wait assertions')
          expect(pending!.request).toMatchObject({ permission: 'bash', metadata: { command } })
          expect(siblingActiveAtWait).toBe(true)
          expect((await runs.get(runId))?.executionState).toBe('waiting')
          const budget = (await pool.query<{ active_started_at: Date | null; approval_wait_started_at: Date | null }>(
            'select active_started_at,approval_wait_started_at from approval_execution_state where execution_id=$1',
            [pending!.executionId],
          )).rows[0]!
          expect(budget.active_started_at).toBeNull()
          expect(budget.approval_wait_started_at).not.toBeNull()
          const service = new InteractionService(interactions, budgets, approvals,
            (interaction) => engine.resumeInteraction(interaction))
          registerApprovalCheckpointResume(service, engine)
          const access = new PostgresAccessService(pool)
          const wrong = await access.issue({ name: 'C wrong approval handler', audience: 'operator',
            expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['interactions:respond'], scope: { runIds: [runId] } }] })
          const option = pending!.responseOptions.find((item) => item.semantic === 'approve_once')
          expect(option).toBeDefined()
          await expect(service.respond({ kind: 'user', principal: wrong.principal }, { interactionId: pending!.id,
            optionId: option!.optionId, expectedRevision: pending!.revision })).rejects.toBeDefined()
          const user = await access.issue({ name: 'C exact User', audience: 'user',
            expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['interactions:read', 'interactions:respond'],
              scope: { runIds: [runId] } }] })
          progress('response started')
          const response = await service.respond({ kind: 'user', principal: user.principal }, { interactionId: pending!.id,
            optionId: option!.optionId, expectedRevision: pending!.revision })
          progress(`response returned ${response.interaction.deliveryState}`)
          const delivered = response.interaction.deliveryState === 'uncertain'
            ? await service.reconcile(response.interaction) : response.interaction
          if (delivered.deliveryState !== 'delivered') {
            const attempts = (await pool.query<{ attempt: number; state: string; error: string | null;
              evidence: unknown; approval_write_started_at: Date | null }>(
              `select attempt,state,error,evidence,approval_write_started_at from interaction_delivery_attempts
               where interaction_id=$1 order by attempt`, [pending!.id],
            )).rows
            const native = (await pool.query<{ type: string; occurred_at: string }>(
              `select record->>'type' as type,record->>'occurredAt' as occurred_at from harness_native_events
               where execution_id=$1 order by sequence`, [pending!.executionId],
            )).rows
            await writeFile(join(tmpdir(), `eng03-c-a01-diagnostic-${runId}.json`), JSON.stringify({
              runId, interactionId: pending!.id, nativeSessionId: pending!.nativeSessionId,
              nativeRequestId: pending!.nativeRequestId, responseOptionId: option!.optionId,
              firstDeliveryState: response.interaction.deliveryState, reconciledDeliveryState: delivered.deliveryState,
              attempts, native,
            }, null, 2))
          }
          expect(delivered.deliveryState).toBe('delivered')
          progress('response delivered')
          await startTask.catch(() => undefined)
          progress('original Run task joined')
          // The original Start may already have finished at the waiting
          // checkpoint. Join the exact current resumed/reconciled Run task.
          await engine.start(runId)
          progress('continued Run task joined')
          expect((await runs.get(runId))?.outcome).toBe('succeeded')
          const effects = await pool.query<{ effect_kind: string; count: number }>(
            `select effect_kind,count(*)::int as count from run_graph_effects where run_id=$1
             and effect_kind in ('approval.decide','approval.deliver') group by effect_kind`, [runId],
          )
          expect(effects.rows).toEqual(expect.arrayContaining([
            { effect_kind: 'approval.decide', count: 1 }, { effect_kind: 'approval.deliver', count: 1 },
          ]))
          const attempts = (await pool.query<{ attempt: number; state: string; evidence: unknown }>(
            'select attempt,state,evidence from interaction_delivery_attempts where interaction_id=$1 order by attempt',
            [pending!.id],
          )).rows
          const resume = (await pool.query<{ state: string }>(
            'select state from interaction_graph_resumes where interaction_id=$1', [pending!.id],
          )).rows[0]
          approvalEvidence = { runId, interactionId: pending!.id, executionId: pending!.executionId,
            nativeSessionId: pending!.nativeSessionId, nativeRequestId: pending!.nativeRequestId,
            optionId: option!.optionId, siblingActiveAtWait, wrongHandlerDenied: true,
            waitBudgetPaused: budget.active_started_at === null && budget.approval_wait_started_at !== null,
            firstDeliveryState: response.interaction.deliveryState, finalDeliveryState: delivered.deliveryState,
            attempts, resume, effects: effects.rows }
        },
      })
      const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
        runOutcome: string; cleanup: boolean; sourceGraph: { nodes: Array<{ id: string }> }
        executions: Array<{ id: string; nativeSessionId?: string; nodeId: string; result?: unknown; input: unknown }>
        accepted: RepeatNodeInput['predecessors']
        bindings: RepeatInputBinding[]
      }
      expect(artifact.runOutcome).toBe('succeeded')
      expect(artifact.cleanup).toBe(true)
      expect(interactionId).toBeTruthy()
      expect(artifact.executions.some((item) => item.nativeSessionId === sessionId)).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('APPROVED\n')
      const reviewer = artifact.executions.find((item) => item.nodeId === artifact.sourceGraph.nodes[3]?.id)!
      const input = reviewer.input as RepeatNodeInput
      expect(input.predecessors).toHaveLength(2)
      expect(artifact.accepted).toEqual(input.predecessors)
      expect(artifact.bindings).toHaveLength(2)
      const recipientDigest = repeatDigest(reviewer.input)
      for (const [ordinal, predecessor] of input.predecessors.entries()) {
        const sender = artifact.executions.find((item) => item.id === predecessor.execution.executionId)!
        const binding = artifact.bindings.find((item) => 'relationshipId' in item.source && item.source.relationshipId === predecessor.relationshipId)!
        expect(predecessor.acceptedResult).toEqual(sender.result)
        expect(binding).toMatchObject({ ordinal, source: { execution: { executionId: sender.id }, acceptedResultDigest: repeatDigest(sender.result) },
          recipient: { executionId: reviewer.id }, inputDigest: recipientDigest })
      }
      await writeFile(result.artifactPath.replace('.json', '-approval.json'), JSON.stringify({
        scenario: 'E03-A01', mode: 'native internal User approval',
        providerEvidence: result.artifactPath, approvalEvidence,
        outcome: artifact.runOutcome, cleanup: artifact.cleanup,
        exactJoin: { reviewerExecutionId: reviewer.id, recipientInputDigest: recipientDigest,
          predecessors: input.predecessors.map((item) => ({ relationshipId: item.relationshipId,
            senderExecutionId: item.execution.executionId, acceptedResultDigest: repeatDigest(item.acceptedResult) })) },
      }, null, 2))
    } finally { await rm(outside, { recursive: true, force: true }) }
  }, 180_000)

  })

  it('E03-L04 restarts after one native terminal result but before its graph acceptance', async () => {
    let cutExecutionId = '', cutNativeSessionId = ''
    let cutResult: unknown
    let acceptedSiblingId = '', beforeNativeEventCount = -1, afterNativeEventCount = -1
    const result = await runEng03NativeScenario('E03-L04', 'codex', 'codex', {
      prompts: {
        A: 'Read the accepted Entry result. Without tools or files, list n and n squared for n=1 through 25. End with A-RECOVERY.',
        B: 'Read the accepted Entry result. Without tools or files, list n and n cubed for n=1 through 30. End with B-RECOVERY.',
        Reviewer: 'Read the two accepted predecessor results and return exactly RECOVERED. Do not use tools or files.',
      },
      control: async ({ pool, runId, nodeIds, runs, startTask, restartRecoverableRuntime }) => {
        const original = RepeatRunRepository.prototype.acceptTerminal
        let injected = false
        const spy = vi.spyOn(RepeatRunRepository.prototype, 'acceptTerminal').mockImplementation(
          async function (this: RepeatRunRepository, ...args: Parameters<RepeatRunRepository['acceptTerminal']>) {
            const [executionId] = args
            const row = (await pool.query<{ workflow_node_id: string; accepted: boolean; record: unknown }>(
              'select workflow_node_id,accepted,record from harness_executions where id=$1 and run_id=$2',
              [executionId, runId],
            )).rows[0]
            if (row && !injected && [nodeIds[1], nodeIds[2]].includes(row.workflow_node_id)) {
              const sibling = await pool.query(
                `select 1 from harness_executions where run_id=$1 and id<>$2
                 and workflow_node_id=any($3::text[]) and accepted=true limit 1`,
                [runId, executionId, [nodeIds[1], nodeIds[2]]],
              )
              const execution = HarnessExecutionSchema.parse(row.record)
              if (sibling.rowCount && !row.accepted && execution.state === 'completed'
                && execution.result?.outcome === 'succeeded' && execution.nativeSessionId) {
                injected = true
                cutExecutionId = executionId
                cutNativeSessionId = execution.nativeSessionId
                cutResult = execution.result
                throw new Error('ENG03_C_ACCEPTANCE_CUT')
              }
            }
            return original.apply(this, args)
          },
        )
        try {
          await startTask.catch(() => undefined)
          expect(injected).toBe(true)
          expect((await runs.get(runId))?.executionState).toBe('running')
          const before = (await runs.getExecution(cutExecutionId))!
          expect(before).toMatchObject({ state: 'completed', nativeSessionId: cutNativeSessionId, result: cutResult })
          const accepted = await pool.query<{ id: string }>(
            `select id from harness_executions where run_id=$1 and accepted=true
             and workflow_node_id=any($2::text[])`, [runId, [nodeIds[1], nodeIds[2]]],
          )
          expect(accepted.rowCount).toBe(1)
          acceptedSiblingId = accepted.rows[0]!.id
          const beforeEvents = (await pool.query<{ count: number }>(
            'select count(*)::int as count from harness_native_events where execution_id=$1', [cutExecutionId],
          )).rows[0]!.count
          beforeNativeEventCount = beforeEvents
          spy.mockRestore()
          const next = await restartRecoverableRuntime()
          expect((await next.runs.getExecution(cutExecutionId))?.nativeSessionId).toBe(cutNativeSessionId)
          await next.engine.reconcile()
          await next.engine.start(runId)
          expect((await next.runs.get(runId))?.outcome).toBe('succeeded')
          expect((await next.runs.getExecution(cutExecutionId))?.result).toEqual(cutResult)
          const after = await pool.query<{ accepted: boolean }>('select accepted from harness_executions where id=$1', [cutExecutionId])
          expect(after.rows[0]?.accepted).toBe(true)
          const afterEvents = (await pool.query<{ count: number }>(
            'select count(*)::int as count from harness_native_events where execution_id=$1', [cutExecutionId],
          )).rows[0]!.count
          afterNativeEventCount = afterEvents
          expect(afterEvents).toBe(beforeEvents)
          expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
            [runId, nodeIds[3]])).rowCount).toBe(1)
        } finally { spy.mockRestore() }
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; runtimeRestart?: { kind: string; preservedNativeSessionIds: string[] }
      finalText: string; joinExact: boolean; sourceGraph: { nodes: Array<{ id: string }> }
      executions: Array<{ id: string; nodeId: string; nativeSessionId?: string; result?: unknown; input: unknown }>
      bindings: RepeatInputBinding[]
    }
    expect(artifact.runOutcome).toBe('succeeded')
    expect(artifact.cleanup).toBe(true)
    expect(artifact.runtimeRestart?.kind).toBe('terminal_unaccepted')
    expect(artifact.runtimeRestart?.preservedNativeSessionIds).toContain(cutNativeSessionId)
    expect(artifact.executions.find((item) => item.id === cutExecutionId)?.result).toEqual(cutResult)
    expect(artifact.finalText).toBe('RECOVERED')
    expect(artifact.joinExact).toBe(true)
    const reviewer = artifact.executions.find((item) => item.nodeId === artifact.sourceGraph.nodes[3]?.id)!
    const input = reviewer.input as RepeatNodeInput
    expect(input.predecessors).toHaveLength(2)
    expect(artifact.bindings).toHaveLength(2)
    const recipientInputDigest = repeatDigest(reviewer.input)
    for (const [ordinal, predecessor] of input.predecessors.entries()) {
      const sender = artifact.executions.find((item) => item.id === predecessor.execution.executionId)!
      const binding = artifact.bindings.find((item) => 'relationshipId' in item.source && item.source.relationshipId === predecessor.relationshipId)!
      expect(predecessor.acceptedResult).toEqual(sender.result)
      expect(binding).toMatchObject({ ordinal, source: { execution: { executionId: sender.id }, acceptedResultDigest: repeatDigest(sender.result) },
        recipient: { executionId: reviewer.id }, inputDigest: recipientInputDigest })
    }
    expect(beforeNativeEventCount).toBeGreaterThan(0)
    expect(afterNativeEventCount).toBe(beforeNativeEventCount)
    await writeFile(result.artifactPath.replace('.json', '-recovery.json'), JSON.stringify({
      scenario: 'E03-L04', mode: 'native internal post-terminal recovery', providerEvidence: result.artifactPath,
      recovered: true, runOutcome: artifact.runOutcome, cleanup: artifact.cleanup,
      acceptedSiblingId, cutExecutionId, cutNativeSessionId, cutResultDigest: repeatDigest(cutResult),
      nativeEventCountBeforeRestart: beforeNativeEventCount, nativeEventCountAfterRestart: afterNativeEventCount,
      reviewerExecutionId: reviewer.id, reviewerInputDigest: recipientInputDigest,
      bindings: artifact.bindings,
      finalText: artifact.finalText,
    }, null, 2))
  }, 180_000)
})
