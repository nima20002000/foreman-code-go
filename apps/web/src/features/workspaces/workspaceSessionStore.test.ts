import { afterEach, describe, expect, it } from 'vitest'

import { useWorkspaceSessionStore } from './workspaceSessionStore'

afterEach(() => {
  useWorkspaceSessionStore.getState().reset()
})

describe('workspace session registry', () => {
  it('updates a known workspace name without changing the menu order', () => {
    const store = useWorkspaceSessionStore.getState()
    store.registerWorkspace({ id: 'workspace-1', name: 'Website' })
    store.registerWorkspace({ id: 'workspace-2', name: 'Docs' })
    store.registerWorkspace({ id: 'workspace-1', name: 'Website renamed' })

    expect(useWorkspaceSessionStore.getState().knownWorkspaces).toEqual([
      { id: 'workspace-1', name: 'Website renamed' },
      { id: 'workspace-2', name: 'Docs' },
    ])
  })
})
