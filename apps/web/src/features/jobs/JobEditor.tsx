import { useState } from 'react'
import { ZodError } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  JobVerificationRequestSchema,
  isAutoJobSpecRecord,
  jobPolicyRequirementsRecord,
  type JobDefinitionRecord,
  type JobDefinitionSaveRecord,
  type JobDefinitionSpecRecord,
  type JobVerificationTemplate,
} from '@foreman-code/contracts/job-verification'
import { Alert, Button, Dialog, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { jobsClient } from './client'
import { ApiError } from '../../shared/api/client'
import { jobError, jobNetworkLabel, jobReadRetry, jobWriteUncertain } from './model'
import { jobKeys } from './query'
import { compactIdentity } from '../../shared/ui/compactIdentity'
import { autoPolicyKey, editorJson, editorSpec, templateKey } from './jobEditorModel'

export function JobEditor({ workspaceId, definition, onClose }: { workspaceId: string; definition?: JobDefinitionRecord; onClose: () => void }) {
  const choices = useQuery({ queryKey: ['jobs', workspaceId, 'choices'], queryFn: ({ signal }) => jobsClient.choices(workspaceId, { signal }), retry: jobReadRetry })
  const cache = useQueryClient()
  const [name, setName] = useState(definition?.name ?? '')
  const [argv, setArgv] = useState(JSON.stringify(definition?.spec.argv ?? ['corepack', 'pnpm', 'build']))
  const [cwd, setCwd] = useState(definition?.spec.relativeCwd ?? '')
  const [target, setTarget] = useState(!definition || isAutoJobSpecRecord(definition.spec) ? 'auto' : '')
  const auto = target === 'auto'
  const [targetPin, setTargetPin] = useState<JobDefinitionSpecRecord['target'] | undefined>(definition?.spec.target ?? { kind: 'auto' })
  const [source, setSource] = useState('')
  const [sourcePin, setSourcePin] = useState(definition?.spec.source)
  const [policy, setPolicy] = useState('')
  const [policyPin, setPolicyPin] = useState(definition?.spec.policy)
  const [limitsPin, setLimitsPin] = useState(() => {
    if (definition && isAutoJobSpecRecord(definition.spec)) return definition.spec.limits
    if (definition && 'verification' in definition.spec) return definition.spec.verification.resources.limits
    return undefined
  })
  const [inputs, setInputs] = useState(JSON.stringify(definition?.spec.inputs ?? [], null, 2))
  const [outputs, setOutputs] = useState(JSON.stringify(definition?.spec.outputs ?? [], null, 2))
  const savedVerification = definition && 'verification' in definition.spec ? definition.spec.verification : undefined
  const [template, setTemplate] = useState(savedVerification ? 'saved' : 'custom')
  // The selected template is an editor snapshot, retained when server choices refresh.
  const [selectedTemplate, setSelectedTemplate] = useState<JobVerificationTemplate>()
  const [verification, setVerification] = useState(savedVerification ? JSON.stringify(savedVerification, null, 2) : '')
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const validation = useMutation({ mutationFn: (spec: JobDefinitionSpecRecord) => jobsClient.validate(workspaceId, spec), retry: false })
  const save = useMutation({ mutationFn: (input: JobDefinitionSaveRecord) => jobsClient.save(workspaceId, input), retry: false,
    onSuccess: () => { void cache.invalidateQueries({ queryKey: jobKeys.definitions(workspaceId) }); onClose() } })
  const uncertain = jobWriteUncertain(save.error)
  const busy = save.isPending || validation.isPending
  const locked = busy || uncertain
  let spec: JobDefinitionSpecRecord | undefined
  let specProblem = ''
  try {
    spec = editorSpec({ auto, target: targetPin, source: sourcePin, policy: policyPin, limits: limitsPin,
      argv, cwd, inputs, outputs, verification })
  } catch (cause) {
    if (cause instanceof ZodError) {
      specProblem = cause.issues.map(issue => {
        const path = issue.path.join('.')
        return path ? `${path}: ${issue.message}` : issue.message
      }).join(' · ')
    } else if (cause instanceof Error) {
      specProblem = cause.message
    } else {
      throw cause
    }
  }
  const jsonProblem = (text: string) => { try { return Array.isArray(JSON.parse(text)) ? undefined : 'Must be a JSON array.' } catch { return 'Not valid JSON yet.' } }
  const argvProblem = jsonProblem(argv) ?? (JSON.parse(argv).every((item: unknown) => typeof item === 'string' && item) && JSON.parse(argv).length ? undefined : 'Use a non-empty array of non-empty strings.')
  const inputsProblem = jsonProblem(inputs), outputsProblem = jsonProblem(outputs)
  const missing = [!name.trim() && 'a name', !auto && !targetPin && 'a computer', !sourcePin && 'a source', (!policyPin || auto && !limitsPin) && 'a policy', argvProblem && 'a valid command'].filter(Boolean)
  const submit = async () => {
    if (save.variables) { await save.mutateAsync(save.variables); return }
    if (!spec || !name.trim()) { setError(specProblem || 'Enter a job name.'); return }
    const readiness = await validation.mutateAsync(spec)
    if (!readiness.valid) throw new ApiError({ code: 'JOB_NOT_READY', message: readiness.reasons.join(' · ') }, 409)
    await save.mutateAsync({ commandId: crypto.randomUUID(), ...(definition ? { id: definition.id } : {}), expectedRevision: definition?.revision ?? null, name, spec })
  }
  const close = useUnsavedChanges({ label: 'job definition', scope: 'surface', dirty, busy, uncertain, error: save.error ? jobError(save.error) : error, save: submit, discard: onClose, saveDisabled: !spec || !name.trim() })
  const changed = () => { if (!uncertain) save.reset(); setDirty(true); setError('') }
  const sources = choices.data?.sources ?? []
  const policies = (choices.data?.policies ?? []).filter(item => ('schemaVersion' in item) === Boolean(verification))
  const autoPolicies = (choices.data?.autoPolicies ?? []).filter(item =>
    ('schemaVersion' in item.policy) === Boolean(verification))
  const templates = choices.data?.verificationTemplates ?? []
  const templateListed = selectedTemplate && templates.some(item => templateKey(item) === template)
  let policyValue = policy
  if (policy && spec && isAutoJobSpecRecord(spec)) {
    policyValue = autoPolicyKey({ policy: spec.policy, limits: spec.limits })
  }
  const policyListed = autoPolicies.some(item => autoPolicyKey(item) === policyValue)
  const selectRequirements = (selected: (typeof autoPolicies)[number] | undefined) => {
    setPolicyPin(selected?.policy)
    setLimitsPin(selected?.limits)
    if (verification && selected) {
      let parsed: unknown
      try {
        parsed = editorJson(verification, 'Verification request')
      } catch (cause) {
        if (cause instanceof Error) { setError(cause.message); return }
        throw cause
      }
      const request = JobVerificationRequestSchema.safeParse(parsed)
      if (request.success) {
        setVerification(JSON.stringify({ ...request.data,
          resources: { ...request.data.resources, limits: selected.limits } }, null, 2))
      }
    }
  }
  let policyPlaceholder = 'Choose runtime requirements'
  if (definition && (definition.schemaVersion === 2) === Boolean(verification)) {
    policyPlaceholder = 'Keep saved runtime requirements'
  }
  if (selectedTemplate) policyPlaceholder = 'Keep selected template runtime requirements'
  const selectTemplate = (value: string) => {
    setTemplate(value)
    setSelectedTemplate(undefined)
    setPolicy('')
    if (value === 'custom') {
      setVerification('')
      if (verification) {
        const build = definition?.schemaVersion === 1 ? definition.spec : undefined
        setArgv(JSON.stringify(build?.argv ?? ['corepack', 'pnpm', 'build']))
        setOutputs(JSON.stringify(build?.outputs ?? [], null, 2))
        setCwd(build?.relativeCwd ?? '')
        setLimitsPin(undefined)
      }
      if (policyPin && 'schemaVersion' in policyPin) setPolicyPin(undefined)
    } else if (value === 'saved' && savedVerification) {
      setVerification(JSON.stringify(savedVerification, null, 2))
      setPolicyPin(definition?.spec.policy)
      setLimitsPin(savedVerification.resources.limits)
      setArgv(JSON.stringify(definition?.spec.argv))
      setOutputs(JSON.stringify(definition?.spec.outputs, null, 2))
      setCwd(definition?.spec.relativeCwd ?? '')
      setTarget(definition && isAutoJobSpecRecord(definition.spec) ? 'auto' : '')
      setTargetPin(definition?.spec.target)
    } else {
      const selected = templates.find(item => templateKey(item) === value)
      if (!selected) return
      setSelectedTemplate(selected)
      setTarget('auto')
      setTargetPin({ kind: 'auto' })
      setPolicyPin(selected.policy)
      setLimitsPin(selected.resources.limits)
      setArgv(JSON.stringify(selected.argv))
      setOutputs(JSON.stringify(selected.outputs ?? [], null, 2))
      setCwd('')
      setVerification(JSON.stringify({ suite: selected.suite, parameters: selected.parameters,
        resources: selected.resources, credentialRefs: [] }, null, 2))
      if (!name.trim()) setName(`Repository ${selected.suite}`)
    }
    changed()
  }
  return <Dialog open className="job-dialog" title={definition ? `Edit ${definition.name}` : 'New job'} size="lg" busy={busy} onOpenChange={open => { if (!open) void close(onClose) }} footer={<><Button disabled={locked} onClick={() => void close(onClose)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!save.variables && (!spec || !name.trim() || choices.isError)} onClick={() => { void submit().catch(cause => setError(jobError(cause))) }}>{save.variables ? 'Retry original save' : 'Save job definition'}</Button></>}>
    <p>Saving creates a new revision. Existing execution snapshots stay unchanged.</p>
    {choices.isPending && <p role="status">Loading authorized job choices…</p>}
    {Boolean(choices.error) && <Alert title="Choices unavailable" tone="danger">{jobError(choices.error)}</Alert>}
    {specProblem && (dirty || Boolean(definition)) && <Alert title="Configuration needs attention" tone="danger">
      {specProblem}
    </Alert>}
    {(error || save.error) && <Alert title={uncertain ? 'Save not confirmed' : 'Job not saved'} tone="danger">{error || jobError(save.error)}</Alert>}
    <TextField label="Job name" value={name} disabled={locked} onChange={event => { setName(event.target.value); changed() }} />
    <Select label="Job template" value={template} disabled={locked || choices.isError}
      options={[{ value: 'custom', label: 'Custom command' },
        ...(savedVerification ? [{ value: 'saved', label: `Keep saved ${savedVerification.suite} verification` }] : []),
        ...(selectedTemplate && !templateListed ? [{ value: template,
          label: `Repository ${selectedTemplate.suite} · ${selectedTemplate.profileId}`
            + ` revision ${selectedTemplate.profileRevision} · no longer listed; keeping selected requirements` }] : []),
        ...templates.map(item => ({ value: templateKey(item),
          label: `Repository ${item.suite} · ${item.profileId} revision ${item.profileRevision}${item.ready ? '' : ' · runtime setup required'}` }))]}
      onChange={event => selectTemplate(event.target.value)}
      hint="Verification templates run the complete repository suite and publish its summary, JUnit, JSON results and logs." />
    {selectedTemplate?.setupIssue === 'report_budget_insufficient' && <Alert title="Report budget too small" tone="warning">
      Four required reports cannot fit the saved {selectedTemplate.policy.maxOutputBytes}-byte output allowance.
      Increase the runtime profile's output allowance and report reservation, then qualify the updated profile.
    </Alert>}
    <Select label="Computer and validated root" value={target} disabled={locked || choices.isError}
      options={[{ value: 'auto', label: 'Auto · highest-priority ready build computer' },
        { value: 'fixed', label: 'Fixed computer (advanced)' },
        ...(definition && !isAutoJobSpecRecord(definition.spec) ? [{ value: '', label: 'Keep saved computer and root binding' }] : []),
        ...(choices.data?.targets ?? []).map(item => ({ value: item.id,
          label: `${item.label}${item.ready ? '' : ` — ${item.reasons.join(' · ')}`}`, disabled: !item.ready }))]}
      onChange={event => {
        const value = event.target.value
        setTarget(value)
        setPolicy('')
        setTargetPin(value === 'auto' ? { kind: 'auto' }
          : choices.data?.targets.find(item => item.id === value)?.target ?? definition?.spec.target)
        if (value === 'auto' && policyPin && 'isolationPolicyId' in policyPin) setPolicyPin(jobPolicyRequirementsRecord(policyPin))
        if (value !== 'auto' && policyPin && !('isolationPolicyId' in policyPin)) setPolicyPin(undefined)
        changed()
      }} hint="Auto selects at Start. Settings → Computers controls build participation and priority." />
    <Select label="Pinned source snapshot" value={source} disabled={locked || choices.isError} options={[{ value: '', label: definition ? 'Keep saved source snapshot' : 'Choose a source' }, ...sources.map(item => ({ value: `${item.snapshotId}:${item.manifestDigest}`,
      label: `Commit ${compactIdentity(item.commit, sources.map(other => other.commit))}${sources.some(other => other.snapshotId !== item.snapshotId && other.commit === item.commit) ? ` · ${compactIdentity(item.snapshotId, sources.map(other => other.snapshotId))}` : ''}` }))]} onChange={event => { setSource(event.target.value); setSourcePin(choices.data?.sources.find(item => `${item.snapshotId}:${item.manifestDigest}` === event.target.value) ?? definition?.spec.source); changed() }} />
    {auto ? <Select label="Required isolation and toolchain policy" value={policyValue} disabled={locked || choices.isError}
      options={[{ value: '', label: policyPlaceholder },
        ...(policyValue && !policyListed ? [{ value: policyValue,
          label: 'Selected runtime requirements · no longer listed; keeping selected values' }] : []),
        ...autoPolicies.map(item => ({ value: autoPolicyKey(item),
          label: `Image ${item.policy.imageDigest.slice(7, 15)} · ${item.limits.cpuLimit} CPU · ${Math.round(item.limits.memoryBytes / 1048576)} MiB` }))]}
      onChange={event => {
        setPolicy(event.target.value)
        let selected = autoPolicies.find(item => autoPolicyKey(item) === event.target.value)
        if (event.target.value === '') {
          if (selectedTemplate) {
            selected = { policy: selectedTemplate.policy, limits: selectedTemplate.resources.limits }
          } else if (definition && isAutoJobSpecRecord(definition.spec)
            && (definition.schemaVersion === 2) === Boolean(verification)) {
            selected = { policy: definition.spec.policy, limits: definition.spec.limits }
          }
        }
        selectRequirements(selected)
        changed()
      }} hint="Preserves image, toolchain, security and limits across computers. Offline computers do not prevent saving." />
      : <Select label="Qualified isolation and toolchain policy" value={policy} disabled={locked || choices.isError} options={[{ value: '', label: definition ? 'Keep saved policy' : 'Choose a policy' }, ...policies.map(item => ({ value: `${item.isolationPolicyId}:${item.isolationPolicyRevision}:${item.toolchainDigest}`,
      label: `${compactIdentity(item.isolationPolicyId, policies.map(other => other.isolationPolicyId))} · rev ${item.isolationPolicyRevision}${policies.some(other => other.toolchainDigest !== item.toolchainDigest && other.isolationPolicyId === item.isolationPolicyId && other.isolationPolicyRevision === item.isolationPolicyRevision) ? ` · ${compactIdentity(item.toolchainDigest, policies.map(other => other.toolchainDigest))}` : ''}` }))]} onChange={event => { setPolicy(event.target.value); setPolicyPin(choices.data?.policies.find(item => `${item.isolationPolicyId}:${item.isolationPolicyRevision}:${item.toolchainDigest}` === event.target.value) ?? definition?.spec.policy); changed() }} />}
    {policyPin ? <p>Selected policy: network {jobNetworkLabel(policyPin.network)}; execution limit {policyPin.executionTimeoutMs} ms.</p> : null}
    {verification && <Textarea label="Verification request (JSON)" value={verification} disabled={locked}
      onChange={event => { setVerification(event.target.value); changed() }}
      hint="Auto placement uses the resource limits in this request. Ordinary suites require no provider credentials; test workers must fit the qualified allowance and owner limit." />}
    {choices.isSuccess && !choices.data.targets.some(item => item.ready) && <Alert title="No computer and validated source root" tone="warning">Jobs need an authorized computer with an approved, validated source root that allows exclusive writes. Ask the person managing this workspace to approve and bind the source root.</Alert>}
    {choices.isSuccess && !choices.data.sources.length && <Alert title="No approved Git source snapshot" tone="warning">A person must approve a Git source and retain its snapshot for this workspace before it appears here.</Alert>}
    {choices.isSuccess && (auto ? !autoPolicies.length : !choices.data.policies.length) && <Alert title="No qualified CI runtime policy" tone="warning">CI isolation needs human-approved runtime, image and bounded storage setup on the chosen computer, followed by the CI runtime qualification diagnostic. A saved harness profile check does not qualify CI isolation. Ask the person managing this workspace to complete that setup.</Alert>}
    <Textarea label="Exact executable and arguments (JSON array)" value={argv} disabled={locked} error={argvProblem} onChange={event => { setArgv(event.target.value); changed() }} hint={'Example: ["corepack","pnpm","build"]. Arguments are passed directly; there is no shell interpolation.'} />
    <TextField label="Relative working directory" value={cwd} disabled={locked} onChange={event => { setCwd(event.target.value); changed() }} hint="Leave empty for the materialized repository root. Absolute paths and traversal are rejected." />
    <details open={inputs !== '[]' || outputs !== '[]'}><summary>File inputs and outputs (optional)</summary>
      <Textarea label="Pinned file inputs (JSON array)" value={inputs} disabled={locked} error={inputsProblem} onChange={event => { setInputs(event.target.value); changed() }} hint="Each input requires a relative path, fileId, revisionId, sha256 and byteSize. No secrets." />
      <Textarea label="Output policy (JSON array)" value={outputs} disabled={locked} error={outputsProblem} onChange={event => { setOutputs(event.target.value); changed() }} hint={'Each output: {"path":"apps/web/dist/index.html","required":true,"mediaType":"text/html"}'} />
    </details>
    {!save.variables && missing.length > 0 && <p role="status" className="job-needs">To save, add {missing.join(', ')}.</p>}
    {Boolean(targetPin || sourcePin || policyPin) && <details><summary>{spec ? 'Review exact saved specification' : 'Review selected configuration'}</summary><pre className="job-log-window">{JSON.stringify(spec ?? { target: targetPin, source: sourcePin, policy: policyPin, ...(auto ? { limits: limitsPin } : {}) }, null, 2)}</pre></details>}
  </Dialog>
}
