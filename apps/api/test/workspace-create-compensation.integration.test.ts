import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import * as contracts from '@graphql/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

afterEach(() => vi.restoreAllMocks())

const failures = ['receipt', 'audit', 'commit', 'commit division by zero'] as const

describe('workspace project folder compensation through authenticated MCP', () => {
  for (const explicitName of [true, false]) {
    it.each(failures)(`removes the ${explicitName ? 'explicit' : 'suggested'} folder after a %s failure`, async failure => {
      const f = await workspaceMcpFixture()
      try {
        const name = 'Recovered project'
        await f.defaults.updateWorkspaceDefaults({ suggestedName: name, description: '', parentPath: f.parentPath }, 0)
        const table = failure === 'receipt' ? 'management_command_receipts' : 'management_audit'
        const trigger = failure.startsWith('commit')
          ? `create constraint trigger reject_creation after insert on ${table}
             deferrable initially deferred for each row execute function reject_creation()`
          : `create trigger reject_creation before insert on ${table}
             for each row execute function reject_creation()`
        const condition = failure === 'receipt'
          ? "new.operation = 'workspace.create'" : "new.action = 'workspace.create' and new.outcome = 'succeeded'"
        const rejection = failure === 'commit division by zero'
          ? "raise exception 'Injected division by zero' using errcode = '22012'"
          : "raise exception 'Injected creation failure'"
        await f.pool.query(`create function reject_creation() returns trigger language plpgsql as $$
          begin
            if ${condition} then ${rejection}; end if;
            return new;
          end $$; ${trigger}`)
        const input = { commandId: randomUUID(), parentPath: f.parentPath, ...(explicitName ? { name } : {}) }
        const failed = await f.owner.client.callTool({ name: 'workspace_create', arguments: input })
        expect(failed.isError).toBe(true)
        expect(await readdir(f.parentPath)).toEqual([])
        expect((await f.pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(0)
        expect((await f.pool.query('select count(*)::int as count from management_command_receipts where command_id = $1',
          [input.commandId])).rows[0].count).toBe(0)
        await f.pool.query(`drop trigger reject_creation on ${table}`)
        const retried = await callWorkspaceTool(f.owner.client, 'workspace_create', contracts.ManagedWorkspaceCommandResultSchema, input)
        expect(retried.replayed).toBe(false)
        expect(retried.value.workspace.name).toBe(name)
        const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
          { workspaceId: retried.value.workspace.id })
        expect(readback.executionLocation?.rootPath).toBe(join(f.parentPath, name))
        expect(readback.locationValidation.status).toBe('ready')
        expect(await readdir(f.parentPath)).toEqual([name])
        const owned = (await f.pool.query('select id, created_project_folder from workspaces')).rows
        expect(owned).toHaveLength(1)
        expect(owned[0]).toMatchObject({ id: retried.value.workspace.id,
          created_project_folder: { rootPath: join(f.parentPath, name) } })
        expect((await callWorkspaceTool(f.owner.client, 'workspace_create',
          contracts.ManagedWorkspaceCommandResultSchema, input)).replayed).toBe(true)
        expect(await readdir(f.parentPath)).toEqual([name])
        expect((await f.pool.query(`select outcome from management_audit
          where action = 'workspace.create' and details->>'commandId' = $1 order by sequence`,
        [input.commandId])).rows.map(row => row.outcome)).toEqual(['failed', 'succeeded'])
      } finally { await f.close() }
    }, 30_000)
  }

  it('retains a committed project folder after lost acknowledgement and replays the same workspace', async () => {
    const f = await workspaceMcpFixture()
    try {
      const input = { commandId: randomUUID(), parentPath: f.parentPath, name: 'Acknowledged on retry' }
      const query = pg.Client.prototype.query as unknown as
        (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
      const creatingClients = new WeakSet<pg.Client>()
      let loseAcknowledgement = true
      vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const sql = args[0]
        const values = args[1] as unknown[] | undefined
        if (typeof sql === 'string' && sql.includes('insert into management_command_receipts')
          && values?.[2] === input.commandId) creatingClients.add(this)
        const response = query.apply(this, args)
        if (sql === 'commit' && creatingClients.has(this) && loseAcknowledgement) {
          loseAcknowledgement = false
          return response.then(() => { throw new Error('Commit acknowledgement lost') })
        }
        return response
      } as never)
      expect((await f.owner.client.callTool({ name: 'workspace_create', arguments: input })).isError).toBe(true)
      vi.restoreAllMocks()
      const directory = join(f.parentPath, input.name)
      expect((await stat(directory)).isDirectory()).toBe(true)
      const persisted = (await f.pool.query('select id from workspaces')).rows
      expect(persisted).toHaveLength(1)
      const replayed = await callWorkspaceTool(f.owner.client, 'workspace_create', contracts.ManagedWorkspaceCommandResultSchema, input)
      expect(replayed.replayed).toBe(true)
      expect(replayed.value.workspace.id).toBe(persisted[0].id)
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
        { workspaceId: replayed.value.workspace.id })
      expect(readback.executionLocation?.rootPath).toBe(directory)
      expect(readback.locationValidation.status).toBe('ready')
      expect(await readdir(f.parentPath)).toEqual([input.name])
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('denies creation without provisioning grants and creates neither workspace nor directory', async () => {
    const f = await workspaceMcpFixture()
    try {
      const caller = await f.issue([{ actions: ['workspaces:create'], scope: {} }])
      const input = { commandId: randomUUID(), name: 'Denied project', parentPath: f.parentPath }
      const denied = await caller.client.callTool({ name: 'workspace_create', arguments: input })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      expect(await readdir(f.parentPath)).toEqual([])
      expect((await callWorkspaceTool(f.owner.client, 'workspace_list', contracts.ManagedWorkspacePageSchema)).items).toEqual([])
      expect((await f.pool.query('select count(*)::int as count from management_command_receipts where command_id = $1',
        [input.commandId])).rows[0].count).toBe(0)
    } finally { await f.close() }
  }, 30_000)
})
