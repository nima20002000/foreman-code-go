import { useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { enrollOperator } from '../../shared/api/client'
import { rotateProtectedSession } from '../../shared/api/protectedChatStorage'
import { Alert, Button, SettingsSection, TextField } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { beginSessionChange, clearProtectedStorage } from '../../shared/api/sessionBoundary'
import { useGraphDraftStore } from '../graph/store'
import { managedSaveQueue } from '../graph/managedSave'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'

export function OperatorAccessSettings() {
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>(() =>
    globalThis.location?.hash === '#operator-enrollment-failed' ? 'error' : 'idle')
  const inFlight = useRef(false)

  const enroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!token.trim() || inFlight.current) return
    const graphs = useGraphDraftStore.getState()
    const workflows = useSessionWorkflowStore.getState()
    const hasUnsavedWork = Object.values(graphs.drafts).some((draft) => draft.dirty)
      || Object.values(graphs.managedSaving).some(Boolean)
      || Object.keys(graphs.drafts).some((key) => managedSaveQueue.hasPending(key))
      || Object.values(useConversationDraftStore.getState().drafts).some((draft) => draft.trim().length > 0)
      || Object.keys(workflows.workflows).length > 0
      || Object.keys(workflows.workflowNameOverrides).length > 0
      || workflows.hiddenWorkflowIds.length > 0
      || Object.values(useAgentDirectoryStore.getState().catalogs).some((catalog) =>
        catalog.localAgents.length > 0 || catalog.deletedAgentIds.length > 0)
      || queryClient.isMutating() > 0
    // Always confirm: fields in a mounted editor may not yet be in a draft store.
    // Cancel happens BEFORE any identity rotation, request cancellation, or cleanup.
    const warning = hasUnsavedWork
      ? 'Unsaved work or a pending operation was found in this browser. '
      : 'This changes browser access. '
    if (!window.confirm(`${warning}Enrollment reloads the app and discards unsent edits, message drafts, and browser-only workflows, even if enrollment fails. Cancel to save or copy your work first. Continue and discard?`)) return
    inFlight.current = true
    setStatus('working')
    const credential = token.trim()
    beginSessionChange()
    const clear = () => {
      queryClient.clear()
      managedSaveQueue.reset()
      useGraphDraftStore.getState().clearAllDrafts()
      useAgentDirectoryStore.getState().reset()
      useWorkspaceSessionStore.getState().reset()
      useSessionWorkflowStore.getState().clearSessionWorkflows()
      useConversationDraftStore.getState().clearAllDrafts()
      useOperatorChatStore.getState().reset()
      try { clearProtectedStorage(localStorage) } catch { /* Inaccessible storage has no readable chat state. */ }
      try { clearProtectedStorage(sessionStorage) } catch { /* Restricted storage holds no accessible snapshots. */ }
    }
    let enrolled = false
    try {
      await queryClient.cancelQueries()
      clear()
      await enrollOperator(credential)
      enrolled = true
    } catch {
      setStatus('error')
    } finally {
      setToken('')
      clear()
      rotateProtectedSession() // Notify other tabs after the cookie may have changed, including lost responses.
      // Even a failed/lost enrollment response may have changed the cookie.
      // Replace the document on either outcome: closures, mutation observers,
      // session stores and old routes cannot survive an identity transition.
      window.addEventListener('pagehide', clear, { once: true })
      window.location.replace(enrolled ? '/settings' : '/settings#operator-enrollment-failed')
    }
  }

  return (
    <SettingsSection title="Operator access">
      <p className="settings-note" role="note">Changing access reloads the app and discards this browser's unsent edits and cached workspace data.</p>
      <form className="settings-enrollment-form" onSubmit={(event) => void enroll(event)}>
        <TextField className="settings-enrollment-field" label="Enrollment token" type="password" value={token} autoComplete="off" disabled={status === 'working'}
          onChange={(event) => { setToken(event.target.value); if (status === 'error') setStatus('idle') }}
          aria-label="Operator enrollment token" />
        <Button className="settings-enrollment-submit" type="submit" variant="primary" disabled={!token.trim() || status === 'working'}>
          {status === 'working' ? 'Enrolling…' : 'Enroll browser'}
        </Button>
      </form>
      {status === 'working' ? <Alert live tone="info" title="Changing access and clearing the previous session…" /> : null}
      {status === 'error' ? <Alert live tone="danger" title="Enrollment failed or its response was lost. Check the credential and expiry, then retry." /> : null}
    </SettingsSection>
  )
}
