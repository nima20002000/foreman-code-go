import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ClaudeMcpConfiguration } from './ClaudeMcpConfiguration'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
function setup() {
  server.use(http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({
    graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3999/mcp' },
  })))
  function Editor() {
    const [value, setValue] = useState({ ...savedClaudeConfiguration, mcpServers: {} })
    return <><ClaudeMcpConfiguration value={value} onChange={setValue} /><output data-testid="draft">{JSON.stringify(value)}</output></>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><Editor /></QueryClientProvider>)
  return userEvent.setup()
}
it('adds the server-supplied app endpoint to the draft without changing permissions or claiming connected health', async () => {
  const user = setup()
  const add = await screen.findByRole('button', { name: 'Add GraphQL MCP' })
  await waitFor(() => expect(add).toBeEnabled())
  await user.click(add)
  expect(await screen.findByRole('button', { name: 'GraphQL added' })).toBeDisabled()
  expect(JSON.parse(screen.getByTestId('draft').textContent!)).toEqual({ ...savedClaudeConfiguration,
    mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:3999/mcp' } } })
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Remove graphql' }))
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers).toEqual({})
})
it('rejects secret-bearing endpoints and duplicate names before adding a custom HTTP server', async () => {
  const user = setup()
  await user.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'docs')
  const endpoint = screen.getByRole('textbox', { name: 'MCP endpoint' })
  await user.type(endpoint, 'https://user:secret@example.com/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(screen.getByRole('alert')).toHaveTextContent('without credentials')
  await user.clear(endpoint); await user.type(endpoint, 'https://example.com/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers).toEqual({ docs: { type: 'http', url: 'https://example.com/mcp' } })
  await user.type(screen.getByRole('textbox', { name: 'MCP server name' }), 'docs')
  await user.type(endpoint, 'https://other.example.com/mcp')
  await user.click(screen.getByRole('button', { name: 'Add HTTP MCP server' }))
  expect(screen.getByRole('alert')).toHaveTextContent('already configured')
  expect(JSON.parse(screen.getByTestId('draft').textContent!).mcpServers.docs.url).toBe('https://example.com/mcp')
})
