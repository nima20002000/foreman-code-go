import { useEffect, useRef } from 'react'
import type { CompatibilityHarness, HarnessCompatibility } from '@foreman-code/contracts'
import { ApiError } from '../../shared/api/client'
import { useHarnessCompatibilityQuery, useRetryHarnessCompatibility } from '../../shared/api/harnessCompatibility'
import { useCheckHarnessQualification, useHarnessQualificationsQuery } from '../../shared/api/harnessQualification'
import { Button, useToast } from '../../shared/ui/nocturne'
import './harnessCompatibility.css'

const nameOf = (harness: CompatibilityHarness) => harness === 'codex' ? 'Codex' : 'OpenCode'
const statusLabels: Record<HarnessCompatibility['status'], string> = {
  'not-checked': 'Not checked', checking: 'Checking…',
  'known-compatible': 'Version recognized',
  'probe-passed': 'Check passed; execution blocked',
  'probe-failed': 'Check failed', unavailable: 'Unavailable',
}
const sourceLabels: Record<HarnessCompatibility['source'], string> = {
  none: 'No reusable result', 'release-record': 'Recorded official release',
  'local-probe': 'Local schema check', cache: 'Reused local check',
}
function resultToast(report: HarnessCompatibility) {
  const name = nameOf(report.harness)
  if (report.status === 'known-compatible') return {
    title: `${name} version is known compatible`, tone: 'success' as const,
    description: 'The version matches the recorded release. Normal execution qualification still applies.',
  }
  if (report.status === 'probe-passed') return {
    title: `${name} local check passed`, tone: 'warning' as const,
    description: `This is not execution qualification. Version ${report.installedVersion} remains outside the qualified release. ${report.cacheWarning ?? 'The diagnostic result can be reused.'}`,
  }
  return {
    title: `${name} compatibility check failed`, tone: 'danger' as const,
    description: report.reason?.message ?? 'No compatibility result was confirmed. Refresh the status and retry.',
  }
}
function loadError(error: unknown): string {
  if (ApiError.is(error) && ['INVALID_REQUEST', 'INVALID_RESPONSE'].includes(error.code)) {
    return 'This page and the running API may be out of sync. Restart the local API, then retry.'
  }
  return error instanceof Error ? error.message : 'Check the local API, then retry.'
}
function HarnessQualificationRow({ harness }: { harness: CompatibilityHarness }) {
  const query = useHarnessQualificationsQuery()
  const check = useCheckHarnessQualification()
  const row = query.data?.qualifications.find((entry) => entry.harness === harness)
  const checking = row?.status === 'qualifying' || check.isPending
  const status = row?.status === 'baseline' || row?.status === 'qualified' ? 'Trusted'
    : checking ? 'Checking…' : 'Failed'
  return <div className="harness-qualification" aria-label={`${nameOf(harness)} qualification`}>
    <span>Installed {row?.version ?? 'unknown'}</span>
    <span role="status">{query.isPending ? 'Loading…' : status}</span>
    {!query.isPending && status === 'Failed' ? <span>{row?.failureReason ?? (query.isError ? loadError(query.error) : 'Not qualified')}</span> : null}
    <Button size="sm" disabled={checking} onClick={() => void check.mutateAsync(harness).catch(() => undefined)}>Check</Button>
    {check.isError ? <span role="alert">{loadError(check.error)}</span> : null}
  </div>
}
export function HarnessCompatibilityPanel({ harness }: { harness: CompatibilityHarness }) {
  const query = useHarnessCompatibilityQuery()
  const { notify } = useToast()
  const name = nameOf(harness)
  const row = query.data?.harnesses.find((entry) => entry.harness === harness)
  // Notification ownership is local interaction state; reports remain solely in Query.
  const requested = useRef(new Set<string>())
  const submitting = useRef(new Set<CompatibilityHarness>())
  const retry = useRetryHarnessCompatibility((report) => {
    if (report.status === 'checking') requested.current.add(report.checkId)
    else notify(resultToast(report))
  })
  useEffect(() => {
    for (const report of query.data?.harnesses ?? []) {
      if (report.status === 'checking' || !requested.current.delete(report.checkId)) continue
      notify(resultToast(report))
    }
  }, [query.data, notify])
  const check = async (target: CompatibilityHarness) => {
    if (submitting.current.has(target)) return
    submitting.current.add(target)
    notify({ title: `Checking ${nameOf(target)} compatibility`, tone: 'info', description: 'Checking the local CLI only. No model turn or settings change will be made.' })
    try {
      await retry.mutateAsync(target)
    } catch (error) {
      notify({ title: `Could not confirm the ${nameOf(target)} check`, tone: 'danger', description:
        ApiError.is(error) && [401, 403].includes(error.status) ? 'Access is unavailable. Check the local API connection, then try again.'
          : `${error instanceof Error ? error.message : 'The API is unavailable.'} A check may still be running. Refresh its status before retrying.`,
      })
    } finally { submitting.current.delete(target) }
  }
  return <section className="harness-compatibility" aria-label={`${name} installation`}>
    <HarnessQualificationRow harness={harness} />
    {!row ? <div className="harness-compatibility-summary">
      <strong>{name} installation</strong>
      {query.isError ? <><span role="alert">Check unavailable. {loadError(query.error)}</span>
        <Button size="sm" onClick={() => void query.refetch()}>Try again</Button></>
        : <span role="status">Loading installation check…</span>}
    </div> : <>
      <div className="harness-compatibility-summary">
        <strong>{name} installation</strong>
        <span>{row.installedVersion ?? 'Not detected'}{row.status === 'checking' && row.installedVersion ? ' (last observed)' : ''}</span>
        <span className="harness-compatibility-state" role="status">{statusLabels[row.status]}</span>
        <Button size="sm" disabled={!query.data?.canRetry || row.status === 'checking' || row.reason?.code === 'CLI_CLEANUP_FAILED'
          || (retry.isPending && retry.variables === row.harness)}
          onClick={() => void check(row.harness)}>{row.status === 'checking' ? `Checking ${name}…` : `Retry ${name} check`}</Button>
      </div>
      {row.reason ? <p role="alert">{row.reason.message}</p> : null}
      {row.status === 'probe-passed' ? <p role="status">The local check passed, but this version is not qualified for execution.</p> : null}
      {row.cacheWarning ? <p role="status">{row.cacheWarning}</p> : null}
      {query.isError ? <p role="alert">Could not refresh. The last result is still shown. <Button size="sm" onClick={() => void query.refetch()}>Try again</Button></p> : null}
      <details className="harness-compatibility-details"><summary>Check details and repair</summary>
        <dl>
          <div><dt>Qualified release</dt><dd>{row.qualifiedRelease.version}</dd></div>
          {row.checkedAt ? <div><dt>Last checked</dt><dd><time dateTime={row.checkedAt}>{new Date(row.checkedAt).toLocaleString()}</time></dd></div> : null}
          <div><dt>Evidence</dt><dd>{sourceLabels[row.source]}</dd></div>
        </dl>
        <p>This checks the local version and exported schema only. Authentication, settings, and execution are checked separately.</p>
        {!query.data?.canRetry ? <p>Retry requires harness update access.</p> : null}
        {row.status === 'probe-passed' ? <p>This version remains blocked by the exact-version execution gate.</p> : null}
        <p>To repair, check <code>{harness === 'codex' ? 'CODEX_BINARY' : 'OPENCODE_BINARY'}</code> on the API host and restore the qualified release. Back up native data before changing versions.</p>
        {harness === 'codex' ? <p>The default Codex binary comes from the pinned package. Restore it with <code>corepack pnpm install --frozen-lockfile</code>. Repair an explicit binary override separately.</p> : <p>OpenCode is installed separately from the app.</p>}
        {row.reason?.code.startsWith('CHECKER_') ? <p>If the app checker failed, rebuild and restart the API before changing the CLI.</p> : null}
        {row.reason?.code === 'CLI_CLEANUP_FAILED' ? <p>Stop the unfinished diagnostic process and restart the API before retrying.</p> : null}
        <a href={row.qualifiedRelease.releaseUrl} target="_blank" rel="noopener noreferrer">Official {name} {row.qualifiedRelease.version} release</a>
      </details>
    </>}
  </section>
}
