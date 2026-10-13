import { useSessionControls } from '../sessionControls/useSessionControls'
import { compactionBlocksSend, parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { useEffect, useRef, useState } from 'react'
import type { AgentChatIntent, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { useConversationAttachments } from '../../attachments'

import { prepareChatAttachments } from '../chatAttachmentAttempt'

import { useAgentChat } from './useAgentChat'

export function useAgentConversationComposer({ chat, state, sessionControls, attachments, draft }: {
  chat: ReturnType<typeof useAgentChat>
  state: ReturnType<typeof useAgentChat>['state']
  sessionControls: ReturnType<typeof useSessionControls>
  attachments: ReturnType<typeof useConversationAttachments>
  draft: string
}) {
  const composer = useRef<HTMLTextAreaElement>(null), focused = useRef(false)
  const [sendAgainDraft, setSendAgain] = useState<Pick<SendAgentChatMessageRequest,
    'content' | 'attachments' | 'sessionMode'> & { draftKey: string }>()
  const sendAgain = sendAgainDraft?.draftKey === chat.draftKey ? sendAgainDraft : undefined
  const resendCommand = parseSessionCommand(sendAgain?.content ?? '')
  const resendControl = resendCommand.kind === 'compact' || resendCommand.kind === 'mode'
  const resendPending = chat.pending || resendControl && sessionControls.mutation.isPending
  const [commandError, setCommandError] = useState<{ draftKey: string; content: string; message: string }>()
  const commandCompaction = sessionControls.commandFeedback?.draft.content === commandError?.content
    ? sessionControls.commandFeedback?.compaction : undefined
  useEffect(() => {
    if (!state || focused.current || !composer.current) return
    const active = document.activeElement, popover = composer.current.closest('.n-agent-popover')
    if (!active || active === document.body || active.matches('.n-agent-action--chat[aria-expanded="true"]')
      || active.getAttribute('role') === 'tab' && popover?.contains(active)) {
      focused.current = true
      composer.current.focus({ preventScroll: true })
    }
  }, [state])
  const focus = () => composer.current?.focus({ preventScroll: true })
  const submit = async (intent: AgentChatIntent, content = draft, sessionMode?: SessionMode,
    resend?: Pick<SendAgentChatMessageRequest, 'attachments'>) => {
    const command = parseSessionCommand(content)
    setCommandError(undefined)
    try {
      if (command.kind === 'invalid') throw new Error(command.message)
      if (command.kind === 'compact' || command.kind === 'mode') {
        return await sessionControls.command(content, resend ? `${chat.draftKey}:resend` : chat.draftKey)
      }
      if (command.kind === 'new') throw new Error('/new is available in Operator chat.')
      const mode = command.kind === 'plan-task' ? 'plan' : sessionMode ?? sessionControls.state?.desiredMode
      if (intent === 'steer' && mode === 'plan') return false
      if (compactionBlocksSend(sessionControls.state?.compaction ?? null)) return false
      const attempt = resend ? { attachments: resend.attachments ?? [] } : prepareChatAttachments(attachments)
      return !!attempt && chat.send(content, intent, !resend, !!resend, attempt, mode)
    } catch (failure) {
      setCommandError({ draftKey: chat.draftKey, content,
        message: failure instanceof Error ? failure.message : 'The native command could not be confirmed.' })
      return false
    } finally {
      focus()
    }
  }
  return { composer, sendAgain, setSendAgain, resendCommand, resendControl, resendPending,
    commandError, commandCompaction, focus, submit }
}
