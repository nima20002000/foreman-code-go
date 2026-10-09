import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessProfileEvidenceSchema,
  HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { AcceptedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { placementDigest } from '../src/modules/placement/binding.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>

async function profiles(fixture: Fixture, token = fixture.writer.token) {
  const result = await fixture.call('harness_instances_list', { hostRef: fixture.hostRef,
    applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId }, token)
  expect(result.isError).not.toBe(true)
  return HostHarnessOverrideListSchema.parse(decodeMcpToolResult(result)).overrides
}

async function latestEvidence(fixture: Fixture) {
  const result = await fixture.db.pool.query<{ record: unknown }>(`select distinct on(instance_id) record
    from harness_instance_profile_evidence order by instance_id,instance_revision desc,created_at desc,check_id desc`)
  return result.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record))
}

async function startWhenReady(fixture: Fixture) {
  return waitForRemoteReview(async () => {
    try { return await fixture.start() } catch (error) {
      if (error instanceof Error && error.message.includes('HARNESS_PROFILE_CHECK_PENDING')) return undefined
      throw error
    }
  }, result => result !== undefined, 'Start after installation qualification')
}

async function pinnedPlacements(fixture: Fixture, runId: string) {
  const rows = await fixture.db.pool.query<{ record: unknown }>(
    'select record from run_node_placements where run_id=$1 order by node_id', [runId])
  return rows.rows.map(row => AcceptedNodePlacementSchema.parse(row.record))
}

async function profileReader(fixture: Fixture) {
  const reader = await fixture.access.issue({ name: 'Update readback reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
  const profile = (await profiles(fixture, reader.token))[0]!
  await expectMcpAccessDenied(fixture.call('harness_instance_check', { commandId: randomUUID(),
    instanceId: profile.instanceId, expectedRevision: profile.revision, target: profile.target }, reader.token))
  await expectMcpAccessDenied(fixture.call('run_start', { commandId: randomUUID(),
    workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId,
    workflowVersionId: fixture.version.id, executionSemanticsVersion: 3,
    expectedWorkflowRevision: fixture.version.version, expectedLocationRevision: 1,
    expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds, input: {},
  }, reader.token))
  return reader.token
}

async function runningTurn(fixture: Fixture) {
  const calls = await waitForRemoteReview(() => fixture.provider.calls(), values =>
    values.some(call => call.workflowTurn !== undefined), 'the resident native turn')
  return calls.find(call => call.workflowTurn !== undefined)!.workflowTurn as {
    pid: number; sessionId: string; turnId: string
  }
}

async function completedRun(fixture: Fixture, runId: string) {
  const details = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    return fixture.details(runId)
  }, value => value.run.executionState === 'completed', 'resident Run completion')
  expect(details.run.outcome).toBe('succeeded')
  return details
}

