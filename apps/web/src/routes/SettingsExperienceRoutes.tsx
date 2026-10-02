import { Navigate, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { AgentDefaultsSettings } from '../features/settings/AgentDefaultsSettings'
import { ComputerSettings } from '../features/settings/ComputerSettings'
import { DeviceRegistrationSchema } from '@graphql/contracts/device-identity'
import { Alert } from '../shared/ui/nocturne'
import { HarnessComputerScope } from '../features/settings/HarnessComputerScope'
import { HarnessDefaultsSettings } from '../features/settings/HarnessDefaultsSettings'
import { WorkspaceDefaultsSettings } from '../features/settings/WorkspaceDefaultsSettings'
import { AccountAccess } from '../features/auth/AccountAccess'
import { WorkspaceShell } from '../shared/ui/WorkspaceShell'
import { SkillsLibrary } from '../features/skills/SkillsLibrary'
import { NewSkillPage, SkillDetailPage } from '../features/skills/SkillPages'
import '../features/settings/settingsExperience.css'

function SettingsShell({ children }: { children: ReactNode }) {
  return <WorkspaceShell workspaceId="workspace-1" activeGlobalSection="settings" slots={{ main:
    <div className="settings-page settings-experience">
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
      if (section === 'connections' || section === 'workspace' || section === 'plugins') return
      void navigate({ search: { ...search, section } })
    }} /></SettingsShell>
}
export function HarnessSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  useEffect(() => {
    if (search.harness === 'opencode' && search.section === 'plugins') void navigate({ search: { ...search, harness: 'opencode', section: 'model' }, replace: true })
  }, [search, navigate])
  return <SettingsShell><HarnessComputerScope selectedComputer={search.computer} onSelectComputer={(computer) => void navigate({ search: { ...search, computer } })}><HarnessDefaultsSettings selectedHarness={search.harness} section={search.harness === 'opencode' && search.section === 'plugins' ? 'model' : search.section ?? 'model'}
    onSelectHarness={(harness) => void navigate({ search: harness ? { ...search, harness, section: 'model' } : { computer: search.computer } })}
    onSectionChange={(section) => void navigate({ search: { ...search, section } })} /></HarnessComputerScope></SettingsShell>
}
export function SkillsSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/skills' })
  const navigate = useNavigate({ from: '/settings/skills' })
  return <SettingsShell><SkillsLibrary search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} /></SettingsShell>
}
export function NewSkillRouteEntry() {
  const search = useSearch({ from: '/settings/skills/new' })
  const navigate = useNavigate()
  return <SettingsShell><NewSkillPage workspaceId={search.workspace}
    onSaved={(result) => void navigate({ to: '/settings/skills/$workspaceId/$skillId', params: { workspaceId: result.skill.workspaceId, skillId: result.skill.skillId }, replace: true })}
    onCancel={() => void navigate({ to: '/settings/skills', search: search.workspace ? { workspace: search.workspace } : {} })} /></SettingsShell>
}
export function SkillDetailRouteEntry() {
  const params = useParams({ from: '/settings/skills/$workspaceId/$skillId' })
  const navigate = useNavigate()
  return <SettingsShell><SkillDetailPage key={`${params.workspaceId}:${params.skillId}`} workspaceId={params.workspaceId} skillId={params.skillId}
    onCancel={() => void navigate({ to: '/settings/skills' })} /></SettingsShell>
}
export function WorkspaceDefaultsSettingsRouteEntry() {
  return <SettingsShell><WorkspaceDefaultsSettings /></SettingsShell>
}
export function OperatorAccessSettingsRouteEntry() {
  return <Navigate to="/account" replace />
}

export function AccountRouteEntry() {
  return <WorkspaceShell workspaceId="workspace-1" activeGlobalSection="account" slots={{ main:
    <div className="settings-page settings-experience"><AccountAccess /></div>,
  }} />
}

export function ComputersSettingsRouteEntry() {
  const navigate = useNavigate()
  return <SettingsShell><ComputerSettings onSelectComputer={(deviceId) => void navigate({ to: '/settings/computers/$deviceId', params: { deviceId } })} /></SettingsShell>
}
export function ComputerDetailsSettingsRouteEntry() {
  const params = useParams({ strict: false })
  const device = DeviceRegistrationSchema.shape.deviceId.safeParse(params.deviceId)
  return <SettingsShell>
    {device.success ? <ComputerSettings key={device.data} deviceId={device.data} /> : <Alert tone="danger" title="The computer address is invalid." />}
  </SettingsShell>
}
