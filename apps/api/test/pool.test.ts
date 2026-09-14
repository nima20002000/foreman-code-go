import { EventEmitter } from 'node:events'

import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { createPool, queryForReadiness } from '../src/infrastructure/pool.js'

const connectionString = 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

describe('PostgreSQL probe cleanup', () => {
  it('handles and reports idle pool errors without throwing', async () => {
    const onError = vi.fn()
    const pool = createPool({
      connectionString, maxConnections: 1, connectionTimeoutMs: 100, onError,
    }, 'test-pool')
    try {
      const error = new Error('database restarted')
      expect(() => pool.emit('error', error)).not.toThrow()
      expect(onError).toHaveBeenCalledWith(error)
    } finally {
      await pool.end()
    }
  })

  it('discards a lease acquired after cancellation without executing a query', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(), release: vi.fn(),
    })
    let acquire!: (client: pg.PoolClient) => void
    const pool = {
      connect: () => new Promise<pg.PoolClient>((resolve) => { acquire = resolve }),
    } as unknown as pg.Pool
    const controller = new AbortController()
    const work = queryForReadiness(pool, 'select 1', controller.signal)
    let settled = false
    void work.then(() => { settled = true }, () => { settled = true })
    controller.abort(new Error('probe aborted'))
    await Promise.resolve()
    expect(settled).toBe(false)
    acquire(client as unknown as pg.PoolClient)
    await expect(work).rejects.toThrow('probe aborted')
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('destroys an active canceled query exactly once', async () => {
    let rejectQuery!: (error: Error) => void
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectQuery = reject })),
      release: vi.fn((destroy: boolean) => {
        if (destroy) rejectQuery(new Error('connection destroyed'))
      }),
    })
    const pool = { connect: async () => client } as unknown as pg.Pool
    const controller = new AbortController()
    const work = queryForReadiness(pool, 'select 1', controller.signal)
    const rejected = expect(work).rejects.toThrow('connection destroyed')
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(client.listenerCount('error')).toBe(0)
  })
})
