import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { continuationValidator } from '../src/modules/runs/continuation.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../src/modules/workspaces/location.js'

function fixture(mode: 1 | 2 = 2) {
  const f = makeWave25Fixture(`r1-continuation-${mode}`)
  const run: Record<string, unknown> = { ...f.run, executionState: 'running', authorizationPrincipalId: 'authorized-user',
    executionLocation: { runnerId: 'local', rootPath: '/synthetic/project', locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } }
  if (mode === 1) delete run.executionSemanticsVersion
  const row = { run, execution: { ...f.executions[0]!, state: 'running', workingDirectory: '/synthetic/project' },
    configuration: structuredClone(f.configurations[0]!) }
  const query = vi.fn(async () => ({ rows: [row] }))
  const authorization = vi.fn(async () => undefined), location = vi.fn(async () => undefined)
  const pool = { query } as unknown as pg.Pool
  const locations = { revalidateRunAuthorization: authorization, revalidateSnapshot: location } as unknown as WorkspaceLocationService
  return { ...f, row, query, authorization, location, pool, validate: continuationValidator(pool, locations) }
}

describe('BR1-001: real shared continuation validator', () => {
  it.each([1, 2] as const)('valid v%s records reach the existing authority and filesystem checks', async (mode) => {
    const f = fixture(mode), signal = new AbortController().signal
    await f.validate(f.row.execution.id, signal)
    expect(f.authorization).toHaveBeenCalledWith('authorized-user', f.run.workspaceId, f.run.workflowId, f.pool)
    expect(f.location).toHaveBeenCalledWith(f.run.workspaceId, f.row.run.executionLocation, requiredLocationAccess([f.row.configuration]), signal)
  })
  it.each([1, 2] as const)('v%s malformed records are still strictly rejected', async (mode) => {
    const f = fixture(mode)
    f.row.run.unrecognizedField = true
    await expect(f.validate(f.row.execution.id)).rejects.toBeDefined()
    expect(f.authorization).not.toHaveBeenCalled()
    expect(f.location).not.toHaveBeenCalled()
  })
  it.each(['executionId', 'runId', 'configurationId', 'configurationWorkspace', 'configurationAgent', 'immutablePin', 'directory'] as const)(
    'rejects a mismatched %s before native preflight', async (field) => {
      const f = fixture(), requestedId = f.row.execution.id
      if (field === 'executionId') f.row.execution.id = 'another-execution'
      if (field === 'runId') f.row.execution.runId = 'another-run'
      if (field === 'configurationId') f.row.configuration.id = 'another-configuration'
      if (field === 'configurationWorkspace') f.row.configuration.workspaceId = 'another-workspace'
      if (field === 'configurationAgent') f.row.configuration.agentId = 'another-agent'
      if (field === 'immutablePin') f.row.run.agentConfigurationVersionIds = { [f.row.execution.agentId]: 'another-configuration' }
      if (field === 'directory') f.row.execution.workingDirectory = '/other/project'
      await expect(f.validate(requestedId)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_IDENTITY_INVALID' })
      expect(f.location).not.toHaveBeenCalled()
    })
  it('revoked authority remains denied before filesystem work', async () => {
    const f = fixture(), revoked = new Error('AUTH_REVOKED')
    f.authorization.mockRejectedValueOnce(revoked)
    await expect(f.validate(f.row.execution.id)).rejects.toBe(revoked)
    expect(f.location).not.toHaveBeenCalled()
  })
  it('a location revalidation failure remains denied', async () => {
    const f = fixture(), invalid = new Error('LOCATION_CHANGED')
    f.location.mockRejectedValueOnce(invalid)
    await expect(f.validate(f.row.execution.id)).rejects.toBe(invalid)
  })
  it('an interrupted Run cannot authorize attachment', async () => {
    const f = fixture(); f.row.run.executionState = 'interrupted'
    await expect(f.validate(f.row.execution.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_IDENTITY_INVALID' })
    expect(f.location).not.toHaveBeenCalled()
  })
  it('missing accepted location is not invented for legacy or v2 work', async () => {
    const f = fixture(); delete f.row.run.executionLocation
    await expect(f.validate(f.row.execution.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_IDENTITY_INVALID' })
  })
  it('cancellation remains visible after validation', async () => {
    const f = fixture(), controller = new AbortController(), error = new Error('stop')
    controller.abort(error)
    await expect(f.validate(f.row.execution.id, controller.signal)).rejects.toBe(error)
  })
})