describe('installed harness updates', () => {
  it('starts a Main-only workflow while discovery on an unused Worker is still blocked', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'main' })
    try {
      const reader = await profileReader(fixture)
      await fixture.blockWorkerDiscovery()
      const started = await fixture.start()
      expect((await pinnedPlacements(fixture, started.run.id)).every(pin => pin.hostRef.kind === 'main')).toBe(true)
      expect((await profiles(fixture, reader))[0]!.qualification).toBe('qualified')
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)

  it('cancels Start during required Worker discovery without canceling its shared refresh or persisting a Run', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker' })
    try {
      const reader = await profileReader(fixture)
      await fixture.blockWorkerDiscovery()
      await expect(fixture.start()).rejects.toThrow('RUN_START_PREPARATION_TIMEOUT')
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect((await profiles(fixture, reader))[0]!.qualification).toBe('qualified')
      await fixture.releaseWorkerDiscovery()
      await completedRun(fixture, (await startWhenReady(fixture))!.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)

  it('keeps a Main Codex Run and its pinned outputs valid when only Claude inventory changes', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'main', claudeInventory: true })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const before = await profiles(fixture, reader)
      const proofs = await latestEvidence(fixture)
      const inventory = await fixture.inventory()
      const claudeFingerprint = inventory.installations.find(value => value.driverId === 'claude')!.installationFingerprint
      await fixture.provider.blockWorkflowTurns()
      blocked = true
      const started = await fixture.start()
      const turn = await runningTurn(fixture)
      const pins = await pinnedPlacements(fixture, started.run.id)
      const measurements = (await fixture.db.pool.query(
        'select qualification,evidence from host_harness_measurements order by identity_hash')).rows
      await fixture.claudeInventory!.updatePayload()
      await waitForRemoteReview(() => fixture.inventory(), value => value.installations.some(installation =>
        installation.driverId === 'claude' && installation.installationFingerprint !== claudeFingerprint),
      'Claude-only inventory replacement')
      await waitForRemoteReview(() => profiles(fixture, reader), values =>
        values.every(value => value.qualification === 'qualified'), 'automatic recovery after Claude-only change')
      expect(await profiles(fixture, reader)).toEqual(before)
      expect(await latestEvidence(fixture)).toEqual(proofs)
      expect((await fixture.db.pool.query(
        'select qualification,evidence from host_harness_measurements order by identity_hash')).rows)
        .toEqual(measurements)
      expect(process.kill(turn.pid, 0)).toBe(true)
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
      await completedRun(fixture, started.run.id)
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
      const calls = await fixture.provider.calls()
      expect(calls).toContainEqual({ workflowCompleted: turn })
      const executions = await fixture.executions(started.run.id)
      expect(executions).toHaveLength(1)
      expect(executions[0]!.result).toMatchObject({ outcome: 'succeeded', output: { text: 'fixture complete' } })
    } finally {
      if (blocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)

  it.each(['main', 'worker'] as const)(
    'retains a resident %s Run across unavailable inventory before a completed payload replacement',
    async executionHost => {
      const fixture = await remoteReviewProduction({ workflow: 'single', executionHost })
      let blocked = false
      try {
        const reader = await profileReader(fixture)
        const before = (await profiles(fixture, reader))[0]!
        await fixture.provider.blockWorkflowTurns()
        blocked = true
        const started = await fixture.start()
        const turn = await runningTurn(fixture)
        const pins = await pinnedPlacements(fixture, started.run.id)
        await fixture.provider.removePayload()
        await waitForRemoteReview(() => fixture.inventory(), value => value.installations.some(installation =>
          installation.driverId === 'codex' && !installation.installed && installation.installationFingerprint === null),
        'unavailable intermediate inventory')
        await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
          value.qualification === 'unqualified' && value.qualificationFailure !== undefined), 'unavailable profile readback')
        await expect(fixture.start()).rejects.toThrow('HARNESS_INSTALLATION_INVALID')
        expect(process.kill(turn.pid, 0)).toBe(true)
        await fixture.provider.updatePayload()
        await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
          value.qualification === 'qualified' && value.target.installationFingerprint !== before.target.installationFingerprint),
        'qualified replacement after missing inventory')
        const next = (await startWhenReady(fixture))!
        await fixture.provider.releaseWorkflowTurns()
        blocked = false
        await completedRun(fixture, started.run.id)
        await completedRun(fixture, next.run.id)
        expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
        expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
        expect((await pinnedPlacements(fixture, next.run.id))[0]!.payload).toMatchObject({
          installationFingerprint: (await profiles(fixture, reader))[0]!.target.installationFingerprint,
        })
      } finally {
        if (blocked) await fixture.provider.releaseWorkflowTurns()
        await fixture.close()
      }
    }, 240_000)

  it('runs the updated Main suite after an explicit qualification of the previous payload drains', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'main' })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const before = (await profiles(fixture, reader))[0]!
      const previousCalls = (await fixture.provider.calls()).length
      await fixture.provider.blockQualification()
      blocked = true
      await fixture.value('harness_qualification_run', { harness: 'codex' })
      await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.slice(previousCalls)
        .some(call => call.qualificationSuite !== undefined), 'held explicit suite for the previous payload')
      await fixture.provider.updatePayload()
      const updatedSha = createHash('sha256').update(await readFile(fixture.provider.binary)).digest('hex')
      await waitForRemoteReview(() => profiles(fixture, reader), values =>
        values.every(value => value.qualification === 'qualifying'), 'automatic recovery waiting for the old suite')
      await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
      expect((await fixture.provider.calls()).slice(previousCalls).filter(call => call.qualificationSuite)).toHaveLength(1)
      await fixture.provider.releaseQualification()
      blocked = false
      await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.some(call =>
        (call.qualificationSuite as { binarySha256?: string } | undefined)?.binarySha256 === updatedSha),
      'the native suite executing against the updated binary')
      await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
        value.qualification === 'qualified' && value.target.installationFingerprint !== before.target.installationFingerprint),
      'persisted qualification for the new installation')
      const proof = (await latestEvidence(fixture))[0]!
      expect(proof.qualified).toBe(true)
      expect(proof.target.installationFingerprint).toBe((await profiles(fixture, reader))[0]!.target.installationFingerprint)
      const result = await fixture.db.pool.query<{ status: string }>(
        'select status from harness_qualifications where binary_sha256=$1', [updatedSha])
      expect(result.rows.map(row => row.status)).toEqual(['passed'])
      await completedRun(fixture, (await startWhenReady(fixture))!.run.id)
    } finally {
      if (blocked) await fixture.provider.releaseQualification()
      await fixture.close()
    }
  }, 240_000)

  it('keeps a Worker Run on its original profile proof through a payload update and rollback', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker' })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const original = (await profiles(fixture, reader))[0]!
      await fixture.provider.blockWorkflowTurns()
      blocked = true
      const started = await fixture.start()
      const turn = await runningTurn(fixture)
      const pins = await pinnedPlacements(fixture, started.run.id)
      await fixture.provider.updatePayload()
      await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
        value.qualification === 'qualified' && value.revision === original.revision + 1), 'qualified intermediate payload')
      await fixture.provider.restorePayload()
      await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
        value.qualification === 'qualified' && value.revision === original.revision + 2
          && value.target.installationFingerprint === original.target.installationFingerprint), 'qualified rollback')
      const latest = (await latestEvidence(fixture))[0]!
      const next = (await startWhenReady(fixture))!
      const newPins = await pinnedPlacements(fixture, next.run.id)
      expect(newPins[0]!.payload).toMatchObject({ profileProofDigest: placementDigest(latest) })
      expect(newPins[0]!.payload).not.toEqual(pins[0]!.payload)
      expect(process.kill(turn.pid, 0)).toBe(true)
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
      await completedRun(fixture, started.run.id)
      await completedRun(fixture, next.run.id)
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
      expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
    } finally {
      if (blocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)

  it.each(['main', 'worker'] as const)(
    'automatically checks every qualified %s profile and preserves the running process through authenticated MCP',
    async executionHost => {
      const fixture = await remoteReviewProduction({ workflow: 'single', executionHost })
      let modelsBlocked = false
      let turnsBlocked = false
      try {
        const configured = fixture.profiles[0]!
        const additional = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
          commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target: configured.target,
          presetId: configured.presetId, enabled: true, configuration: configured.configuration,
        })).value
        const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
          commandId: randomUUID(), instanceId: additional.instanceId,
          expectedRevision: additional.revision, target: additional.target,
        }))
        expect(checked.proof.qualified).toBe(true)
        const before = await profiles(fixture)
        expect(before).toHaveLength(2)
        const oldFingerprint = before[0]!.target.installationFingerprint
        const oldProofs = await latestEvidence(fixture)
        await fixture.provider.blockWorkflowTurns()
        turnsBlocked = true
        const oldRun = await fixture.start()
        const original = await waitForRemoteReview(() => fixture.provider.calls(), calls =>
          calls.some(call => call.workflowTurn !== undefined), 'the original native turn')
        const turn = original.find(call => call.workflowTurn !== undefined)!.workflowTurn as {
          pid: number; sessionId: string; turnId: string
        }
        expect(process.kill(turn.pid, 0)).toBe(true)
        await fixture.provider.blockModels()
        modelsBlocked = true
        await fixture.provider.updatePayload()
        await waitForRemoteReview(() => profiles(fixture), values =>
          values.length === before.length && values.every(value => value.qualification === 'qualifying'),
        'automatic installation check pending in MCP readback')
        await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
        expect(process.kill(turn.pid, 0)).toBe(true)

        const reader = await fixture.access.issue({ name: 'Installation profile reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
        const pending = await profiles(fixture, reader.token)
        const profile = pending[0]!
        const denied = await fixture.call('harness_instance_check', { commandId: randomUUID(),
          instanceId: profile.instanceId, expectedRevision: profile.revision, target: profile.target }, reader.token)
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
        await fixture.provider.releaseModels()
        modelsBlocked = false
        const updated = await waitForRemoteReview(() => profiles(fixture, reader.token), values =>
          values.length === before.length && values.every(value => value.qualification === 'qualified'
            && value.target.installationFingerprint !== oldFingerprint), 'qualified updated installation in MCP')
        for (const value of updated) {
          const previous = before.find(profile => profile.instanceId === value.instanceId)!
          expect(value.instanceRevision).toBe(previous.instanceRevision)
          expect(value.revision).toBe(previous.revision + 1)
          expect(value.configuration).toEqual(previous.configuration)
        }
        const evidence = await latestEvidence(fixture)
        expect(evidence).toHaveLength(updated.length)
        expect(evidence.every(proof => proof.qualified
          && proof.target.installationFingerprint === updated[0]!.target.installationFingerprint)).toBe(true)
        const history = await fixture.db.pool.query<{ record: unknown }>(`select record
          from harness_instance_profile_evidence where instance_revision=1 order by instance_id`)
        expect(history.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record)))
          .toEqual(oldProofs)

        const next = (await startWhenReady(fixture))!
        const pins = await fixture.db.pool.query<{ run_id: string; record: { payload: { installationFingerprint: string } } }>(
          'select run_id,record from run_node_placements where run_id=any($1::text[])', [[oldRun.run.id, next.run.id]])
        expect(pins.rows.filter(row => row.run_id === oldRun.run.id)).toHaveLength(fixture.version.definition.nodes.length)
        expect(pins.rows.filter(row => row.run_id === next.run.id)).toHaveLength(fixture.version.definition.nodes.length)
        expect(pins.rows.filter(row => row.run_id === oldRun.run.id)
          .every(row => row.record.payload.installationFingerprint === oldFingerprint)).toBe(true)
        expect(pins.rows.filter(row => row.run_id === next.run.id)
          .every(row => row.record.payload.installationFingerprint === updated[0]!.target.installationFingerprint)).toBe(true)
        await fixture.provider.releaseWorkflowTurns()
        turnsBlocked = false
        await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.some(call => {
          const completed = call.workflowCompleted as typeof turn | undefined
          return completed?.pid === turn.pid && completed.sessionId === turn.sessionId && completed.turnId === turn.turnId
        }), 'completion from the original pinned native process')
        const details = await waitForRemoteReview(async () => {
          await fixture.reconcile()
          return fixture.details(oldRun.run.id)
        }, value => value.run.executionState === 'completed', 'completion of the Run started before the update')
        expect(details.run.workflowVersionId).toBe(fixture.version.id)
        expect(details.run.outcome).toBe('succeeded')
        const updatedRun = await waitForRemoteReview(async () => {
          await fixture.reconcile()
          return fixture.details(next.run.id)
        }, value => value.run.executionState === 'completed', 'completion of the Run on the updated installation')
        expect(updatedRun.run.outcome).toBe('succeeded')
      } finally {
        if (modelsBlocked) await fixture.provider.releaseModels()
        if (turnsBlocked) await fixture.provider.releaseWorkflowTurns()
        await fixture.close()
      }
    }, 240_000)

  it('persists a failed update check and exposes its reason through MCP without admitting a new Run', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'sequential' })
    try {
      await fixture.provider.hideModels()
      await fixture.provider.updatePayload()
      const failed = await waitForRemoteReview(() => profiles(fixture), values => values.every(value =>
        value.qualification === 'unqualified' && value.qualificationFailure !== undefined), 'failed update readback')
      expect(failed).toHaveLength(fixture.profiles.length)
      expect(failed.every(value => value.qualificationFailure!.message.length > 0)).toBe(true)
      expect((await latestEvidence(fixture)).every(proof => !proof.qualified && proof.failure !== undefined)).toBe(true)
      await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_UNAVAILABLE')
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
    } finally { await fixture.close() }
  }, 240_000)
})
