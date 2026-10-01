import { useRef } from 'react'
import type { DeviceRegistration } from '@graphql/contracts/device-identity'
import { useRevokeComputer } from '../../shared/api/computerSettings'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { Button } from '../../shared/ui/nocturne'

export function ComputerRevokeButton({ registration }: { registration: DeviceRegistration }) {
  const revoke = useRevokeComputer()
  type Input = Omit<Parameters<typeof revoke.mutateAsync>[0], 'commandId'>
  const attempt = useRef(new CommandAttempt<Input>()).current
  const original = useRef<Input | undefined>(undefined)
  const submit = async () => {
    original.current ??= { deviceId: registration.deviceId, expectedRevision: registration.authorizationRevision }
    try {
      await revoke.mutateAsync(attempt.input(original.current))
      attempt.succeeded(); original.current = undefined
    } catch (error) { attempt.failed(error); if (!attempt.unresolved) original.current = undefined }
  }
  return <div>
    <p>Revoking application access blocks future authenticated connections. It does not prove an unreachable worker process has stopped.</p>
    <Button disabled={revoke.isPending || registration.status === 'revoked'} onClick={() => void submit()}>
      {revoke.isPending ? 'Revoking…' : attempt.unresolved ? 'Reconcile original revoke command' : 'Revoke worker access'}
    </Button>
    {revoke.error ? <p role="alert">{revoke.error.message}</p> : null}
    {revoke.isSuccess ? <p role="status">Application access revoked.</p> : null}
  </div>
}
