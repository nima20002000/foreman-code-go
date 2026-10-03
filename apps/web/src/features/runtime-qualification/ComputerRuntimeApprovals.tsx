import { useRef } from 'react'
import type { DeviceRegistration } from '@graphql/contracts/device-identity'
import type { JobRuntimeApproval } from '@graphql/contracts/job-runtime'
import { useWorkspacePages } from '../../shared/api/query'
import { useApproveJobRuntime, useJobRuntimeProfiles } from '../../shared/api/jobRuntimeProfiles'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'

function Approval({ approval, name }: { approval: JobRuntimeApproval; name: string }) {
  const mutation = useApproveJobRuntime(approval.workspaceId)
  const commandId = useRef<string | undefined>(undefined)
  const expired = Date.parse(approval.expiresAt) <= Date.now()
  return <article aria-label={`Runtime profile ${name}`}>
    <h4>{name}</h4>
    <dl className="computer-facts">
      <div><dt>Profile revision</dt><dd>{approval.profileRevision}</dd></div>
      <div><dt>Installed fingerprint</dt><dd><code>{approval.fingerprintDigest}</code></dd></div>
      <div><dt>Status</dt><dd>{expired ? 'Expired — request a new fingerprint' : approval.status === 'approved' ? 'Approved for physical qualification' : 'Awaiting your approval'}</dd></div>
    </dl>
    <details><summary>Exact runtime configuration</summary>
      <dl className="computer-facts">
        <div><dt>Runtime</dt><dd>{approval.fingerprint.runtimeExecutable}</dd></div>
        <div><dt>Runtime binary SHA256</dt><dd><code>{approval.fingerprint.runtimeBinarySha256}</code></dd></div>
        <div><dt>Image</dt><dd><code>{approval.fingerprint.imageDigest}</code></dd></div>
        <div><dt>CPU / memory / processes</dt><dd>{approval.fingerprint.limits.cpuLimit} CPU / {approval.fingerprint.limits.memoryBytes} bytes / {approval.fingerprint.limits.pidsLimit} processes</dd></div>
      </dl>
    </details>
    {approval.status === 'awaiting-approval' && !expired ? <Button disabled={mutation.isPending} onClick={() => {
      commandId.current ??= crypto.randomUUID()
      mutation.mutate({ approval, commandId: commandId.current })
    }}>{mutation.isPending ? 'Approving…' : 'Approve'}</Button> : null}
    {mutation.isError && approval.status === 'awaiting-approval' ? <Alert tone="danger" title={mutation.error.message} /> : null}
  </article>
}
function WorkspaceApprovals({ workspaceId, name, registration }: { workspaceId: string; name: string; registration: DeviceRegistration }) {
  const read = useJobRuntimeProfiles(workspaceId)
  if (read.isPending) return <LoadingState label={`Loading runtime approvals for ${name}…`} />
  if (read.isError) return <><Alert tone="warning" title={`Runtime approvals for ${name} could not be read: ${read.error.message}`} />
    <Button onClick={() => void read.refetch()}>Retry runtime approvals</Button></>
  const approvals = read.data.approvals.filter(value => {
    const host = value.fingerprint.hostRef, profile = read.data.profiles.find(item => item.profile.id === value.profileId)?.profile
    return host.kind === 'device' && host.mainId === registration.mainId && host.deviceId === registration.deviceId
      && value.fingerprint.registration?.workerInstallationId === registration.workerInstallationId
      && value.fingerprint.registration.keyRevision === registration.keyRevision && value.fingerprint.registration.authorizationRevision === registration.authorizationRevision
      && ['awaiting-approval', 'approved'].includes(value.status) && profile?.revision === value.profileRevision && profile.specDigest === value.fingerprint.specDigest
  })
  return approvals.length ? <section aria-label={`Runtime approvals for ${name}`}><h3>{name}</h3>
    {approvals.map(value => <Approval key={value.id} approval={value} name={read.data.profiles.find(item => item.profile.id === value.profileId)!.profile.name} />)}</section> : null
}
export function ComputerRuntimeApprovals({ registration }: { registration: DeviceRegistration }) {
  const workspaces = useWorkspacePages(registration.status === 'paired')
  if (registration.status !== 'paired') return null
  return <section aria-label="Runtime qualification approvals"><h2>Runtime qualification</h2>
    <p>Approve an exact installed fingerprint before physical qualification. Approval does not start a workload.</p>
    {workspaces.isPending ? <LoadingState label="Loading workspaces for runtime approvals…" /> : workspaces.isError
      ? <><Alert tone="warning" title={`Runtime approval workspaces could not be read: ${workspaces.error.message}`} /><Button onClick={() => void workspaces.refetch()}>Retry workspaces</Button></>
      : workspaces.data.pages.flatMap(page => page.items).map(item => <WorkspaceApprovals key={item.workspace.id} workspaceId={item.workspace.id} name={item.workspace.name} registration={registration} />)}
    {workspaces.hasNextPage ? <Button disabled={workspaces.isFetchingNextPage} onClick={() => void workspaces.fetchNextPage()}>{workspaces.isFetchingNextPage ? 'Loading more workspaces…' : 'Load more workspaces'}</Button> : null}
  </section>
}
