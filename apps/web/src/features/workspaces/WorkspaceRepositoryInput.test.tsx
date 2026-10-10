import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { WorkspaceRepositoryForm } from './WorkspaceRepositoryForm'
import { worktreeFixture } from '../workflow-board/worktree.fixtures'
import { mainRoot } from '../settings/workspaceBoundLocation.fixtures'

afterEach(clearRevisionedFormPersistence)

function mount() {
  const writes: unknown[] = []
  const fixture = worktreeFixture()
  server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
    workspaceId: 'workspace-1', policies: [], allowlists: [mainRoot], readiness: 'metadata-only',
  })), http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
    const input = await request.json() as { repository: unknown; commandId: string }
    writes.push(input)
    return HttpResponse.json({ value: { ...fixture.ready, operation: { ...fixture.ready.operation,
      commandId: input.commandId } }, replayed: false })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>
    <WorkspaceRepositoryForm workspaceId="workspace-1" revision={1} repository={undefined} />
  </QueryClientProvider>)
  return writes
}

describe('repository input', () => {
  it.each([
    'octo-owner/website/extra',
    'https://github.com/octo-owner/website/tree/main',
    'https://github.com/octo-owner/website/tree/feature/add-login',
    'https://github.com/octo-owner/website/blob/main/README.md',
    'https://github.com/octo-owner/website/issues/42',
    'octo-owner/website//',
  ])('rejects the complete input %s without sending a truncated repository', async (value) => {
    const writes = mount()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Repository' }), value)
    const save = screen.getByRole('button', { name: 'Add project' })
    expect(save).toBeDisabled()
    expect(screen.getByText('Use owner/name or a GitHub repository URL without extra path segments.')).toBeVisible()
    await user.click(save)
    expect(writes).toEqual([])
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue(value)
  })

  it.each([
    'octo-owner/website',
    'octo-owner/website.git',
    'https://github.com/octo-owner/website',
    'https://github.com/octo-owner/website.git',
    'https://github.com/octo-owner/website/',
    'https://github.com/octo-owner/website.git/',
    '  octo-owner/website  ',
  ])('saves the complete repository reference %s', async (value) => {
    const writes = mount()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Repository' }), value)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ repository: {
      provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main',
    } })
  })
})
