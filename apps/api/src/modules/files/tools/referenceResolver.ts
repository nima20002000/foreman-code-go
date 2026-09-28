import { FileRowSchema } from '@graphql/contracts/files'
import { DomainError } from '../../errors.js'
import type { FileRepository } from '../repository.js'
import type { AgentReferenceService } from '../references/agentService.js'
import type { FileReferenceResolver } from './types.js'

/** The file session selects a persisted conversation; tool arguments only assert the desired scope. */
export function agentFileReferenceResolver(references: AgentReferenceService,
  files: Pick<FileRepository, 'read'>): FileReferenceResolver {
  return {
    async list(caller, scope, page) {
      const manifest = await references.forConversation(caller.principal, caller.context.scope.chat.conversationId).list(page)
      const items = await Promise.all(manifest.items.filter((entry) => entry.scope.kind === scope.kind
        && entry.scope.workspaceId === scope.workspaceId
        && (scope.kind !== 'workflow_reference' || entry.scope.kind === 'workflow_reference'
          && entry.scope.workflowId === scope.workflowId)).map(async (entry) => {
        const stored = await files.read(entry.fileId, entry.revisionId)
        if (!stored || stored.value.file.currentRevisionId !== entry.revisionId) {
          throw new DomainError('FILE_REFERENCE_METADATA_UNAVAILABLE', 'Reference list metadata is unavailable.', 503)
        }
        return FileRowSchema.parse(stored.value)
      }))
      return { items, pageInfo: manifest.pageInfo }
    },
    read(caller, input) {
      return references.forConversation(caller.principal, caller.context.scope.chat.conversationId).read(input)
    },
  }
}
