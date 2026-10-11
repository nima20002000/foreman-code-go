import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { onlineManager } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { SidebarComputers } from './ComputerActivity'
import { computersFixture, deviceName } from './computersTestFixture'

it('lists every computer with live meters and opens the active one with Jobs, agents and utilization', async () => {
  const f = computersFixture(<SidebarComputers />)
  const list = await screen.findByRole('list', { name: 'Computers' })
  expect(within(list).getByRole('button', { name: 'Activity on Main PC' })).toBeVisible()
  expect(within(list).getByRole('button', { name: `Activity on ${deviceName}` })).toBeVisible()
  expect(within(list).getAllByRole('meter', { name: 'Disk' })).toHaveLength(2)
  expect(within(list).queryByTestId('computer-busy')).not.toBeInTheDocument()
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: new Date(Date.now() - 65_000).toISOString() })
  f.activity.computers[0]!.agents.push({ id: 'execution-1', workspaceId: 'workspace-1', workflowId: 'workflow-1',
    workflowName: 'Release', runId: 'run-1', nodeId: 'review', agentName: 'Reviewer', state: 'waiting' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await within(list).findByTestId('computer-busy')).toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Activity on Main PC' }))
  const modal = screen.getByRole('dialog', { name: 'Main PC' })
  expect(within(modal).getByText('Building')).toBeVisible()
  expect(within(modal).getByText('Web build')).toBeVisible()
  expect(within(modal).getByText('Store')).toBeVisible()
  expect(within(modal).getByText('running')).toBeVisible()
  expect(within(modal).getByText(/1 min/)).toBeVisible()
  expect(within(modal).getByText('Reviewer')).toBeVisible()
  expect(within(modal).getByText('Release · review')).toBeVisible()
  expect(within(modal).getByText('waiting')).toBeVisible()
  expect(within(modal).getByRole('meter', { name: 'CPU' })).toBeInTheDocument()
  await user.click(within(modal).getByText('Web build'))
  expect(modal).toBeVisible()
  fireEvent.pointerDown(within(modal).getByText('Web build'))
  fireEvent.click(modal)
  expect(modal).toBeVisible()
  fireEvent.pointerDown(modal)
  fireEvent.click(modal)
  await waitFor(() => expect(modal).not.toBeVisible())
})
it('shows workflow-only activity and keeps an open modal readable when the computer becomes idle', async () => {
  const f = computersFixture(<SidebarComputers />)
  f.activity.computers[1]!.online = true
  f.activity.computers[1]!.agents.push({ id: 'execution-1', workspaceId: 'workspace-1', workflowId: 'workflow-1',
    workflowName: 'Release', runId: 'run-1', nodeId: 'build', agentName: 'Builder', state: 'starting' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: `Activity on ${deviceName}` }))
  const modal = screen.getByRole('dialog', { name: deviceName })
  expect(within(modal).getByText('Running agents')).toBeVisible()
  f.activity.computers[1]!.agents = []
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  await waitFor(() => expect(within(modal).getByText('Idle')).toBeVisible())
  expect(screen.queryByTestId('computer-busy')).not.toBeInTheDocument()
  expect(within(modal).getByText('No running Jobs')).toBeVisible()
  expect(within(modal).getByText('No running agents')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(modal).not.toBeVisible())
})
it('reports an activity read error and retries without showing stale computers', async () => {
  const f = computersFixture(<SidebarComputers />)
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'preparing', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Activity on Main PC' }))
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({
    error: { code: 'UNAVAILABLE', message: 'Unavailable' },
  }, { status: 503 })))
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByText('Activity could not be read.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Activity on Main PC' })).not.toBeInTheDocument()
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json(f.activity)))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry activity' }))
  expect(await screen.findByText('Build')).toBeVisible()
})
afterEach(() => onlineManager.setOnline(true))
it('stops presenting sidebar presence and activity as current while the browser is offline', async () => {
  const f = computersFixture(<SidebarComputers />)
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const main = await screen.findByRole('button', { name: 'Activity on Main PC' })
  await within(main).findByTestId('computer-busy')
  expect(main).toHaveAttribute('title', 'Main PC: Building')
  act(() => onlineManager.setOnline(false))
  expect(main).toHaveAttribute('title', 'Main PC: Status stale')
  expect(within(main).queryByTestId('computer-busy')).not.toBeInTheDocument()
})
