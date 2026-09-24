import { type ReactNode } from 'react'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useQuery } from '@tanstack/react-query'
import { CompatibleWorkflowDefinitionSchema } from '@graphql/contracts'
import { GraphDraftV2Schema } from '@graphql/contracts/wave25'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { boardDraftContextKey } from '../workflow-board/keys'
import { useWorkflowBoard } from '../workflow-board/context'
import { NextDraftEditor } from './nextDraft/NextDraftEditor'
import { nextDraftApi } from './nextDraft/transport'
import { nextDraftKey } from './nextDraft/state'
import { useGraphDraftStore, workflowDraftKey } from './store'

/** Keep the strict identity boundary. Editable draft semantics need not match a saved Run. */
export function PersistedWorkflowBoundary({ workspaceId, workflowId, workflow, children }: {
  workspaceId: string; workflowId: string; workflow: unknown; children: ReactNode
}) {
  const parsed = CompatibleWorkflowDefinitionSchema.safeParse(workflow)
  if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.id !== workflowId) {
    return <section role="alert" className="workflow-graph-state workflow-graph-state-error">
      <h2>Authoring unavailable</h2><p>The saved workflow is unavailable or unsupported in this workspace. An authorized Run can still be inspected on this board.</p>
    </section>
  }
  return <AuthoringBoundary workspaceId={workspaceId} workflowId={workflowId} savedVersion={parsed.data.version}
    savedSemantics={'executionSemanticsVersion' in parsed.data ? 2 : 1}>{children}</AuthoringBoundary>
}

function AuthoringBoundary({ workspaceId, workflowId, savedSemantics, savedVersion, children }: {
  workspaceId: string; workflowId: string; savedSemantics: 1 | 2; savedVersion?: number; children: ReactNode
}) {
  const key = nextDraftKey(workspaceId, workflowId), board = useWorkflowBoard()
  const edit = useGraphDraftStore((state) => state.nextDrafts[key])
  const promotion = useGraphDraftStore((state) => state.nextDraftPromotions[key])
  const legacyEdit = useGraphDraftStore((state) => state.drafts[workflowDraftKey(workspaceId, workflowId)])
  const source = useQuery({ queryKey: [...boardDraftContextKey(workspaceId, workflowId), savedSemantics, savedVersion ?? null],
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }),
    staleTime: 3_000, refetchInterval: 3_000, refetchOnWindowFocus: true, retry: false,
  })
  const denied = useProtectedAccessError(source)
  const sourceIsTyped = !!source.data && GraphDraftV2Schema.safeParse(source.data.draft).success
  const legacyConflict = !!legacyEdit && (savedSemantics === 2 || sourceIsTyped)
  useUnsavedChanges({ label: 'unpublished legacy edits', dirty: legacyConflict, saveDisabled: true,
    save: () => { throw new Error('The shared draft changed semantics. Preserve these local edits before proceeding.') },
    discard: () => { throw new Error('These legacy edits cannot be discarded by the board migration.') } })
  if (denied) return <section role="alert">Draft access is unavailable. No local draft was replaced.</section>
  if (legacyConflict) return <section role="alert" className="workflow-graph-state">
    <h2>Local legacy edits are retained</h2><p>The shared workflow changed execution semantics. The migration will not reinterpret or discard your unpublished legacy edits.</p>
    <details><summary>Preserve the exact local draft before resolving this conflict</summary><pre>{JSON.stringify(legacyEdit, null, 2)}</pre></details>
  </section>
  // Never install/refetch a server graph over an occupied local editor.
  if (edit || promotion || board?.conversionRequested || sourceIsTyped) {
    const newer = edit && source.data && (source.data.draft.id !== edit.context.draft.id || source.data.draft.revision > edit.context.draft.revision)
    return <>
      {newer ? <p role="status">The shared draft changed elsewhere. Your local edits are retained. Review them before explicitly reloading the shared draft.</p> : null}
      <NextDraftEditor key={key} workspaceId={workspaceId} workflowId={workflowId} initialContext={source.data} />
    </>
  }
  if (source.isPending) return <section role="status">Loading workflow…</section>
  if (source.isError || !source.data) return <section role="alert">
    <p>Authoring could not be opened. Run inspection does not depend on draft access.</p>
    <button type="button" onClick={() => void source.refetch()}>Retry authoring</button>
  </section>
  if (savedSemantics === 2) return <section role="alert">The editable draft conflicts with the saved execution semantics. Reload explicitly; no legacy editor was mounted.</section>
  return <>{children}</>
}
