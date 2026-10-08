import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { JobRuntimeApprovalRecord, JobRuntimeProfileRecord } from '@foreman-code/contracts/job-verification-runtime'
import type { BuildComputerPrepareStatus } from '@foreman-code/contracts'
import { useWorkspacePages } from '../../shared/api/query'
import { useComputerPreparation, useJobRuntimeProfiles } from '../../shared/api/jobRuntimeProfiles'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'

const CANDIDATE_STATES: Record<JobRuntimeApprovalRecord['status'], string> = {
  captured: 'Captured — ready to qualify',
  'awaiting-approval': 'Captured — ready to qualify',
  approved: 'Captured — ready to qualify',
  qualifying: 'Qualification in progress — refresh status to follow it',
  complete: 'Qualification complete — see the profile readiness above',
  failed: 'Qualification failed — capture the installed runtime again',
  cancelled: 'Qualification cancelled — capture the installed runtime again',
  'recovery-required': 'Qualification needs recovery — ask Operator to reconcile the original qualification',
}

function Candidate({ candidate }: { candidate: JobRuntimeApprovalRecord }) {
  const captured = ['captured', 'awaiting-approval', 'approved'].includes(candidate.status)
  const expired = captured && Date.parse(candidate.expiresAt) <= Date.now()
  return <div>
    <dl className="computer-facts">
      <div><dt>Profile revision</dt><dd>{candidate.profileRevision}</dd></div>
      <div><dt>Installed fingerprint</dt><dd><code>{candidate.fingerprintDigest}</code></dd></div>
      <div><dt>Status</dt><dd>{expired
        ? 'Expired — capture the installed runtime again' : CANDIDATE_STATES[candidate.status]}</dd></div>
    </dl>
    <details><summary>Exact runtime configuration</summary>
      <dl className="computer-facts">
        <div><dt>Runtime</dt><dd>{candidate.fingerprint.runtimeExecutable}</dd></div>
        <div><dt>Runtime binary SHA256</dt><dd><code>{candidate.fingerprint.runtimeBinarySha256}</code></dd></div>
        <div><dt>Image</dt><dd><code>{candidate.fingerprint.imageDigest}</code></dd></div>
        <div><dt>CPU / memory / processes</dt><dd>{candidate.fingerprint.limits.cpuLimit} CPU / {candidate.fingerprint.limits.memoryBytes} bytes / {candidate.fingerprint.limits.pidsLimit} processes</dd></div>
      </dl>
    </details>
  </div>
}

const PREPARATION_STATES: Record<BuildComputerPrepareStatus['state'], string> = {
  idle: 'No preparation running', approving: 'Approving the commit',
  preparing: 'Building the offline packages and image', binding: 'Moving profiles to the new image',
  refreshing: 'Restarting the computer\'s Worker', qualifying: 'Qualifying',
  qualified: 'Qualified', failed: 'Preparation failed',
}
function Preparation({ workspaceId, profileId }: { workspaceId: string; profileId: string }) {
  const { status, start } = useComputerPreparation(workspaceId, profileId)
  const current = status.data
  const busy = start.isPending || Boolean(current && !['idle', 'qualified', 'failed'].includes(current.state))
  return <div>
    {status.isPending && <LoadingState label="Loading preparation status…" />}
    {status.isError && <>
      <Alert tone="warning" title={`Preparation status could not be read: ${status.error.message}`} />
      {current && <p>Last observed: {PREPARATION_STATES[current.state]}. Retry status to check its progress.</p>}
      <Button disabled={status.isFetching} onClick={() => void status.refetch()}>Retry preparation status</Button>
    </>}
    {!status.isError && current && current.state !== 'idle' && <p role="status">{PREPARATION_STATES[current.state]}
      {current.commit ? ` at ${current.commit.slice(0, 12)}` : ''}{current.stage ? ` — ${current.stage}` : ''}
      {current.message ? `: ${current.message}` : ''}</p>}
    {start.isError && <Alert tone="warning" title={`Preparation could not start: ${start.error.message}`} />}
    <Button disabled={busy || status.isPending || status.isError} onClick={() => start.mutate()}>
      {busy ? 'Preparing…' : 'Prepare automatically'}
    </Button>
  </div>
}

const PROFILE_STATES: Record<JobRuntimeProfileRecord['status'], string> = {
  unqualified: 'Not qualified', captured: 'Runtime captured', 'awaiting-approval': 'Runtime captured',
  qualifying: 'Qualification in progress', qualified: 'Qualified — setup needs attention',
  failed: 'Qualification failed', revoked: 'Qualification revoked', 'recovery-required': 'Qualification needs recovery',
}

function legacyNextStep(profile: JobRuntimeProfileRecord) {
  if (profile.status === 'recovery-required') return 'Ask Operator to reconcile the original qualification before starting again.'
  if (profile.status === 'qualifying') return 'Refresh runtime qualification to follow the running qualification.'
  if (['captured', 'awaiting-approval'].includes(profile.status)) return 'Ask Operator to run the captured qualification for this profile.'
  return 'Ask Operator to capture this installed runtime profile and run its qualification.'
}

