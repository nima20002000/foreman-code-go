import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { JobQueueFacts } from './JobSpecFacts'
import { autoQueueTicket, definition } from './fixtures'

it('shows preferred placement, spillover policy and accepted computer separately', () => {
  const preferred = { kind: 'prefer' as const, hostRef: definition.spec.target.hostRef }
  const ticket = { ...autoQueueTicket, placement: preferred, placementOverride: preferred }
  const view = render(<JobQueueFacts ticket={ticket} />)
  expect(screen.getByText('Preferred computer')).toBeInTheDocument()
  expect(screen.getByText(/Then try eligible computers in build priority order/)).toBeInTheDocument()
  expect(screen.getByText(/Not assigned/)).toBeInTheDocument()
  view.rerender(<JobQueueFacts ticket={{ ...ticket, state: 'accepted', reservationId: ticket.id,
    selectedComputer: { target: { ...definition.spec.target, labelAtAcceptance: 'Build laptop' },
      rootId: '11111111-1111-4111-8111-111111111111', bindingRevision: 1, profileId: 'profile', profileRevision: 1 } }} />)
  expect(screen.getByText('Accepted computer')).toBeInTheDocument()
  expect(screen.getByText('Build laptop')).toBeInTheDocument()
  expect(screen.getByText('Preferred computer')).toBeInTheDocument()
})
