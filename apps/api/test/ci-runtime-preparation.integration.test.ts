import Fastify from 'fastify'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CiRuntimeProvisioner } from '../src/modules/jobs/ciRuntimeProvisioner.js'
import { buildComputerTarget, buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { ciPreparationFixture, qualifiedPreparationProfile, commit, dexter, mainId } from './helpers/ciPreparationFixture.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'

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
      values($1,$2,$1,'synthetic-runtime-key',$3::jsonb)`, [dexter, mainId, JSON.stringify({
      mainId, deviceId: dexter, workerInstallationId: dexter, publicKeyFingerprint: 'a'.repeat(64),
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
    const call = async (name: string, input: unknown, bearer = writer.token) => {
      const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })
      const body = await response.text()
      return JSON.parse(body.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? body).result as {
        isError?: boolean; structuredContent?: unknown
      }
    }
    const settle = async (service: CiRuntimeProvisioner) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const status = await service.get(writer.principal, { workspaceId: fixture.workspaceId, profileId: 'p-unit' })
        if (['qualified', 'failed'].includes(status.state)) return status
        await new Promise(resolve => setImmediate(resolve))
      }
      throw new Error('Preparation did not settle')
    }
    return { service, create, call, settle, writer, reader, services }
  }

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
      const retry = await f.call('build_computer_prepare', input)
      expect(BuildComputerPrepareStatusSchema.parse(retry.structuredContent)).toEqual(done)
      const read = await f.call('build_computer_prepare_get', { workspaceId: fixture.workspaceId, profileId: 'p-unit' }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(read.structuredContent)).toEqual(done)
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
})
