import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexHarnessConfigurationSchema } from '@foreman-code/contracts'
import { AgentCreateInputSchema, WorkspaceCreateInputSchema } from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeFailure } from '../reporting/report.js'
import type { ScenarioContext } from '../scenario.js'
import { createWorkspace } from '../scenarios/smoke/support.js'
import { createCodexAgent } from '../scenarios/workflows/agents.js'
import { createExecutableWorkflow } from '../scenarios/workflows/authoring.js'
import { PublicHttpClient } from './http.js'

afterEach(() => { vi.unstubAllGlobals() })

function context(scenarioDirectory = '/unused-http-helper-fixture'): ScenarioContext {
  const origin = `http://127.0.0.1:${randomInt(20_000, 60_000)}`
  return {
    http: new PublicHttpClient({ baseUrl: origin, browserOrigin: origin, token: 'synthetic-request-credential' }),
    scenarioDirectory, signal: new AbortController().signal,
    get target(): never { throw new Error('These HTTP helper tests must not start or access a target runtime.') },
  }
}

function returnJson(body: unknown, status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })))
}

async function failureOf(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    return describeFailure(error)
  }
  throw new Error('The public helper accepted an unsuccessful response.')
}

const timestamp = '2026-10-17T00:00:00.000Z'

function acceptedWorkspace(name: string, executionLocation: { runnerId: string; rootPath: string } | null = null) {
  return {
    value: {
      workspace: { id: `workspace-${randomUUID()}`, name, description: 'Isolated conformance workspace.',
        createdAt: timestamp, updatedAt: timestamp },
      revision: 1, archivedAt: null, executionLocation, locationRevision: executionLocation ? 1 : 0,
      locationValidation: executionLocation ? { status: 'ready', checkedAt: timestamp } : { status: 'restricted' },
    },
    replayed: false,
  }
}

