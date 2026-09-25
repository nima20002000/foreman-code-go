import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import {
  REPEAT_OPERATOR_TOOL_NAMES, OperatorToolNameSchema, RepeatCapabilitiesResultSchema,
  type ManagementPrincipal,
} from '@graphql/contracts/management'
import { RepeatCapabilityV1Schema } from '@graphql/contracts/wave25'
import { RepeatAuthoringService } from '../src/modules/repeats/authoring.js'
import { OPERATOR_TOOL_ACTIONS } from '../src/mcp/operator/catalog.js'
import { operatorToolAvailable, operatorToolRequirements } from '../src/mcp/operator/availability.js'
import { unavailableRepeatToolCall } from '../src/mcp/operator/repeats.js'
import type { OperatorRequestContext, OperatorServices } from '../src/mcp/operator/types.js'

const scope = { workspaceId: 'composition-w', workflowId: 'composition-f', runId: 'composition-r' }
const read = ['workflows:read', 'graph:read', 'runs:read'] as const
const write = ['workflows:update', 'graph:edit', 'graph:save', 'agents:read'] as const
function context(grants: ManagementPrincipal['grants']): OperatorRequestContext {
  return {
    principal: { id: 'composition-principal', name: 'Synthetic composition test', audience: 'operator',
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants },
    // This suite tests catalog policy only, NOT authentication or PG authority.
    services: { repeats: {}, commands: { recordDenied: vi.fn().mockResolvedValue(undefined) } } as unknown as OperatorServices,
  }
}
const globalCapabilities: ManagementPrincipal['grants'][number] = { actions: ['capabilities:read'], scope: {} }
const matchingScope = { workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId] }

describe('ENG04 composition catalog, gate and independently scoped grants', () => {
  it('registers exactly the four shared repeat names with an action', () => {
    for (const name of REPEAT_OPERATOR_TOOL_NAMES) {
      expect(OperatorToolNameSchema.parse(name)).toBe(name)
      expect(OPERATOR_TOOL_ACTIONS.filter((entry) => entry.name === name)).toHaveLength(1)
    }
  })
  it('advertises read-only tools, not publication, and audits an attempted unlisted write', async () => {
    const c = context([globalCapabilities, { actions: [...read], scope: matchingScope }])
    expect(REPEAT_OPERATOR_TOOL_NAMES.filter((name) => operatorToolAvailable(c, name))).toEqual([
      'repeat_capabilities_get', 'repeat_get', 'repeat_run_get',
    ])
    const rejected = await unavailableRepeatToolCall(c, {
      jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'repeat_update', arguments: {} },
    })
    expect(rejected).toMatchObject({ id: 17, result: { isError: true, structuredContent: { error: { code: 'ACCESS_DENIED' } } } })
    expect(c.services.commands.recordDenied).toHaveBeenCalledExactlyOnceWith(c.principal.id, 'mcp', 'repeat_update', 'mcp:repeat_update')
  })
  it('requires compatible dependent scopes, not a union of disjoint grants', () => {
    const disjoint = context([
      { actions: [...read], scope: matchingScope },
      { actions: [...write], scope: { workspaceIds: ['another-workspace'] } },
    ])
    expect(operatorToolAvailable(disjoint, 'repeat_update')).toBe(false)
    const permitted = context([{ actions: [...read, ...write], scope: matchingScope }])
    expect(operatorToolAvailable(permitted, 'repeat_update')).toBe(true)
    expect(operatorToolAvailable(permitted, 'repeat_update', scope)).toBe(true)
    expect(operatorToolAvailable(permitted, 'repeat_update', { ...scope, workflowId: 'other' })).toBe(false)
    expect(operatorToolRequirements('repeat_update').map((item) => item.action)).not.toContain('runs:stop')
  })
  it('applies the optional capability resource to dependent reads, but requires a global capability grant', () => {
    const c = context([globalCapabilities, { actions: [...read], scope: matchingScope }])
    expect(operatorToolAvailable(c, 'repeat_capabilities_get')).toBe(true)
    expect(operatorToolAvailable(c, 'repeat_capabilities_get', scope)).toBe(true)
    expect(operatorToolAvailable(c, 'repeat_capabilities_get', { ...scope, workflowId: 'other' })).toBe(false)
    expect(operatorToolAvailable(c, 'repeat_capabilities_get', { workspaceId: scope.workspaceId })).toBe(false)
    const onlyScoped = context([{ actions: ['capabilities:read'], scope: { workspaceIds: [scope.workspaceId] } }])
    expect(operatorToolAvailable(onlyScoped, 'repeat_capabilities_get')).toBe(false)
    expect(operatorToolRequirements('repeat_capabilities_get', scope).map((item) => item.action))
      .toEqual(['capabilities:read', 'workflows:read', 'graph:read'])
  })
  it('honors Run-scoped reads without granting workflow publication', () => {
    const c = context([{ actions: [...read, ...write], scope: { ...matchingScope, runIds: [scope.runId] } }])
    expect(operatorToolAvailable(c, 'repeat_run_get')).toBe(true)
    expect(operatorToolAvailable(c, 'repeat_run_get', scope)).toBe(true)
    expect(operatorToolAvailable(c, 'repeat_get')).toBe(false)
    expect(operatorToolAvailable(c, 'repeat_update')).toBe(false)
  })
  it('hides absent services and does not intercept unrelated or malformed protocol messages', async () => {
    const c = context([{ actions: [...read, ...write], scope: matchingScope }])
    delete c.services.repeats
    expect(REPEAT_OPERATOR_TOOL_NAMES.some((name) => operatorToolAvailable(c, name))).toBe(false)
    for (const body of [null, [], { method: 'tools/call', params: { name: 'repeat_update' } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_stop' } }]) {
      expect(await unavailableRepeatToolCall(c, body)).toBeUndefined()
    }
    expect(c.services.commands.recordDenied).not.toHaveBeenCalled()
  })
  it('reports separate saved authoring and readback wiring without claiming runtime or edit-intent readiness', () => {
    const c = context([globalCapabilities])
    const service = new RepeatAuthoringService({} as pg.Pool, c.services.commands, true)
    const result = RepeatCapabilitiesResultSchema.parse(service.capabilities(c.principal, {}))
    expect(result.supported).toBe(false)
    expect(result.availability).toEqual({ savedAuthoring: true, persistedReadback: true,
      runtimeAdmission: false, meaningfulEdit: false, reasons: ['NATIVE_START_NOT_READY', 'REPEAT_EDIT_INTENT_NOT_READY'] })
    // Keep A0 limits aligned without importing repeatAuthoring into management
    // and creating a cyclic eager schema initialization.
    const { availability, ...contract } = result
    void availability
    expect(RepeatCapabilityV1Schema.safeParse({ ...contract, supported: true }).success).toBe(true)
    expect(RepeatCapabilitiesResultSchema.safeParse({ ...result, supported: true }).success).toBe(false)
    expect(new RepeatAuthoringService({} as pg.Pool, c.services.commands).capabilities(c.principal, {}).availability.persistedReadback).toBe(false)
  })
})
