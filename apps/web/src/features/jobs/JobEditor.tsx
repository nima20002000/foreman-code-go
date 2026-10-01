import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { JobDefinitionSpecSchema, type JobDefinition, type JobDefinitionSave, type JobDefinitionSpec } from '@graphql/contracts/jobs'
import { Alert, Button, Dialog, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { jobsClient } from './client'
import { ApiError } from '../../shared/api/client'
import { jobError, jobReadRetry, jobWriteUncertain } from './model'
import { jobKeys } from './query'

export function JobEditor({ workspaceId, definition, onClose }: { workspaceId: string; definition?: JobDefinition; onClose: () => void }) {
  const choices = useQuery({ queryKey: ['jobs', workspaceId, 'choices'], queryFn: ({ signal }) => jobsClient.choices(workspaceId, { signal }), retry: jobReadRetry })
  const cache = useQueryClient()
  const [name, setName] = useState(definition?.name ?? '')
  const [argv, setArgv] = useState(JSON.stringify(definition?.spec.argv ?? ['corepack', 'pnpm', 'build']))
  const [cwd, setCwd] = useState(definition?.spec.relativeCwd ?? '')
  const [target, setTarget] = useState('')
  const [targetPin, setTargetPin] = useState(definition?.spec.target)
  const [source, setSource] = useState('')
  const [sourcePin, setSourcePin] = useState(definition?.spec.source)
  const [policy, setPolicy] = useState('')
  const [policyPin, setPolicyPin] = useState(definition?.spec.policy)
  const [inputs, setInputs] = useState(JSON.stringify(definition?.spec.inputs ?? [], null, 2))
  const [outputs, setOutputs] = useState(JSON.stringify(definition?.spec.outputs ?? [], null, 2))
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const validation = useMutation({ mutationFn: (spec: JobDefinitionSpec) => jobsClient.validate(workspaceId, spec), retry: false })
  const save = useMutation({ mutationFn: (input: JobDefinitionSave) => jobsClient.save(workspaceId, input), retry: false,
    onSuccess: () => { void cache.invalidateQueries({ queryKey: jobKeys.definitions(workspaceId) }); onClose() } })
  const uncertain = jobWriteUncertain(save.error)
  const busy = save.isPending || validation.isPending
  const locked = busy || uncertain
  let spec: JobDefinitionSpec | undefined
  try {
    spec = JobDefinitionSpecSchema.parse({
      target: targetPin,
      source: sourcePin,
      policy: policyPin,
      argv: JSON.parse(argv), ...(cwd ? { relativeCwd: cwd } : {}), inputs: JSON.parse(inputs), outputs: JSON.parse(outputs),
    })
  } catch { /* Incomplete authoring is validated on save. */ }
  const jsonProblem = (text: string) => { try { return Array.isArray(JSON.parse(text)) ? undefined : 'Must be a JSON array.' } catch { return 'Not valid JSON yet.' } }
  const argvProblem = jsonProblem(argv) ?? (JSON.parse(argv).every((item: unknown) => typeof item === 'string' && item) && JSON.parse(argv).length ? undefined : 'Use a non-empty array of non-empty strings.')
  const inputsProblem = jsonProblem(inputs), outputsProblem = jsonProblem(outputs)
  const missing = [!name.trim() && 'a name', !targetPin && 'a computer', !sourcePin && 'a source', !policyPin && 'a policy', argvProblem && 'a valid command'].filter(Boolean)
  const submit = async () => {
    if (save.variables) { await save.mutateAsync(save.variables); return }
    if (!spec || !name.trim()) { setError('Choose a qualified computer, source and policy; enter a name and valid command/input/output JSON.'); return }
    const readiness = await validation.mutateAsync(spec)
    if (!readiness.valid) throw new ApiError({ code: 'JOB_NOT_READY', message: readiness.reasons.join(' · ') }, 409)
    await save.mutateAsync({ commandId: crypto.randomUUID(), ...(definition ? { id: definition.id } : {}), expectedRevision: definition?.revision ?? null, name, spec })
  }
  const close = useUnsavedChanges({ label: 'job definition', scope: 'surface', dirty, busy, uncertain, error: save.error ? jobError(save.error) : error, save: submit, discard: onClose, saveDisabled: !spec || !name.trim() })
  const changed = () => { if (!uncertain) save.reset(); setDirty(true); setError('') }
  return <Dialog open title={definition ? `Edit ${definition.name}` : 'New job'} size="lg" busy={busy} onOpenChange={open => { if (!open) void close(onClose) }} footer={<><Button disabled={locked} onClick={() => void close(onClose)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!save.variables && (!spec || !name.trim() || choices.isError)} onClick={() => { void submit().catch(cause => setError(jobError(cause))) }}>{save.variables ? 'Retry original save' : 'Save job definition'}</Button></>}>
    <p>Saving creates a new revision. Existing execution snapshots stay unchanged.</p>
    {Boolean(choices.error) && <Alert title="Choices unavailable" tone="danger">{jobError(choices.error)}</Alert>}
    {(error || save.error) && <Alert title={uncertain ? 'Save not confirmed' : 'Job not saved'} tone="danger">{error || jobError(save.error)}</Alert>}
    <TextField label="Job name" value={name} disabled={locked} onChange={event => { setName(event.target.value); changed() }} />
    <Select label="Computer and validated root" value={target} disabled={locked || choices.isError} options={[{ value: '', label: definition ? 'Keep saved computer and root binding' : 'Choose a computer' }, ...(choices.data?.targets ?? []).map(item => ({ value: item.id, label: `${item.label}${item.ready ? '' : ` — ${item.reasons.join(' · ')}`}`, disabled: !item.ready }))]} onChange={event => { setTarget(event.target.value); setTargetPin(choices.data?.targets.find(item => item.id === event.target.value)?.target ?? definition?.spec.target); changed() }} hint="Only authorized resource choices are offered. Selection has no install, login or path fallback." />
    <Select label="Pinned source snapshot" value={source} disabled={locked || choices.isError} options={[{ value: '', label: definition ? 'Keep saved source snapshot' : 'Choose a source' }, ...(choices.data?.sources ?? []).map(item => ({ value: `${item.snapshotId}:${item.manifestDigest}`, label: `${item.commit} · ${item.snapshotId}` }))]} onChange={event => { setSource(event.target.value); setSourcePin(choices.data?.sources.find(item => `${item.snapshotId}:${item.manifestDigest}` === event.target.value) ?? definition?.spec.source); changed() }} />
    <Select label="Qualified isolation and toolchain policy" value={policy} disabled={locked || choices.isError} options={[{ value: '', label: definition ? 'Keep saved policy' : 'Choose a policy' }, ...(choices.data?.policies ?? []).map(item => ({ value: `${item.isolationPolicyId}:${item.isolationPolicyRevision}:${item.toolchainDigest}`, label: `${item.isolationPolicyId} rev ${item.isolationPolicyRevision} · ${item.executionTimeoutMs} ms · ${item.network}` }))]} onChange={event => { setPolicy(event.target.value); setPolicyPin(choices.data?.policies.find(item => `${item.isolationPolicyId}:${item.isolationPolicyRevision}:${item.toolchainDigest}` === event.target.value) ?? definition?.spec.policy); changed() }} />
    {!choices.isPending && !choices.error && !choices.data?.targets.length && <Alert title="No qualified computer" tone="warning">Register and qualify a computer and root in Computers before authoring a job.</Alert>}
    <Textarea label="Exact executable and arguments (JSON array)" value={argv} disabled={locked} error={argvProblem} onChange={event => { setArgv(event.target.value); changed() }} hint={'Example: ["corepack","pnpm","build"]. Arguments are passed directly; there is no shell interpolation.'} />
    <TextField label="Relative working directory" value={cwd} disabled={locked} onChange={event => { setCwd(event.target.value); changed() }} hint="Leave empty for the materialized repository root. Absolute paths and traversal are rejected." />
    <details open={inputs !== '[]' || outputs !== '[]'}><summary>File inputs and outputs (optional)</summary>
      <Textarea label="Pinned file inputs (JSON array)" value={inputs} disabled={locked} error={inputsProblem} onChange={event => { setInputs(event.target.value); changed() }} hint="Each input requires a relative path, fileId, revisionId, sha256 and byteSize. No secrets." />
      <Textarea label="Output policy (JSON array)" value={outputs} disabled={locked} error={outputsProblem} onChange={event => { setOutputs(event.target.value); changed() }} hint={'Each output: {"path":"apps/web/dist/index.html","required":true,"mediaType":"text/html"}'} />
    </details>
    {!save.variables && missing.length > 0 && <p role="status" className="job-needs">To save, add {missing.join(', ')}.</p>}
    {spec && <details><summary>Review exact saved specification</summary><pre className="job-log-window">{JSON.stringify(spec, null, 2)}</pre></details>}
  </Dialog>
}
