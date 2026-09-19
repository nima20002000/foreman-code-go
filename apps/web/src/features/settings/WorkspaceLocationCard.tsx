import { Icon, IconButton } from '../../shared/ui/nocturne'
import './mcpConnections.css'
import './workspaceLocation.css'

/** Reuse the supplied App connections folder notice across location controls. */
export function WorkspaceLocationCard({ label, path, description, disabled, onChoose, onCopy }: {
  label: string
  path: string
  description?: string
  disabled?: boolean
  onChoose(): void
  onCopy?: () => void
}) {
  return <div className="mcp-folder-notice workspace-location-card" data-copy={Boolean(onCopy && path)}>
    <button type="button" className="workspace-location-choose"
      aria-label={label} disabled={disabled} onClick={onChoose} />
    <span className="mcp-provider-icon"><Icon name="folder" size={22} /></span>
    <div>
      <strong>{path ? label : 'Choose a workspace folder'}</strong>
      <p dir={path ? 'ltr' : undefined} title={path || undefined}>{path || description || 'Choose where this workspace will work.'}</p>
    </div>
    {onCopy && path ? <IconButton label="Copy folder path" variant="ghost" onClick={onCopy}><Icon name="copy" size={16} /></IconButton> : null}
  </div>
}
