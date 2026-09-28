import { randomUUID } from 'node:crypto'

import {
  ApiErrorResponseSchema,
  ServiceHealthSchema,
  type ServiceHealth,
  type RuntimeIdentity,
} from '@graphql/contracts'
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/fastify'
import type pg from 'pg'
import { z } from 'zod'

import type { AppMcpServices } from './mcp/app/types.js'
import { registerGraphqlMcp } from './mcp/unified/transport.js'
import type { OperatorServices } from './mcp/operator/types.js'
import { registerOperatorHttpSecurity } from './modules/access/http.js'
import { registerBrowserAuthRoutes } from './modules/browser-auth/routes.js'
import type { BrowserAuthentication } from './modules/browser-auth/service.js'
import type { PostgresAccessService } from './modules/access/postgres.js'
import type { LocalDevBrowserAccess } from './modules/access/localDevBrowser.js'
import { DomainError } from './modules/errors.js'
import type { McpDetectionService } from './modules/harnesses/mcpDetection.js'
import { registerUserInteractions } from './routes/userInteractions.js'
import { registerRunGraphRoutes } from './routes/runGraph.js'
import { registerManagementRoutes } from './routes/management.js'
import { registerMcpDetectionRoute } from './routes/mcpDetection.js'
import { registerProductRoutes, type ProductServices } from './routes/product.js'
import { registerAgentChatRoutes } from './routes/agentChat.js'
import { registerWorkflowScheduleRoutes } from './routes/workflowSchedules.js'
import { registerHarnessCompatibilityRoutes } from './routes/harnessCompatibility.js'
import type { HarnessCompatibilityService } from './modules/harnesses/compatibility/service.js'

export interface ReadinessDependencies {
  database: { ping(signal?: AbortSignal): Promise<void> }
  checkpoints: { ping(signal?: AbortSignal): Promise<void> }
}

export interface BuildAppOptions {
  runtimeIdentity?: () => Promise<RuntimeIdentity>
  browserAuth?: BrowserAuthentication
  localDevBrowserAccess?: LocalDevBrowserAccess
  harnessCompatibility?: HarnessCompatibilityService
  readiness: ReadinessDependencies
  readinessTimeoutMs?: number
  product?: ProductServices
  operator?: { access: PostgresAccessService; services: OperatorServices }
  appMcp?: AppMcpServices
  mcpDetection?: { pool: pg.Pool; service: McpDetectionService }
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

const SLOW_REQUEST_MS = 2000

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
    // Fastify's per-request lines are replaced by one line whose level says whether it matters.
    logController: new LogController({ disableRequestLogging: true }),
  })
  // Timed delivery is an API lifecycle, never a browser or HTTP-request timer.
  app.addHook('onReady', async () => {
    options.operator?.services.runs?.startScheduleDispatcher?.(() => {
      app.log.error({ code: 'SCHEDULE_DISPATCH_RETRY' }, 'schedule dispatch failed; durable state retained for retry')
    })
  })
  app.addHook('preClose', async () => { await options.operator?.services.runs?.stopScheduleDispatcher?.() })
  app.addHook('onResponse', async (request, reply) => {
    const statusCode = reply.statusCode, responseTimeMs = Math.round(reply.elapsedTime)
    // Routine success (the Board polls every 1.5s) is debug; failures and slow calls stay visible.
    const level = statusCode >= 500 ? 'error' : responseTimeMs >= SLOW_REQUEST_MS ? 'warn' : statusCode >= 400 ? 'info' : 'debug'
    // The path without its query string: queries can carry codes and tokens.
    request.log[level]({ method: request.method, path: request.url.split('?')[0], statusCode, responseTimeMs }, 'request completed')
  })
  if (options.operator || options.appMcp) {
    app.addHook('onRequest', localhostHostValidation())
    app.addHook('onRequest', localhostOriginValidation())
  }
  const checkDatabase = createDependencyCheck(
    (signal) => options.readiness.database.ping(signal), timeoutMs,
  )
  const checkCheckpoints = createDependencyCheck(
    (signal) => options.readiness.checkpoints.ping(signal), timeoutMs,
  )

  if (options.runtimeIdentity) {
    app.get('/health/identity', async (_request, reply) => { reply.header('cache-control', 'no-store'); return options.runtimeIdentity!() })
    app.get('/api/auth/identity', async (_request, reply) => { reply.header('cache-control', 'no-store'); return options.runtimeIdentity!() })
  }

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

  if (options.operator) registerBrowserAuthRoutes(app, options.browserAuth)
  if (options.operator) registerOperatorHttpSecurity(app, options.operator.access, options.browserAuth, options.localDevBrowserAccess)
  if (options.operator) registerManagementRoutes(app, options.operator.services)
  if (options.operator?.services.workflows?.schedules) registerWorkflowScheduleRoutes(app, options.operator.services.workflows.schedules)
  if (options.operator?.services.runGraph) registerRunGraphRoutes(app, options.operator.services.runGraph,
    (principalId, code, route) => options.operator!.services.commands.recordDenied(principalId, 'http', code, route))
  if (options.operator && options.harnessCompatibility) registerHarnessCompatibilityRoutes(app, options.harnessCompatibility)
  if (options.operator && options.mcpDetection) registerMcpDetectionRoute(app, options.mcpDetection.pool, options.mcpDetection.service)
  if (options.operator?.services.agentChat) registerAgentChatRoutes(app, options.operator.services.agentChat)
  if (options.operator && options.product?.interactions) registerUserInteractions(app, options.operator.access, options.product.interactions)
  if (options.product) registerProductRoutes(app, options.product, Boolean(options.operator), options.operator?.services)
  if (options.operator || options.appMcp) registerGraphqlMcp(app, {
    access: (options.operator?.access ?? options.appMcp?.access)!,
    ...(options.operator ? { operator: { ...options.operator.services, workerToolsMcpImplemented: Boolean(options.appMcp) } } : {}),
    ...(options.appMcp ? { interactions: options.appMcp.interactions } : {}),
  })

  app.setErrorHandler(async (error, request, reply) => {
    const domain = error instanceof DomainError
      ? error
      : error instanceof z.ZodError
        ? new DomainError('INVALID_REQUEST', 'The request does not match its shared contract.', 400, {
            issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          })
        : new DomainError('INTERNAL_ERROR', 'The API could not complete the request.', 500)
    if (domain.status >= 500) request.log.error({ err: error }, domain.message)
    const mcpRequest = request.url.split('?')[0] === '/mcp'
    if (options.operator && (domain.status === 401 || domain.status === 403)
      && (request.url.startsWith('/api/') || mcpRequest)) {
      await options.operator.services.commands.recordDenied(
        request.operatorPrincipal?.id, mcpRequest ? 'mcp' : 'http',
        domain.code, request.url.split('?')[0] ?? request.url,
      ).catch((auditError: unknown) => request.log.error({ err: auditError }, 'management denial audit failed'))
    }
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
