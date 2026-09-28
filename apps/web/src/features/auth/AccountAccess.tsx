import { useBrowserAccessQuery } from '../../shared/api/settingsExperience'
import { ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { SignOutButton } from './SignOutButton'
import { ProtectedAccessError } from './ProtectedAccessError'
import { isAuthAccessError } from './accessError'
import { ChatRetentionSettings } from '../retention-settings'
import './auth.css'

export function AccountAccess() {
  const session = useBrowserAccessQuery()
  if (isAuthAccessError(session.error)) return <ProtectedAccessError error={session.error} returnTo="/account" />
  if (session.isError) return <ErrorState title="Account unavailable" description="The server could not check your session."
    onRetry={() => void session.refetch()} />
  if (!session.data) return <LoadingState label="Loading account…" />
  const { account, principal } = session.data
  const actionCount = new Set(principal.grants.flatMap((grant) => grant.actions)).size
  const restricted = principal.grants.some((grant) => Object.values(grant.scope).some((ids) => ids?.length))
  return <section className="settings-editor-page account-page" aria-label="Account profile">
    <header className="settings-experience-heading"><span className="n-eyebrow">Account</span>
      <h1>Profile</h1><p>Your identity and access on this GraphQL installation.</p></header>
    <div className="settings-editor-content account-content">
      <section aria-labelledby="account-identity-heading">
        <h2 id="account-identity-heading">Your profile</h2>
        <dl className="account-facts">
          {account?.name && account.name !== account.email ? <div><dt>Name</dt><dd>{account.name}</dd></div> : null}
          <div><dt>Email</dt><dd>{account?.email ?? 'Not available for this session'}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="account-session-heading">
        <h2 id="account-session-heading">Session</h2>
        <dl className="account-facts">
          <div><dt>Browser access</dt><dd>{session.data.localDev ? 'Local development access' : 'Signed in'}</dd></div>
          <div><dt>Expires</dt><dd><time dateTime={principal.expiresAt}>{new Date(principal.expiresAt).toLocaleString()}</time></dd></div>
        </dl>
      </section>
      <section aria-labelledby="account-permissions-heading">
        <h2 id="account-permissions-heading">Permissions</h2>
        <p>{restricted ? 'Restricted access' : 'App-wide access'} · {actionCount} allowed actions</p>
        <details className="account-permissions"><summary>View permission details</summary>
          {principal.grants.map((grant, index) => <div key={index} className="auth-grant">
            <strong>{Object.values(grant.scope).some((ids) => ids?.length) ? 'Restricted scope' : 'App-wide scope'}</strong>
            <p>{grant.actions.join(', ')}</p>
            {Object.entries(grant.scope).map(([key, ids]) => <p key={key}>{key}: {ids?.join(', ')}</p>)}
          </div>)}
        </details>
      </section>
      <ChatRetentionSettings />
    </div>
    <footer className="account-actions">{session.data.localDev
      ? <p>Local development access stays active while the dev server runs.</p>
      : <><p>Signing out ends this browser session. CLI and MCP credentials stay active.</p><SignOutButton /></>}</footer>
  </section>
}
