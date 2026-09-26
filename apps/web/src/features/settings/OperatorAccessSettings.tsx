import { useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BrowserAccessLogoutSchema } from '@graphql/contracts/management'
import { apiClient, ApiError, enrollOperator } from '../../shared/api/client'
import { useBrowserAccessQuery } from '../../shared/api/settingsExperience'
import { rotateProtectedSession } from '../../shared/api/protectedChatStorage'
import { Alert, Button, ConfirmDialog, Select, StatusBadge, TextField } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { beginSessionChange, clearProtectedStorage } from '../../shared/api/sessionBoundary'
import { useGraphDraftStore } from '../graph/store'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { browserCredentialCommand, revokeCredentialCommand } from './accessSetup'
import './settingsExperience.css'

type Transition = 'connect' | 'disconnect'
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [message, setMessage] = useState('')
  return <div className="access-command"><pre tabIndex={0} aria-label={label}>{command}</pre>
    <Button size="sm" onClick={() => void (async () => {
      try { await navigator.clipboard.writeText(command); setMessage('Command copied.') }
      catch { setMessage('Select and copy the command above.') }
    })()}>Copy command</Button><span role="status">{message}</span></div>
}
function TokenSetup() {
  const [name, setName] = useState('My browser')
  const [days, setDays] = useState(30)
  const [access, setAccess] = useState<'manage' | 'read-only'>('read-only')
  const [scope, setScope] = useState<'app' | 'workspace'>('app')
  const [workspace, setWorkspace] = useState('')
  let command = ''
  try { command = browserCredentialCommand({ name, days, access, ...(scope === 'workspace' ? { workspaceId: workspace } : {}) }) } catch { /* Incomplete setup fields are not executable commands. */ }
  return <section className="access-setup" aria-label="Create an app access token">
    <header className="settings-section-heading"><h2>Create a token on the server</h2><p>Run this command from the repository folder on the computer running the API.</p></header>
    <div className="harness-two-columns">
      <TextField label="Browser name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      <Select label="Expires after" value={days} options={[1, 7, 30, 90].map((value) => ({ value: String(value), label: `${value} day${value === 1 ? '' : 's'}` }))}
        onChange={(event) => setDays(Number(event.target.value))} />
      <Select label="Access level" value={access} options={[{ value: 'read-only', label: 'Read only' }, { value: 'manage', label: 'Manage app' }]}
        onChange={(event) => setAccess(event.target.value as typeof access)} />
      <Select label="Scope" value={scope} options={[{ value: 'app', label: 'Whole app' }, { value: 'workspace', label: 'One workspace' }]}
        onChange={(event) => setScope(event.target.value as typeof scope)} />
    </div>
    {scope === 'workspace' ? <TextField label="Workspace ID" value={workspace} maxLength={200} onChange={(event) => setWorkspace(event.target.value)}
      hint="A workspace-scoped token cannot change app-wide settings." /> : null}
    <p className="harness-muted">{access === 'manage' ? 'Manage app allows changes and running agents within the selected scope.' : 'Read only lets you view data. It cannot save settings, start agents, or approve requests.'}</p>
    {command ? <CopyCommand command={command} label="Token creation command" /> : <p className="n-field-error" role="status">Enter a browser name and, when selected, a workspace ID without line breaks.</p>}
    <p className="harness-muted">Copy the token printed by the command into Connect below. Keep it private; it grants the access selected here.</p>
  </section>
}

