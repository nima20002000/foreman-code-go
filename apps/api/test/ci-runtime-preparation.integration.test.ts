import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { CiRuntimeProvisioner } from '../src/modules/jobs/ciRuntimeProvisioner.js'
import { buildComputerTarget, buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { ciPreparationFixture, qualifiedPreparationProfile, commit, builder, mainId } from './helpers/ciPreparationFixture.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { ciPreparationLimits } from '../src/modules/jobs/ciPreparationLimits.js'

describe.skipIf(!postgresEnabled)('persisted runtime preparation over authenticated MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let fixture: Awaited<ReturnType<typeof ciPreparationFixture>>
  const provisioners: CiRuntimeProvisioner[] = []
  const apps: ReturnType<typeof Fastify>[] = []
  beforeEach(async () => { database = await agent3Database() }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(provisioners.splice(0).map(service => service.close()))
    await Promise.allSettled(apps.splice(0).map(app => app.close()))
    await fixture?.ciRuntime.close()
    await fixture?.app.close()
    await database?.close()
  })

  async function setup(options: Parameters<typeof ciPreparationFixture>[0] = {}) {
    fixture = await ciPreparationFixture(options)
    await database.pool.query('update application_installation set id=$1 where singleton=true', [mainId])
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Runtime author', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
    const reader = await access.issue({ name: 'Runtime reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: ['job_definitions:read'], scope: {} }] })
    const commands = new PostgresCommandCoordinator(database.pool)
    for (const workspaceId of [fixture.workspaceId, 'another-workspace']) {
      await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
        JSON.stringify({ id: workspaceId, name: 'Runtime preparation',
          repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } })])
    }
    await database.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$1,'synthetic-runtime-key',$3::jsonb)`, [builder, mainId, JSON.stringify({
      mainId, deviceId: builder, workerInstallationId: builder, publicKeyFingerprint: 'a'.repeat(64),
      keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] })])
    const profile = fixture.profiles.get('p-unit')!
    const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
      registration: profile.root.registration, mainInstallationId: mainId })
    await database.pool.query(`insert into build_computer_preferences
      (host_key,target,revision,build_enabled,build_priority,updated_by) values($1,$2::jsonb,1,true,100,$3)`,
    [buildComputerKey(target), JSON.stringify(target), writer.principal.id])
    const create = () => {
      const service = new CiRuntimeProvisioner(database.pool, fixture.profileService as never, fixture.sources as never,
        () => fixture.endpoint, commands, { timing: { pollMs: 0,
          wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date() } })
      provisioners.push(service)
      return service
    }
    const service = create()
    const app = Fastify()
    apps.push(app)
    const services = { commands, ciRuntime: service, jobRuntimeProfiles: fixture.profileService } as unknown as OperatorServices
    const interactions = { toolAccess: async () => ({ role: 'coder', tools: [] }), canRead: async () => false,
      canRespond: async () => false } as unknown as AppInteractionService
    registerGraphqlMcp(app, { access, operator: services, interactions })
    const url = await app.listen({ port: 0, host: '127.0.0.1' })
    const rpc = async (method: string, params: unknown, bearer = writer.token) => {
      const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const body = await response.text()
      return JSON.parse(body.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? body).result
    }
    const call = async (name: string, input: unknown, bearer = writer.token) =>
      await rpc('tools/call', { name, arguments: input }, bearer) as {
        isError?: boolean; structuredContent?: unknown
      }
    const listTools = async (bearer = writer.token) =>
      await rpc('tools/list', {}, bearer) as { tools: { name: string; description: string }[] }
    const settle = async (service: CiRuntimeProvisioner) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const status = await service.get(writer.principal, { workspaceId: fixture.workspaceId, profileId: 'p-unit' })
        if (['qualified', 'failed'].includes(status.state)) return status
        await new Promise(resolve => setImmediate(resolve))
      }
      throw new Error('Preparation did not settle')
    }
    return { service, create, call, listTools, settle, writer, reader, services, access }
  }

  it('discovers scoped runtime refresh without advertising write access to a reader', async () => {
    const f = await setup()
    const writerTools = (await f.listTools()).tools
    const readerTools = (await f.listTools(f.reader.token)).tools
    for (const tools of [writerTools, readerTools]) {
      const profiles = tools.find(tool => tool.name === 'job_runtime_profile_list')!
      expect(profiles.description).toContain('Authorized writers can use build_computer_prepare')
      expect(profiles.description).toContain('arbitrary installer paths are unavailable')
    }
    expect(writerTools.some(tool => tool.name === 'build_computer_prepare')).toBe(true)
    expect(readerTools.some(tool => tool.name === 'build_computer_prepare')).toBe(false)
    expect((await f.call('build_computer_prepare', { workspaceId: fixture.workspaceId,
      profileId: 'p-unit', commit, commandId: randomUUID() }, f.reader.token)).isError).toBe(true)
    expect(decodeMcpToolResult((await f.call('build_computer_prepare_get', {
      workspaceId: fixture.workspaceId, profileId: 'p-unit',
    }, f.reader.token)))).toMatchObject({ state: 'idle' })
    expect(fixture.calls.prepare).toEqual([])
  })

  it('denies a reader, recovers a saved profile command after Main restarts and reads the completed command again', async () => {
    let reached!: () => void
    const atProfile = new Promise<void>(resolve => { reached = resolve })
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    let stopped = false
    const f = await setup({ loseRefreshAck: true, pause: async stage => {
      if (stage === 'profile' && !stopped) { reached(); await paused }
    } })
    const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    try {
      const withoutDefinitionRead = await f.access.issue({
        name: 'Runtime author without definition reads', audience: 'operator',
        expiresAt: new Date(Date.now() + 3_600_000),
        grants: [{ actions: ManagementActionSchema.options.filter(action => action !== 'job_definitions:read'),
          scope: { workspaceIds: [fixture.workspaceId] } }],
      })
      const denied = await f.call('build_computer_prepare', input, withoutDefinitionRead.token)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      expect((await database.pool.query(
        'select source,outcome from management_audit where principal_id=$1 and action=$2',
        [withoutDefinitionRead.principal.id, 'build_computer_prepare'],
      )).rows).toEqual([{ source: 'mcp', outcome: 'denied' }])
      expect((await database.pool.query(
        'select command_id from management_command_receipts where principal_id=$1',
        [withoutDefinitionRead.principal.id],
      )).rows).toEqual([])
      const unchanged = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      })
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(unchanged)).state).toBe('idle')
      expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
      expect(fixture.calls.prepare).toEqual([])
      expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
      await atProfile
      stopped = true
      const closing = f.service.close()
      release()
      await closing
      const recovered = f.create()
      f.services.ciRuntime = recovered
      expect((await recovered.get(f.writer.principal, { workspaceId: fixture.workspaceId, profileId: 'p-unit' })).state)
        .not.toBe('idle')
      await recovered.recover()
      const done = await f.settle(recovered)
      expect(done.state).toBe('qualified')
      expect(done.preparationLimits).toEqual(ciPreparationLimits())
      const retry = await f.call('build_computer_prepare', input)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(retry))).toEqual(done)
      const read = await f.call('build_computer_prepare_get', { workspaceId: fixture.workspaceId, profileId: 'p-unit' }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
      expect(fixture.calls.refresh).toHaveLength(1)
      expect(fixture.calls.saves).toHaveLength(2)
    } finally { stopped = true; release() }
  })

  it('serializes independent Main services and workspaces on the same computer at the same commit', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = await setup({ pause: stage => stage === 'source' ? paused : Promise.resolve() })
    const other = f.create()
    const foreign = structuredClone(fixture.profiles.get('p-unit')!)
    foreign.id = 'p-other'
    foreign.workspaceId = 'another-workspace'
    foreign.root.binding.workspaceId = 'another-workspace'
    fixture.profiles.set(foreign.id, qualifiedPreparationProfile(foreign))
    try {
      await f.service.start(f.writer.principal, 'mcp', { workspaceId: fixture.workspaceId,
        profileId: 'p-unit', commit, commandId: 'workspace-first' })
      await expect(other.start(f.writer.principal, 'mcp', { workspaceId: 'another-workspace',
        profileId: 'p-other', commit, commandId: 'workspace-second' })).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
      await other.recover()
      release()
      expect((await f.settle(f.service)).state).toBe('qualified')
      expect(fixture.calls.prepare).toHaveLength(1)
      expect(fixture.calls.refresh).toHaveLength(1)
    } finally { release() }
  })

  it('starts preparation when profile reads share a single-connection application pool', async () => {
    const f = await setup()
    const pool = new pg.Pool({ ...database.pool.options, max: 1, connectionTimeoutMillis: 1000 })
    const commands = new PostgresCommandCoordinator(pool)
    const profiles = {
      ...fixture.profileService,
      list: async (...args: Parameters<typeof fixture.profileService.list>) => {
        await pool.query('select 1')
        return fixture.profileService.list(...args)
      },
    }
    const service = new CiRuntimeProvisioner(pool, profiles as never, fixture.sources as never,
      () => fixture.endpoint, commands, { timing: { pollMs: 0,
        wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date() } })
    try {
      const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: 'single-connection' }
      expect(await service.start(f.writer.principal, 'mcp', input)).toMatchObject({ state: 'approving', commit })
      const done = await f.settle(service)
      expect(done.state).toBe('qualified')
      expect(await service.start(f.writer.principal, 'mcp', input)).toEqual(done)
      expect(fixture.calls.prepare).toHaveLength(1)
    } finally {
      await service.close()
      await pool.end()
    }
  })

  it.each(['missing', 'revoked', 'registration changed', 'wrong Main'] as const)(
    'rejects a new preparation for a computer whose identity is %s through MCP', async condition => {
      const f = await setup()
      const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
      const devices = new PostgresDeviceAccessService(database.pool, mainId)
      if (condition === 'revoked') {
        await devices.revoke(f.writer.principal, builder, 1, randomUUID(), 'mcp')
      } else if (condition === 'missing') {
        await database.pool.query('delete from device_registrations where id=$1', [builder])
      } else if (condition === 'registration changed') {
        await database.pool.query(`update device_registrations
          set record=jsonb_set(record,'{authorizationRevision}','2'::jsonb) where id=$1`, [builder])
      } else {
        await database.pool.query('update application_installation set id=$1 where singleton=true', [randomUUID()])
      }
      expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
      const result = await f.call('build_computer_prepare', input)
      expect(result.isError).toBe(true)
      expect(fixture.calls.prepare).toEqual([])
      expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
      expect((await database.pool.query(`select command_id from management_command_receipts
        where principal_id=$1 and operation='build_computer_prepare'`, [f.writer.principal.id])).rows).toEqual([])
      const read = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read)).state).toBe('idle')
    })

  it.each(['continuation', 'recovery'] as const)(
    'retains failed preparation history when a device is revoked before %s', async phase => {
      let reached!: () => void
      const atSource = new Promise<void>(resolve => { reached = resolve })
      let release!: () => void
      const paused = new Promise<void>(resolve => { release = resolve })
      let stopped = false
      const f = await setup({ pause: async stage => {
        if (stage === 'source' && !stopped) {
          reached()
          await paused
        }
      } })
      const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
      try {
        expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
        expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
        await atSource
        const original = (await database.pool.query<{ id: string }>('select id from ci_runtime_preparations')).rows[0]!
        const devices = new PostgresDeviceAccessService(database.pool, mainId)
        await devices.revoke(f.writer.principal, builder, 1, randomUUID(), 'mcp')
        let service = f.service
        if (phase === 'recovery') {
          stopped = true
          const closing = service.close()
          release()
          await closing
          service = f.create()
          f.services.ciRuntime = service
          await service.recover()
        } else {
          release()
        }
        const done = await f.settle(service)
        expect(done).toMatchObject({ state: 'failed', message: 'Device access rejected: revoked' })
        expect(fixture.calls.prepare).toEqual([])
        expect(fixture.calls.refresh).toEqual([])
        expect(fixture.calls.qualified).toEqual([])
        expect((await database.pool.query('select id,device_id,active from ci_runtime_preparations')).rows)
          .toEqual([{ id: original.id, device_id: builder, active: false }])
        const read = await f.call('build_computer_prepare_get', {
          workspaceId: fixture.workspaceId, profileId: 'p-unit',
        }, f.reader.token)
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
        expect((await f.call('build_computer_prepare', { ...input, commandId: randomUUID() })).isError).toBe(true)
        expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([original])
      } finally {
        stopped = true
        release()
      }
    })

  it('closes an active qualification and resumes the same persisted preparation through MCP', async () => {
    const f = await setup()
    const originalQualify = fixture.profileService.qualify
    let reached!: () => void
    const qualifying = new Promise<void>(resolve => { reached = resolve })
    let cancelProbe!: () => void
    fixture.profileService.qualify = async (principal, source, workspaceId, commandId, approvalId,
      options: { signal?: AbortSignal } = {}) => {
      reached()
      await new Promise<void>((_resolve, reject) => {
        cancelProbe = () => reject(new Error('Qualification interrupted'))
        options.signal?.throwIfAborted()
        options.signal?.addEventListener('abort', cancelProbe, { once: true })
      })
      return originalQualify(principal, source, workspaceId, commandId, approvalId)
    }
    const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    let closing: Promise<void> | undefined
    let closed = false
    try {
      expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
      expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
      await qualifying
      closing = f.service.close().then(() => { closed = true })
      await vi.waitFor(() => { expect(closed).toBe(true) }, { timeout: 1_000 })
      expect(fixture.calls.qualified).toEqual([])
      const interrupted = (await database.pool.query('select id,active from ci_runtime_preparations')).rows[0]!
      expect(interrupted.active).toBe(true)
      const pending = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(pending)).state).toBe('qualifying')
      fixture.profileService.qualify = originalQualify
      const recovered = f.create()
      f.services.ciRuntime = recovered
      await recovered.recover()
      const done = await f.settle(recovered)
      expect(done.state).toBe('qualified')
      const read = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
      expect((await database.pool.query('select id,active from ci_runtime_preparations')).rows)
        .toEqual([{ id: interrupted.id, active: false }])
      expect(fixture.calls.refresh).toHaveLength(1)
    } finally {
      fixture.profileService.qualify = originalQualify
      cancelProbe?.()
      await closing
    }
  })

  it('persists preparation failure over authenticated MCP and replays it after service replacement without refresh', async () => {
    const f = await setup({ prepareFails: true })
    const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    const denied = await f.call('build_computer_prepare', input, f.reader.token)
    expect(denied.isError).toBe(true)
    expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
    expect((await database.pool.query(
      'select outcome from management_audit where principal_id=$1 and action=$2',
      [f.reader.principal.id, 'build_computer_prepare'],
    )).rows).toEqual([{ outcome: 'denied' }])
    expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
    const failed = await f.settle(f.service)
    expect(failed).toMatchObject({ state: 'failed', message: 'podman build failed: no space left on device' })
    expect(fixture.calls.prepare).toHaveLength(1)
    expect(fixture.calls.refresh).toEqual([])
    expect(fixture.calls.qualified).toEqual([])
    const saved = (await database.pool.query('select id,active,record from ci_runtime_preparations')).rows[0]!
    expect(saved.active).toBe(false)
    expect(saved.record.status).toEqual(failed)
    await f.service.close()
    const replacement = f.create()
    f.services.ciRuntime = replacement
    await replacement.recover()
    const read = await f.call('build_computer_prepare_get', {
      workspaceId: fixture.workspaceId, profileId: 'p-unit',
    }, f.reader.token)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(failed)
    const replay = await f.call('build_computer_prepare', input)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(replay))).toEqual(failed)
    expect((await database.pool.query('select id,active from ci_runtime_preparations')).rows)
      .toEqual([{ id: saved.id, active: false }])
    expect(fixture.calls.prepare).toHaveLength(1)
    expect(fixture.calls.refresh).toEqual([])
  })
})
