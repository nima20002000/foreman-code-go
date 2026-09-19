import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { browserAuthClient } from '../../shared/api/browserAuth'
import { ConfirmDialog, Button } from '../../shared/ui/nocturne'
import { clearBrowserIdentity, prepareBrowserIdentityChange } from './sessionTransition'

export function SignOutButton() {
  const client = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      let confirmed = false
      try {
        await prepareBrowserIdentityChange(client)
        await browserAuthClient.signOut()
        confirmed = true
      } finally {
        clearBrowserIdentity(client)
        // A lost reply may or may not have revoked the server session. Do not claim otherwise.
        window.location.replace(`/sign-in?notice=${confirmed ? 'signed-out' : 'sign-out-unconfirmed'}`)
      }
    },
  })
  return <>
    <Button disabled={mutation.isPending} onClick={() => setConfirm(true)}>Sign out</Button>
    <ConfirmDialog open={confirm} onOpenChange={(open) => { if (!mutation.isPending) setConfirm(open) }}
      title="Sign out of this browser?" description="Unsaved edits and unsent messages will be cleared. Save or copy them before continuing."
      confirmLabel="Sign out" pending={mutation.isPending}
      onConfirm={() => mutation.mutate()} />
  </>
}
