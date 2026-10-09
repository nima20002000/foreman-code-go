import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { DeviceConnectionError } from '../src/modules/devices/deviceWire.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { commit, mainId } from './helpers/ciPreparationFixture.js'
import { persistedMainPreparationFixture } from './helpers/persistedMainPreparationFixture.js'
import { deferred } from './helpers/wave25Agent3.js'

type Fixture = Awaited<ReturnType<typeof persistedMainPreparationFixture>>
type Runtime = Awaited<ReturnType<Fixture['create']>>

describe.skipIf(!postgresEnabled)('Main CI preparation interruption and recovery', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let fixture: Fixture | undefined
  beforeEach(async () => { database = await currentDatabase() }, 60_000)
  afterEach(async () => {
    try { await fixture?.close() } finally { await database?.close() }
    fixture = undefined
  })

  const input = (f: Fixture) => ({ workspaceId: f.fixture.workspaceId,
    profileId: 'p-main', commit, commandId: randomUUID() })
  async function settle(runtime: Runtime) {
    await expect.poll(async () => (await runtime.read()).state, { timeout: 10_000, interval: 10 })
      .toMatch(/^(qualified|failed)$/u)
    return runtime.read()
  }
  async function readBoth(runtime: Runtime) {
    const status = await runtime.read()
    const response = await runtime.httpRead()
    expect(response.status).toBe(200)
    expect(BuildComputerPrepareStatusSchema.parse(await response.json())).toEqual(status)
    return status
  }

  it.each(['source', 'root', 'profile', 'refresh', 'capture', 'qualify'] as const)(
    'resumes Main after interruption at %s without repeating completed side effects', async stage => {
      const reached = deferred()
      const paused = deferred()
      let interrupted = false
      const pause = async () => {
        if (interrupted) return
        reached.resolve()
        await paused.promise
      }
      fixture = await persistedMainPreparationFixture(database, {
        pause: async current => { if (current === stage) await pause() },
        onMainRefresh: async () => { if (stage === 'refresh') await pause() },
      })
      const f = fixture
      const original = await f.create()
      const request = input(f)
      try {
        expect((await original.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
        expect(await f.repository.pending()).toEqual([])
        expect((await original.call('build_computer_prepare', request)).isError).not.toBe(true)
        await reached.promise
        const pending = (await f.repository.pending())[0]!
        expect(pending.status.deviceId).toBe(mainId)
        expect(await readBoth(original)).toEqual(pending.status)
        interrupted = true
        const closing = original.service.close()
        paused.resolve()
        await closing
        const saved = await f.repository.get(pending.id)
        expect(saved.status.state).not.toBe('failed')
        const recovered = await f.create()
        await Promise.all([recovered.service.recover(), recovered.service.recover()])
        const completed = await settle(recovered)
        expect(completed).toMatchObject({ state: 'qualified', deviceId: mainId, commit,
          profiles: [{ profileId: 'p-main', revision: 4, status: 'qualified' }] })
        expect(await readBoth(recovered)).toEqual(completed)
        const replay = await recovered.call('build_computer_prepare', request)
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(replay))).toEqual(completed)
        const replayHttp = await recovered.httpStart({ commandId: request.commandId, commit })
        expect(replayHttp.status).toBe(200)
        expect(BuildComputerPrepareStatusSchema.parse(await replayHttp.json())).toEqual(completed)
        expect(await f.repository.pending()).toEqual([])
        expect((await database.pool.query('select id,device_id,active from ci_runtime_preparations')).rows)
          .toEqual([{ id: pending.id, device_id: mainId, active: false }])
        expect((await database.pool.query(`select result from management_command_receipts
          where principal_id=$1 and operation='build_computer_prepare' and command_id=$2`,
        [f.writer.principal.id, request.commandId])).rows).toEqual([{ result: { operationId: pending.id } }])
        expect(f.fixture.calls.prepare).toHaveLength(1)
        expect(f.fixture.calls.refresh).toHaveLength(1)
        expect(f.fixture.calls.bind).toHaveLength(1)
        expect(f.fixture.calls.saves).toHaveLength(1)
        expect(f.fixture.calls.qualified).toEqual(['p-main'])
      } finally {
        interrupted = true
        paused.resolve()
      }
    }, 30_000)

  it('fences a disconnected owner before a replacement commits the same pending preparation', async () => {
    const reached = deferred()
    const paused = deferred()
    const disconnected = deferred()
    const acquired = deferred<JobOwnership>()
    let interrupted = false
    fixture = await persistedMainPreparationFixture(database, {
      acquire: async (pool, id, onLost) => {
        const owner = await JobOwnership.acquire(pool, id, () => {
          onLost()
          disconnected.resolve()
        })
        if (owner) acquired.resolve(owner)
        return owner
      },
      pause: async stage => {
        if (stage === 'profile' && !interrupted) {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const f = fixture
    const original = await f.create()
    const replacement = await f.create()
    const request = input(f)
    try {
      expect((await original.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
      await original.call('build_computer_prepare', request)
      await reached.promise
      const pending = (await f.repository.pending())[0]!
      const owner = await acquired.promise
      const competing = await JobOwnership.acquire(database.pool, `ci-runtime:${mainId}`, () => undefined)
      try { expect(competing).toBeUndefined() } finally { await competing?.release() }
      const pid = await owner.connection.transaction(async sql => {
        const fence = await owner.readFence(sql)
        return Number(fence.ownerId)
      })
      expect((await database.pool.query<{ stopped: boolean }>(
        'select pg_terminate_backend($1) as stopped', [pid])).rows[0]!.stopped).toBe(true)
      await disconnected.promise
      interrupted = true
      await replacement.service.recover()
      const completed = await settle(replacement)
      expect(completed.state).toBe('qualified')
      const saved = await f.repository.get(pending.id)
      paused.resolve()
      await original.service.close()
      expect(await f.repository.get(pending.id)).toEqual(saved)
      expect(await readBoth(replacement)).toEqual(completed)
      expect(f.fixture.calls.prepare).toHaveLength(1)
      expect(f.fixture.calls.bind).toHaveLength(1)
      expect(f.fixture.calls.saves).toHaveLength(1)
      expect(f.fixture.calls.refresh).toHaveLength(1)
      expect(f.fixture.calls.qualified).toEqual(['p-main'])
    } finally {
      interrupted = true
      paused.resolve()
    }
  }, 30_000)

  it('expires a persisted refresh deadline instead of trusting a stale operation indefinitely', async () => {
    const reached = deferred()
    const paused = deferred()
    let interrupted = false
    fixture = await persistedMainPreparationFixture(database, {
      onMainRefresh: async () => {
        if (!interrupted) {
          reached.resolve()
          await paused.promise
        }
      },
    })
    const f = fixture
    const original = await f.create()
    const request = input(f)
    try {
      await original.call('build_computer_prepare', request)
      await reached.promise
      const pending = (await f.repository.pending())[0]!
      expect(pending.status.state).toBe('refreshing')
      interrupted = true
      const closing = original.service.close()
      paused.resolve()
      await closing
      f.advance(15 * 60_000 + 1)
      const recovered = await f.create()
      await recovered.service.recover()
      const completed = await settle(recovered)
      expect(completed).toMatchObject({ state: 'failed', message: 'The computer did not come back after its runtime refresh.' })
      expect(await readBoth(recovered)).toEqual(completed)
      expect(await f.repository.pending()).toEqual([])
      expect(f.fixture.calls.refresh).toHaveLength(1)
      expect(f.fixture.calls.qualified).toEqual([])
      expect((await recovered.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(
        decodeMcpToolResult((await recovered.call('build_computer_prepare', request))))).toEqual(completed)
      expect(await f.repository.get(pending.id)).toMatchObject({ status: completed })
    } finally {
      interrupted = true
      paused.resolve()
    }
  }, 30_000)

  it('keeps repeated refreshes separate while HTTP and MCP retries reuse each completed operation', async () => {
    fixture = await persistedMainPreparationFixture(database)
    const f = fixture
    const runtime = await f.create()
    const first = input(f)
    const denied = await runtime.httpStart({ commandId: first.commandId, commit }, f.reader.token)
    expect(denied.status).toBe(403)
    expect((await runtime.call('build_computer_prepare', first, f.reader.token)).isError).toBe(true)
    expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
    const started = await runtime.httpStart({ commandId: first.commandId, commit })
    expect(started.status).toBe(200)
    const initial = await settle(runtime)
    expect(initial.state).toBe('qualified')
    const original = (await f.repository.latestForDevice(mainId))!
    const same = await runtime.call('build_computer_prepare', first)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(same))).toEqual(initial)
    expect(f.fixture.calls.refresh).toHaveLength(1)
    const second = input(f)
    expect((await runtime.call('build_computer_prepare', second)).isError).not.toBe(true)
    const completed = await settle(runtime)
    expect(completed).toMatchObject({ state: 'qualified', profiles: [
      { profileId: 'p-main', revision: 5, status: 'qualified' },
    ] })
    expect(await readBoth(runtime)).toEqual(completed)
    const latest = (await f.repository.latestForDevice(mainId))!
    expect(latest.id).not.toBe(original.id)
    expect(await f.repository.get(original.id)).toEqual(original)
    expect(f.fixture.calls.refresh).toEqual([
      expect.objectContaining({ operationId: original.id }), expect.objectContaining({ operationId: latest.id }),
    ])
    expect((await database.pool.query('select id,active from ci_runtime_preparations order by created_at')).rows)
      .toEqual([{ id: original.id, active: false }, { id: latest.id, active: false }])
    expect((await database.pool.query(`select source,outcome from management_audit
      where principal_id=$1 and action='build_computer_prepare' order by sequence`, [f.reader.principal.id])).rows)
      .toEqual([{ source: 'http', outcome: 'denied' }, { source: 'mcp', outcome: 'denied' }])
    await Promise.all([runtime.service.recover(), runtime.service.recover()])
    await vi.waitFor(() => { expect(f.fixture.calls.refresh).toHaveLength(2) })
  }, 30_000)

  it('reconciles an accepted Main refresh after its acknowledgement is lost', async () => {
    fixture = await persistedMainPreparationFixture(database, {
      onMainRefresh: async () => { throw new DeviceConnectionError('transport') },
    })
    const f = fixture
    const runtime = await f.create()
    const request = input(f)
    expect((await runtime.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
    expect((await runtime.call('build_computer_prepare', request)).isError).not.toBe(true)
    const completed = await settle(runtime)
    expect(completed.state).toBe('qualified')
    expect(await readBoth(runtime)).toEqual(completed)
    expect(f.fixture.calls.refresh).toHaveLength(1)
    expect(f.fixture.calls.qualified).toEqual(['p-main'])
    expect(await f.repository.pending()).toEqual([])
  }, 30_000)

  it.each(['builds disabled', 'Main changed', 'writer revoked'] as const)(
    'retains a failed pending preparation when recovery finds %s', async condition => {
      const reached = deferred()
      const paused = deferred()
      let interrupted = false
      fixture = await persistedMainPreparationFixture(database, { pause: async stage => {
        if (stage === 'source' && !interrupted) {
          reached.resolve()
          await paused.promise
        }
      } })
      const f = fixture
      const original = await f.create()
      const request = input(f)
      try {
        expect((await original.call('build_computer_prepare', request, f.reader.token)).isError).toBe(true)
        expect((await original.call('build_computer_prepare', request)).isError).not.toBe(true)
        await reached.promise
        const pending = (await f.repository.pending())[0]!
        interrupted = true
        const closing = original.service.close()
        paused.resolve()
        await closing
        if (condition === 'builds disabled') {
          await database.pool.query('update build_computer_preferences set build_enabled=false')
        } else if (condition === 'Main changed') {
          await database.pool.query('update application_installation set id=$1 where singleton=true', [randomUUID()])
        } else {
          await database.pool.query('update management_principals set revoked_at=now() where id=$1',
            [f.writer.principal.id])
        }
        const recovered = await f.create()
        await recovered.service.recover()
        const completed = await settle(recovered)
        expect(completed.state).toBe('failed')
        expect(completed.message).toBeTruthy()
        expect(await readBoth(recovered)).toEqual(completed)
        expect(await f.repository.get(pending.id)).toMatchObject({ id: pending.id, status: completed })
        expect(await f.repository.pending()).toEqual([])
        expect(f.fixture.calls.prepare).toEqual([])
        expect(f.fixture.calls.refresh).toEqual([])
        expect(f.fixture.calls.qualified).toEqual([])
        expect((await database.pool.query('select id,active from ci_runtime_preparations')).rows)
          .toEqual([{ id: pending.id, active: false }])
      } finally {
        interrupted = true
        paused.resolve()
      }
    }, 30_000)
})
