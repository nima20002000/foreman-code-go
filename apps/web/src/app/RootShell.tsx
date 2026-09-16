import { Outlet } from '@tanstack/react-router'

import { OperatorChat, OperatorChatVisibilityProvider } from '../features/operator-chat'
import { useAgentDefaultsQuery } from '../shared/api/query'

export function RootShell() {
  const defaults = useAgentDefaultsQuery()
  const enabled = defaults.isSuccess && defaults.data.value.operator.uiEnabled
  return <OperatorChatVisibilityProvider enabled={enabled}><Outlet /><OperatorChat /></OperatorChatVisibilityProvider>
}
