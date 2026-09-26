import type { QueryClient } from '@tanstack/react-query'
import { beginSessionChange, clearProtectedStorage } from '../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { useGraphDraftStore } from '../graph/store'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'

export function clearBrowserIdentity(client: QueryClient): void {
  client.clear()
  useGraphDraftStore.getState().clearAllDrafts()
  useAgentDirectoryStore.getState().reset()
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
