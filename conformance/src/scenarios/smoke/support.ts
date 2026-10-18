import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import {
  ManagedWorkspaceCommandResultSchema,
  ManagedWorkspaceSchema,
  WorkspaceCreateInputSchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import { parseSuccessResponse } from '../../clients/response.js'
import type { CoverageClaim, ScenarioContext } from '../../scenario.js'

export function httpCoverage(method: string, path: string, outcome: 'success' | 'error'): CoverageClaim {
  return { surface: 'http', method, path, case: outcome }
}

export async function createWorkspace(ctx: ScenarioContext, name: string, parentPath?: string) {
  const input = WorkspaceCreateInputSchema.parse({
    commandId: randomUUID(), name, description: 'Isolated conformance workspace.',
    ...(parentPath === undefined ? {} : { parentPath }),
  })
  const response = await ctx.http.request('POST', '/api/management/workspaces', { body: input })
  const created = parseSuccessResponse(response, ManagedWorkspaceCommandResultSchema, {
    method: 'POST', path: '/api/management/workspaces', status: 201, contract: 'ManagedWorkspaceCommandResult',
  })
  assertResponse(response, {
    status: 201,
    body: {
      value: {
        workspace: {
          id: '<id>', name, description: input.description,
          createdAt: '<timestamp>', updatedAt: '<timestamp>',
        },
        revision: 1, archivedAt: null,
        executionLocation: parentPath === undefined ? null : {
          runnerId: 'runner-local', rootPath: join(await realpath(parentPath), name),
        },
        locationRevision: parentPath === undefined ? 0 : 1,
        locationValidation: parentPath === undefined ? { status: 'restricted' }
          : { status: 'ready', checkedAt: '<timestamp>' },
      },
      replayed: false,
    },
  }, [
    { pointer: '/body/value/workspace/id', kind: 'id' },
    { pointer: '/body/value/workspace/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/workspace/updatedAt', kind: 'timestamp' },
    ...(parentPath === undefined ? [] : [{ pointer: '/body/value/locationValidation/checkedAt', kind: 'timestamp' as const }]),
  ])
  assert.equal(created.value.workspace.createdAt, created.value.workspace.updatedAt)
  assert.match(created.value.workspace.id, /^workspace-[0-9a-f-]{36}$/)
  return { input, created: created.value }
}

export async function readWorkspace(ctx: ScenarioContext, created: ReturnType<typeof ManagedWorkspaceSchema.parse>) {
  const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}`)
  ManagedWorkspaceSchema.parse(response.body)
  assertResponse(response, {
    status: 200,
    body: { ...created, locationValidation: { status: 'unconfigured' } },
  })
}

export function assertApiError(
  response: Awaited<ReturnType<ScenarioContext['http']['request']>>,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  ApiErrorResponseSchema.parse(response.body)
  assertResponse(response, {
    status,
    body: { error: { code, message, ...(details ? { details } : {}), requestId: '<uuid>' } },
  }, [{ pointer: '/body/error/requestId', kind: 'uuid' }])
}
