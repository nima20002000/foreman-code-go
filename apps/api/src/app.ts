import { randomUUID } from 'node:crypto'

import {
  ApiErrorResponseSchema,
  ServiceHealthSchema,
  type ServiceHealth,
} from '@graphql/contracts'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'

export interface ReadinessDependencies {
  database: { ping(): Promise<void> }
  checkpoints: { ping(): Promise<void> }
}

export interface BuildAppOptions {
  readiness: ReadinessDependencies
  logger?: boolean | FastifyBaseLogger
}

async function dependencyStatus(check: () => Promise<void>): Promise<'ok' | 'unavailable'> {
  try {
    await check()
    return 'ok'
  } catch {
    return 'unavailable'
  }
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => randomUUID(),
  })

  app.get('/health/live', async () => ServiceHealthSchema.parse({ status: 'ok', service: 'graphql-api' }))

  app.get('/health/ready', async (_request, reply) => {
    const [database, checkpoints] = await Promise.all([
      dependencyStatus(() => options.readiness.database.ping()),
      dependencyStatus(() => options.readiness.checkpoints.ping()),
    ])
    const response: ServiceHealth = ServiceHealthSchema.parse({
      status: database === 'ok' && checkpoints === 'ok' ? 'ok' : 'unavailable',
      service: 'graphql-api',
      checks: { database, checkpoints },
    })
    if (response.status === 'unavailable') reply.code(503)
    return response
  })

  app.setNotFoundHandler((request, reply) => {
    const body = ApiErrorResponseSchema.parse({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested API route was not found.',
        requestId: request.id,
      },
    })
    return reply.code(404).send(body)
  })

  return app
}
