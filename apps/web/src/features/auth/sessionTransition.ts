import type { QueryClient } from '@tanstack/react-query'
import { beginSessionChange, clearProtectedStorage } from '../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { useGraphDraftStore } from '../graph/store'
import { managedSaveQueue } from '../graph/managedSave'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'

export function clearBrowserIdentity(client: QueryClient): void {
  client.clear()
  managedSaveQueue.reset()
  useGraphDraftStore.getState().clearAllDrafts()
  useAgentDirectoryStore.getState().reset()
  useWorkspaceSessionStore.getState().reset()
  useSessionWorkflowStore.getState().clearSessionWorkflows()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.getState().reset()
  clearRevisionedFormPersistence()
  try { clearProtectedStorage(localStorage) } catch { /* Storage may be disabled. */ }
  try { clearProtectedStorage(sessionStorage) } catch { /* Storage may be disabled. */ }
}

export async function prepareBrowserIdentityChange(client: QueryClient): Promise<void> {
  beginSessionChange()
  await client.cancelQueries()
  clearBrowserIdentity(client)
}
