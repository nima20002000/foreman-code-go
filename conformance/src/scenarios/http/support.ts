import { assertResponse } from '../../assertions.js'
import type { CoverageClaim, ScenarioContext } from '../../scenario.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'

export function readCoverage(path: string): CoverageClaim[] {
  return ['GET', 'HEAD'].flatMap(method => [
    httpCoverage(method, path, 'success'),
    httpCoverage(method, path, 'error'),
  ])
}

/** HEAD has the same authorization boundary as GET and an empty response body. */
export async function assertProtectedRead(ctx: ScenarioContext, path: string, body: unknown): Promise<void> {
  assertResponse(await ctx.http.request('GET', path), { status: 200, body })
  assertResponse(await ctx.http.request('HEAD', path), { status: 200, body: null })
  await assertReadCredentialRejected(ctx, path)
}

export async function assertReadCredentialRejected(ctx: ScenarioContext, path: string): Promise<void> {
  const options = { token: 'conformance-invalid-credential' }
  assertApiError(await ctx.http.request('GET', path, options),
    401, 'AUTH_INVALID', 'The supplied credential is invalid.')
  assertResponse(await ctx.http.request('HEAD', path, options), { status: 401, body: null })
}
