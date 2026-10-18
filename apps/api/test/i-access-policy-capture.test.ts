import { afterEach, expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema, type ManagementGrant, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { authorizationPrincipal, hasAction, isAuthorized } from '../src/modules/access/policy.js'
import { workerScope, workerScopesForAction } from '../src/modules/access/appPolicy.js'
import { canUserInteract } from '../src/modules/access/userPolicy.js'
import { intersectGrants } from '../src/modules/access/operatorDelegation.js'

const now = new Date('2026-10-18T12:00:00.000Z')
function principal(audience: 'operator' | 'worker' | 'user', grants: ManagementGrant[]): ManagementPrincipal {
  return ManagementPrincipalSchema.parse({ id: 'principal-test', name: 'test', audience,
    ...(audience === 'worker' ? { agentId: 'agent-test' } : {}), grants,
    expiresAt: '2026-10-19T00:00:00.000Z', revokedAt: null })
}
function clock(): void { vi.useFakeTimers(); vi.setSystemTime(now) }
afterEach(() => { vi.useRealTimers() })

it('auth.operator-scope-dimensions', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const dimensions = [
    ['workspaceIds', 'workspaceId'], ['workflowIds', 'workflowId'], ['runIds', 'runId'],
    ['mainIds', 'mainId'], ['deviceIds', 'deviceId'],
    ['applicationInstallationIds', 'applicationInstallationId'], ['providerAccountIds', 'providerAccountId'],
  ] as const
  for (const [scopeKey, resourceKey] of dimensions) {
    const value = principal('operator', [{ actions: ['capabilities:read'], scope: { [scopeKey]: [id] } }])
    expect(isAuthorized(value, 'capabilities:read', {}, now)).toBe(false)
    expect(isAuthorized(value, 'capabilities:read', { [resourceKey]: id }, now)).toBe(true)
    expect(isAuthorized(value, 'capabilities:read', { [resourceKey]: '22222222-2222-4222-8222-222222222222' }, now)).toBe(false)
    const empty = principal('operator', [{ actions: ['capabilities:read'], scope: { [scopeKey]: [] } }])
    expect(isAuthorized(empty, 'capabilities:read', { [resourceKey]: id }, now)).toBe(false)
  }
  const pair = principal('operator', [
    { actions: ['runs:read'], scope: { workspaceIds: ['w1'], runIds: ['r1'] } },
    { actions: ['runs:read'], scope: { workspaceIds: ['w2'], runIds: ['r2'] } },
  ])
  expect(isAuthorized(pair, 'runs:read', { workspaceId: 'w1', runId: 'r2' }, now)).toBe(false)
})

it('auth.immutable-snapshot', () => {
  clock()
  const mutable = principal('operator', [{ actions: ['runs:read'], scope: { runIds: ['r1'] } }])
  const snapshot = authorizationPrincipal(mutable)
  mutable.grants[0]!.actions[0] = 'runs:stop'
  mutable.grants[0]!.scope.runIds![0] = 'r2'
  expect(isAuthorized(snapshot, 'runs:read', { runId: 'r1' }, now)).toBe(true)
  expect(() => { snapshot.grants[0]!.actions[0] = 'runs:stop' }).toThrow()
  expect(isAuthorized(mutable, 'runs:stop', { runId: 'r2' }, now)).toBe(true)
})

it('auth.audience-expiry-and-visibility', () => {
  clock()
  for (const audience of ['operator', 'worker', 'user'] as const) {
    const value = principal(audience, [{ actions: ['capabilities:read'], scope: {} }])
    expect(isAuthorized(value, 'capabilities:read', {}, now)).toBe(audience === 'operator')
  }
  const value = principal('operator', [{ actions: ['runs:read'], scope: { runIds: ['r1'] } }])
  expect(hasAction(value, 'runs:read')).toBe(true)
  expect(isAuthorized(value, 'runs:read', {}, now)).toBe(false)
  expect(isAuthorized({ ...value, expiresAt: now.toISOString() }, 'runs:read', { runId: 'r1' }, now)).toBe(false)
  expect(isAuthorized({ ...value, revokedAt: '2026-10-17T00:00:00Z' }, 'runs:read', { runId: 'r1' }, now)).toBe(false)
})

