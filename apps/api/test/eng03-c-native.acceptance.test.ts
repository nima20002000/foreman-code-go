import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { cgroupBoundary, killCgroup } from '../src/modules/harnesses/recovery/cgroupBoundary.js'
import { bootIdentity, identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { runEng03NativeScenario, type Eng03NativeControl } from './helpers/eng03NativeAcceptance.js'

async function startedBranches({ pool, runId, nodeIds, runs }: Eng03NativeControl) {
  const deadline = Date.now() + 120_000
  let started: Array<{ execution_id: string; native_session_id: string }> = []
  while (Date.now() < deadline) {
    started = (await pool.query<{ execution_id: string; native_session_id: string }>(
      `select distinct he.id as execution_id,he.record->>'nativeSessionId' as native_session_id
       from harness_executions he join harness_native_events ne on ne.execution_id=he.id
       where he.run_id=$1 and he.workflow_node_id=any($2::text[])
         and ne.record->>'type'='turn.started' and he.record->>'nativeSessionId' is not null`,
      [runId, [nodeIds[1], nodeIds[2]]],
    )).rows
    if (started.length === 2 || (await runs.get(runId))?.executionState === 'completed') break
    await delay(250)
  }
  expect(started).toHaveLength(2)
  expect(new Set(started.map((item) => item.native_session_id)).size).toBe(2)
  return started
}

/** Paid-provider, task-owned internal qualification. Public app acceptance is separate. */
describe.skipIf(process.env.RUN_ENG03_C_NATIVE_TESTS !== '1')('ENG-03 C live native lifecycle', () => {
  it('E03-L01 stops two positively started Codex branches without starting Reviewer', async () => {
    let started: Array<{ execution_id: string; native_session_id: string }> = []
    const result = await runEng03NativeScenario('E03-L01', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, engine, runs, startTask } = context
        started = await startedBranches(context)
        await engine.cancel(runId)
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
    const result = await runEng03NativeScenario('E03-L02', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, registry, runs, startTask } = context
        const started = await startedBranches(context)
        interruptedExecutionId = started[0]!.execution_id
        await registry.closeOwner(`execution:${interruptedExecutionId}`)
        await startTask.catch(() => undefined)
        expect((await runs.get(runId))?.outcome).toBe('failed')
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(0)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; executions: Array<{ id: string; result?: { outcome: string } }>
    }
    expect(artifact.runOutcome).toBe('failed')
    expect(artifact.cleanup).toBe(true)
    // The provider reports this interrupted turn as canceled. The saved
    // selected-path policy fails the Run and cancels the sibling; it cannot
    // turn either canceled branch into accepted success.
    expect(artifact.executions.find((item) => item.id === interruptedExecutionId)?.result?.outcome).toBe('canceled')
    expect(artifact.executions.filter((item) => item.result?.outcome === 'canceled')).toHaveLength(2)
  }, 180_000)

  it('E03-L02 fails after an exact task-owned native cgroup exits abnormally', async () => {
    let interruptedExecutionId = ''
    let fault: { registrationId: string; guardianPid: number; guardianStartTicks: string; cgroup: string; at: string } | undefined
    const result = await runEng03NativeScenario('E03-L02', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, runtimeDirectory, registry, runs, startTask } = context
        const started = await startedBranches(context)
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
      executions: Array<{ id: string; result?: { outcome: string } }>
    }
    expect(artifact.runOutcome).toBe('failed')
    expect(artifact.cleanup).toBe(true)
    expect(artifact.activeCredentialCount).toBe(0)
    // An abruptly killed provider turn was observed as canceled. The selected
    // path fails the Run, and the sibling is canceled without a Reviewer launch.
    expect(artifact.executions.find((item) => item.id === interruptedExecutionId)?.result?.outcome).toBe('canceled')
    expect(artifact.executions.filter((item) => item.result?.outcome === 'canceled')).toHaveLength(2)
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
})
