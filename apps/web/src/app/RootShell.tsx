import { UnsavedChangesProvider } from '../shared/ui/UnsavedChangesProvider'
import { AppNavigationHistoryProvider } from '../shared/ui/AppNavigationHistory'
import { Outlet, useLocation } from '@tanstack/react-router'
import { RequireBrowserSession } from '../features/auth/RequireBrowserSession'

import { OperatorChat, OperatorChatVisibilityProvider } from '../features/operator-chat'
import { ApprovalInbox } from '../features/approvals'
import { useAgentDefaultsQuery } from '../shared/api/query'
import { useAccessFailureLatch } from '../shared/api/useAccessFailureLatch'
import { sessionIsSwitching } from '../shared/api/sessionBoundary'

export function RootShell() {
  const { pathname } = useLocation()
  if (pathname === '/sign-in' || pathname === '/setup') return <Outlet />
  return <RequireBrowserSession><AppNavigationHistoryProvider><UnsavedChangesProvider><AuthenticatedShell /></UnsavedChangesProvider></AppNavigationHistoryProvider></RequireBrowserSession>
}

function AuthenticatedShell() {
  const defaults = useAgentDefaultsQuery()
  // Query retains the last confirmed value during transient refresh failures.
  // The enrollment boundary clears this cache before another identity can use it.
  const denied = useAccessFailureLatch(defaults)
  const enabled = !sessionIsSwitching() && !denied && defaults.data?.value.operator.uiEnabled === true
  const settingsWarning = enabled && (defaults.isError || defaults.failureCount > 0)
    ? 'Settings could not be refreshed. Showing the last confirmed Operator setting for this session.' : undefined
  return <OperatorChatVisibilityProvider enabled={enabled}><Outlet /><ApprovalInbox /><OperatorChat settingsWarning={settingsWarning} /></OperatorChatVisibilityProvider>
}