it('auth.worker-complete-grants', () => {
  clock()
  const incomplete = principal('worker', [
    { actions: ['interactions:read'], scope: { workspaceIds: ['w'], workflowIds: ['f'] } },
    { actions: ['interactions:read'], scope: { runIds: ['r'] } },
  ])
  expect(workerScopesForAction(incomplete, 'interactions:read')).toEqual([])
  const complete = principal('worker', [
    { actions: ['interactions:read'], scope: { workspaceIds: ['w1'], workflowIds: ['f1'], runIds: ['r1'] } },
    { actions: ['interactions:read', 'bug_reports:report'], scope: { workspaceIds: ['w2'], workflowIds: ['f2'], runIds: ['r2'] } },
  ])
  expect(workerScopesForAction(complete, 'interactions:read')).toHaveLength(2)
  expect(workerScopesForAction(complete, 'interactions:respond')).toEqual([])
  expect(workerScope(complete)).toEqual({ workspaceIds: ['w1', 'w2'], workflowIds: ['f1', 'f2'], runIds: ['r1', 'r2'] })
})

it('auth.approval-user-authority', () => {
  clock()
  const user = principal('user', [{ actions: ['interactions:read', 'interactions:respond', 'capabilities:read'], scope: {} }])
  expect(canUserInteract(user, 'interactions:read', {})).toBe(true)
  expect(canUserInteract(user, 'interactions:respond', {})).toBe(true)
  expect(isAuthorized(user, 'capabilities:read', {}, now)).toBe(false)
  expect(workerScopesForAction(user, 'interactions:read')).toEqual([])
})

it('auth.delegation-intersection', () => {
  const issued = principal('operator', [{ actions: ['runs:read', 'runs:read', 'runs:stop'], scope: { workspaceIds: ['w1', 'w2', 'w1'], runIds: ['r1'] } }])
  const current = principal('operator', [
    { actions: ['runs:read'], scope: { workspaceIds: ['w1'], runIds: ['r1'] } },
    { actions: ['runs:stop'], scope: { workspaceIds: ['w2'], runIds: ['r2'] } },
  ])
  expect(intersectGrants(issued.grants, current.grants)).toEqual([
    { actions: ['runs:read', 'runs:read'], scope: { workspaceIds: ['w1', 'w1'], runIds: ['r1'] } },
  ])
})

it('auth.timestamp-source-boundaries', () => {
  clock()
  const value = principal('operator', [{ actions: ['capabilities:read'], scope: {} }])
  const outcomes = [
    ['2026-10-18T12:00:00Z', true, false], ['2026-10-18T12:00:00.000999999999Z', true, false],
    ['2026-10-18T12:00:00.001000000001Z', true, true], ['2026-10-18T14:00:00+02:00', true, false],
    ['2026-10-18T10:00:00.001-02:00', true, true], ['2026-10-18T12:01Z', false, false],
    ['2026-10-18T14:00:00+0200', false, false], ['0000-01-01T00:00:00Z', true, false],
    ['9999-12-31T23:59:59.999Z', true, true],
  ] as const
  for (const [expiresAt, accepted, active] of outcomes) {
    const parsed = ManagementPrincipalSchema.safeParse({ ...value, expiresAt })
    expect(parsed.success).toBe(accepted)
    if (parsed.success) expect(hasAction(parsed.data, 'capabilities:read')).toBe(active)
  }
})

it('auth.utf16-scope-identity', () => {
  const value = principal('operator', [{ actions: ['runs:read'], scope: { runIds: ['\ud800'] } }])
  expect(isAuthorized(value, 'runs:read', { runId: '\ud800' }, now)).toBe(true)
  expect(isAuthorized(value, 'runs:read', { runId: '\ufffd' }, now)).toBe(false)
})
