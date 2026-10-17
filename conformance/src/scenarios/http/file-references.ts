import { randomUUID } from 'node:crypto'
import {
  FileRetentionSaveInputSchema,
  FileWithRevisionSchema,
  PermanentFileScopeSchema,
  type FileWithRevision,
  type PermanentFileScope,
} from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { readCodecFixture, type CodecFixture } from '../codecs/fixtures.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { allocateFile, assertFileDownload, fileContentPath, fileListBody, finalizeFile } from './file-support.js'
import { cancelStagedFile } from './file-cancellation.js'
import { assertUploadRejections } from './file-upload-errors.js'
import { assertProtectedRead, readCoverage } from './support.js'
import { createEmptyWorkflow } from './workflow-support.js'

type ReferenceKind = PermanentFileScope['kind']

function referencePath(scope: PermanentFileScope): string {
  const workspace = `/api/workspaces/${scope.workspaceId}`
  if (scope.kind === 'workspace_reference') return `${workspace}/reference-files`
  return `${workspace}/workflows/${scope.workflowId}/reference-files`
}

async function referenceScope(ctx: ScenarioContext, kind: ReferenceKind, name: string): Promise<PermanentFileScope> {
  const { created } = await createWorkspace(ctx, name)
  const workspaceId = created.workspace.id
  if (kind === 'workspace_reference') return PermanentFileScopeSchema.parse({ kind, workspaceId })
  const workflow = await createEmptyWorkflow(ctx, workspaceId, `${name} workflow`)
  return PermanentFileScopeSchema.parse({ kind, workspaceId, workflowId: workflow.created.workflow.id })
}

async function cancelStagedReference(ctx: ScenarioContext, path: string, scope: PermanentFileScope, fixture: CodecFixture) {
  const { input, pending } = await allocateFile(ctx, path, fixture, scope)
  const uploadPath = `${path}/uploads/${input.requestId}`
  assertResponse(await ctx.http.upload(uploadPath, fixture.bytes), {
    status: 200, body: { value: pending, replayed: false },
  })
  return cancelStagedFile(ctx, path, input.requestId, pending, fixture)
}

async function removeReadyReference(ctx: ScenarioContext, path: string, ready: FileWithRevision) {
  const removePath = `${path}/${ready.file.fileId}/revisions/${ready.revision.revisionId}`
  const input = FileRetentionSaveInputSchema.pick({ commandId: true }).parse({ commandId: randomUUID() })
  assertApiError(await ctx.http.request('DELETE', `${path}/${ready.file.fileId}/revisions/${randomUUID()}`, {
    body: { commandId: randomUUID() },
  }),
    404, 'FILE_NOT_FOUND', 'The pinned reference was not found in this scope.')
  const removed = FileWithRevisionSchema.parse({ ...ready, file: { ...ready.file, state: 'removed' } })
  assertResponse(await ctx.http.request('DELETE', removePath, { body: input }), {
    status: 200, body: { value: removed, replayed: false },
  })
  assertResponse(await ctx.http.request('DELETE', removePath, { body: input }), {
    status: 200, body: { value: removed, replayed: true },
  })
  assertApiError(await ctx.http.request('GET', fileContentPath(path, removed)),
    410, 'FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.')
  assertResponse(await ctx.http.request('HEAD', fileContentPath(path, removed)), { status: 410, body: null })
  return removed
}

function referenceScenario(kind: ReferenceKind): Scenario {
  const isWorkspace = kind === 'workspace_reference'
  const domain = isWorkspace ? 'workspace' : 'workflow'
  const root = isWorkspace ? '/api/workspaces/:workspaceId/reference-files'
    : '/api/workspaces/:workspaceId/workflows/:workflowId/reference-files'
  const uploads = `${root}/uploads`
  const upload = `${uploads}/:requestId`
  const reference = `${root}/:fileId/revisions/:revisionId`
  return {
    id: `http.files.${domain}-references`,
    title: `${isWorkspace ? 'Workspace' : 'Workflow'} reference files preserve bytes, scope, cancellation, and removal tombstones`,
    lane: 'A2',
    covers: [
      ...readCoverage(root),
      ...readCoverage(`${reference}/content`),
      ...(['success', 'error'] as const).flatMap(outcome => [
        httpCoverage('POST', uploads, outcome),
        httpCoverage('PUT', upload, outcome),
        httpCoverage('POST', `${upload}/finalize`, outcome),
        httpCoverage('DELETE', upload, outcome),
        httpCoverage('DELETE', reference, outcome),
      ]),
    ],
    async run(ctx) {
      const scope = await referenceScope(ctx, kind, `Conformance ${domain} reference`)
      const path = referencePath(scope)
      await assertProtectedRead(ctx, path, { items: [], pageInfo: { nextCursor: null } })
      const fixture = await readCodecFixture('sample.png')
      const { input, pending } = await allocateFile(ctx, path, fixture, scope)
      assertApiError(await ctx.http.request('POST', `${path}/uploads`, {
        body: { ...input, filename: 'renamed.png' },
      }), 409, 'FILE_REQUEST_CONFLICT', 'requestId was already used for different file metadata or a different scope.')
      await assertUploadRejections(ctx, path, input.requestId, pending, fixture)
      await assertProtectedRead(ctx, path, { items: [pending], pageInfo: { nextCursor: null } })
      const uploadPath = `${path}/uploads/${input.requestId}`
      assertResponse(await ctx.http.upload(uploadPath, fixture.bytes), {
        status: 200, body: { value: pending, replayed: false },
      })
      assertResponse(await ctx.http.upload(uploadPath, fixture.bytes), {
        status: 200, body: { value: pending, replayed: true },
      })
      const ready = await finalizeFile(ctx, path, input.requestId, pending)
      await assertProtectedRead(ctx, path, { items: [ready], pageInfo: { nextCursor: null } })
      await assertFileDownload(ctx, fileContentPath(path, ready), fixture)
      assertApiError(await ctx.http.request('DELETE', uploadPath),
        409, 'FILE_ALREADY_FINALIZED', 'Only unsent staging can be canceled; finalized files cannot be deleted through this route.')
      const unrelatedScope = await referenceScope(ctx, kind, `Conformance unrelated ${domain}`)
      assertApiError(await ctx.http.request('GET', fileContentPath(referencePath(unrelatedScope), ready)),
        404, 'FILE_NOT_FOUND', 'The pinned file revision was not found in this scope.')
      await ctx.target.restart()
      await assertProtectedRead(ctx, path, { items: [ready], pageInfo: { nextCursor: null } })
      await assertFileDownload(ctx, fileContentPath(path, ready), fixture)

      const canceled = await cancelStagedReference(ctx, path, scope, fixture)
      const removed = await removeReadyReference(ctx, path, ready)
      const tombstones = fileListBody([removed, canceled])
      await assertProtectedRead(ctx, path, tombstones)
      await ctx.target.restart()
      await assertProtectedRead(ctx, path, tombstones)
      assertApiError(await ctx.http.request('GET', fileContentPath(path, removed)),
        410, 'FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.')
    },
  }
}

export const fileReferenceScenarios = [referenceScenario('workspace_reference'), referenceScenario('workflow_reference')]
