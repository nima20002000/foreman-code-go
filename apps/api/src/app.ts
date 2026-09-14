import { randomUUID } from 'node:crypto'

import {
  ApiErrorResponseSchema,
  ServiceHealthSchema,
  type ServiceHealth,
} from '@graphql/contracts'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { z } from 'zod'

import { DomainError } from './modules/errors.js'
import { registerProductRoutes, type ProductServices } from './routes/product.js'

export interface ReadinessDependencies {
  database: { ping(signal?: AbortSignal): Promise<void> }
  checkpoints: { ping(signal?: AbortSignal): Promise<void> }
}

export interface BuildAppOptions {
  readiness: ReadinessDependencies
  readinessTimeoutMs?: number
  product?: ProductServices
  logger?: boolean | FastifyBaseLogger
}

type DependencyStatus = 'ok' | 'unavailable'

function createDependencyCheck(
  check: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): () => Promise<DependencyStatus> {
  let inFlight: Promise<DependencyStatus> | undefined
  return () => {
    if (inFlight) return inFlight
    const controller = new AbortController()
    const work = Promise.resolve().then(() => check(controller.signal))
    const status = work.then<DependencyStatus, DependencyStatus>(
      () => 'ok',
      () => 'unavailable',
    )
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<DependencyStatus>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Readiness deadline exceeded'))
        resolve('unavailable')
      }, timeoutMs)
    })
    const attempt = Promise.race([status, deadline])
    inFlight = attempt
    // Keep the same unavailable result while a non-cooperative check is still
    // pending. Concurrent/repeated probes must not queue more dependency work.
    void status.then(() => {
      clearTimeout(timer)
      inFlight = undefined
    })
    return attempt
  }
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const timeoutMs = options.readinessTimeoutMs ?? 2000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('readinessTimeoutMs must be a positive 32-bit integer')
  }
  const app = Fastify({
    ...(typeof options.logger === 'object'
      ? { loggerInstance: options.logger }
      : { logger: options.logger ?? false }),
    genReqId: () => randomUUID(),
  })
  const checkDatabase = createDependencyCheck(
    (signal) => options.readiness.database.ping(signal), timeoutMs,
  )
  const checkCheckpoints = createDependencyCheck(
    (signal) => options.readiness.checkpoints.ping(signal), timeoutMs,
  )

  app.get('/health/live', async () => ServiceHealthSchema.parse({ status: 'ok', service: 'graphql-api' }))

  app.get('/health/ready', async (_request, reply) => {
    const [database, checkpoints] = await Promise.all([checkDatabase(), checkCheckpoints()])
    const response: ServiceHealth = ServiceHealthSchema.parse({
      status: database === 'ok' && checkpoints === 'ok' ? 'ok' : 'unavailable',
      service: 'graphql-api',
      checks: { database, checkpoints },
    })
    if (response.status === 'unavailable') reply.code(503)
    return response
  })

  if (options.product) registerProductRoutes(app, options.product)

  app.setErrorHandler((error, request, reply) => {
    const domain = error instanceof DomainError
      ? error
      : error instanceof z.ZodError
        ? new DomainError('INVALID_REQUEST', 'The request does not match its shared contract.', 400, {
            issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          })
        : new DomainError('INTERNAL_ERROR', 'The API could not complete the request.', 500)
    if (domain.status >= 500) request.log.error({ err: error }, domain.message)
    const body = ApiErrorResponseSchema.parse({
      error: {
        code: domain.code,
        message: domain.message,
        ...(domain.details ? { details: domain.details } : {}),
        requestId: request.id,
      },
    })
    return reply.code(domain.status).send(body)
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
