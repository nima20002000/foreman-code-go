import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { createProductionJobs } from '../src/modules/jobs/production.js'
import { jobComputerHasCapacity } from '../src/modules/jobs/computerSelection.js'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { RemoteJobExecutionHost } from '../src/modules/runs/remote/jobExecutionHost.js'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { retainedJobFixture } from './helpers/retainedJobFixture.js'

describe.skipIf(!postgresEnabled)('production Job closure and retained-attempt recovery', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let principal: Awaited<ReturnType<PostgresAccessService['issue']>>['principal']
  beforeEach(async () => {
    database = await currentDatabase()
    principal = (await new PostgresAccessService(database.pool).issue({ name: 'Recovery writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ scope: {}, actions: [
        'jobs:start', 'jobs:read', 'jobs:cancel', 'job_definitions:read', 'job_definitions:write',
        'sources:read', 'source_roots:read', 'settings:read', 'settings:update', 'workspace_locations:read',
      ] }] })).principal
  }, 60000)
  afterEach(async () => { await database?.close() })

  it.each(['cancelled', 'disabled'] as const)('settles %s before delivery and recovers interrupted source closure', async reason => {
    const f = await retainedJobFixture(database.pool, database.directory, principal)
    const capacity = () => jobComputerHasCapacity(database.pool, f.spec.target, f.profile)
    const closed = vi.fn(async () => { throw new Error('Lost source-close acknowledgement') })
    const create = (interrupted: boolean) => createProductionJobs({ pool: database.pool, commands: f.commands,
      locations: f.locations, mainId: f.mainId, runtimeRoot: f.runtimeRoot,
      storageRoot: join(f.runtimeRoot, 'storage'),
      endpoint: () => { throw new Error('Undelivered attempts cannot contact a Worker') },
      infrastructure: { installedConfiguration: null },
      ...(interrupted ? { transferMaterializationClosed: closed } : {}) })
    let runtime = await create(true)
    try {
      expect(await capacity()).toBe(false)
      if (reason === 'cancelled') {
        await expect(runtime.jobs.cancel(principal, 'mcp', f.workspaceId, f.execution.id, randomUUID()))
          .rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
      } else {
        await runtime.buildComputers.update(principal, 'http', { target: buildComputerTarget(f.spec.target),
          commandId: randomUUID(), expectedRevision: 0, buildEnabled: false, buildPriority: 100 })
        await expect(runtime.dispatch.wake(f.execution.id)).rejects.toThrow('Lost source-close acknowledgement')
      }
      expect(closed).toHaveBeenCalledOnce()
      const execution = await runtime.jobs.getExecution(principal, f.workspaceId, f.execution.id)
      expect(execution.process).toMatchObject({ phase: 'terminal', processStopped: true,
        outcome: reason === 'cancelled' ? 'cancelled' : 'preparation_failed' })
      expect(await capacity()).toBe(false)
      await runtime.close()
      runtime = await create(false)
      await runtime.dispatch.wake(f.execution.id)
      expect(await capacity()).toBe(true)
      const persisted = (await database.pool.query(`select d.delivery_attempted,d.last_receipt,m.state,s.released_at
        from job_dispatch_intents d join source_execution_materializations m on m.execution_id=d.execution_id
        join job_computer_selections s on s.execution_id=d.execution_id where d.execution_id=$1`, [f.execution.id])).rows[0]
      expect(persisted).toMatchObject({ delivery_attempted: false, last_receipt: null, state: 'closed',
        released_at: expect.any(Date) })
      expect(await readFile(join(f.root.binding.canonicalPath, f.record.receipt.materializationId, 'tree/app.mjs'), 'utf8'))
        .toContain('retained = true')
      await expect(readFile(join(f.root.binding.canonicalPath, `binding-${f.root.binding.rootId}.lock`)))
        .rejects.toMatchObject({ code: 'ENOENT' })
      // A completed attempt stays fenced even if the computer is enabled again.
      const settings = await runtime.buildComputers.read(principal, { target: buildComputerTarget(f.spec.target) })
      await runtime.buildComputers.update(principal, 'http', { target: buildComputerTarget(f.spec.target),
        commandId: randomUUID(), expectedRevision: settings.preference.revision, buildEnabled: true, buildPriority: 100 })
      await runtime.dispatch.wake(f.execution.id)
      expect((await runtime.jobs.getExecution(principal, f.workspaceId, f.execution.id)).process).toEqual(execution.process)
    } finally { await runtime.close() }
  })

  it('reconciles and cancels the original journal after restart with expired qualification and unavailable inspection', async () => {
    const f = await retainedJobFixture(database.pool, database.directory, principal)
    const intent = (await database.pool.query<{ intent: RemoteJobDispatchIntent }>(
      'select intent from job_dispatch_intents where execution_id=$1', [f.execution.id])).rows[0]!.intent
    const journalPath = join(f.runtimeRoot, 'journal')
    let journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
    const connection = { kind: 'main' as const, mainId: f.mainId, mainInstallationId: f.mainId, bootId: randomUUID() }
    const incarnationId = randomUUID()
    await journal.jobAccept(intent, f.execution, connection, incarnationId)
    await database.pool.query('update job_dispatch_intents set delivery_attempted=true where execution_id=$1', [f.execution.id])
    let runtime: Awaited<ReturnType<typeof createProductionJobs>>
    const native = vi.fn(async (): Promise<never> => { throw new Error('Recovery cannot create a native execution') })
    const create = async () => {
      const host = new RemoteJobExecutionHost({ journal, connection, incarnationId, supervisor: native,
        source: { verify: native }, inputs: { prepare: native }, appendLog: native, collectOutputs: native,
        authorize: async (_intent, execution, action) => {
          const sql = await database.pool.connect()
          try {
            const fence = { attemptId: execution.attemptId, owner: execution.owner }
            if (action === 'start') await runtime.dispatch.requireLaunch(sql, execution, fence)
            else await runtime.dispatch.requireControl(sql, execution, fence)
          } finally { sql.release() }
        }, observeReceipt: receipt => runtime.dispatch.observeReceipt(f.workspaceId, f.execution.id, receipt) })
      return createProductionJobs({ pool: database.pool, commands: f.commands, locations: f.locations,
        mainId: f.mainId, runtimeRoot: f.runtimeRoot, storageRoot: join(f.runtimeRoot, 'storage'),
        endpoint: () => { throw new Error('Main recovery cannot contact a Worker') },
        infrastructure: { installedConfiguration: null, localExecution: host } })
    }
    runtime = await create()
    try {
      await runtime.dispatch.wake(f.execution.id)
      expect((await runtime.jobs.getExecution(principal, f.workspaceId, f.execution.id)).transport).toBe('connected')
      await runtime.close()
      await journal.close()
      journal = await RemoteOperationJournal.open(journalPath)
      const expired = { ...f.profile.measurement!, expiresAt: new Date(Date.now() - 1).toISOString() }
      await database.pool.query('update job_runtime_qualification_approvals set measurement=$2::jsonb where profile_id=$1',
        [f.profile.id, JSON.stringify(expired)])
      runtime = await create()
      await expect(runtime.host.descriptor(f.profile)).rejects.toMatchObject({ code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE' })
      const inspection = vi.spyOn(runtime.host, 'descriptor')
      await expect(runtime.profiles.revalidate(database.pool, principal, f.root, f.spec))
        .rejects.toMatchObject({ code: 'JOB_RUNTIME_UNQUALIFIED' })
      await runtime.dispatch.wake(f.execution.id)
      await runtime.jobs.cancel(principal, 'mcp', f.workspaceId, f.execution.id, randomUUID())
      const execution = await runtime.jobs.getExecution(principal, f.workspaceId, f.execution.id)
      expect(execution).toMatchObject({ id: f.execution.id, attemptId: f.execution.attemptId,
        operationId: f.execution.operationId, acceptedSpec: f.execution.acceptedSpec,
        process: { phase: 'terminal', outcome: 'cancelled', processStopped: true }, publication: 'complete' })
      expect(inspection).not.toHaveBeenCalled()
      expect(native).not.toHaveBeenCalled()
      expect(await journal.jobStatus(f.execution.operationId)).toMatchObject({ status: 'known', receipt: {
        intent, connection, workerIncarnationId: incarnationId, entryAttempted: false, stopFence: true,
        terminal: { outcome: 'cancelled', processStopped: true }, publication: 'complete',
      } })
      const status = await journal.jobStatus(f.execution.operationId)
      if (status.status !== 'known') throw new Error('Original retained receipt missing')
      const persisted = (await database.pool.query<{ last_receipt: unknown; receipt_sequence: string }>(
        'select last_receipt,receipt_sequence::text from job_dispatch_intents where execution_id=$1',
        [f.execution.id])).rows[0]!
      expect(persisted.last_receipt).toEqual(status.receipt)
      expect(persisted.receipt_sequence).toBe(String(status.receipt.sequence))
      expect(await runtime.dispatch.readAcceptedClosureReceipt(database.pool, {
        workspaceId: f.workspaceId, executionId: execution.id, attemptId: execution.attemptId,
        operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner,
      })).toEqual(status.receipt)
      expect((await database.pool.query('select state from source_execution_materializations where execution_id=$1',
        [f.execution.id])).rows[0]).toEqual({ state: 'closed' })
      expect(await jobComputerHasCapacity(database.pool, f.spec.target, f.profile)).toBe(true)
    } finally {
      await runtime.close()
      await journal.close()
    }
  })
})
