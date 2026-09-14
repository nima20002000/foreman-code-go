import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('operational endpoints', () => {
  it('reports liveness without consulting infrastructure', async () => {
    const app = buildApp({
      readiness: {
        database: { ping: async () => { throw new Error('must not run') } },
        checkpoints: { ping: async () => { throw new Error('must not run') } },
      },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: 'graphql-api' })
  })

  it('reports each readiness dependency', async () => {
    const app = buildApp({
      readiness: {
        database: { ping: async () => undefined },
        checkpoints: { ping: async () => { throw new Error('offline') } },
      },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: 'unavailable',
      service: 'graphql-api',
      checks: { database: 'ok', checkpoints: 'unavailable' },
    })
  })

  it('returns contract-shaped not-found errors', async () => {
    const app = buildApp({
      readiness: {
        database: { ping: async () => undefined },
        checkpoints: { ping: async () => undefined },
      },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/not-real' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'The requested API route was not found.' },
    })
    expect(response.json().error.requestId).toEqual(expect.any(String))
  })
})
