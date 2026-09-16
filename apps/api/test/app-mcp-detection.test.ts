import { describe, expect, it } from 'vitest'

import {
  McpDetectionService,
  WorkerLaunchCredentialService,
  intersectNativeToolFilters,
  type NativeMcpInspectionEvidence,
  type NativeMcpInspector,
} from '../src/modules/harnesses/mcpDetection.js'

const base: NativeMcpInspectionEvidence = {
  harness: 'codex', providerVersion: '0.154.0', runnerId: 'runner-a',
  workingDirectory: '/workspace', inspectedAt: '2026-09-16T00:00:00.000Z',
}

function service(evidence: NativeMcpInspectionEvidence | Error) {
  const inspector: NativeMcpInspector = {
    inspect: async () => { if (evidence instanceof Error) throw evidence; return evidence },
  }
  return new McpDetectionService(inspector, 'http://127.0.0.1:3000/mcp/tools')
}

async function state(entry: NativeMcpInspectionEvidence['entry'], harness: 'codex' | 'opencode' = 'codex') {
  return (await service({ ...base, harness, providerVersion: harness === 'codex' ? '0.154.0' : '1.18.31', ...(entry ? { entry } : {}) }).inspect({
    harness, runnerId: 'runner-a', workingDirectory: '/workspace',
  })).detection.state
}

describe('App MCP detection normalization', () => {
  const matching = {
    name: 'graphql-app', transport: 'streamable-http' as const,
    endpoint: 'http://127.0.0.1:3000/mcp/tools',
    credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN',
  }

  it('covers every honest normalized state without treating inspection failure as absence', async () => {
    for (const harness of ['codex', 'opencode'] as const) {
      expect(await state(undefined, harness)).toBe('not_detected')
      expect(await state({ ...matching, endpoint: 'http://127.0.0.1:9999/mcp/tools' }, harness)).toBe('misconfigured')
      expect(await state(matching, harness)).toBe('status_unavailable')
      expect(await state({ ...matching, status: 'connected' }, harness)).toBe('connected')
      expect(await state({ ...matching, status: 'disabled' }, harness)).toBe('disabled')
      expect(await state({ ...matching, status: 'authentication_required' }, harness)).toBe('authentication_required')
      expect(await state({ ...matching, status: 'broken' }, harness)).toBe('broken')
    }
    const failed = await service(new Error('unsupported output')).inspect({
      harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
    })
    expect(failed.detection).toMatchObject({ state: 'check_failed', endpointMatches: null })
    expect(failed.detection.detail).toContain('unsupported output')
  })

  it('requires exact endpoint, transport, and credential reference before preflight succeeds', async () => {
    await expect(service({ ...base, entry: { ...matching, credentialEnvironmentVariable: 'OTHER' } }).preflight({
      harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
    })).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    await expect(service({ ...base, entry: matching }).preflight({
      harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
    })).resolves.toMatchObject({ detection: { state: 'status_unavailable' } })
  })

  it('applies native filters only as a narrowing intersection', () => {
    expect(intersectNativeToolFilters(
      ['context_get', 'interaction_list', 'interaction_get'],
      { enabledTools: ['context_get', 'interaction_respond'], disabledTools: ['interaction_get'] },
    )).toEqual(['context_get'])
  })

  it('does not issue a credential until preflight succeeds', async () => {
    let issued = 0
    const credentials = {
      issueForExecution: async () => { issued += 1; throw new Error('must not issue') },
      revoke: async () => undefined,
    }
    const launch = new WorkerLaunchCredentialService(
      service({ ...base, entry: { ...matching, endpoint: 'http://127.0.0.1:9999/mcp/tools' } }),
      credentials as never,
      'runner-a',
    )
    await expect(launch.prepare({
      executionId: 'execution-a', harness: 'codex', workingDirectory: '/workspace',
    })).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    expect(issued).toBe(0)
  })
})
