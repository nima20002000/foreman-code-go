import { render, screen } from '@testing-library/react'

import { App } from './App'

describe('web foundation', () => {
  it('renders the wireframe shell without a backend', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'graphql' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Phase 1 · Mock data')
    expect(screen.getByText('Frontend product wireframe')).toBeVisible()
    expect(screen.getByText(/not GraphQL protocol tooling/i)).toBeVisible()
  })
})