function ProfileSetup({ profile, ready, reasons, candidates }: {
  profile: JobRuntimeProfileRecord
  ready: boolean
  reasons: string[]
  candidates: JobRuntimeApprovalRecord[]
}) {
  return <article aria-label={`Runtime profile ${profile.name}`}>
    <h4>{profile.name}</h4>
    <p role="status">{ready ? 'Qualified — ready' : PROFILE_STATES[profile.status]}
      {profile.schemaVersion === 2 && !ready && <>. Verification needs runtime setup for this saved commit.
        The saved policy uses offline dependencies and a {profile.approvalConfig.approvalLifetimeMs / 3_600_000}-hour qualification lifetime.</>}
    </p>
    {reasons.length > 0 && <p>Setup needs attention: {reasons.join(', ')}</p>}
    {profile.schemaVersion === 2 ? <>
      <dl className="computer-facts">
        <div><dt>Saved commit</dt><dd>{profile.sourceCommit ?? 'Save a profile revision to bind its commit'}</dd></div>
        <div><dt>Requested suites</dt><dd>{profile.spec.suites.join(', ')}</dd></div>
        <div><dt>Requested CPU / memory / processes</dt><dd>{profile.spec.resources.limits.cpuLimit} CPU / {profile.spec.resources.limits.memoryBytes} bytes / {profile.spec.resources.limits.pidsLimit} processes</dd></div>
      </dl>
      {profile.approvalConfig.review ? <Preparation workspaceId={profile.workspaceId} profileId={profile.id} />
        : <p>Ask Operator to save a reviewed verification profile before preparing this computer automatically.</p>}
    </> : <>
      <p>Automatic preparation is unavailable for legacy build profiles.
        Runtime installation and repair must be performed locally by a person on this computer.</p>
      <p>{legacyNextStep(profile)}</p>
    </>}
    {profile.schemaVersion === 2 && profile.status === 'recovery-required' && <p>Ask Operator to reconcile the original qualification before starting again.</p>}
    {candidates.map(candidate => <Candidate key={candidate.id} candidate={candidate} />)}
  </article>
}

function WorkspaceQualification({ workspaceId, name, registration }: {
  workspaceId: string; name: string; registration: DeviceRegistration
}) {
  const read = useJobRuntimeProfiles(workspaceId)
  if (read.isPending) return <LoadingState label={`Loading runtime qualification for ${name}…`} />
  if (read.isError) return <><Alert tone="warning" title={`Runtime qualification for ${name} could not be read: ${read.error.message}`} />
    <Button onClick={() => void read.refetch()}>Retry runtime qualification</Button></>
  const profiles = read.data.profiles.filter(({ profile }) => {
    const host = profile.root.selection.hostRef
    const binding = profile.root.registration
    return host.kind === 'device' && host.mainId === registration.mainId && host.deviceId === registration.deviceId
      && binding?.workerInstallationId === registration.workerInstallationId
      && binding.keyRevision === registration.keyRevision && binding.authorizationRevision === registration.authorizationRevision
  })
  const candidates = read.data.approvals.filter(value => {
    const host = value.fingerprint.hostRef
    const profile = profiles.find(item => item.profile.id === value.profileId)?.profile
    const binding = value.fingerprint.registration
    return host.kind === 'device' && host.mainId === registration.mainId && host.deviceId === registration.deviceId
      && binding?.workerInstallationId === registration.workerInstallationId
      && binding.keyRevision === registration.keyRevision && binding.authorizationRevision === registration.authorizationRevision
      && profile?.revision === value.profileRevision && profile.specDigest === value.fingerprint.specDigest
  })
  return <section aria-label={`Runtime qualification for ${name}`}><h3>{name}</h3>
    {profiles.length === 0 && <p>No runtime profiles for this computer. Ask Operator to create a verification profile
      using this workspace's approved source root; then prepare it here.</p>}
    {profiles.map(item => <ProfileSetup key={item.profile.id} {...item}
      candidates={candidates.filter(candidate => candidate.profileId === item.profile.id)} />)}
    <Button disabled={read.isFetching} onClick={() => void read.refetch()}>Refresh runtime qualification</Button>
  </section>
}

export function ComputerRuntimeQualification({ registration }: { registration: DeviceRegistration }) {
  const workspaces = useWorkspacePages(registration.status === 'paired')
  if (registration.status !== 'paired') return null
  return <section aria-label="Runtime qualification"><h2>Runtime qualification</h2>
    <p>This paired computer runs CI after its installed runtime is captured and qualified. No approval is needed.</p>
    {workspaces.isPending ? <LoadingState label="Loading workspaces for runtime qualification…" /> : workspaces.isError
      ? <><Alert tone="warning" title={`Runtime qualification workspaces could not be read: ${workspaces.error.message}`} /><Button onClick={() => void workspaces.refetch()}>Retry workspaces</Button></>
      : workspaces.data.pages.flatMap(page => page.items).map(item => <WorkspaceQualification key={item.workspace.id} workspaceId={item.workspace.id} name={item.workspace.name} registration={registration} />)}
    {workspaces.data?.pages.every(page => page.items.length === 0) && <p>Create a workspace with an approved source root,
      then ask Operator to create a verification profile for this computer.</p>}
    {workspaces.hasNextPage ? <Button disabled={workspaces.isFetchingNextPage} onClick={() => void workspaces.fetchNextPage()}>{workspaces.isFetchingNextPage ? 'Loading more workspaces…' : 'Load more workspaces'}</Button> : null}
  </section>
}
