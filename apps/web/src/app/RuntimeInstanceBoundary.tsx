import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRuntimeIdentityQuery, useRuntimeInstallationId } from '../shared/api/runtimeIdentity'
import { bindProtectedChatInstance } from '../shared/api/protectedChatStorage'
import { Button } from '../shared/ui/nocturne'
import './runtimeBoundary.css'

/** Check installation ownership before document-scoped drafts or outbox can render. */
export function RuntimeInstanceBoundary({ children }: { children: ReactNode }) {
  const identity = useRuntimeIdentityQuery()
  const installationId = useRuntimeInstallationId()
  const current = installationId ? `installation:${installationId}` : undefined
  const [accepted, setAccepted] = useState<string>()
  const [storageFailed, setStorageFailed] = useState(false)
  const reloading = useRef(false)
  const reconnecting = identity.failureCount > 0 && !identity.isError
  useEffect(() => {
    if (!current || identity.isError || reloading.current || storageFailed) return
    try {
      if (bindProtectedChatInstance(current)) {
        reloading.current = true
        window.location.reload()
      } else setAccepted(current)
    } catch { setStorageFailed(true) }
  }, [current, identity.isError, storageFailed])
  if (identity.isError || storageFailed) return <main className="runtime-screen"><section className="runtime-card" role="alert">
    <h1>Could not verify this app</h1>
    <p>{storageFailed ? 'Browser storage is unavailable. Allow storage for this app, then try again.'
      : 'The app connection could not be verified. Your saved drafts have not been changed.'}</p>
    <Button variant="primary" onClick={() => { setStorageFailed(false); void identity.refetch() }}>Try again</Button>
  </section></main>
  if (!current || current !== accepted || reloading.current) {
    return <main className="runtime-screen" role="status">
      {reconnecting ? 'Reconnecting…' : 'Connecting to this app…'}
    </main>
  }
  return <>
    {reconnecting && <div className="runtime-reconnecting" role="status">Reconnecting…</div>}
    {children}
  </>
}
