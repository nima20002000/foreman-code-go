import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssuedWorkerCredential } from '../src/modules/access/workerCredentials.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'
import type { NativeMcpInspector } from '../src/modules/harnesses/mcpDetection.js'
import { DomainError } from '../src/modules/errors.js'
import { providerAppEndpoint, providerLaunchCredentials } from './helpers/wave25Br1003Runtime.js'

const { validate } = vi.hoisted(() => ({ validate: vi.fn() }))
vi.mock('../src/modules/runs/continuation.js', () => ({ continuationValidator: () => validate }))

type Ports = Parameters<typeof providerLaunchCredentials>
/** Unit scope: the fixture's real runner/directory/configuration guard and real
 * MCP preflight. SQL continuation and issuance are observed ports, not claims
 * of database authorization. The PG scenarios retain all real authority checks. */
function fixture(runnerId = 'local') {
  const signal = new AbortController().signal
  const input = { executionId: 'eng07-execution', harness: 'codex' as const,
    workingDirectory: '/eng07-test-project', signal }
  const execution = { id: input.executionId, runId: 'eng07-run', agentId: 'eng07-agent',
    agentConfigurationVersionId: 'eng07-configuration', workingDirectory: input.workingDirectory }
  const configuration = { id: execution.agentConfigurationVersionId, agentId: execution.agentId,
    harness: { harness: 'codex' as const } }
  const run = { executionLocation: { runnerId } }
  const runs = { getExecution: vi.fn(async () => execution), get: vi.fn(async () => run),
    getExecutionConfiguration: vi.fn(async () => configuration) }
  const manager = { harness: 'codex' as const }
  const managers = { resolve: vi.fn(() => ({ manager })) }
  const credential: IssuedWorkerCredential = { principalId: 'eng07-unit-principal',
    expiresAt: '2099-01-01T00:00:00.000Z', environment: { agentId: execution.agentId, variables: {} } }
  const credentials = { ttlMs: 900000, issueForExecution: vi.fn(async () => credential),
    revokeSupersededForExecution: vi.fn(async () => 0), revokeForExecution: vi.fn(async () => 0) }
  const inspect = vi.fn<NativeMcpInspector['inspect']>(async (context) => ({ harness: context.harness,
    providerVersion: '0.154.0', runnerId: context.runnerId, workingDirectory: context.workingDirectory,
    inspectedAt: new Date().toISOString(), entry: { name: context.serverName, transport: 'streamable-http',
      endpoint: providerAppEndpoint, enabled: true, credentialEnvironmentVariable: APP_MCP_TOKEN_ENVIRONMENT_VARIABLE,
      status: 'connected' } }))
  const inspector = vi.fn(() => ({ inspect }))
  const provider = providerLaunchCredentials(runs as unknown as Ports[0], { runnerId: 'local' } as Ports[1],
    managers as unknown as Ports[2], credentials as unknown as Ports[3], inspector, {} as Ports[5])
  return { provider, input, execution, configuration, run, runs, managers, credentials, inspect, inspector, credential }
}
function noPreflightEffects(f: ReturnType<typeof fixture>) {
  expect(f.managers.resolve).not.toHaveBeenCalled()
  expect(f.inspector).not.toHaveBeenCalled()
  expect(f.inspect).not.toHaveBeenCalled()
  expect(f.credentials.revokeSupersededForExecution).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
  expect(f.credentials.issueForExecution).not.toHaveBeenCalled()
}
beforeEach(() => { validate.mockReset(); validate.mockResolvedValue(undefined) })
afterEach(() => vi.restoreAllMocks())

describe('ENG07-B provider preflight keeps the strict seeded-runner boundary', () => {
  it('qualifies and issues only for the exact local execution without changing its pins', async () => {
    const f = fixture(), before = structuredClone({ execution: f.execution, configuration: f.configuration, run: f.run })
    const prepared = await f.provider.prepare(f.input)
    expect(validate).toHaveBeenCalledExactlyOnceWith(f.input.executionId, f.input.signal)
    expect(f.managers.resolve).toHaveBeenCalledExactlyOnceWith({ executionId: f.execution.id,
      agentId: f.execution.agentId, harness: 'codex', workingDirectory: f.input.workingDirectory,
      configuration: f.configuration })
    expect(f.inspect).toHaveBeenCalledTimes(1)
    expect(f.inspect.mock.calls[0]![0]).toMatchObject({ runnerId: 'local',
      workingDirectory: f.input.workingDirectory, harness: 'codex', phase: 'configuration' })
    expect(f.credentials.revokeSupersededForExecution).toHaveBeenCalledExactlyOnceWith(f.input.executionId)
    expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
    expect(f.credentials.issueForExecution).toHaveBeenCalledExactlyOnceWith(f.input.executionId)
    expect(prepared.credential).toBe(f.credential)
    expect(prepared.detection).toMatchObject({ runnerId: 'local', detection: { state: 'connected' } })
    expect({ execution: f.execution, configuration: f.configuration, run: f.run }).toEqual(before)
  })
  it.each(['runner-local', 'different-runner'])('rejects %s BEFORE provider inspection or credential mutation', async (runnerId) => {
    const f = fixture(runnerId)
    await expect(f.provider.prepare(f.input)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_IDENTITY_INVALID',
      message: 'Credential preflight requires the pinned local execution.' })
    expect(validate).toHaveBeenCalledExactlyOnceWith(f.input.executionId, f.input.signal)
    noPreflightEffects(f)
  })
  it('still rejects a different accepted directory before native or credential work', async () => {
    const f = fixture()
    f.execution.workingDirectory = '/another-test-project'
    await expect(f.provider.prepare(f.input)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_IDENTITY_INVALID',
      message: 'Credential preflight requires the accepted directory.' })
    noPreflightEffects(f)
  })
  it('still rejects another Agent configuration before native or credential work', async () => {
    const f = fixture()
    f.configuration.agentId = 'another-agent'
    await expect(f.provider.prepare(f.input)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_IDENTITY_INVALID' })
    noPreflightEffects(f)
  })
  it('propagates the original continuation denial before reading execution or creating a native manager', async () => {
    const f = fixture(), error = new DomainError('AUTH_REVOKED', 'Unit continuation denial', 401)
    validate.mockRejectedValueOnce(error)
    await expect(f.provider.prepare(f.input)).rejects.toBe(error)
    expect(f.runs.getExecution).not.toHaveBeenCalled()
    noPreflightEffects(f)
  })
})
