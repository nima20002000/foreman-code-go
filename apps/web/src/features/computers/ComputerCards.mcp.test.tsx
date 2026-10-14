import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { ComputerCards } from './ComputerCards'
import { computersFixture, deviceName, deviceTarget, mainId, registration } from './computersTestFixture'

it('shows host-scoped MCP state read-only for each harness on a paired computer', async () => {
  const hosts: unknown[] = []
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.get('*/api/management/harnesses/:harness/mcp', ({ params, request }) => {
      const hostRef = JSON.parse(new URL(request.url).searchParams.get('hostRef')!)
      hosts.push(hostRef)
      return HttpResponse.json({ harness: params.harness, hostRef, revision: `sha256:${'a'.repeat(64)}`,
        servers: [], presets: { graphql: params.harness === 'codex' ? 'installed' : 'missing', linear: 'missing' },
        checkedAt: new Date().toISOString(), scope: 'native-user' })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('Codex · Installed')).toBeVisible()
  expect(await within(device).findByText('Claude · Setup needed')).toBeVisible()
  expect(hosts).toEqual([deviceTarget.hostRef, deviceTarget.hostRef])
  expect(within(device).queryByRole('button', { name: /install.*mcp|repair.*mcp/i })).not.toBeInTheDocument()
  expect(within(device).getByRole('button', { name: 'Ask Operator to change…' })).toBeVisible()
})
