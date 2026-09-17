import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopedMcpDetectionSchema } from '@graphql/contracts'

import { queryKeys } from '../../shared/api/query'
import { McpDetectionSettings } from './McpDetectionSettings'

afterEach(cleanup)

describe('MCP detection settings', () => {
  function seedWorkspace(client: QueryClient, workspaceId: string, workingDirectory: string) {
    const value = {
      workspace: { id: workspaceId, name: 'Test workspace', description: '' }, revision: 1, archivedAt: null,
      executionLocation: { runnerId: 'runner-local', rootPath: workingDirectory }, locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: '2026-09-16T00:00:00.000Z' },
    }
    client.setQueryData(queryKeys.managedWorkspaces, { items: [value], pageInfo: { nextCursor: null } })
    client.setQueryData(queryKeys.managedWorkspace(workspaceId), value)
  }
  it('distinguishes connected evidence from an unknown failed check and scopes both to the runner', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const base = { runnerId: 'runner-local', workingDirectory: '/srv/project', providerVersion: '0.154.0', nativeFilters: {} }
    seedWorkspace(client, 'workspace-1', '/srv/project')
    client.setQueryData(queryKeys.mcpDetection('workspace-1', 'codex'), ScopedMcpDetectionSchema.parse({
      ...base, detection: { harness: 'codex', serverName: 'graphql-app', state: 'connected', endpointMatches: true,
        credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: '2026-09-16T00:00:00.000Z' },
    }))
    client.setQueryData(queryKeys.mcpDetection('workspace-1', 'opencode'), ScopedMcpDetectionSchema.parse({
      ...base, providerVersion: 'unknown', nativeFilters: { diagnostics: ['Inspector timed out'] },
      detection: { harness: 'opencode', serverName: 'graphql-app', state: 'check_failed', endpointMatches: null,
        credentialEnvironmentVariable: null, checkedAt: '2026-09-16T00:00:00.000Z', detail: 'CLI unavailable' },
    }))
    render(<QueryClientProvider client={client}><McpDetectionSettings workspaceId="workspace-1" /></QueryClientProvider>)
    expect(await screen.findByText('Connected')).toBeVisible()
    expect(screen.getByText('Check failed')).toBeVisible()
    expect(screen.getByText('CLI unavailable')).toBeVisible()
    expect(screen.getAllByText(/runner-local/)).toHaveLength(2)
    expect(screen.getAllByText('Connection details')).toHaveLength(2)
  })

  it.each([
    ['not_detected', 'Not configured'], ['misconfigured', 'Configuration mismatch'],
    ['status_unavailable', 'Configured · health unknown'], ['connected', 'Connected'],
    ['disabled', 'Disabled'], ['authentication_required', 'Sign-in required'],
    ['broken', 'Connection failed'], ['check_failed', 'Check failed'],
  ] as const)('renders the normalized %s state', async (state, label) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    seedWorkspace(client, 'workspace-state', '/srv/state')
    for (const harness of ['codex', 'opencode'] as const) client.setQueryData(
      queryKeys.mcpDetection('workspace-state', harness),
      ScopedMcpDetectionSchema.parse({
        runnerId: 'runner-state', workingDirectory: '/srv/state', providerVersion: 'qualified', nativeFilters: {},
        detection: { harness, serverName: 'graphql-app', state, endpointMatches: state === 'not_detected' || state === 'check_failed' ? null : true,
          credentialEnvironmentVariable: null, checkedAt: '2026-09-16T00:00:00.000Z' },
      }),
    )
    render(<QueryClientProvider client={client}><McpDetectionSettings workspaceId="workspace-state" /></QueryClientProvider>)
    expect((await screen.findAllByText(label))).toHaveLength(2)
  })
})
