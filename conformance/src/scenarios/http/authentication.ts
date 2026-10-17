import assert from 'node:assert/strict'
import { assertResponse } from '../../assertions.js'
import type { PublicResponse } from '../../clients/http.js'
import type { HttpRoute } from '../../coverage/http-routes.js'
import { describeFailure } from '../../reporting/report.js'
import type { Lane, ScenarioFailure } from '../../reporting/types.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { protectedHttpRoutes } from './protected-route-selection.js'

interface RouteFailure {
  method: string
  path: string
  provenance: string
  response?: { status: number; body: unknown }
  failure: ScenarioFailure
}

class AuthenticationFailures extends AggregateError {
  constructor(errors: unknown[], readonly details: RouteFailure[]) {
    super(errors, `${errors.length} protected HTTP requests failed authentication conformance`)
    this.name = 'AuthenticationFailures'
  }
}

function requestPath(route: HttpRoute): string {
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => `conformance-${name}`)
}

async function assertRejectedRoutes(ctx: ScenarioContext, routes: readonly HttpRoute[]): Promise<void> {
  assert.ok(routes.length > 0, 'An authentication group must execute at least one declared route')
  const errors: unknown[] = []
  const details: RouteFailure[] = []
  for (const route of routes) {
    let response: PublicResponse | undefined
    try {
      response = await ctx.http.request(route.method, requestPath(route), {
        token: 'conformance-invalid-credential',
        ...(['GET', 'HEAD'].includes(route.method) ? {} : { body: {} }),
      })
      if (route.method === 'HEAD') {
        assertResponse(response, { status: 401, body: null })
      } else {
        assertApiError(response, 401, 'AUTH_INVALID', 'The supplied credential is invalid.')
      }
    } catch (error) {
      errors.push(error)
      details.push({
        method: route.method,
        path: route.path,
        provenance: route.provenance,
        ...(response ? { response: { status: response.status, body: response.body } } : {}),
        failure: describeFailure(error),
      })
    }
  }
  if (errors.length > 0) throw new AuthenticationFailures(errors, details)
}

const groups = [
  { lane: 'E', id: 'workflows', title: 'Workflow, version, schedule, and Run HTTP routes reject an invalid credential' },
  { lane: 'H', id: 'harnesses', title: 'Harness and provider account HTTP routes reject an invalid credential' },
  { lane: 'J', id: 'jobs', title: 'Job, runtime profile, and CI HTTP routes reject an invalid credential' },
  { lane: 'A1', id: 'conversations', title: 'Conversation, interaction, and bug report HTTP routes reject an invalid credential' },
  { lane: 'S', id: 'sources', title: 'Source and workspace location HTTP routes reject an invalid credential' },
  { lane: 'R', id: 'computers', title: 'Computer, device management, and placement HTTP routes reject an invalid credential' },
  { lane: 'A2', id: 'workspace-settings', title: 'Workspace, Agent, skill, file, and settings HTTP routes reject an invalid credential' },
] satisfies { lane: Lane; id: string; title: string }[]

export const authenticationScenarios: Scenario[] = groups.map(group => {
  const routes = protectedHttpRoutes.filter(route => route.lane === group.lane)
  return {
    id: `http.authentication.${group.id}`,
    title: group.title,
    lane: group.lane,
    covers: routes.map(route => httpCoverage(route.method, route.path, 'error')),
    run: ctx => assertRejectedRoutes(ctx, routes),
  }
})
