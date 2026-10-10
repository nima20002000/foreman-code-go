import { useRef, type ReactNode } from 'react'
import { useLocalHumanAccessQuery } from '../shared/api/settingsExperience'
import { ApiError } from '../shared/api/client'
import { Button, Dialog } from '../shared/ui/nocturne'
import { RuntimeInstanceBoundary } from './RuntimeInstanceBoundary'
import { ChatAttachmentBoundary } from '../features/conversations/ChatAttachmentBoundary'
import './runtimeBoundary.css'

export function AppConnectionBoundary({ children }: { children: ReactNode }) {
  const access = useLocalHumanAccessQuery()
  const retryButton = useRef<HTMLButtonElement>(null)
  const denied = ApiError.is(access.error) && [401, 403].includes(access.error.status ?? 0)
  const retryableLookup = ApiError.is(access.error)
    && (access.error.code === 'NETWORK_ERROR' || access.error.status >= 500)
  const unavailable = <main className="runtime-screen"><section className="runtime-card" role="alert">
    <h1>{denied ? 'Access unavailable' : 'Cannot reach the server'}</h1>
    <p>{access.error?.message ?? 'Check the local API connection, then try again.'}</p>
    <Button variant="primary" onClick={() => void access.refetch()}>Try again</Button>
  </section></main>
  if (access.isError && (denied || !access.data)) return unavailable
  if (!access.data) return <main className="runtime-screen" role="status">Connecting to the local app…</main>
  return <RuntimeInstanceBoundary><ChatAttachmentBoundary>
    {access.isError && !retryableLookup ? unavailable : <>
      {retryableLookup ? <Dialog open onOpenChange={() => {}} title="Reconnecting to the server"
        dismissible={false} busy initialFocusRef={retryButton}>
        <p role="alert">{access.error?.message}</p>
        <Button ref={retryButton} data-skip-folder-blur onClick={() => void access.refetch()}
          loading={access.isFetching}>Try again</Button>
      </Dialog> : null}
      {children}
    </>}
  </ChatAttachmentBoundary></RuntimeInstanceBoundary>
}