describe('public HTTP success diagnostics', () => {
  it('reports a rejected Workspace mutation before reading success fields', async () => {
    const body = { error: { code: 'SYNTHETIC_WORKSPACE_REJECTION', message: 'The isolated location was rejected.',
      details: { cause: { code: 'SYNTHETIC_LOCATION_CAUSE', message: 'Fixture location unavailable.' } }, requestId: randomUUID() } }
    returnJson(body, 409)
    const failure = await failureOf(() => createWorkspace(context(), 'Diagnostic workspace'))
    expect(failure.name).toBe('PublicHttpResponseError')
    expect(failure.details).toEqual({ method: 'POST', path: '/api/management/workspaces', status: 409,
      expectedStatus: 201, contract: 'ManagedWorkspaceCommandResult',
      contentType: 'application/json',
      responseBodyPreview: JSON.stringify(body), responseBodyTruncated: false })
    expect(failure.cause).toBeUndefined()
  })

  it('identifies the rejected Agent mutation and retains its public error', async () => {
    const workspaceId = `workspace-${randomUUID()}`
    const body = { error: { code: 'SYNTHETIC_AGENT_REJECTION', message: 'The requested fixture configuration was rejected.',
      details: { reason: 'Synthetic compatibility conflict.' }, requestId: randomUUID() } }
    returnJson(body, 422)
    const failure = await failureOf(() => createCodexAgent(context(), workspaceId, { name: 'Diagnostic Agent' }))
    expect(failure.name).toBe('PublicHttpResponseError')
    expect(failure.details).toEqual({ method: 'POST', path: `/api/management/workspaces/${workspaceId}/agents`, status: 422,
      expectedStatus: 201, contract: 'AgentMutationResult',
      contentType: 'application/json',
      responseBodyPreview: JSON.stringify(body), responseBodyTruncated: false })
  })

  it('identifies Workflow creation after accepted Workspace and Agent fixture responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foreman-http-diagnostic-'))
    try {
      const name = 'Diagnostic workflow'
      const workspace = acceptedWorkspace(name, { runnerId: 'runner-local', rootPath: join(await realpath(directory), name) })
      const workspaceId = workspace.value.workspace.id
      const errorBody = { error: { code: 'SYNTHETIC_WORKFLOW_REJECTION', message: 'The initial Save was rejected.',
        details: { reason: 'Synthetic immutable pin conflict.' }, requestId: randomUUID() } }
      const calls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
        const path = url.pathname
        calls.push(`${options.method} ${path}`)
        if (path === '/api/management/workspaces') {
          const input = WorkspaceCreateInputSchema.parse(JSON.parse(String(options.body)))
          expect(input.name).toBe(name)
          expect(input.parentPath).toBe(directory)
          return Response.json(workspace, { status: 201 })
        }
        if (path === `/api/management/workspaces/${workspaceId}/agents`) {
          const input = AgentCreateInputSchema.parse(JSON.parse(String(options.body)))
          const configuration = CodexHarnessConfigurationSchema.parse(input.configuration)
          return Response.json({ value: { agent: {
            id: input.agentId, name: input.name, productRole: input.productRole, harness: 'codex',
            model: configuration.model, effort: configuration.reasoningEffort,
            fastMode: configuration.serviceTier === 'priority', harnessConfiguration: configuration,
            configurationVersionId: `configuration-${randomUUID()}`, prompt: input.prompt,
            assignedSkills: input.assignedSkills, nativeTools: input.nativeTools, createdAt: timestamp, updatedAt: timestamp,
          }, metadataRevision: 1 }, replayed: false }, { status: 201 })
        }
        expect(path).toBe(`/api/management/workspaces/${workspaceId}/workflows`)
        return Response.json(errorBody, { status: 409 })
      }))
      const failure = await failureOf(() => createExecutableWorkflow(context(directory), { name }))
      expect(calls).toEqual(['POST /api/management/workspaces',
        `POST /api/management/workspaces/${workspaceId}/agents`, `POST /api/management/workspaces/${workspaceId}/workflows`])
      expect(failure.name).toBe('PublicHttpResponseError')
      expect(failure.details).toEqual({ method: 'POST', path: `/api/management/workspaces/${workspaceId}/workflows`, status: 409,
        expectedStatus: 201, contract: 'CurrentManagedWorkflowCommandResult',
        contentType: 'application/json',
        responseBodyPreview: JSON.stringify(errorBody), responseBodyTruncated: false })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an error envelope at the expected status and retains the schema cause', async () => {
    const body = { error: { code: 'SYNTHETIC_WRONG_ENVELOPE', message: 'This is an error, even at HTTP 201.' } }
    returnJson(body, 201)
    const failure = await failureOf(() => createWorkspace(context(), 'Diagnostic workspace'))
    expect(failure.name).toBe('PublicHttpResponseError')
    expect(failure.details).toEqual({ method: 'POST', path: '/api/management/workspaces', status: 201,
      expectedStatus: 201, contract: 'ManagedWorkspaceCommandResult',
      contentType: 'application/json',
      responseBodyPreview: JSON.stringify(body), responseBodyTruncated: false })
    expect(failure.cause?.name).toBe('ZodError')
    expect(failure.cause?.message.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(failure.cause!.message)).toBeLessThanOrEqual(2048)
  })

  it('retains a text HTTP failure while redacting embedded bearer credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Synthetic upstream unavailable; Bearer synthetic-response-secret',
      { status: 503, headers: { 'content-type': 'text/plain', 'set-cookie': 'synthetic-header-secret' } })))
    const failure = await failureOf(() => createWorkspace(context(), 'Diagnostic workspace'))
    expect(failure.name).toBe('PublicHttpResponseError')
    expect(failure.details).toEqual({ method: 'POST', path: '/api/management/workspaces', status: 503,
      expectedStatus: 201, contract: 'ManagedWorkspaceCommandResult',
      contentType: 'text/plain',
      responseBodyPreview: JSON.stringify('Synthetic upstream unavailable; Bearer [redacted]'), responseBodyTruncated: false })
    expect(JSON.stringify(failure)).not.toContain('synthetic-response-secret')
    expect(JSON.stringify(failure)).not.toContain('synthetic-header-secret')
    expect(JSON.stringify(failure)).not.toContain('synthetic-request-credential')
  })

  it('bounds the failure body and redacts credential fields before truncation', async () => {
    const workspaceId = `workspace-${randomUUID()}`
    const body = { error: { code: 'SYNTHETIC_LARGE_ERROR',
      message: 'Synthetic message mentions nested-secret-value and synthetic-header-secret.',
      details: { accessToken: 'nested-secret-value', headers: { authorization: 'synthetic-header-secret' },
        request: { headers: { credential: 'synthetic-request-echo-secret' } }, prompt: 'synthetic-prompt-secret',
        cause: 'Bearer synthetic-cause-secret; synthetic-request-echo-secret', trace: '界'.repeat(10_000) } } }
    returnJson(body, 500)
    const failure = await failureOf(() => createCodexAgent(context(), workspaceId, { name: 'Diagnostic Agent' }))
    expect(failure.name).toBe('PublicHttpResponseError')
    expect(failure.details).toMatchObject({ method: 'POST', path: `/api/management/workspaces/${workspaceId}/agents`,
      status: 500, expectedStatus: 201, contract: 'AgentMutationResult',
      responseBodyPreview: expect.any(String), responseBodyTruncated: true })
    const preview = (failure.details as { responseBodyPreview: string }).responseBodyPreview
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(4096)
    const output = JSON.stringify(failure)
    expect(output).toContain('SYNTHETIC_LARGE_ERROR')
    expect(output).toContain('[redacted]')
    expect(output).toContain('[truncated]')
    for (const secret of ['nested-secret-value', 'synthetic-header-secret', 'synthetic-prompt-secret',
      'synthetic-cause-secret', 'synthetic-request-echo-secret', 'synthetic-request-credential']) expect(output).not.toContain(secret)
    expect(Buffer.byteLength(output)).toBeLessThan(8000)
  })

  it('returns an accepted Workspace with the original exact success assertions', async () => {
    const body = acceptedWorkspace('Accepted diagnostic workspace')
    returnJson(body, 201)
    const result = await createWorkspace(context(), 'Accepted diagnostic workspace')
    expect(result.created).toEqual(body.value)
  })

  it('still rejects a schema-valid response that violates exact success expectations', async () => {
    returnJson({ ...acceptedWorkspace('Diagnostic workspace'), replayed: true }, 201)
    const failure = await failureOf(() => createWorkspace(context(), 'Diagnostic workspace'))
    expect(failure.name).toBe('AssertionError')
  })

  it('leaves intentional error responses available through the public HTTP client', async () => {
    const body = { error: { code: 'SYNTHETIC_DENIED', message: 'The caller is denied.', requestId: randomUUID() } }
    returnJson(body, 403)
    const response = await context().http.request('GET', '/api/management/workspaces')
    expect(response.status).toBe(403)
    expect(response.body).toEqual(body)
  })
})
