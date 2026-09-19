import { Link } from '@tanstack/react-router'
import { ApiError } from '../../shared/api/client'

export function ProtectedAccessError({ error, returnTo = '/settings/workspaces' }: { error: ApiError; returnTo?: string }) {
  if (error.status === 401) return <section role="alert" className="auth-message">
    <h1>Sign in to continue</h1><p>Your browser session has expired or is missing.</p>
    <Link to="/sign-in" search={{ returnTo }}>Sign in</Link>
  </section>
  return <section role="alert" className="auth-message">
    <h1>Access denied</h1><p>You are signed in, but this account does not have permission for this page or action.</p>
    <p>Signing in again will not add permissions. Ask the server owner to review the Operator grants.</p>
    {returnTo !== '/account' ? <Link to="/account">View account access</Link> : null}
  </section>
}
