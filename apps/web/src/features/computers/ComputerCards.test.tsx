import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { ComputerCards } from './ComputerCards'
import { computersFixture, deviceName, mainTarget, registration } from './computersTestFixture'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'

afterEach(() => useOperatorChatStore.getState().reset())

it('summarizes each computer on one card in build order with harnesses, GitHub, builds and activity', async () => {
  const { activity } = computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />)
  activity.computers[0]!.agents = [
    { id: 'execution-1', workspaceId: 'workspace', workflowId: 'workflow-a', workflowName: 'A', runId: 'run-1', nodeId: 'node-1', agentName: 'Coder', state: 'running' },
    { id: 'execution-2', workspaceId: 'workspace', workflowId: 'workflow-a', workflowName: 'A', runId: 'run-1', nodeId: 'node-2', agentName: 'Reviewer', state: 'running' },
  ]
  const main = await screen.findByRole('article', { name: 'Main PC' })
  const device = screen.getByRole('article', { name: deviceName })
  expect(await within(main).findByText('1st of 2 · up to 60% CPU and RAM')).toBeVisible()
  const cards = screen.getAllByRole('article')
  expect(cards.indexOf(main)).toBeLessThan(cards.indexOf(device))
  expect(within(main).getByText('Online')).toBeVisible()
  expect(await within(main).findByText('octo-owner')).toBeVisible()
  expect(within(main).getByText('Codex')).toBeVisible()
  expect(within(main).getByText('Claude · signed out')).toBeVisible()
  expect(within(main).queryByText(/OpenCode/)).not.toBeInTheDocument()
  expect(within(device).getByText('2nd of 2 · up to 60% CPU and RAM')).toBeVisible()
  expect(within(main).getByText('2 agents running · 1 workflow')).toBeVisible()
  expect(within(main).queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(main).queryByRole('switch')).not.toBeInTheDocument()
})

it('asks the Operator to fix a signed-out harness and drafts a settings change without sending it', async () => {
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />)
  const main = await screen.findByRole('article', { name: 'Main PC' })
  await userEvent.click(await within(main).findByRole('button', { name: 'Sign in' }))
  expect(useOperatorChatStore.getState()).toMatchObject({ open: true, request: { content: 'Sign Claude in on Main PC.', send: true } })
  await userEvent.click(within(main).getByRole('button', { name: 'Ask Operator to change…' }))
  expect(useOperatorChatStore.getState().request).toMatchObject({ content: 'On Main PC: ', send: false })
})

it.each([['pending', 'Pairing pending'], ['revoked', 'Access revoked']] as const)('shows a %s computer as a short registration card', async (status, label) => {
  const device: DeviceRegistration = { ...registration, status }
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[device]} />)
  const card = await screen.findByRole('article', { name: /^Computer / })
  expect(within(card).getByText(label)).toBeVisible()
})
