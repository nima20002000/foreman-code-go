import Fastify from 'fastify'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunOutputSchema } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CiService } from '../src/modules/jobs/ci.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { ciFixture } from './helpers/ciFixture.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('persists two concurrent same-suite MCP requests with pool.max=2 and replays them after recreation', async () => {
  const database = await agent3Database()
  const pool = new pg.Pool({ ...database.pool.options, max: 2 })
  const app = Fastify()
  const f = ciFixture()
  try {
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [f.workspaceId, JSON.stringify({ id: f.workspaceId, name: 'CI concurrency' })])
    const access = new PostgresAccessService(pool)
    const writer = await access.issue({ name: 'CI writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [f.workspaceId] } }] })
    const reader = await access.issue({ name: 'CI reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['jobs:read'], scope: { workspaceIds: [f.workspaceId] } }] })
    const commands = new PostgresCommandCoordinator(pool)
    const createCi = () => new CiService(pool, commands, f.authority, f.sources, f.jobs)
    f.services.commands = commands
    f.services.ci = createCi()
    const choices = f.jobs.choices.bind(f.jobs)
    let firstChoices = true
    f.jobs.choices = async (...args) => {
      if (firstChoices) {
        firstChoices = false
        const deadline = Date.now() + 5000
        let attempts = 0
        while (attempts < 2 && Date.now() < deadline) {
          const row = (await database.pool.query<{ count: string }>(
            `select count(*) from pg_locks where locktype='advisory'
             and database=(select oid from pg_database where datname=current_database())
             and objid=(hashtext($1)::bigint & 4294967295)`, [`ci:${f.workspaceId}:unit`])).rows[0]!
          attempts = Number(row.count)
          if (attempts < 2) await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(attempts).toBe(2)
      }
      // This read needs the application pool while the other request waits for the suite lock.
      await pool.query('select 1')
      return choices(...args)
    }
    registerGraphqlMcp(app, { access, operator: f.services })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const call = async (commandId: string, token = writer.token) => {
      const response = await fetch(`${address}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
          params: { name: 'ci_run', arguments: { workspaceId: f.workspaceId, suite: 'unit', commandId } } }) })
      const content = await response.text()
      const body = content.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? content
      return JSON.parse(body).result
    }
    const ids = [randomUUID(), randomUUID()]
    const results = await Promise.all(ids.map(id => call(id)))
    expect(results.every(result => result.isError !== true)).toBe(true)
    const started = results.map(result => CiRunOutputSchema.parse(result.structuredContent))
    expect(started[0]!.ticketId).not.toBe(started[1]!.ticketId)
    f.services.ci = createCi()
    for (const [index, commandId] of ids.entries()) {
      expect(CiRunOutputSchema.parse((await call(commandId)).structuredContent)).toEqual(started[index])
    }
    expect(f.counts().enqueues).toBe(2)
    const receipts = (await pool.query<{ result: unknown }>(
      "select result from management_command_receipts where principal_id=$1 and operation='ci.run'",
      [writer.principal.id])).rows.map(row => row.result)
    expect(receipts).toHaveLength(2)
    expect(receipts).toEqual(expect.arrayContaining(started))
    const denied = await call(randomUUID(), reader.token)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
  } finally {
    await app.close()
    await pool.end()
    await database.close()
  }
}, 30_000)
