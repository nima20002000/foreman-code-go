import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { OperatorChat } from './OperatorChat'
import { OperatorChatVisibilityProvider } from './visibility'

function renderChat(enabled = true) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <OperatorChatVisibilityProvider enabled={enabled}><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
}

describe('OperatorChat', () => {
  it('mounts the global launcher without starting a conversation', () => {
    renderChat()
    expect(screen.getByRole('button', { name: 'Open Operator chat' })).toBeInTheDocument()
  })
  it('hides only the UI when visibility is disabled', () => {
    renderChat(false)
    expect(screen.queryByRole('button', { name: 'Open Operator chat' })).not.toBeInTheDocument()
  })
})
