import { useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { enrollOperator } from '../../shared/api/client'
import { rotateProtectedSession } from '../../shared/api/protectedChatStorage'
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
    <section className="harness-defaults" aria-labelledby="operator-access-title">
      <div className="harness-defaults-heading"><div>
        <h2 id="operator-access-title">Operator access</h2>
        <p>Enroll this browser with a scoped local credential. It is kept in an HttpOnly cookie, not browser storage.</p>
        <p role="note">Changing access reloads the app and discards this browser's unsent edits and cached workspace data.</p>
      </div></div>
      <form className="settings-control" onSubmit={(event) => void enroll(event)}>
        <span>Enrollment token</span>
        <input type="password" value={token} autoComplete="off" disabled={status === 'working'}
          onChange={(event) => { setToken(event.target.value); if (status === 'error') setStatus('idle') }}
          aria-label="Operator enrollment token" />
        <button type="submit" disabled={!token.trim() || status === 'working'}>
          {status === 'working' ? 'Enrolling…' : 'Enroll browser'}
        </button>
      </form>
      {status === 'working' ? <p className="settings-save-status" role="status">Changing access and clearing the previous session…</p> : null}
      {status === 'error' ? <p className="settings-save-status settings-state-error" role="alert">Enrollment failed or its response was lost. Check the credential and expiry, then retry.</p> : null}
    </section>
  )
}
