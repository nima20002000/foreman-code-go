import { useCallback, useContext, useEffect, useMemo, useReducer } from 'react'
import { skipToken, useMutationState, useQuery, type MutationState } from '@tanstack/react-query'
import { useStore } from 'zustand'
import {
  MAX_MESSAGE_ATTACHMENTS, MessageAttachmentRefsSchema, TemporaryFileScopeSchema, fileStateAt,
  type FileWithRevision, type MessageAttachmentRef, type TemporaryFileScope,
} from '@graphql/contracts/files'
import { AttachmentDraftContext } from './attachmentContext'
import { attachmentDraftKey } from './attachmentFiles'
import type { AttachmentProgressMap, AttachmentSelection, AttachmentSendSnapshot, UploadVariables } from './attachmentDrafts'

export interface AttachmentItem extends AttachmentSelection {
  status: 'uploading' | 'ready' | 'error'
  statusLabel: string
  error?: string
  canRetry: boolean
  progress: number | null
  ref?: MessageAttachmentRef
}
export interface ConversationAttachments {
  items: readonly AttachmentItem[]
  readyRefs: MessageAttachmentRef[]
  hasAttachments: boolean
  hasBlockingAttachments: boolean
  isUploading: boolean
  canAdd: boolean
  available: boolean
  pickerIssue?: string
  addFiles: (files: readonly File[]) => void
  remove: (id: string) => void
  retry: (id: string) => void
  prepareSend: () => AttachmentSendSnapshot | null
  acknowledgeSent: (snapshot: AttachmentSendSnapshot) => void
}
const EMPTY_PROGRESS: AttachmentProgressMap = Object.freeze({})
type UploadState = MutationState<FileWithRevision, Error, UploadVariables, unknown>

/** Scope must describe an existing authenticated conversation; null disables attachments. */
export function useConversationAttachments(scope: TemporaryFileScope | null): ConversationAttachments {
  const drafts = useContext(AttachmentDraftContext)
  if (!drafts) throw new Error('useConversationAttachments requires AttachmentDraftProvider.')
  const parsedScope = useMemo(() => scope === null ? null : TemporaryFileScopeSchema.parse(scope), [scope])
  const key = parsedScope === null ? null : attachmentDraftKey(parsedScope)
  const draft = useStore(drafts.store, (state) => key === null ? undefined : state.drafts[key])
  const available = useStore(drafts.store, (state) => state.available) && key !== null
  const uploads = useMutationState<UploadState>({
    filters: { mutationKey: drafts.uploadKey, exact: true },
    // The provider-private key is written only by the typed upload mutation factory.
    select: (mutation) => mutation.state as UploadState,
  })
  const { data: progress } = useQuery<AttachmentProgressMap>({
    queryKey: drafts.progressKey(key ?? 'unselected'), queryFn: skipToken,
    initialData: EMPTY_PROGRESS, gcTime: draft?.selections.length ? Infinity : 0, staleTime: Infinity,
  })
  const now = Date.now()
  const [clockTick, refreshClock] = useReducer((tick: number) => tick + 1, 0)
  const states = new Map(uploads.filter((upload) => upload.variables?.draftKey === key)
    .map((upload) => [upload.variables?.selectionId, upload]))
  // Keep an idle ready chip honest when its retention deadline passes.
  const nextExpiry = Math.min(...(draft?.selections ?? []).flatMap((selection) => {
    const file = states.get(selection.id)?.data?.file
    return file && 'expiresAt' in file && Date.parse(file.expiresAt) > now ? [Date.parse(file.expiresAt)] : []
  }))
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return
    const timer = setTimeout(refreshClock, Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now())))
    return () => clearTimeout(timer)
  }, [nextExpiry, clockTick])

  const items: AttachmentItem[] = (draft?.selections ?? []).map((selection) => {
    const state = states.get(selection.id)
    const base = { ...selection, progress: null, canRetry: false }
    if (selection.issue) return { ...base, status: 'error', statusLabel: selection.issue.label, error: selection.issue.message }
    if (state?.status === 'error') return {
      ...base, status: 'error', statusLabel: 'Upload failed', canRetry: available,
      error: state.error instanceof Error ? state.error.message : 'The attachment could not be uploaded.',
    }
    if (state?.status === 'success' && state.data) {
      if (fileStateAt(state.data.file, new Date(now).toISOString()) !== 'ready') {
        return { ...base, status: 'error', statusLabel: 'Expired', error: 'Remove this file and select it again.' }
      }
      return { ...base, status: 'ready', statusLabel: 'Ready', ref: {
        fileId: state.data.revision.fileId, revisionId: state.data.revision.revisionId,
      } }
    }
    const telemetry = progress[selection.id]
    const percent = telemetry?.percent ?? null
    return {
      ...base, status: 'uploading', progress: percent,
      statusLabel: telemetry?.phase === 'finalizing' || percent === 100 ? 'Checking' : percent === null ? 'Uploading' : `${percent}%`,
    }
  })
  const refs = MessageAttachmentRefsSchema.safeParse(items.flatMap((item) => item.ref ? [item.ref] : []))
  const hasBlockingAttachments = !refs.success || items.some((item) => item.status !== 'ready')
  const addFiles = useCallback((files: readonly File[]) => {
    if (parsedScope && drafts.store.getState().available) drafts.add(parsedScope, files)
  }, [drafts, parsedScope])
  const remove = useCallback((selectionId: string) => { if (key !== null) drafts.remove(key, selectionId) }, [drafts, key])
  const retry = useCallback((selectionId: string) => {
    if (key !== null && drafts.store.getState().available) drafts.retry(key, selectionId)
  }, [drafts, key])
  const prepareSend = useCallback(() => key === null || !drafts.store.getState().available ? null : drafts.prepareSend(key), [drafts, key])
  return {
    items, readyRefs: refs.success ? refs.data : [], hasAttachments: items.length > 0,
    hasBlockingAttachments, isUploading: items.some((item) => item.status === 'uploading'),
    available, canAdd: available && items.length < MAX_MESSAGE_ATTACHMENTS,
    pickerIssue: draft?.pickerIssue ?? (!refs.success ? 'Duplicate file' : undefined),
    addFiles, remove, retry, prepareSend, acknowledgeSent: drafts.acknowledgeSent,
  }
}
