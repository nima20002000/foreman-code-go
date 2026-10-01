import { JobWorkflowExecutionReferenceSchema, type JobWorkflowAdmissionReference } from '@graphql/contracts/job-workflow'
import { z } from 'zod'
import { JobDefinitionSchema, JobDefinitionSaveSchema, JobDefinitionSpecSchema, JobExecutionSchema, JobStartSchema, JobLogPageSchema, JobArtifactSchema, JobValidationSchema, JobAuthoringChoicesSchema, type JobDefinitionSave, type JobDefinitionSpec, type JobStart } from '@graphql/contracts/jobs'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'

const root = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}/jobs`
const executionPath = (workspaceId: string, id: string) => `${root(workspaceId)}/executions/${encodeURIComponent(id)}`
function mismatch(): never { throw new ApiError({ code: 'JOB_SELECTION_MISMATCH', message: 'The response belongs to another job or workspace.' }, 409) }
export const jobsClient = {
  async workflowExecution(input: JobWorkflowAdmissionReference, options?: RequestOptions) {
    const { reference } = await apiClient.request(`${root(input.workspaceId)}/workflow-executions/${encodeURIComponent(input.runId)}/${encodeURIComponent(input.nodeExecutionId)}`, z.object({ reference: JobWorkflowExecutionReferenceSchema }), options)
    for (const key of ['workspaceId', 'workflowId', 'runId', 'workflowVersionId', 'nodeId', 'nodeExecutionId', 'occurrenceId', 'occurrenceIndex'] as const) if (reference[key] !== input[key]) mismatch()
    return reference
  },
  choices(workspaceId: string, options?: RequestOptions) { return apiClient.request(`${root(workspaceId)}/choices`, JobAuthoringChoicesSchema, options) },
  async definitions(workspaceId: string, options?: RequestOptions) {
    const { definitions } = await apiClient.request(`${root(workspaceId)}/definitions`, z.object({ definitions: z.array(JobDefinitionSchema) }), options)
    if (definitions.some(item => item.workspaceId !== workspaceId)) mismatch()
    return definitions
  },
  async definition(workspaceId: string, id: string, options?: RequestOptions) {
    const { definition } = await apiClient.request(`${root(workspaceId)}/definitions/${encodeURIComponent(id)}`, z.object({ definition: JobDefinitionSchema }), options)
    if (definition.workspaceId !== workspaceId || definition.id !== id) mismatch()
    return definition
  },
  async definitionVersion(workspaceId:string,id:string,versionId:string,options?:RequestOptions) {
    const {definition}=await apiClient.request(`${root(workspaceId)}/definitions/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,z.object({definition:JobDefinitionSchema}),options)
    if(definition.workspaceId!==workspaceId||definition.id!==id||definition.versionId!==versionId)mismatch()
    return definition
  },
  async save(workspaceId: string, input: JobDefinitionSave) {
    const { definition } = await apiClient.request(`${root(workspaceId)}/definitions`, z.object({ definition: JobDefinitionSchema }), { method: 'POST', body: JobDefinitionSaveSchema.parse(input) })
    if (definition.workspaceId !== workspaceId || (input.id && definition.id !== input.id)) mismatch()
    return definition
  },
  validate(workspaceId: string, spec: JobDefinitionSpec) {
    return apiClient.request(`${root(workspaceId)}/validate`, JobValidationSchema, { method: 'POST', body: { spec: JobDefinitionSpecSchema.parse(spec) } })
  },
  async start(workspaceId: string, input: JobStart) {
    const { execution } = await apiClient.request(`${root(workspaceId)}/executions`, z.object({ execution: JobExecutionSchema }), { method: 'POST', body: JobStartSchema.parse(input), signal: AbortSignal.timeout(30000) })
    if (execution.workspaceId !== workspaceId || execution.acceptedSpec.definitionId !== input.definitionId || execution.acceptedSpec.definitionRevision !== input.expectedRevision) mismatch()
    return execution
  },
  async executions(workspaceId: string, options?: RequestOptions) {
    const { executions } = await apiClient.request(`${root(workspaceId)}/executions`, z.object({ executions: z.array(JobExecutionSchema) }), options)
    if (executions.some(item => item.workspaceId !== workspaceId)) mismatch()
    return executions
  },
  async execution(workspaceId: string, id: string, options?: RequestOptions) {
    const { execution } = await apiClient.request(executionPath(workspaceId, id), z.object({ execution: JobExecutionSchema }), options)
    if (execution.workspaceId !== workspaceId || execution.id !== id) mismatch()
    return execution
  },
  async cancel(workspaceId: string, id: string, commandId: string) {
    const { execution } = await apiClient.request(`${executionPath(workspaceId, id)}/cancel`, z.object({ execution: JobExecutionSchema }), { method: 'POST', body: { commandId } })
    if (execution.workspaceId !== workspaceId || execution.id !== id) mismatch()
    return execution
  },
  async logs(workspaceId: string, id: string, attemptId: string, afterSequence: number, options?: RequestOptions) {
    const page = await apiClient.request(`${executionPath(workspaceId, id)}/logs?afterSequence=${afterSequence}&limit=50`, JobLogPageSchema, options)
    if (page.chunks.length > 50 || page.chunks.some(chunk => chunk.executionId !== id || chunk.attemptId !== attemptId) || page.nextCursor < afterSequence) mismatch()
    return page
  },
  async artifacts(workspaceId: string, id: string, options?: RequestOptions) {
    const { artifacts } = await apiClient.request(`${executionPath(workspaceId, id)}/artifacts`, z.object({ artifacts: z.array(JobArtifactSchema) }), options)
    if (artifacts.some(item => item.executionId !== id)) mismatch()
    return artifacts
  },
}

/** Save only digest-verified immutable bytes; artifact HTML is never opened in the app origin. */
export async function downloadJobArtifact(workspaceId: string, artifact: import('@graphql/contracts/jobs').JobArtifact, signal?: AbortSignal) {
  const { JobArtifactSchema } = await import('@graphql/contracts/jobs')
  const pin = JobArtifactSchema.parse(artifact)
  if (pin.state !== 'available' || pin.byteSize > 64 * 1024 * 1024) throw new ApiError({ code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact expired, unavailable or above the 64 MiB browser download limit.' })
  const { assertSession, sessionGeneration, sessionSignal, sessionIsSwitching, SessionChangedError } = await import('../../shared/api/sessionBoundary')
  if (sessionIsSwitching()) throw new SessionChangedError()
  const generation = sessionGeneration()
  const requestSignal = AbortSignal.any([sessionSignal(), AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
  const path = `${executionPath(workspaceId, pin.executionId)}/artifacts/${encodeURIComponent(pin.fileId)}/revisions/${encodeURIComponent(pin.revisionId)}/content`
  const response = await fetch(new URL(path, location.origin), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: requestSignal })
  assertSession(generation)
  requestSignal.throwIfAborted()
  if (!response.ok) throw new ApiError({ code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact bytes unavailable or permission lost.' }, response.status)
  const { readExactBytes, sha256Hex } = await import('../project-files/projectFilesBytes')
  const bytes = await readExactBytes(response, pin.byteSize, requestSignal)
  assertSession(generation)
  if (bytes.byteLength !== pin.byteSize || await sha256Hex(bytes) !== pin.sha256) throw new ApiError({ code: 'ARTIFACT_CORRUPT', message: 'Artifact bytes do not match the accepted revision digest or size.' })
  assertSession(generation)
  return new Blob([bytes], { type: 'application/octet-stream' })
}
