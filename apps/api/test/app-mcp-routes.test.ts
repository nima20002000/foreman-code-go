import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'

it('refreshes same-token lease expiration and removes revoked routes and shutdown metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'app-routes-'))
  let rows = [{ token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const routes = new AppMcpRoutes(pool, 'http://127.0.0.1:3002/mcp', join(directory, 'launcher.mjs'))
  try {
    await routes.refresh()
    const file = join(directory, 'routes', `${'a'.repeat(64)}.json`)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ expiresAt: rows[0]!.expires_at.toISOString() })
    rows = [{ ...rows[0]!, expires_at: new Date(Date.now() + 120_000) }]
    await routes.refresh()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ expiresAt: rows[0]!.expires_at.toISOString() })
    rows = []
    await routes.refresh()
    expect(await readdir(join(directory, 'routes'))).toEqual([])
    rows = [{ token_hash: 'b'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
    await routes.refresh()
    await routes.close()
    expect(await readdir(join(directory, 'routes'))).toEqual([])
  } finally { await routes.close(); await rm(directory, { recursive: true, force: true }) }
})