export function OperatorAccessSettings() {
  const queryClient = useQueryClient()
  const session = useBrowserAccessQuery()
  const [token, setToken] = useState('')
  const [setup, setSetup] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [transition, setTransition] = useState<Transition>()
  const [working, setWorking] = useState(false)
  const inFlight = useRef(false)
  const resultHash = globalThis.location?.hash ?? ''
  const unauthorized = session.isError && ApiError.is(session.error) && session.error.status === 401
  const principal = !session.isError ? session.data?.principal : undefined
  const connected = Boolean(principal && Date.parse(principal.expiresAt) > Date.now())

  const clear = () => {
    queryClient.clear()
      useGraphDraftStore.getState().clearAllDrafts()
    useAgentDirectoryStore.getState().reset()
    useConversationDraftStore.getState().clearAllDrafts()
    useOperatorChatStore.getState().reset()
    clearRevisionedFormPersistence()
    try { clearProtectedStorage(localStorage) } catch { /* Restricted storage has no readable snapshots. */ }
    try { clearProtectedStorage(sessionStorage) } catch { /* Same isolation for session storage. */ }
  }
  const changeAccess = async (kind: Transition) => {
    if (inFlight.current || (kind === 'connect' && !token.trim())) return
    inFlight.current = true
    setWorking(true)
    const credential = token.trim()
    beginSessionChange()
    let confirmed = false
    try {
      await queryClient.cancelQueries()
      clear()
      if (kind === 'connect') await enrollOperator(credential)
      else await apiClient.request('/api/auth/logout', BrowserAccessLogoutSchema, { method: 'POST' })
      confirmed = true
    } catch { /* A lost reply can still have changed the cookie. Always replace the document. */ }
    finally {
      setToken('')
      clear()
      rotateProtectedSession()
      window.addEventListener('pagehide', clear, { once: true })
      window.location.replace(`/settings/operator-access${confirmed ? kind === 'disconnect' ? '#signed-out' : '' : '#access-change-unconfirmed'}`)
    }
  }
  const connect = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (token.trim() && !working) setTransition('connect') }
  let revokeCommand = ''
  if (principal) { try { revokeCommand = revokeCredentialCommand(principal.id) } catch { /* Never turn an unrecognized ID into a shell command. */ } }
  return <section className="settings-editor-page access-page" aria-label="App access">
    <header className="settings-experience-heading"><h1>App access</h1>
      <p>Connect this browser to GraphQL. This token controls app permissions, not your Codex or OpenCode sign-in.</p></header>
    {resultHash === '#operator-enrollment-failed' || resultHash === '#access-change-unconfirmed' ? <Alert live tone="warning" title="The access change was not confirmed. Check the current session below before trying again." /> : null}
    {session.isPending ? <p role="status">Checking browser access…</p> : null}
    {session.isError && !unauthorized ? <Alert tone="danger" title="Could not check browser access."
      action={<Button size="sm" onClick={() => void session.refetch()}>Retry</Button>}>{session.error.message}</Alert> : null}
    {principal && connected ? <section className="access-session" aria-label="Current browser session">
      <div className="harness-section-heading"><div><strong>{principal.name}</strong><p>Expires {new Date(principal.expiresAt).toLocaleString()}</p></div><StatusBadge label="Connected" tone="success" /></div>
      <details><summary>Permissions & scope</summary>{principal.grants.map((grant, index) => <div className="access-grant" key={index}>
        <strong>{Object.values(grant.scope).some(Boolean) ? 'Restricted scope' : 'App-wide permissions'}</strong>
        <p>{grant.actions.join(', ')}</p>{Object.entries(grant.scope).map(([key, ids]) => <p key={key}>{key}: {ids?.join(', ')}</p>)}
      </div>)}</details>
      <div className="harness-inline-actions"><Button disabled={working} onClick={() => setReplacing(!replacing)}>{replacing ? 'Keep current connection' : 'Use another token'}</Button>
        <Button variant="ghost" disabled={working} onClick={() => setTransition('disconnect')}>Disconnect browser</Button></div>
      {revokeCommand ? <details><summary>Revoke this token everywhere</summary><p className="harness-muted">Disconnecting clears this browser only. Run this on the server to revoke the token for every client that uses it.</p><CopyCommand command={revokeCommand} label="Token revocation command" /></details> : null}
    </section> : unauthorized ? <div className="access-session"><StatusBadge label="Not connected" tone="neutral" /><p>Use an existing app token or create one on the server.</p></div> : null}
    {!connected || replacing ? <>
      <div className="harness-inline-actions"><Button aria-expanded={setup} disabled={working} onClick={() => setSetup(!setup)}>{setup ? 'Hide token setup' : 'Create an access token'}</Button></div>
      {setup ? <TokenSetup /> : null}
      <section className="access-connect" aria-label="Connect browser"><header className="settings-section-heading"><h2>Connect</h2><p>Paste an existing token or the one you just created.</p></header>
        <form className="settings-enrollment-form" onSubmit={connect}>
          <TextField label="App access token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={working}
            onChange={(event) => setToken(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!token.trim() || working}>{working ? 'Connecting…' : 'Connect browser'}</Button>
        </form>
      </section>
    </> : null}
    <ConfirmDialog open={Boolean(transition)} onOpenChange={(open) => { if (!open && !working) setTransition(undefined) }}
      title={transition === 'disconnect' ? 'Disconnect this browser?' : 'Connect with this token?'}
      description="The app reloads. Unsaved edits and unsent messages in this browser will be discarded. Save or copy them before continuing."
      pending={working} confirmLabel={transition === 'disconnect' ? 'Disconnect & reload' : 'Connect & reload'}
      onConfirm={() => { if (transition) void changeAccess(transition) }} />
  </section>
}
