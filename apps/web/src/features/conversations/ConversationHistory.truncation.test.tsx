import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ConversationHistory } from './ConversationHistory'

it('identifies a shortened answer when reading saved conversation history', () => {
  render(<ConversationHistory messages={[{ id: 'answer', conversationId: 'chat', role: 'assistant',
    content: 'Saved prefix', truncation: { truncated: true, originalBytes: 30_000 } }]} />)
  expect(screen.getByText('Saved prefix')).toBeVisible()
  expect(screen.getByRole('note', { name: 'Shortened message' })).toHaveTextContent('remaining text is not shown')
})
