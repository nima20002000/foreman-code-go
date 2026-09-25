import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { startFixture } from './eng04-start-fixtures.js'

// Dispatch/redaction unit tests. These are not authenticated HTTP/MCP endpoint
// tests; all application boundaries except schemas/policy are explicit doubles.
const hooks = vi.hoisted(() => ({ repeat: vi.fn(), oneShot: vi.fn(), wave25: vi.fn() }))
vi.mock('../src/modules/runs/repeatStartAdmission.js', () => ({ admitRepeatRun: hooks.repeat }))
vi.mock('../src/modules/runs/oneShotAdmission.js', () => ({ admitOneShotRun: hooks.oneShot }))
vi.mock('@graphql/contracts/wave25', async (original) => ({ ...await original<object>(), assertWave25Admission: hooks.wave25 }))
beforeEach(() => { vi.resetAllMocks() })

function service() {
  const start = vi.fn(async () => undefined), execute = vi.fn()
  type Dependencies = ConstructorParameters<typeof RunManagementService>
  const values = [{}, { execute }, {}, { start }, {}] as unknown as Dependencies
  return { start, execute, values, service: new RunManagementService(...values) }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('ENG04 NATIVE-3 explicit existing service Start arm', () => {
  it.each(['http', 'mcp'] as const)('%s keeps new v3 admission closed and never falls through to legacy/v2', async (source) => {
    const f = startFixture(), s = service()
    hooks.repeat.mockImplementation(async (_pool, _locations, _principal, _source, _command, publisher) => {
      expect(publisher).toBeUndefined()
      throw new DomainError('REPEAT_START_RUNTIME_UNAVAILABLE', 'not composed', 409)
    })
    await expect(s.service.start(f.principal, source, f.request)).rejects.toMatchObject({ code: 'REPEAT_START_RUNTIME_UNAVAILABLE' })
    await turn()
    expect(s.execute).not.toHaveBeenCalled()
    expect(hooks.oneShot).not.toHaveBeenCalled()
    expect(s.start).not.toHaveBeenCalled()
  })
  it('returns a verified v3 receipt without a second dispatch and strips the accepted authority ID', async () => {
    const f = startFixture(), s = service()
    hooks.repeat.mockResolvedValue({ value: f.run, replayed: true })
    const result = await s.service.start(f.principal, 'http', f.request)
    await turn()
    expect(result.replayed).toBe(true)
    expect('executionSemanticsVersion' in result.run && result.run.executionSemanticsVersion).toBe(3)
    expect(result.run.authorizationPrincipalId).toBeUndefined()
    expect(f.run.authorizationPrincipalId).toBeDefined()
    expect(s.start).not.toHaveBeenCalled()
    expect(hooks.repeat).toHaveBeenCalledWith(s.values[0], s.values[4], f.principal, 'http', f.request, undefined, {})
  })
  it('preserves the existing v2 arm rather than sending it to the repeat service', async () => {
    const f = startFixture(), s = service()
    hooks.oneShot.mockResolvedValue({ value: f.f.run, replayed: true })
    const result = await s.service.start(f.principal, 'mcp', { workspaceId: f.f.run.workspaceId,
      workflowId: f.f.run.workflowId, workflowVersionId: f.f.run.workflowVersionId, executionSemanticsVersion: 2,
      commandId: 'v2-control-start', expectedLocationRevision: 4, input: {} })
    expect(result.replayed).toBe(true)
    expect(hooks.wave25).toHaveBeenCalledTimes(1)
    expect(hooks.oneShot).toHaveBeenCalledTimes(1)
    expect(hooks.repeat).not.toHaveBeenCalled()
    expect(s.execute).not.toHaveBeenCalled()
  })
  it('denied or malformed/unknown-version calls cannot reach any admission boundary', async () => {
    const f = startFixture(), s = service()
    await expect(s.service.start({ ...f.principal, grants: [] }, 'http', f.request)).rejects.toThrow()
    const bad = { ...f.request, executionSemanticsVersion: '3' } as unknown as Parameters<RunManagementService['start']>[2]
    await expect(s.service.start(f.principal, 'http', bad)).rejects.toMatchObject({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
    const incomplete = { ...f.request } as Record<string, unknown>
    delete incomplete.expectedWorkflowRevision
    await expect(s.service.start(f.principal, 'http', incomplete as Parameters<RunManagementService['start']>[2])).rejects.toThrow()
    expect(hooks.repeat).not.toHaveBeenCalled()
    expect(hooks.oneShot).not.toHaveBeenCalled()
    expect(s.execute).not.toHaveBeenCalled()
    expect(s.start).not.toHaveBeenCalled()
  })
})
