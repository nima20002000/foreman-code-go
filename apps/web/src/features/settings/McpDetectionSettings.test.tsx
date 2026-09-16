import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopedMcpDetectionSchema } from '@graphql/contracts'

import { queryKeys } from '../../shared/api/query'
import { McpDetectionSettings } from './McpDetectionSettings'

afterEach(cleanup)

describe('MCP detection settings', () => {
  it('distinguishes connected evidence from an unknown failed check and scopes both to the runner', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const base = { runnerId: 'runner-local', workingDirectory: '/srv/project', providerVersion: '0.154.0', nativeFilters: {} }
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
    expect(await screen.findByText('Detected · connected')).toBeVisible()
    expect(screen.getByText('Check failed')).toBeVisible()
    expect(screen.getByText(/unknown, not evidence that MCP is absent/i)).toBeVisible()
    expect(screen.getAllByText(/runner-local/)).toHaveLength(2)
    expect(screen.getByText(/will not rewrite it automatically/i)).toBeVisible()
  })
})
