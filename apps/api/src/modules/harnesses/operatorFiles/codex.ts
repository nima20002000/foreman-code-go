import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { OperatorConfigurationVersion } from '@graphql/contracts'
import { MAX_FILE_READ_BYTES, type MessageAttachmentRef } from '@graphql/contracts/files'
import { DomainError } from '../../errors.js'
import { productionFileTools } from '../../files/tools/production.js'
import type { FileToolContext } from '../../files/tools/types.js'
import { pathsOverlap } from '../../workspaces/filesystem.js'
import { codexChatFileTools } from '../codexFiles/declarations.js'
import { localCodexChatHost } from '../codexFiles/localHost.js'
import type { ProductionCodexChatFiles } from '../codexFiles/production.js'
import { acceptedOperatorFileInputs, adoptOperatorFilePublications } from './postgres.js'

/** Uses the same byte/auth service as the native OpenCode bridge. The pre-ACK
 * reader is server-only: it does not issue or expose a file-session credential. */
export function operatorCodexFileAdmissions(app: () => FastifyInstance, pool: pg.Pool,
  configuration: OperatorConfigurationVersion, workingDirectory: string, runtimeRoot: string): ProductionCodexChatFiles {
  return { async resolve(input) {
    input.signal.throwIfAborted()
    const harness = configuration.harness
    if (harness.harness !== 'codex' || input.session.harness !== 'codex' || harness.sandbox === 'danger-full-access') throw new DomainError(
      'CODEX_FILE_HOST_UNAVAILABLE', 'This Operator configuration cannot safely receive local file inputs.', 409)
    const accepted = await acceptedOperatorFileInputs(pool, input.conversationId, input.clientCorrelationId,
      configuration, input.session.nativeSessionId, input.session.providerVersion)
    const allowMutation = harness.sandbox === 'workspace-write'
    if (allowMutation) await accepted.authorization.resolve(accepted.owner,
      { kind: 'operator', conversationId: input.conversationId }, 'write')
    const allowedTools = codexChatFileTools(harness)
    // The local lease lives in this sibling of the Operator cwd, not in the cwd
    // itself. Checking runtimeRoot would incorrectly reject every Operator turn.
    const hostDirectory = join(runtimeRoot, 'codex-chat-files')
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
    const canonicalHost = await realpath(hostDirectory)
    const roots = await Promise.all([workingDirectory,
      ...(harness.advanced?.additionalWritableDirectories ?? [])].map((path) => realpath(path)))
    if (canonicalHost !== resolve(hostDirectory) || roots.some((root) => pathsOverlap(root, canonicalHost))
      || allowMutation && ['/tmp', '/var/tmp'].some((root) => pathsOverlap(root, canonicalHost))) throw new DomainError(
      'CODEX_FILE_HOST_UNAVAILABLE', 'The file host overlaps a Codex writable root.', 409)
    const service = productionFileTools(app())
    const context: FileToolContext = { ownerPrincipalId: accepted.row.owner_principal_id, scope: accepted.scope,
      nativeSessionId: input.session.nativeSessionId, turnId: input.clientCorrelationId,
      messageId: accepted.row.message_id, allowMutation, allowedTools }
    const pins = new Set(accepted.attachments.map((ref) => `${ref.fileId}/${ref.revisionId}`))
    const read = async (ref: MessageAttachmentRef, offset: number, length: number) => {
      input.signal.throwIfAborted()
      if (!pins.has(`${ref.fileId}/${ref.revisionId}`)) throw new DomainError(
        'CODEX_FILE_ADMISSION_MISMATCH', 'The file is not pinned to the accepted Operator message.', 409)
      const result = await service.readAccepted(context, { ...ref, offset, length })
      input.signal.throwIfAborted()
      if (result.status !== 'ready') throw new DomainError('CODEX_FILE_UNAVAILABLE', 'The pinned Operator attachment is unavailable.', 410)
      return result
    }
    input.signal.throwIfAborted()
    const host = await localCodexChatHost(runtimeRoot)
    return {
      clientCorrelationId: input.clientCorrelationId,
      accepted: { ownerPrincipalId: context.ownerPrincipalId, scope: context.scope,
        nativeSessionId: context.nativeSessionId, messageId: accepted.row.message_id, admissionId: accepted.requestId,
        executionHostId: host.executionHostId, projectMode: allowMutation ? 'write' : 'read', allowMutation, allowedTools,
        expiresAt: new Date(Math.min(Date.parse(accepted.owner.expiresAt), Date.now() + 60 * 60_000)),
        attachments: accepted.attachments },
      // PNG is the conservative localImage wire representation. The existing
      // helper bounds bytes/dimensions and reports animated first-frame previews;
      // native model/version qualification remains with the session manager.
      dependencies: { host, nativeImageOptions: { acceptedMediaTypes: ['image/png'] }, source: {
        async open(ref) {
          const first = await read(ref, 0, MAX_FILE_READ_BYTES)
          return { value: { file: first.file, revision: first.revision }, stream: Readable.from((async function* () {
            let part = first
            for (;;) {
              yield Buffer.from(part.contentBase64, 'base64')
              if (part.eof) return
              part = await read(ref, part.offset + part.byteLength, MAX_FILE_READ_BYTES)
            }
          })()) }
        },
        async recheck(ref) {
          const current = await read(ref, 0, 1)
          return { file: current.file, revision: current.revision }
        },
      } },
      adoptPublished: (nativeTurnId, refs) => adoptOperatorFilePublications(pool,
        { ...context, turnId: nativeTurnId }, refs),
    }
  } }
}
