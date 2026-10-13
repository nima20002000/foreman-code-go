import { buildApp } from '../src/app.js'
import { describe, expect, it, vi } from 'vitest'
import { readRuntimeIdentity } from '../src/infrastructure/runtimeIdentity.js'
import { createRuntimeIdentity } from '@foreman-code/contracts/runtime-identity-node'
import type pg from 'pg'

const first = 'd95abeb8-598a-49a4-8c3c-c6e3533053e8'
const second = '8b8fe654-6e4a-4d4c-b451-2795ccbf7074'
describe('runtime installation identity', () => {
  it('serves only opaque identity and forbids caching', async () => {
    const identity = createRuntimeIdentity(process.cwd(), 'postgres://alice:secret@localhost/demo', first)
    const app = buildApp({
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      runtimeIdentity: async () => identity,
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/health/identity' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(identity)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.body).not.toContain('secret')
    } finally { await app.close() }
  })
  it('keeps credentials out of identity and distinguishes database targets', () => {
    const original = createRuntimeIdentity(process.cwd(), 'postgres://alice:secret@localhost/demo', first)
    expect(createRuntimeIdentity(process.cwd(), 'postgres://bob:other@localhost:5432/demo?sslmode=require', first)).toEqual(original)
    expect(createRuntimeIdentity(process.cwd(), 'postgres://alice:secret@localhost/other', first).databaseId).not.toEqual(original.databaseId)
    expect(JSON.stringify(original)).not.toContain('secret')
  })
  it('reads persisted nonce, including reset at the same database URL', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: first }] }).mockResolvedValueOnce({ rows: [{ id: first }] }).mockResolvedValueOnce({ rows: [{ id: second }] })
    const pool = { query } as unknown as Pick<pg.Pool, 'query'>
    const read = () => readRuntimeIdentity(pool, process.cwd(), 'postgres://localhost/demo')
    const original = await read()
    expect(await read()).toEqual(original)
    const reset = await read()
    expect(reset.installationId).not.toEqual(original.installationId)
    expect(reset.databaseId).toEqual(original.databaseId)
  })
  it('does not invent an identity when migration has not been applied', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pick<pg.Pool, 'query'>
    await expect(readRuntimeIdentity(pool, process.cwd(), 'postgres://localhost/demo')).rejects.toThrow()
  })
})
