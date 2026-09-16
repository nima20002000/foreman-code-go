import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { WorkspaceExecutionLocationSetup } from './WorkspaceExecutionLocationSetup'

vi.mock('../../shared/api/query', () => ({
  useManagedWorkspaceQuery: () => ({
    data: {
      workspace: { id: 'workspace-1' },
      locationValidation: { status: 'ready' },
    },
    isPending: false,
  }),
}))

describe('WorkspaceExecutionLocationSetup', () => {
  it('keeps the workflow graph in a full-height flex layout', () => {
    render(
      <WorkspaceExecutionLocationSetup workspaceId="workspace-1" enabled>
        <section>Workflow graph</section>
      </WorkspaceExecutionLocationSetup>,
    )

    const content = screen.getByText('Workflow graph').parentElement
    expect(content).toHaveClass('workspace-execution-content')
    expect(getComputedStyle(content!).display).toBe('flex')
    expect(getComputedStyle(content!).flexDirection).toBe('column')
  })
})
