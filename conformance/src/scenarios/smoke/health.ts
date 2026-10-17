import { ServiceHealthSchema } from '@foreman-code/contracts'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, httpCoverage } from './support.js'

export const healthScenarios: Scenario[] = [
  {
    id: 'health.live', title: 'Liveness returns the public service identity', lane: 'SKEL',
    covers: [httpCoverage('GET', '/health/live', 'success')],
    async run(ctx) {
      const response = await ctx.http.request('GET', '/health/live')
      ServiceHealthSchema.parse(response.body)
      assertResponse(response, { status: 200, body: { status: 'ok', service: 'graphql-api' } })
    },
  },
  {
    id: 'health.ready', title: 'Readiness includes both fresh database dependencies', lane: 'SKEL',
    covers: [httpCoverage('GET', '/health/ready', 'success')],
    async run(ctx) {
      const response = await ctx.http.request('GET', '/health/ready')
      ServiceHealthSchema.parse(response.body)
      assertResponse(response, {
        status: 200,
        body: { status: 'ok', service: 'graphql-api', checks: { database: 'ok', checkpoints: 'ok' } },
      })
    },
  },
  {
    id: 'http.unknown-route', title: 'Unknown routes return the public error envelope', lane: 'SKEL',
    async run(ctx) {
      const response = await ctx.http.request('GET', '/api/conformance-missing-route')
      assertApiError(response, 404, 'NOT_FOUND', 'The requested API route was not found.')
    },
  },
]
