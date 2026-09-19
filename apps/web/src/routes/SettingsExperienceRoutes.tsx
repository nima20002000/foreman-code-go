import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AgentDefaultsSettings } from '../features/settings/AgentDefaultsSettings'
import { HarnessDefaultsSettings } from '../features/settings/HarnessDefaultsSettings'
import { WorkspaceDefaultsSettings } from '../features/settings/WorkspaceDefaultsSettings'
import { AccountAccess } from '../features/auth/AccountAccess'
import { WorkspaceShell } from '../shared/ui/WorkspaceShell'
import '../features/settings/settingsExperience.css'

function SettingsShell({ children }: { children: ReactNode }) {
  return <WorkspaceShell workspaceId="workspace-1" activeGlobalSection="settings" slots={{ main:
    <div className="settings-page settings-experience n-theme">
      <Link to="/settings" className="settings-back-link" aria-label="Back to settings"><span aria-hidden="true">←</span> Settings</Link>
      {children}
    </div>,
  }} />
}
export function AgentSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/agents' })
  const navigate = useNavigate({ from: '/settings/agents' })
  return <SettingsShell><AgentDefaultsSettings selectedRole={search.role} section={search.section ?? 'model'}
    onSelectRole={(role) => void navigate({ search: role ? { role, section: 'model' } : {} })}
    onSectionChange={(section) => {
      if (section === 'connections' || section === 'workspace') return
      void navigate({ search: { ...search, section } })
    }} /></SettingsShell>
}
export function HarnessSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  return <SettingsShell><HarnessDefaultsSettings selectedHarness={search.harness} section={search.section ?? 'model'}
    onSelectHarness={(harness) => void navigate({ search: harness ? { harness, section: 'model' } : {} })}
    onSectionChange={(section) => void navigate({ search: { ...search, section } })} /></SettingsShell>
}
export function WorkspaceDefaultsSettingsRouteEntry() {
  return <SettingsShell><WorkspaceDefaultsSettings /></SettingsShell>
}
export function OperatorAccessSettingsRouteEntry() {
  return <Navigate to="/account" replace />
}

export function AccountRouteEntry() {
  return <WorkspaceShell workspaceId="workspace-1" activeGlobalSection="account" slots={{ main:
    <div className="settings-page settings-experience n-theme"><AccountAccess /></div>,
  }} />
}
