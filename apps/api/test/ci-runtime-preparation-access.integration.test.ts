import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { useCiRuntimePreparationFixture } from './ci-runtime-preparation.test-support.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { commit, builder, mainId } from './helpers/ciPreparationFixture.js'

describe.skipIf(!postgresEnabled)('persisted runtime preparation access over authenticated MCP', () => {
  const { setup } = useCiRuntimePreparationFixture()

  it('discovers scoped runtime refresh without advertising write access to a reader', async () => {
    const f = await setup()
    const { fixture } = f
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

  it.each(['missing', 'revoked', 'registration changed', 'wrong Main'] as const)(
    'rejects a new preparation for a computer whose identity is %s through MCP', async condition => {
      const f = await setup()
      const { database, fixture } = f
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


})
