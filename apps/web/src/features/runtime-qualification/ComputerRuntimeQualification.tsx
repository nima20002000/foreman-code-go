import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { JobRuntimeApprovalRecord } from '@foreman-code/contracts/job-verification-runtime'
import { useWorkspacePages } from '../../shared/api/query'
import { useJobRuntimeProfiles } from '../../shared/api/jobRuntimeProfiles'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'

/** A paired computer is a build machine: a captured candidate is qualified directly, never approved. */
function Candidate({ candidate, name }: { candidate: JobRuntimeApprovalRecord; name: string }) {
  const expired = Date.parse(candidate.expiresAt) <= Date.now()
  return <article aria-label={`Runtime profile ${name}`}>
    <h4>{name}</h4>
    <dl className="computer-facts">
      <div><dt>Profile revision</dt><dd>{candidate.profileRevision}</dd></div>
      <div><dt>Installed fingerprint</dt><dd><code>{candidate.fingerprintDigest}</code></dd></div>
      <div><dt>Status</dt><dd>{expired ? 'Expired — capture the installed runtime again' : 'Captured — ready to qualify'}</dd></div>
    </dl>
    <details><summary>Exact runtime configuration</summary>
      <dl className="computer-facts">
        <div><dt>Runtime</dt><dd>{candidate.fingerprint.runtimeExecutable}</dd></div>
        <div><dt>Runtime binary SHA256</dt><dd><code>{candidate.fingerprint.runtimeBinarySha256}</code></dd></div>
        <div><dt>Image</dt><dd><code>{candidate.fingerprint.imageDigest}</code></dd></div>
        <div><dt>CPU / memory / processes</dt><dd>{candidate.fingerprint.limits.cpuLimit} CPU / {candidate.fingerprint.limits.memoryBytes} bytes / {candidate.fingerprint.limits.pidsLimit} processes</dd></div>
      </dl>
    </details>
  </article>
}
function WorkspaceQualification({ workspaceId, name, registration }: { workspaceId: string; name: string; registration: DeviceRegistration }) {
  const read = useJobRuntimeProfiles(workspaceId)
  if (read.isPending) return <LoadingState label={`Loading runtime qualification for ${name}…`} />
  if (read.isError) return <><Alert tone="warning" title={`Runtime qualification for ${name} could not be read: ${read.error.message}`} />
    <Button onClick={() => void read.refetch()}>Retry runtime qualification</Button></>
  const candidates = read.data.approvals.filter(value => {
    const host = value.fingerprint.hostRef, profile = read.data.profiles.find(item => item.profile.id === value.profileId)?.profile
    return host.kind === 'device' && host.mainId === registration.mainId && host.deviceId === registration.deviceId
      && value.fingerprint.registration?.workerInstallationId === registration.workerInstallationId
      && value.fingerprint.registration.keyRevision === registration.keyRevision && value.fingerprint.registration.authorizationRevision === registration.authorizationRevision
      && profile?.revision === value.profileRevision && profile.specDigest === value.fingerprint.specDigest
  })
  const pendingVerification = read.data.profiles.filter(item => {
    const profile = item.profile
    const host = profile.root.selection.hostRef
    const binding = profile.root.registration
    return profile.schemaVersion === 2 && !item.ready
      && host.kind === 'device' && host.mainId === registration.mainId && host.deviceId === registration.deviceId
      && binding?.workerInstallationId === registration.workerInstallationId
      && binding.keyRevision === registration.keyRevision && binding.authorizationRevision === registration.authorizationRevision
  })
  return candidates.length || pendingVerification.length ? <section aria-label={`Runtime qualification for ${name}`}><h3>{name}</h3>
    {pendingVerification.map(({ profile }) => {
      if (profile.schemaVersion !== 2) return null
      return <article key={profile.id} aria-label={`Verification profile ${profile.name}`}>
        <h4>{profile.name}</h4>
        <p role="status">Verification needs runtime setup for this saved commit. The saved policy uses offline dependencies and a 24-hour qualification lifetime.</p>
        <dl className="computer-facts">
          <div><dt>Saved commit</dt><dd>{profile.sourceCommit ?? 'Save a profile revision to bind its commit'}</dd></div>
          <div><dt>Requested suites</dt><dd>{profile.spec.suites.join(', ')}</dd></div>
          <div><dt>Requested CPU / memory / processes</dt><dd>{profile.spec.resources.limits.cpuLimit} CPU / {profile.spec.resources.limits.memoryBytes} bytes / {profile.spec.resources.limits.pidsLimit} processes</dd></div>
        </dl>
      </article>
    })}
    {candidates.map(value => <Candidate key={value.id} candidate={value} name={read.data.profiles.find(item => item.profile.id === value.profileId)!.profile.name} />)}</section> : null
}
export function ComputerRuntimeQualification({ registration }: { registration: DeviceRegistration }) {
  const workspaces = useWorkspacePages(registration.status === 'paired')
  if (registration.status !== 'paired') return null
  return <section aria-label="Runtime qualification"><h2>Runtime qualification</h2>
    <p>This paired computer runs CI after its installed runtime is captured and qualified. No approval is needed.</p>
    {workspaces.isPending ? <LoadingState label="Loading workspaces for runtime qualification…" /> : workspaces.isError
      ? <><Alert tone="warning" title={`Runtime qualification workspaces could not be read: ${workspaces.error.message}`} /><Button onClick={() => void workspaces.refetch()}>Retry workspaces</Button></>
      : workspaces.data.pages.flatMap(page => page.items).map(item => <WorkspaceQualification key={item.workspace.id} workspaceId={item.workspace.id} name={item.workspace.name} registration={registration} />)}
    {workspaces.hasNextPage ? <Button disabled={workspaces.isFetchingNextPage} onClick={() => void workspaces.fetchNextPage()}>{workspaces.isFetchingNextPage ? 'Loading more workspaces…' : 'Load more workspaces'}</Button> : null}
  </section>
}
