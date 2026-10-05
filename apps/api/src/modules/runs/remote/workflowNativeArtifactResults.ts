import { isDeepStrictEqual } from 'node:util'
import type { ExecutionResult } from '@foreman-code/contracts'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import { RemoteWorkflowPhysicalOutputSchema, type RemoteWorkflowPhysicalOutput } from '@foreman-code/contracts/remote-workflow-physical'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema,
  type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { WorkflowArtifactResultEnvelopeV1Schema, WorkflowChoiceArtifactResultEnvelopeV1Schema,
  workflowArtifactDigestsByOutputKey } from '@foreman-code/contracts/workflow-artifact-result'
import { z } from 'zod'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { DomainError } from '../../errors.js'
import { fileScopeIdentity } from '../../files/requests.js'

/** Successful replies from the authenticated Main relay, retained for this execution only. */
export class WorkflowNativeArtifactResults {
  private readonly publications = new Map<string, { transferId: string; input: AgentFilePublishInput;
    result: AgentFilePublishResult }>()

  constructor(private readonly placement: AcceptedNodePlacement, private readonly intent: DispatchIntent) {}

  observe(input: { transferId: string; publication: AgentFilePublishInput }, raw: AgentFilePublishResult): void {
    const publication = AgentFilePublishInputSchema.parse(input.publication)
    const result = AgentFilePublishResultSchema.parse(raw)
    const chat = publication.scope.chat
    if (chat.kind !== 'agent' || chat.runId !== this.intent.runId || chat.executionId !== this.intent.executionId
      || this.placement.payload.kind !== 'agent' || chat.agentId !== this.placement.payload.agentId
      || fileScopeIdentity(result.value.file.scope) !== fileScopeIdentity(publication.scope)
      || result.value.file.state !== 'ready' || result.value.revision.filename !== publication.filename
      || result.value.revision.mediaType !== publication.mediaType || result.value.revision.origin !== 'agent_output')
      this.unavailable()
    const previous = this.publications.get(publication.commandId)
    const record = { transferId: input.transferId, input: publication, result: { ...result, replayed: false } }
    if (previous && !isDeepStrictEqual(previous, record)) this.unavailable()
    if (!previous && this.publications.size >= BYTE_TRANSFER_POLICY.maxRecords) this.unavailable()
    this.publications.set(publication.commandId, structuredClone(record))
  }

  read(result: ExecutionResult): { output: RemoteWorkflowPhysicalOutput; artifactDigests: string[] } {
    const payload = this.placement.payload
    if (result.outcome !== 'succeeded' || payload.kind !== 'agent' || !payload.artifactOutputs) {
      return { output: { kind: 'text-only', result }, artifactDigests: [] }
    }
    const text = z.object({ text: z.string().max(64 * 1024) }).strict().parse(result.output).text
    const envelope = z.union([WorkflowArtifactResultEnvelopeV1Schema, WorkflowChoiceArtifactResultEnvelopeV1Schema])
      .parse(JSON.parse(text))
    const output = RemoteWorkflowPhysicalOutputSchema.parse({ kind: 'published-artifacts', result,
      artifactOutputs: envelope.artifactOutputs })
    const keys = envelope.artifactOutputs.outputs.map(mapping => mapping.outputKey)
    if (keys.length !== payload.artifactOutputs.outputKeys.length
      || payload.artifactOutputs.outputKeys.some(key => !keys.includes(key))) this.unavailable()
    const digests = envelope.artifactOutputs.outputs.map(mapping => {
      const published = this.publications.get(mapping.commandId)
      if (!published) return this.unavailable()
      return { outputKey: mapping.outputKey, sha256: published.result.value.revision.sha256 }
    })
    return { output,
      artifactDigests: workflowArtifactDigestsByOutputKey(digests) }
  }

  private unavailable(): never {
    throw new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_PENDING',
      'The original native output requires its successful Main publication reply.', 409)
  }
}
