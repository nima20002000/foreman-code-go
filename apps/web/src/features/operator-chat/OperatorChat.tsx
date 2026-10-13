import { errorMessage } from '../../shared/errorMessage'
import { selectLiveTextTimeline } from '../conversations/chatTimeline'
import { OperatorHistoryActions } from './OperatorHistoryActions'
import { ActivityChangeEnvelopeV1Schema, OperatorActivitySchema } from '@foreman-code/contracts'
import { CompactionActivity } from '../conversations/sessionControls/CompactionActivity'
import { useSessionControls } from '../conversations/sessionControls/useSessionControls'
import type { SessionMode } from '@foreman-code/contracts'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OperatorChatSetup, OperatorConversationState, OperatorConversationSummary, SendOperatorMessageRequest, RespondOperatorInteractionRequest } from '@foreman-code/contracts'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'

import { newerOperatorConversationState as newer } from './operatorConversationReadback'
import { useConversationDraftStore } from '../conversations'
import { ChatAttachmentControl, useConversationAttachments } from '../attachments'
import { useFileDrop } from '../../shared/ui/useFileDrop'
import { ChatAttachmentBoundary } from '../conversations/ChatAttachmentBoundary'
import { containsAttachmentRefs, messageAttachmentRefs, prepareChatAttachments } from '../conversations/chatAttachmentAttempt'
import { settingsExperienceKeys } from '../../shared/api/settingsExperience'
import { apiClient, cancelOperatorTurn, createOperatorConversation, getOperatorConversation,
  sendOperatorMessage, respondOperatorInteraction } from '../../shared/api/client'
