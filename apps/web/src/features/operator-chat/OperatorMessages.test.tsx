import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Message, OperatorActivity } from '@graphql/contracts'
import { OperatorMessages } from './OperatorMessages'

const user: Message = { id: 'user', conversationId: 'chat', requestId: 'turn', role: 'user', content: 'Read the file' }
const thinking: OperatorActivity = { id: 'native-thought', requestId: 'turn', sequence: '1', revision: 1, kind: 'thinking', title: 'Thinking', status: 'running', output: 'Checking the requested file.' }
const tool: OperatorActivity = { ...thinking, id: 'native-read', sequence: '2', kind: 'file_read', title: 'Read file', input: 'note.txt', output: 'file content' }

describe('Operator message ownership', () => {
  it('puts thinking and tools inside the assistant container through streaming and final persistence', () => {
    const props = { messages: [user], activities: [thinking, tool], activeRequestId: 'turn', working: true, partialText: 'The file', onBrowse() {} }
    const view = render(<OperatorMessages {...props} />)
    const mine = screen.getByRole('article', { name: 'Message from You' })
    const assistant = screen.getByRole('article', { name: 'Message from Assistant' })
    expect(within(mine).queryByText('Thinking')).not.toBeInTheDocument()
    fireEvent.click(within(assistant).getByRole('button', { name: 'Thinking' }))
    expect(within(assistant).getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Checking the requested file.')
    expect(within(assistant).getByText('Read · Read file')).toBeInTheDocument()
    expect(within(assistant).getByText('Read · Read file').closest('.operator-answer')).toBeNull()
    expect(within(assistant).getByText('Read · Read file').closest('header')).toBeNull()
    expect(within(assistant).getByText('Read · Read file').closest('summary')?.querySelectorAll('svg')).toHaveLength(1)
    expect(within(assistant).getByText('The file').closest('.operator-answer')).not.toBeNull()
    expect(mine.closest('li')).toHaveAttribute('data-message-role', 'user')
    expect(assistant.closest('li')).toHaveAttribute('data-message-role', 'assistant')
    view.rerender(<OperatorMessages {...props} working={false} partialText="" messages={[user, { id: 'answer', conversationId: 'chat', requestId: 'turn', role: 'assistant', content: 'The file is read.' }]} />)
    expect(screen.getAllByRole('article', { name: 'Message from Assistant' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(assistant).getByText('The file is read.')).toBeInTheDocument()
  })

  it('does not attach another request’s thinking to the current assistant', () => {
    render(<OperatorMessages messages={[user]} activities={[{ ...thinking, requestId: 'older' }]} activeRequestId="turn" working onBrowse={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Operator is typing' })).toBeInTheDocument()
  })
})
