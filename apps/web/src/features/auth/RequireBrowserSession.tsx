import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { safeAuthReturnTo } from '@graphql/contracts/management'
import { ApiError } from '../../shared/api/client'
import { authenticationRequiredEvent } from '../../shared/api/authEvents'
import { useBrowserAccessQuery } from '../../shared/api/settingsExperience'
import { Button } from '../../shared/ui/nocturne'
import { SignOutButton } from './SignOutButton'
import { RuntimeInstanceBoundary } from './RuntimeInstanceBoundary'
import { ChatAttachmentBoundary } from '../conversations/ChatAttachmentBoundary'
import './auth.css'

export function RequireBrowserSession({ children }: { children: ReactNode }) {
  const session = useBrowserAccessQuery()
  const location = useLocation()
  const navigate = useNavigate()
  const [expired, setExpired] = useState(false)
  const redirecting = useRef(false)
  useEffect(() => {
    const requireSignIn = () => setExpired(true)
    window.addEventListener(authenticationRequiredEvent, requireSignIn)
    return () => window.removeEventListener(authenticationRequiredEvent, requireSignIn)
  }, [])
  const needsSignIn = expired || (ApiError.is(session.error) && session.error.status === 401)
  useEffect(() => {
    if (!needsSignIn || redirecting.current) return
    redirecting.current = true
    void navigate({ to: '/sign-in', search: { returnTo: safeAuthReturnTo(location.href) }, replace: true })
  }, [location.href, navigate, needsSignIn])
  if (needsSignIn) return null
  if (session.isError) {
    const denied = ApiError.is(session.error) && session.error.status === 403
    return <main className="auth-screen"><section className="auth-card" role="alert">
      <h1>{denied ? 'Access denied' : 'Cannot reach the server'}</h1>
      <p>{denied ? 'You are signed in, but this account no longer has active Operator access.'
        : 'Your sign-in could not be checked. This is a server or connection problem, not a rejected password.'}</p>
      <div className="n-actions">
        {!denied ? <Button variant="primary" onClick={() => void session.refetch()}>Try again</Button> : null}
        <SignOutButton />
      </div>
    </section></main>
  }
  if (session.isPending || !session.data) return <main className="auth-screen" role="status">Checking your session…</main>
  return <RuntimeInstanceBoundary><ChatAttachmentBoundary>{children}</ChatAttachmentBoundary></RuntimeInstanceBoundary>
}