import { ApiError } from '../../shared/api/client'
import { deleteOperatorConversation, restoreOperatorConversation, listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import { createStreamReadback } from '../../shared/api/streamReadback'
import { subscribeOperatorChat, type OperatorChatConnection } from '../../shared/api/operatorChatStream'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { chatStoragePrefix, identityEpoch } from '../../shared/api/protectedChatStorage'
import { Alert, Badge, Button, EmptyState, Icon, IconButton, LoadingState } from '../../shared/ui/nocturne'
import { isNarrowOperatorChat, operatorChatNarrowQuery, useOperatorChatStore } from './operatorChatStore'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { useOperatorSettings } from './useOperatorSettings'
import { operatorChatSetupKey, useOperatorChatSetup } from '../../shared/api/operatorChatSetup'
import { pendingOperatorSetupTarget } from '../../shared/api/operatorSetupTarget'
import { OperatorSetupNotice } from './OperatorSetupNotice'
import { isMissingOperatorConversation, useMissingOperatorConversation } from './useMissingOperatorConversation'
import { SettingsFormFeedback } from '../settings/SettingsFormActions'
import { acknowledgeOperatorMessage, assertOperatorMessageReserved, beginOperatorMessageAttempt, discardDefinitivelyRejectedOperatorMessage,
  readPendingOperatorMessage, recordOperatorMessageFailure, reserveOperatorMessage } from './operatorOutbox'
import { projectOperatorActivity, projectOperatorEnvelope, type OperatorTextProjection } from './operatorTextProjection'
import { newerOperatorSummaries, operatorNavigationStatus, operatorTurnStatus, summarizeOperatorConversation } from './operatorChatStatus'
import { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import { ChatDecisionReceipts } from '../conversations/ChatDecisionReceipts'
import { OperatorTranscript } from './OperatorTranscript'
import { OperatorApprovalCard } from './OperatorApprovalCard'
import { OperatorComposerSettings } from './OperatorComposerSettings'
import { PinnedProviderAccount } from '../provider-accounts/PinnedProviderAccount'
import { useProviderAccounts } from '../provider-accounts/providerAccountsQueries'
import { OperatorAccessPicker } from './OperatorAccessPicker'
import { OperatorComposer } from './OperatorComposer'
import { operatorResizeEdges, useOperatorChatResize } from './useOperatorChatResize'
import './operatorChat.css'

const listKey = ['operator-chat', 'summaries'] as const
const detailKey = (id: string) => ['operator-chat', 'conversation', id] as const
type Summaries = Awaited<ReturnType<typeof listOperatorConversationSummaries>>
type AppRequest = NonNullable<ReturnType<typeof useOperatorChatStore.getState>['request']>
function currentSession(generation: number): boolean {
  return !sessionIsSwitching() && sessionGeneration() === generation
}

export function OperatorChat(props: { settingsWarning?: string } = {}) {
  return <ChatAttachmentBoundary><OperatorChatContent {...props} /></ChatAttachmentBoundary>
}

function OperatorChatContent({ settingsWarning }: { settingsWarning?: string }) {
  const enabled = useOperatorChatVisibility()
  const browserAccess = useQuery({ queryKey: settingsExperienceKeys.access(), enabled: false,
    queryFn: ({ signal }) => apiClient.request('/api/local-human', LocalHumanAccessSchema, { signal }),
  })
  const attachmentReceipts = useOperatorAttachmentReceipts()
  const { panelRef, size, grip, moveGrip } = useOperatorChatResize()
  const historyLimit = useRef(10)
  const creating = useRef(false)
  const deletedRevisions = useRef(new Map<string, number>())
  const [removed, setRemoved] = useState<{ id: string; title: string }>()
  const [handoffNotice, setHandoffNotice] = useState<{ id: string; epoch: string }>()
  const [closing, setClosing] = useState(false)
  const [askSend, setAskSend] = useState<{
    id: string; requestId: string; content: string; generation: number; navigationGeneration: number; ready: boolean
  }>()
  const queryClient = useQueryClient()
  const open = useOperatorChatStore((state) => state.open)
  const historyOpen = useOperatorChatStore((state) => state.historyOpen)
  const selectedId = useOperatorChatStore((state) => state.selectedConversationId)
  const accounts = useProviderAccounts(enabled && open)
  const sessionControls = useSessionControls(selectedId ?? undefined, { enabled: enabled && open })
  const preferences = useOperatorSettings(enabled && open)
  const preferencesDenied = useAccessFailureLatch(preferences.query)
  const setOpen = useOperatorChatStore((state) => state.setOpen)
  const setHistoryOpen = useOperatorChatStore((state) => state.setHistoryOpen)
  const select = useOperatorChatStore((state) => state.select)
  const clearDraft = useConversationDraftStore((state) => state.clearDraft)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<HTMLElement>(null)
  const panelId = useId()
  const historyId = useId()
  // Presentation-only fragments. Query/PostgreSQL still own all finalized state.
  const readGeneration = useRef(0)
  const [partial, setPartial] = useState<{ conversationId: string; value?: OperatorTextProjection }>()
  const [preparationError, setPreparationError] = useState<{ id: string; message: string }>()
  const [connection, setConnection] = useState<{ id: string; state: OperatorChatConnection }>()
  const [, refreshOutbox] = useState(0)
  const reservations = useRef(new Set<string>())
  const [preparingId, setPreparingId] = useState<string>()
  const list = useQuery({ queryKey: listKey, enabled, refetchInterval: 5_000,
    queryFn: async ({ signal }) => {
      const next = await listOperatorConversationSummaries({ signal }, historyLimit.current)
      const current = queryClient.getQueryData<Summaries>(listKey)
      const visible = next.conversations.flatMap(item => {
        const deletedRevision = deletedRevisions.current.get(item.conversationId)
        if (deletedRevision === undefined || item.revision > deletedRevision) return [item]
        const restored = current?.conversations.find(entry => entry.conversationId === item.conversationId
          && entry.revision > deletedRevision)
        return restored ? [restored] : []
      })
      const conversations = newerOperatorSummaries(current?.conversations, visible).map((item) => {
        const detail = queryClient.getQueryData<OperatorConversationState>(detailKey(item.conversationId))
        return detail && detail.revision > item.revision ? summarizeOperatorConversation(detail) : item
      })
      return { ...next, conversations }
    } })
  const listDenied = useAccessFailureLatch(list)
  const selected = useQuery({ queryKey: detailKey(selectedId ?? ''), enabled: enabled && open && !listDenied && Boolean(selectedId),
    queryFn: async ({ signal }) => {
      const read = ++readGeneration.current
      const state = await getOperatorConversation(selectedId ?? '', { signal })
      signal.throwIfAborted()
      if (read !== readGeneration.current) throw new DOMException('Newer readback required', 'AbortError')
      if (state.conversation.id !== selectedId) throw new SessionChangedError()
      return newer(queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId ?? '')), state, 'read')
    }, retry: false, refetchInterval: 3_000 })
  const selectedDenied = useAccessFailureLatch(selected)
  const accessDenied = listDenied || selectedDenied
  const fileConversation = selectedId && !accessDenied && selected.data?.conversation.id === selectedId ? selected.data.conversation : undefined
  const owner = !browserAccess.isError && browserAccess.data?.principal
  const attachments = useConversationAttachments(enabled && fileConversation?.scope === 'application' && owner
    && Date.parse(owner.expiresAt) > Date.now() ? { kind: 'temporary', chat: { kind: 'operator',
      conversationId: fileConversation.id, operatorId: fileConversation.agentId, ownerPrincipalId: owner.id,
    } } : null)
  const attachmentReceiptPending = Boolean(selectedId && attachmentReceipts.blocksSend(selectedId, attachments.readyRefs))
  const pending = selectedId && !accessDenied && enabled && !sessionIsSwitching() ? readPendingOperatorMessage(selectedId) : {}
  const setup = useOperatorChatSetup(enabled && open && !pending.command && Boolean(preferences.settings), preferences.query.data?.revision,
    { ...(preferences.settings ? { harness: preferences.settings.harness } : {}) })
  const retrySetup = useOperatorChatSetup(enabled && open && Boolean(pending.command) && !accessDenied, undefined,
    pendingOperatorSetupTarget(selectedId, pending.command))
  const shownSetup = pending.command ? retrySetup : setup
  const setupDenied = ApiError.is(shownSetup.error) && [401, 403].includes(shownSetup.error.status)
  const missingSelection = Boolean(selectedId) && !accessDenied && !preferencesDenied && !setupDenied
    && (isMissingOperatorConversation(selected.error) || isMissingOperatorConversation(shownSetup.error))
  const recoveredSelection = useMissingOperatorConversation(selectedId, missingSelection)
  const acceptState = useCallback((id: string, state: OperatorConversationState) => {
    if (state.revision <= (deletedRevisions.current.get(id) ?? -1) || state.conversation.id !== id) return
    const denial = queryClient.getQueryState(detailKey(id))?.error
    if (ApiError.is(denial) && [401, 403].includes(denial.status)) return
    if (useOperatorChatStore.getState().selectedConversationId === id) readGeneration.current++
    const accepted = newer(queryClient.getQueryData<OperatorConversationState>(detailKey(id)), state)
    queryClient.setQueryData(detailKey(id), accepted)
    const summary = summarizeOperatorConversation(accepted)
    queryClient.setQueryData<Summaries>(listKey, (current) => current ? {
      ...current, conversations: current.conversations.some((item) => item.conversationId === id)
        ? current.conversations.map((item) => item.conversationId === id && summary.revision >= item.revision ? summary : item)
        : [summary, ...current.conversations],
    } : current)
  }, [queryClient])
  const invalidate = async (id: string) => { await Promise.all([
    queryClient.invalidateQueries({ queryKey: detailKey(id) }), queryClient.invalidateQueries({ queryKey: listKey }),
  ]) }
  const create = useMutation({ mutationFn: (input: {
    generation: number; navigationGeneration: number; commandId: string; request?: AppRequest
  }) => {
    if (!currentSession(input.generation)) throw new SessionChangedError()
    return createOperatorConversation({ commandId: input.commandId })
  },
    onSuccess: async ({ conversation }, input) => {
      if (!currentSession(input.generation)) return
      if (input.request) {
        const store = useOperatorChatStore.getState()
        if (store.request?.id !== input.request.id) return
        useConversationDraftStore.getState().setDraft(conversation.id, input.request.content)
        store.takeRequest(input.request.id)
      }
      if (useOperatorChatStore.getState().navigationGeneration === input.navigationGeneration) {
        select(conversation.id)
        if (isNarrowOperatorChat()) historyTriggerRef.current?.focus()
        if (input.request?.send) setAskSend({
          id: conversation.id, requestId: input.request.id, content: input.request.content,
          generation: input.generation, navigationGeneration: useOperatorChatStore.getState().navigationGeneration,
          ready: false,
        })
      }
      // Pre-creation inspection has no accepted configuration pin. Once one
      // exists, reuse its verified installation across every subsequent chat.
      const cached = queryClient.getQueryState<OperatorChatSetup>(operatorChatSetupKey(preferences.query.data?.revision,
        { ...(preferences.settings ? { harness: preferences.settings.harness } : {}) }))
      const inspected = cached?.fetchStatus === 'fetching' ? await setup.refetch({ cancelRefetch: false }) : cached
      if (inspected?.data?.status === 'configured' && !inspected.data.configurationVersionId) await setup.refetch()
      await queryClient.invalidateQueries({ queryKey: listKey })
    },
    onSettled: (_data, error, input) => {
      creating.current = false
      const requestId = input.request?.id
      if (!error && requestId) setAskSend((current) =>
        current?.requestId === requestId ? { ...current, ready: true } : current)
    },
  })
  const send = useMutation({
    mutationFn: async (input: { id: string; command: SendOperatorMessageRequest; generation: number; epoch: string; navigationGeneration: number; recoverFirst?: boolean; attemptId?: string }) => {
      const { id, command, generation, epoch } = input
      if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
      // Persist the in-flight attempt across tabs before crossing the HTTP boundary.
      input.attemptId = await beginOperatorMessageAttempt(id, command)
      refreshOutbox((value) => value + 1)
      if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
      assertOperatorMessageReserved(id, command)
      const confirmed = (result: Awaited<ReturnType<typeof sendOperatorMessage>>) => {
        if (command.attachments?.length) {
          const message = result.state.messages.find((entry) => entry.role === 'user' && entry.requestId === command.requestId)
          if (result.state.conversation.id !== id || !message || message.conversationId !== id
            || message.content.trim() !== command.content.trim() || !containsAttachmentRefs(messageAttachmentRefs(message), command.attachments)) {
            throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The file message receipt was not confirmed. Retry the pending message.' })
          }
          if (result.state.turnState === 'uncertain' && (!result.state.activeRequestId || result.state.activeRequestId === command.requestId)) {
            throw new ApiError({ code: 'OPERATOR_DELIVERY_UNCONFIRMED', message: 'Delivery is unknown. Your draft is kept.' }, 409)
          }
        }
        return result
      }
      if (input.recoverFirst) {
        try { return confirmed(await sendOperatorMessage(id, { ...command, recovery: 'receipt' })) }
        catch (error) {
          if (!ApiError.is(error) || error.code !== 'OPERATOR_RECEIPT_NOT_FOUND') throw error
          // A read-only miss is not an abandonment receipt. Reuse the original
          // command identity if new admission is still needed.
          if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
          assertOperatorMessageReserved(id, command)
        }
      }
      try {
        return confirmed(await sendOperatorMessage(id, command))
      } catch (error) {
        if (!ApiError.is(error) || error.code !== 'REQUEST_TIMEOUT') throw error
        if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
        assertOperatorMessageReserved(id, command)
        return confirmed(await sendOperatorMessage(id, { ...command, recovery: 'receipt' }))
      }
    },
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
      const targetId = result.state.conversation.id
      // Acceptance, not winning the cross-tab outbox deletion, consumes the snapshot.
      attachmentReceipts.confirm(input.command.requestId, result.state)
      let acknowledged = false
      try {
        acknowledged = await acknowledgeOperatorMessage(input.id, input.command.requestId)
        if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
        if (acknowledged) {
          clearDraft(input.id, input.command.content)
        }
      } catch (error) {
        if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
        setPreparationError({ id: input.id, message: errorMessage(error, 'The message receipt could not be saved.') })
      }
      refreshOutbox((value) => value + 1)
      acceptState(targetId, result.state)
      if (targetId !== input.id && acknowledged) {
        const navigation = useOperatorChatStore.getState()
        if (navigation.selectedConversationId === input.id && navigation.navigationGeneration === input.navigationGeneration) select(targetId)
        else setHandoffNotice({ id: targetId, epoch: input.epoch })
      }
      await invalidate(targetId)
    },
    onError: async (error, input) => {
      if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
      try { await recordOperatorMessageFailure(input.id, input.command.requestId,
        errorMessage(error, 'Message delivery failed.'), ApiError.is(error)
          && ['INVALID_REQUEST', 'CONVERSATION_REVISION_CONFLICT', 'HARNESS_PROFILE_SELECTION_CONFLICT', 'MESSAGE_ATTACHMENT_NOT_FOUND',
            'MESSAGE_ATTACHMENT_NOT_READY', 'MESSAGE_ATTACHMENT_UNAVAILABLE', 'MESSAGE_ATTACHMENT_CONVERSATION_REQUIRED'].includes(error.code), input.attemptId) } catch { /* The current error remains visible. */ }
      if (currentSession(input.generation) && input.epoch === identityEpoch()) refreshOutbox((value) => value + 1)
    },
    // A later 4xx cannot prove an earlier lost delivery was not accepted.
    // Keep the same durable request identity until a successful receipt is read.
  })
  const cancel = useMutation({ mutationFn: ({ id, requestId }: { id: string; requestId: string; generation: number }) => cancelOperatorTurn(id, requestId),
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation)) return
      acceptState(input.id, result.state); await invalidate(input.id)
    } })
  const respond = useMutation({ mutationFn: ({ id, input }: { id: string; input: RespondOperatorInteractionRequest; generation: number }) => respondOperatorInteraction(id, input),
    onSuccess: async (result, variables) => {
      if (!currentSession(variables.generation)) return
      acceptState(variables.id, result.state); await invalidate(variables.id)
    } })

  const remove = useMutation({
    mutationFn: ({ id }: { id: string; title: string; generation: number }) => deleteOperatorConversation(id),
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation)) return
      const previous = queryClient.getQueryData<OperatorConversationState>(detailKey(input.id))?.revision
        ?? queryClient.getQueryData<Summaries>(listKey)?.conversations.find(item => item.conversationId === input.id)?.revision ?? 0
      deletedRevisions.current.set(input.id, result.revision ?? previous + 1)
      await queryClient.cancelQueries({ queryKey: listKey })
      await queryClient.cancelQueries({ queryKey: detailKey(input.id) })
      queryClient.setQueryData<Summaries>(listKey, (current) => current && ({ ...current, conversations: current.conversations.filter((item) => item.conversationId !== input.id) }))
      queryClient.removeQueries({ queryKey: detailKey(input.id) })
      queryClient.removeQueries({ queryKey: ['operator-chat', 'activity', input.id] })
      setRemoved({ id: input.id, title: input.title })
      if (useOperatorChatStore.getState().selectedConversationId === input.id) {
        select(queryClient.getQueryData<Summaries>(listKey)?.conversations[0]?.conversationId)
      }
      await queryClient.invalidateQueries({ queryKey: listKey })
    },
  })
  const restore = useMutation({
    mutationFn: ({ id }: { id: string; generation: number; navigationGeneration: number }) => restoreOperatorConversation(id),
    onSuccess: async (_result, input) => {
      if (!currentSession(input.generation)) return
      setRemoved(undefined)
      await queryClient.invalidateQueries({ queryKey: listKey })
      if (currentSession(input.generation)
        && useOperatorChatStore.getState().navigationGeneration === input.navigationGeneration) select(input.id)
    },
  })

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(chatStoragePrefix)) refreshOutbox((value) => value + 1)
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])

  useEffect(() => {
    if (enabled && open) closeRef.current?.focus()
  }, [enabled, open])
  useEffect(() => {
    if (!closing || open) return
    const timer = window.setTimeout(() => {
      setClosing(false)
      window.requestAnimationFrame(() => launcherRef.current?.focus())
    }, 180)
    return () => window.clearTimeout(timer)
  }, [closing, open])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(operatorChatNarrowQuery)
    const change = () => { if (media.matches) setHistoryOpen(false) }
    change()
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [setHistoryOpen])
  useEffect(() => {
    if (!enabled || !open || !selectedId || accessDenied) return
    let disposed = false
    const readback = createStreamReadback(async () => {
      await queryClient.cancelQueries({ queryKey: detailKey(selectedId), exact: true })
      if (disposed) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey(selectedId) }),
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({ queryKey: ['operator-chat', 'history', identityEpoch(), selectedId] }),
      ])
    })
    const refresh = readback.request
    const close = subscribeOperatorChat(selectedId, {
      snapshot: (state) => {
        void queryClient.cancelQueries({ queryKey: detailKey(selectedId), exact: true })
        acceptState(selectedId, state)
        refresh()
      },
      reconnect: () => { setPartial((current) => current?.conversationId === selectedId ? undefined : current); refresh() },
      connection: (state) => setConnection((current) => current?.id === selectedId && current.state === state ? current : { id: selectedId, state }),
      event: (event) => {
        if (event.type !== 'delta') { readGeneration.current++; void queryClient.cancelQueries({ queryKey: detailKey(selectedId), exact: true }).catch(() => undefined) }
        const state = queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId))
        if (event.type === 'activity') {
          const activity = OperatorActivitySchema.safeParse(event.data.activity)
          if (!activity.success || typeof event.data.revision !== 'number') { refresh(); return }
          const value = activity.data
          // A partial event cannot advance the revision of a complete snapshot.
          refresh()
          setPartial((current) => ({ conversationId: selectedId,
            value: projectOperatorActivity(current?.conversationId === selectedId ? current.value : undefined,
              state?.activeRequestId ?? null, value.requestId, value.id) }))
        } else if (event.type === 'delta') {
          if (!ActivityChangeEnvelopeV1Schema.safeParse(event.data.activityChange).success) { refresh(); return }
          refresh()
          setPartial((current) => ({ conversationId: selectedId,
            value: projectOperatorEnvelope(current?.conversationId === selectedId ? current.value : undefined, selectedId, state?.activeRequestId ?? null, event.data.activityChange, state?.messages ?? []) }))
        } else {
          // Keep the streamed reply until the authoritative snapshot contains its
          // final replacement. Clearing here creates a visible blank during refetch.
          refresh()
        }
      },
    })
    return () => { disposed = true; readback.dispose(); close() }
  }, [acceptState, accessDenied, enabled, open, queryClient, selectedId])

  const conversation = accessDenied ? undefined : selected.data
  const active = Boolean(conversation && (conversation.activeRequestId || !['idle', 'error'].includes(conversation.turnState)))
  const archived = conversation?.conversation.status === 'archived'
  const attachmentsDisabled = Boolean(archived || active || pending.command) || preparingId === selectedId
  const fileDrop = useFileDrop({ disabled: attachmentsDisabled || !attachments.canAdd, onFiles: attachments.addFiles })
  // A request from elsewhere in the app (askOperator) starts its own conversation and is sent once the chat can send.
  const request = useOperatorChatStore((state) => state.request)
  const requestedDraft = useConversationDraftStore((state) => askSend ? state.drafts[askSend.id] : undefined)
  const submitRef = useRef<((content: string) => Promise<void>) | undefined>(undefined)
  useEffect(() => {
    if (!enabled || !open || !request || accessDenied || creating.current) return
    if (create.isError && create.variables?.request?.id === request.id) return
    creating.current = true
    create.mutate({ generation: sessionGeneration(), commandId: request.id,
      navigationGeneration: useOperatorChatStore.getState().beginNavigation(), request })
  }, [accessDenied, create, enabled, open, request])
  const settings = preferencesDenied ? undefined : preferences.settings
  // Historical OpenCode chats stay readable, with no composer or response controls.
  const retired = conversation?.settings?.harness === 'opencode'
  const acceptedBinding = conversation?.providerAccountBinding
  let conversationAccountId: string | undefined
  if (acceptedBinding?.kind === 'slot') conversationAccountId = acceptedBinding.accountId
  else if (conversation?.settings?.harness !== 'opencode') conversationAccountId = conversation?.settings?.accountId
  const hasAcceptedConversation = Boolean(acceptedBinding || conversation?.messages.length || conversation?.hasEarlierMessages)
  const usesSavedAccount = hasAcceptedConversation && settings?.harness === conversation?.settings?.harness
  const defaultAccountId = accounts.data?.accounts.find(account =>
    account.provider === settings?.harness && account.isDefault && !account.removedAt)?.id
  const requestedAccountId = settings?.accountId ?? (usesSavedAccount ? conversationAccountId : defaultAccountId)
  const messageSettings = settings && !settings.accountId
    && usesSavedAccount && conversationAccountId ? { ...settings, accountId: conversationAccountId } : settings
  const pendingHandoff = Boolean(settings && conversation?.settings
    && (settings.harness !== conversation.settings.harness || requestedAccountId !== conversationAccountId)
    && (conversation.messages.length > 0 || conversation.hasEarlierMessages))
  const setupReady = setup.isSuccess && setup.data.status === 'configured' && setup.data.harness === settings?.harness
    && Boolean(setup.data.configurationVersionId)
  const settingsReady = Boolean(preferences.query.data) && !preferencesDenied && !preferences.form.isDirty && !preferences.form.isSaving && !preferences.form.uncertain
  const requestId = conversation?.activeRequestId ?? conversation?.pendingInteraction?.turn.nativeRequestId
  const scopedSendError = send.variables?.id === selectedId && send.variables?.command.requestId === pending.command?.requestId
    && send.error instanceof Error ? send.error.message : undefined
  const sendError = preparationError && preparationError.id === selectedId ? preparationError.message
    : scopedSendError ?? pending.sendFailure
  const liveTimeline = partial?.value && partial.conversationId === selectedId && partial.value.requestId === requestId
    ? selectLiveTextTimeline(conversation?.messages ?? [], requestId, partial.value.timeline) : []
  const partialText = liveTimeline.filter(item => item.kind === 'text').map(item => item.text).join('\n\n')
  const thinkingText = conversation?.settings?.showThinking && partial?.value && partial.conversationId === selectedId && partial.value.requestId === requestId
    ? Object.entries(partial.value.parts).filter(([id]) => id.startsWith('thinking:')).map(([, text]) => text).join('\n\n') : ''
  const entries: OperatorConversationSummary[] = accessDenied ? [] : (list.data?.conversations ?? []).map((item) =>
    conversation?.conversation.id === item.conversationId && conversation.revision >= item.revision ? summarizeOperatorConversation(conversation) : item)
  const attention = accessDenied ? [] : newerOperatorSummaries(entries, list.data?.attention ?? entries)
    .filter((item) => item.revision > (deletedRevisions.current.get(item.conversationId) ?? -1) && item.needsAttention)
  const liveConnection = connection && connection.id === selectedId ? connection.state : 'connecting'
  const connectionState = liveConnection !== 'connected' && (selected.isError || selected.failureCount > 0)
    ? 'reconnecting' : liveConnection
  const turnStatus = conversation
    ? operatorTurnStatus(conversation, connectionState, selected.isSuccess && selected.failureCount === 0) : ''
  const respondVariables = respond.variables
  const cancelVariables = cancel.variables
  const close = () => {
    setClosing(true)
    setOpen(false)
  }
  const showHistory = (next: boolean) => {
    setHistoryOpen(next)
    window.requestAnimationFrame(() => {
      if (next) historyRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      else historyTriggerRef.current?.focus()
    })
  }
  const createConversation = async ({ retry = false }: { retry?: boolean } = {}) => {
    if (creating.current || accessDenied) return
    creating.current = true
    try {
      const failed = create.variables
      const commandId = retry && create.isError && failed && !failed.request
        && currentSession(failed.generation) ? failed.commandId : crypto.randomUUID()
      await create.mutateAsync({ generation: sessionGeneration(), commandId,
        navigationGeneration: useOperatorChatStore.getState().beginNavigation() })
      if (selectedId) {
        const draft = useConversationDraftStore.getState().drafts[selectedId] ?? ''
        if (/^\/n?e?w?$/.test(draft.trim())) clearDraft(selectedId, draft)
      }
    } catch { /* The mutation keeps the failure visible. */ }
    finally { creating.current = false }
  }
  const submit = async (content: string, sessionMode?: SessionMode) => {
    if (content.trim() === '/new') {
      await createConversation()
      return
    }
    if (!setupReady || !settingsReady || !selectedId || archived || active || accessDenied || pending.command || pending.error || attachmentReceiptPending
      || reservations.current.has(selectedId) || (send.isPending && send.variables?.id === selectedId)) return
    if ((useConversationDraftStore.getState().drafts[selectedId] ?? '').trim() !== content.trim()) return
    const attachmentAttempt = prepareChatAttachments(attachments)
    if (!attachmentAttempt || (!content.trim() && !attachmentAttempt.attachments.length)
      || attachmentReceipts.blocksSend(selectedId, attachmentAttempt.attachments)) return
    if (attachmentAttempt.attachments.length && pendingHandoff) {
      setPreparationError({ id: selectedId, message: 'Start the new chat before attaching files.' })
      return
    }
    const id = selectedId
    const generation = sessionGeneration()
    const epoch = identityEpoch()
    const navigationGeneration = useOperatorChatStore.getState().navigationGeneration
    reservations.current.add(id); setPreparingId(id)
    try {
      const command = await reserveOperatorMessage(id, content, window.location.pathname + window.location.search, messageSettings,
        conversation?.revision,
        { configurationVersionId: conversation?.conversation.operatorConfigurationVersionId,
          defaultsRevision: preferences.query.data?.revision, ...(sessionMode ? { sessionMode } : {}) }, attachmentAttempt.attachments)
      if (!currentSession(generation) || epoch !== identityEpoch()) return
      attachmentReceipts.remember(id, command, attachmentAttempt)
      setPreparationError(undefined)
      send.mutate({ id, command, generation, epoch, navigationGeneration })
    } catch (error) {
      if (currentSession(generation) && epoch === identityEpoch()) setPreparationError({ id,
        message: errorMessage(error, 'Message preparation failed.') })
    } finally {
      reservations.current.delete(id)
      setPreparingId((current) => current === id ? undefined : current)
      refreshOutbox((value) => value + 1)
    }
  }
  function loadOlderChats() {
    if (!list.data?.hasMore || list.isFetching || accessDenied) return
    historyLimit.current += 10
    void list.refetch()
  }
  submitRef.current = submit
  const askReady = setupReady && settingsReady && conversation?.conversation.id === selectedId && !active && !archived
    && !pending.command && !pending.error && !attachmentReceiptPending
  useEffect(() => {
    if (!askSend) return
    const store = useOperatorChatStore.getState()
    if (!currentSession(askSend.generation) || store.navigationGeneration !== askSend.navigationGeneration
      || (store.request && store.request.id !== askSend.requestId) || requestedDraft !== askSend.content) {
      setAskSend(undefined)
      return
    }
    if (!askSend.ready || askSend.id !== selectedId || !askReady) return
    setAskSend(undefined)
    void submitRef.current?.(askSend.content)
  }, [askReady, askSend, request, requestedDraft, selectedId])
  if (!enabled || sessionIsSwitching()) return null
  return <div className="operator-chat-root">
    {open || closing ? <section ref={panelRef} style={size} id={panelId} className="operator-chat" data-state={open ? 'open' : 'closing'} role="dialog" aria-modal={false} aria-label="Operator chat" aria-hidden={closing} inert={closing}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation()
        if (historyOpen && isNarrowOperatorChat()) showHistory(false)
        else close()
      }}>
      {operatorResizeEdges.map((edge) => <button key={edge} type="button" className={`operator-chat-resize operator-chat-resize-${edge}`} {...grip(edge)} />)}
      {settingsWarning ? <details><summary>Operator settings refresh failed</summary>{settingsWarning}</details> : null}
      {accessDenied ? <Alert live tone="danger" title="Operator access unavailable">Check your browser enrollment and permissions.</Alert> : null}
      <div className="operator-chat-navigation" data-history-open={historyOpen}>
        <IconButton className="operator-history-toggle" ref={historyTriggerRef} label={historyOpen ? 'Collapse history' : 'Open history'} variant="ghost"
          aria-expanded={historyOpen} aria-controls={historyId} onClick={() => showHistory(!historyOpen)}
          title={list.isError ? 'History refresh failed. Open history to retry.' : undefined}>
          <Icon name={list.isError ? 'warning' : 'menu'} /></IconButton>
        <button type="button" className="operator-chat-move" title="Drag to move Operator chat" {...moveGrip}><span aria-hidden="true" /></button>
        <IconButton ref={closeRef} label="Close Operator chat" variant="ghost" className="operator-chat-close" onClick={close}><Icon name="close" /></IconButton>
      </div>
      <div className={`operator-chat-body${historyOpen ? ' operator-chat-history-open' : ''}`}>
        <aside aria-hidden={!historyOpen} inert={!historyOpen} ref={historyRef} id={historyId} aria-label="Operator conversation history"
          onScroll={(event) => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 72) loadOlderChats() }}>
          <Button variant="ghost" className="operator-chat-new" leading={<Icon name="plus" size={14} />} onClick={() => void createConversation()} disabled={create.isPending || accessDenied}>New chat</Button>

          {list.isPending ? <LoadingState label="Loading conversation history…" rows={3} /> : null}
          {list.isError ? <Alert live tone="danger" title={list.data ? 'History refresh failed' : 'Conversation history could not be loaded'} action={<Button size="sm" disabled={list.isFetching} loading={list.isFetching} onClick={() => void list.refetch()}>Retry history</Button>}>{list.data ? 'Previously loaded conversations are still shown.' : 'Try the request again.'}</Alert> : null}
          {list.isSuccess && entries.length === 0 ? <EmptyState icon="history" title="No conversations yet. Start a new chat." description="The Operator will keep the conversation history here." /> : null}
          <nav aria-label="Conversations">{entries.map((item) => <div className="operator-chat-row" key={item.conversationId}>
            <Button variant="ghost" className="operator-chat-row-select" aria-current={item.conversationId === selectedId ? 'page' : undefined}
              onClick={() => { select(item.conversationId); if (isNarrowOperatorChat()) historyTriggerRef.current?.focus() }}
              title={`${item.title ?? 'Conversation'} · ${operatorNavigationStatus(item)}`}>
              <span className="operator-chat-title-clip"><span>{item.title ?? 'Conversation'}</span></span>
              <span className={`operator-chat-state-dot${item.needsAttention ? ' needs-attention' : ''}`} aria-label={operatorNavigationStatus(item)} />
            </Button>
            <OperatorHistoryActions summary={item} queryKey={detailKey(item.conversationId)}
              enabled={!accessDenied} removing={remove.isPending}
              onRemove={() => remove.mutate({ id: item.conversationId, title: item.title ?? 'Conversation', generation: sessionGeneration() })} />
          </div>)}</nav>
          {list.data?.hasMore ? <Button size="sm" variant="ghost" className="operator-chat-load-more" loading={list.isFetching} loadingLabel="Loading…" onClick={loadOlderChats}>Load older chats</Button> : null}
        </aside>
        <main className="operator-chat-main">
          {handoffNotice && handoffNotice.epoch === identityEpoch() ? <p role="status">Your continued chat is ready. <Button size="sm" variant="ghost"
            onClick={() => { select(handoffNotice.id); setHandoffNotice(undefined) }}>Open continued chat</Button></p> : null}
          {recoveredSelection ? <p role="status">The previous conversation is no longer available. Start a new chat. Any saved draft or pending message has been kept on this device.</p> : null}
          {!missingSelection ? <OperatorSetupNotice data={shownSetup.data} checking={shownSetup.isFetching} failed={shownSetup.isError} onRetry={() => void shownSetup.refetch()} /> : null}
          {remove.error instanceof Error ? <Alert live tone="danger" title="Chat could not be deleted">{remove.error.message}</Alert> : null}
          {restore.error instanceof Error ? <Alert live tone="danger" title="Chat could not be restored">{restore.error.message}</Alert> : null}
          {create.error instanceof Error ? <Alert live tone="danger" title="Conversation could not be created"
            action={request && create.variables?.request?.id === request.id
              ? <Button size="sm" disabled={create.isPending || accessDenied} onClick={() => create.reset()}>Retry requested chat</Button>
              : <Button size="sm" disabled={create.isPending || accessDenied}
                onClick={() => void createConversation({ retry: true })}>Retry new chat</Button>}>
            {create.error.message}
            {request && create.variables?.request?.id === request.id ? <p>{request.content}</p> : null}
          </Alert> : null}
          {!selectedId && !accessDenied ? <div className="operator-chat-start"><EmptyState icon="chat" title="Chat with Operator"
            description="Ask about your workspaces and workflows, or describe a change you need."
            action={<Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={() => void createConversation({ retry: create.isError })}
              disabled={create.isPending} loading={create.isPending} loadingLabel="Starting…">Start chat</Button>} /></div> : null}
          {selected.isLoading ? <LoadingState label="Loading conversation…" rows={4} /> : null}
          {selected.isError && !missingSelection ? <Alert live tone="danger" title={conversation ? 'Conversation refresh failed' : 'Conversation could not be loaded'} action={<Button size="sm" disabled={selected.isFetching} loading={selected.isFetching} onClick={() => void selected.refetch()}>Retry conversation</Button>}>{conversation ? 'Previously loaded messages are still shown.' : 'Try the request again.'}</Alert> : null}
          {conversation ? <>
            {!retired ? <PinnedProviderAccount binding={conversation.providerAccountBinding} /> : null}
            {archived ? <Alert tone="warning" title="Conversation ended">This conversation is read-only. Its history and pending receipt remain available.</Alert> : null}
            {conversation.handoff ? <p className="operator-chat-handoff">Continued from <Button size="sm" variant="ghost" onClick={() => select(conversation.handoff!.parentConversationId)}>{conversation.handoff.sourceHarness} chat</Button>
              {conversation.handoff.omittedMessages ? ` · ${conversation.handoff.omittedMessages} older messages omitted from agent context` : ''}</p> : null}
            <OperatorTranscript key={conversation.conversation.id} conversationId={conversation.conversation.id} messages={conversation.messages} activities={conversation.activities} activityNextCursor={conversation.activityNextCursor}
              activeRequestId={requestId} parts={partial && partial.conversationId === selectedId ? partial.value?.parts : undefined} partialText={partialText} thinkingText={thinkingText} hasEarlierMessages={conversation.hasEarlierMessages} working={['starting', 'active'].includes(conversation.turnState) && !conversation.pendingInteraction}
              timeline={partial && partial.conversationId === selectedId ? partial.value : undefined}
              approvalRevision={JSON.stringify([requestId, conversation.pendingInteraction, conversation.activitySnapshot?.pendingInteractions, conversation.activitySnapshot?.activities.filter((item) => item.kind === 'interaction')])}
              approval={(onBrowse) => <><ChatDecisionReceipts snapshot={conversation.activitySnapshot} pending={selected.isFetching} onRefresh={() => { void selected.refetch() }} />
                {!retired && requestId && conversation.pendingInteraction ? <OperatorApprovalCard interaction={conversation.pendingInteraction!} onBrowse={onBrowse}
                disabled={Boolean(archived || !conversation.responseAvailability?.available || conversation.responseAvailability && (conversation.responseAvailability.nativeRequestId !== conversation.pendingInteraction?.turn.nativeRequestId || conversation.responseAvailability.nativeSessionId !== conversation.pendingInteraction?.session.nativeSessionId || conversation.responseAvailability.nativeRequestType !== conversation.pendingInteraction?.nativeRequestType) || (respond.isPending && respond.variables?.id === selectedId) || conversation.responseDelivery !== 'offered' || conversation.turnState === 'canceling')}
                onSelect={(optionId, response) => respond.mutate({ id: conversation.conversation.id, generation: sessionGeneration(),
                  input: { requestId, nativeRequestId: conversation.pendingInteraction!.turn.nativeRequestId!, optionId,
                    ...(response !== undefined ? { response } : {}) } })} /> : null}</>} />
            {conversation.pendingInteraction || conversation.error || pending.error || pending.command || sendError
              || (respondVariables?.id === selectedId && respond.error) || (cancelVariables?.id === selectedId && cancel.error) ? <div className="operator-chat-decision-area">
              {conversation.pendingInteraction && !conversation.responseAvailability?.available ? <p role="status">{conversation.responseAvailability?.message ?? 'Refresh this conversation to check reply availability.'}</p> : null}
              {conversation.pendingInteraction && conversation.responseDelivery !== 'offered' ? <Alert tone="warning" title="Response delivery is being reconciled">It will not be sent twice.</Alert> : null}
              <div className="operator-chat-feedback">
                {conversation.error ? <Alert live tone="danger" title="Operator turn failed">{conversation.error}</Alert> : null}
                {respondVariables && respondVariables.id === selectedId && respondVariables.input.requestId === requestId && respond.error instanceof Error ? <Alert live tone="danger" title="Approval response failed">{respond.error.message}</Alert> : null}
                {cancelVariables && cancelVariables.id === selectedId && cancelVariables.requestId === requestId && cancel.error instanceof Error ? <Alert live tone="danger" title="Cancellation failed">{cancel.error.message}</Alert> : null}
                {pending.error ? <Alert live tone="danger" title="Pending message unavailable">{pending.error}</Alert> : null}
                {sendError ? <Alert live tone="danger" title="Message could not be sent">{sendError}</Alert> : null}
              </div>
              {!retired && pending.command ? <Button disabled={send.isPending && send.variables?.id === selectedId} loading={send.isPending && send.variables?.id === selectedId} onClick={() => {
                setPreparationError(undefined)
                send.mutate({ id: conversation.conversation.id, command: pending.command!, generation: sessionGeneration(), epoch: identityEpoch(), recoverFirst: true, navigationGeneration: useOperatorChatStore.getState().navigationGeneration })
              }}>Retry pending message</Button> : null}
              {!retired && pending.command && pending.definitiveFailure ? <Button variant="ghost" disabled={pending.inFlight || (send.isPending && send.variables?.id === selectedId)} onClick={() => {
                void discardDefinitivelyRejectedOperatorMessage(conversation.conversation.id, pending.command!.requestId).then((discarded) => {
                  if (discarded) { attachmentReceipts.forget(pending.command!.requestId); send.reset(); setPreparationError(undefined); refreshOutbox((value) => value + 1) }
                }).catch((error: unknown) => setPreparationError({ id: conversation.conversation.id,
                  message: errorMessage(error, 'The saved attempt could not be cleared.') }))
              }}>Clear rejected attempt and keep draft</Button> : null}
            </div> : null}
            {retired ? <p role="status">Retired harness (OpenCode): read-only</p> : <footer className="operator-chat-controls">
              {attachmentReceiptPending && !pending.command ? <Button size="sm" onClick={attachmentReceipts.reconcile}>Check previous message</Button> : null}
              {pendingHandoff ? <p className="operator-chat-handoff" role="status">{attachments.hasAttachments ? 'Files stay in this chat. Start a new chat to attach files.' : <>Your next message starts {settings!.harness === 'claude' ? 'a Claude' : 'a Codex'} chat with prior conversation context.</>}</p> : null}
              {preferences.query.isError ? <Alert tone={preferencesDenied ? 'danger' : 'warning'} title={preferencesDenied ? 'Operator settings access unavailable' : 'Could not refresh Operator settings'}
                action={<Button size="sm" onClick={() => void preferences.query.refetch()}>Retry settings</Button>}>
                {preferencesDenied ? 'Check your browser enrollment and permissions.' : preferences.query.data ? 'Last saved settings are still available.' : preferences.query.error.message}
              </Alert> : null}
              {preferences.form.isSaving ? <p role="status">Saving Operator settings…</p> : null}
              {!preferences.form.isSaving && (preferences.form.isDirty || preferences.form.error || preferences.form.conflicted || preferences.form.uncertain) ? <div>
                <SettingsFormFeedback form={preferences.form} />
                <Button size="sm" disabled={preferences.form.isSaving || (preferences.form.conflicted && !preferences.form.uncertain)} onClick={() => void preferences.save()}>Retry settings save</Button>
                {!preferences.form.uncertain ? <Button size="sm" disabled={preferences.form.isSaving} onClick={preferences.form.reset}>Discard settings changes</Button> : null}
              </div> : null}
              {turnStatus && (conversation.messages.length > 0 || conversation.hasEarlierMessages || conversation.activeRequestId || conversation.turnState !== 'idle' || connectionState !== 'connected') ? <div className="operator-chat-turn-actions">
                <p role="status">{turnStatus}</p>
              </div> : null}
              <CompactionActivity controls={sessionControls} />
              <OperatorComposer sessionControls={sessionControls} key={conversation.conversation.id} context={settings ? <OperatorComposerSettings value={settings} disabled={Boolean(pending.command) || preparingId === selectedId || preferences.form.isSaving || preferences.form.uncertain || preferences.query.isError}
                onChange={preferences.change}
                access={preferences.harness ? <OperatorAccessPicker key={preferences.harness.harness} value={preferences.harness} disabled={Boolean(pending.command) || preparingId === selectedId || preferences.form.isSaving || preferences.form.uncertain || preferences.query.isError}
                  saving={preferences.form.isSaving} saveError={preferences.form.error}
                  onChange={preferences.changeAccess} /> : undefined} /> : undefined}
                hasAttachments={attachments.hasAttachments}
                fileDropProps={fileDrop.dropTargetProps}
                attachmentControl={<ChatAttachmentControl draft={attachments} disabled={attachmentsDisabled} composerDrop={fileDrop} />}
                onNewChat={() => void createConversation()} conversationId={conversation.conversation.id}
                sendDisabled={attachmentReceiptPending || attachments.hasBlockingAttachments || (attachments.hasAttachments && pendingHandoff) || !setupReady || !settingsReady || archived || active || preparingId === selectedId || Boolean(pending.error) || Boolean(pending.command)}
                isSending={preparingId === selectedId || (send.isPending && send.variables?.id === selectedId)} onSubmit={submit}
                onCancel={requestId && conversation.turnState !== 'canceling' ? () => cancel.mutate({ id: conversation.conversation.id, requestId, generation: sessionGeneration() }) : undefined} />
            </footer>}
          </> : null}
        </main>
      </div>
      {removed ? <div className="operator-chat-undo" role="status">Chat deleted. <Button size="sm" variant="ghost" disabled={restore.isPending}
        onClick={() => restore.mutate({ id: removed.id, generation: sessionGeneration(),
          navigationGeneration: useOperatorChatStore.getState().beginNavigation() })}>Undo</Button></div> : null}
    </section> : null}
    <IconButton ref={launcherRef} className="operator-chat-launcher" variant="primary" label={attention.length ? `Open Operator chat, ${attention.length} conversation${attention.length === 1 ? '' : 's'} need your decision` : 'Open Operator chat'} hidden={open || closing}
      aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog"
      aria-description={settingsWarning ?? (list.isError ? 'Conversation status may be stale.' : undefined)}
      title={settingsWarning ?? (list.isError ? 'Conversation status may be stale' : 'Open Operator chat')}
      onClick={() => { if (attention[0]) select(attention[0].conversationId); setOpen(true) }}><Icon name="bot" />
      {attention.length ? <Badge tone="warning" className="operator-chat-badge" aria-hidden="true">{attention.length}</Badge> : null}
      {settingsWarning || list.isError ? <Badge tone="warning" className="operator-chat-connection-badge" aria-label="Connection warning">!</Badge> : null}
    </IconButton>
  </div>
}
