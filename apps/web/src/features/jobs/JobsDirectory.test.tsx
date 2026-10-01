import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { it, expect, vi } from 'vitest'
import { server } from '../../mocks/server'
import { JobsDirectory } from './JobsDirectory'
import { definition, execution } from './fixtures'

it('retains a valid long job name and every command argument through keyboard navigation to its result', async () => {
  const name = 'n'.repeat(200)
  const argv = ['node', 'x'.repeat(8192), ...Array.from({ length: 30 }, (_, index) => `--argument-${index}=${'z'.repeat(80)}`)]
  const saved = { ...definition, name, spec: { ...definition.spec, argv } }
  const open = vi.fn()
  const root = '*/api/management/workspaces/:workspaceId/jobs'
  server.use(http.get(`${root}/definitions`, () => HttpResponse.json({ definitions: [saved] })),
    http.get(`${root}/executions`, () => HttpResponse.json({ executions: [execution] })))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <JobsDirectory workspaceId={definition.workspaceId} onSelectExecution={open} />
  </QueryClientProvider>)
  const savedJobs = screen.getByRole('region', { name: 'Saved jobs' })
  expect(await within(savedJobs).findByRole('heading', { name })).toHaveTextContent(name)
  const command = within(savedJobs).getByText(JSON.stringify(argv))
  expect(command.textContent).toBe(JSON.stringify(argv))
  const user = userEvent.setup()
  await user.tab()
  expect(screen.getByRole('button', { name: 'New job' })).toHaveFocus()
  await user.tab()
  expect(command).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Review and start' })).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Edit definition' })).toHaveFocus()
  await user.tab()
  const result = within(screen.getByRole('region', { name: 'Execution history' })).getByRole('button', { name: `Open result of ${name}, revision 1, build failed` })
  expect(result).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(open).toHaveBeenCalledWith(execution.id)
})
