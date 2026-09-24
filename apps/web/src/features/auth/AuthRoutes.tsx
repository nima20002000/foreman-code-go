import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useSearch } from '@tanstack/react-router'
import { useContext, useEffect, useRef, useState, type FormEvent } from 'react'
import { safeAuthReturnTo, type BrowserSignInRequest, type OwnerSetupRequest } from '@graphql/contracts/management'
import { ApiError } from '../../shared/api/client'
import { browserAuthClient, useOwnerSetupStatus } from '../../shared/api/browserAuth'
import { finishSessionChange } from '../../shared/api/sessionBoundary'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import { clearBrowserIdentity, prepareBrowserIdentityChange } from './sessionTransition'
import { SignOutButton } from './SignOutButton'
import './auth.css'

function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null
  const message = ApiError.is(error) && (error.status >= 500 || error.status === 0)
    ? 'The server could not complete this request. Check the API connection and try again.'
    : error instanceof Error ? error.message : 'The request could not be completed.'
  return <Alert live tone="danger" title={message} />
}

export function SignInRoute() {
  const search = useSearch({ from: '/sign-in' })
  const toasts = useContext(ToastContext)
  const shownNotice = useRef<string | undefined>(undefined)
  const status = useOwnerSetupStatus()
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: BrowserSignInRequest) => {
      await prepareBrowserIdentityChange(client)
      try {
        await browserAuthClient.signIn(input)
        clearBrowserIdentity(client)
        window.location.replace(safeAuthReturnTo(search.returnTo))
      } catch (error) {
        finishSessionChange()
        throw error
      } finally { setPassword('') }
    },
  })
  useEffect(() => {
    if (!search.notice || shownNotice.current === search.notice) return
    shownNotice.current = search.notice
    if (search.notice === 'owner-created') toasts?.notify({ tone: 'success', title: 'Owner account created', description: 'Sign in to continue.' })
    if (search.notice === 'signed-out') toasts?.notify({ tone: 'success', title: 'Signed out', description: 'This browser session has ended.' })
    if (search.notice === 'sign-out-unconfirmed') toasts?.notify({ tone: 'danger', title: 'Sign-out was not confirmed',
      description: 'The server session may still be active. Retry sign-out.' })
  }, [search.notice, toasts])
  useEffect(() => {
    if (mutation.error) toasts?.notify({ tone: 'danger', title: 'Sign-in failed',
      description: mutation.error instanceof Error ? mutation.error.message : 'Check the message beside the form.' })
  }, [mutation.error, toasts])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!mutation.isPending) mutation.mutate({ email, password })
  }
  return <main className="auth-screen"><section className="auth-card" aria-labelledby="sign-in-title">
    <p className="auth-brand">graphql · Owner access</p>
    <h1 id="sign-in-title">Welcome back</h1><p>Sign in to manage your workspaces and agents.</p>
    {search.notice === 'owner-created' ? <p role="status">Your owner account is ready. Sign in below.</p> : null}
    {search.notice === 'signed-out' ? <p role="status">You are signed out.</p> : null}
    {search.notice === 'sign-out-unconfirmed' ? <Alert live tone="danger" title="Sign-out was not confirmed" action={<SignOutButton />}>
      The server session may still be active. Retry before leaving a shared browser.
    </Alert> : null}
    <form onSubmit={submit} aria-label="Owner sign in">
      <TextField id="sign-in-email" label="Email" name="email" type="email" autoComplete="username" required maxLength={254}
        value={email} onChange={(event) => setEmail(event.target.value)} disabled={mutation.isPending} />
      <TextField id="sign-in-password" label="Password" name="password" type="password" autoComplete="current-password" required maxLength={128}
        value={password} onChange={(event) => setPassword(event.target.value)} disabled={mutation.isPending} />
      <ErrorMessage error={mutation.error} />
      <Button type="submit" variant="primary" size="lg" loading={mutation.isPending} loadingLabel="Signing in…">Sign in</Button>
    </form>
    {status.data?.state === 'ready' ? <Link to="/setup" search={{ returnTo: search.returnTo }}>Set up the owner account</Link> : null}
    {status.data?.state === 'locked' ? <p className="auth-note">Owner setup is locked. Existing installations must select the owner Operator principal on the server.</p> : null}
    {status.isError ? <Alert live tone="danger" title="Browser authentication could not be checked"
      action={<Button size="sm" onClick={() => void status.refetch()}>Check again</Button>}>Verify the server configuration.</Alert> : null}
    <p className="auth-note">CLI and MCP bearer credentials still work. Browser sign-in does not change your Codex or OpenCode account.</p>
  </section></main>
}

export function OwnerSetupRoute() {
  const search = useSearch({ from: '/setup' })
  const toasts = useContext(ToastContext)
  const status = useOwnerSetupStatus()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const mutation = useMutation({ retry: false,
    mutationFn: (input: OwnerSetupRequest) => browserAuthClient.setup(input),
    onSuccess: () => {
      setPassword('')
      window.location.replace(`/sign-in?notice=owner-created&returnTo=${encodeURIComponent(safeAuthReturnTo(search.returnTo))}`)
    },
    onError: () => { setPassword(''); void status.refetch() },
  })
  useEffect(() => {
    if (mutation.error) toasts?.notify({ tone: 'danger', title: 'Owner setup failed',
      description: mutation.error instanceof Error ? mutation.error.message : 'Check the message beside the form.' })
  }, [mutation.error, toasts])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!mutation.isPending) mutation.mutate({ email, password })
  }
  if (status.data?.state === 'complete') return <Navigate to="/sign-in" search={{ returnTo: search.returnTo }} replace />
  return <main className="auth-screen"><section className="auth-card" aria-labelledby="owner-setup-title">
    <p className="auth-brand">graphql · First-time setup</p><h1 id="owner-setup-title">Create the owner account</h1>
    <p>Use your email and a password to create the local owner account.</p>
    {status.isPending ? <p role="status">Checking owner setup…</p> : null}
    {status.isError ? <div className="auth-retry"><ErrorMessage error={status.error} /><Button onClick={() => void status.refetch()}>Try again</Button></div> : null}
    {status.data?.state === 'locked' ? <Alert live tone="danger" title="Setup is locked">Existing installations require an explicitly selected OWNER_OPERATOR_PRINCIPAL_ID on the server. Do not delete existing accounts or credentials to reopen setup.</Alert> : null}
    {status.data?.state === 'ready' ? <form onSubmit={submit} aria-label="Set up owner">
      <TextField id="owner-email" label="Email" type="email" autoComplete="username" required maxLength={254}
        value={email} onChange={(event) => setEmail(event.target.value)} disabled={mutation.isPending} />
      <TextField id="owner-password" label="Password" type="password" autoComplete="new-password" required minLength={12} maxLength={128}
        hint="Use at least 12 characters. Keep it in your password manager."
        value={password} onChange={(event) => setPassword(event.target.value)} disabled={mutation.isPending} />
      <ErrorMessage error={mutation.error} />
      <Button type="submit" variant="primary" size="lg" loading={mutation.isPending} loadingLabel="Creating owner…">Create owner account</Button>
    </form> : null}
    <Link to="/sign-in" search={{ returnTo: search.returnTo }}>Back to sign in</Link>
  </section></main>
}
