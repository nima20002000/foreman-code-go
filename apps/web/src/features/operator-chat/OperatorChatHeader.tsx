import type { RefObject } from 'react'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import type { useOperatorChatResize } from './useOperatorChatResize'

export function OperatorChatHeader({ historyOpen, historyId, historyTriggerRef, closeRef, historyFailed, moveGrip, onToggleHistory, onClose }: {
  historyOpen: boolean
  historyId: string
  historyTriggerRef: RefObject<HTMLButtonElement | null>
  closeRef: RefObject<HTMLButtonElement | null>
  historyFailed: boolean
  moveGrip: ReturnType<typeof useOperatorChatResize>['moveGrip']
  onToggleHistory: () => void
  onClose: () => void
}) {
  return <div className="operator-chat-navigation" data-history-open={historyOpen}>
    <IconButton className="operator-history-toggle" ref={historyTriggerRef} label={historyOpen ? 'Collapse history' : 'Open history'} variant="ghost"
      aria-expanded={historyOpen} aria-controls={historyId} onClick={onToggleHistory}
      title={historyFailed ? 'History refresh failed. Open history to retry.' : undefined}>
      <Icon name={historyFailed ? 'warning' : 'menu'} /></IconButton>
    <button type="button" className="operator-chat-move" title="Drag to move Operator chat" {...moveGrip}><span aria-hidden="true" /></button>
    <IconButton ref={closeRef} label="Close Operator chat" variant="ghost" className="operator-chat-close" onClick={onClose}><Icon name="close" /></IconButton>
  </div>
}
