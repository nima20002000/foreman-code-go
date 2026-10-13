import { errorMessage } from '../../shared/errorMessage'
import { useRef, useState } from 'react'
import { useArchiveSkillMutation, useSkillQuery, useSkillUsageQuery, useSkillVersionsQuery, useUpdateSkillUsersMutation } from './skillsApi'
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { SkillEditor, SkillTextPreview, type SavedSkill } from './SkillEditor'
import { useWorkspaceNames } from './workspaceNames'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import './skills.css'

export function NewSkillPage({ workspaceId, onSaved, onCancel }: { workspaceId?: string | undefined; onSaved(result: SavedSkill): void; onCancel(): void }) {
  const { workspaces, options } = useWorkspaceNames()
  const accessError = useProtectedAccessError(workspaces)
  return <section className="settings-editor-page skill-page" aria-label="New skill">
    <header className="settings-experience-heading"><h1>New skill</h1>
      <p>Write instructions once and assign them to Agents on the board. Saving creates version 1.</p></header>
    {accessError ? <ProtectedAccessError error={accessError} />
      : workspaces.isPending ? <LoadingState label="Loading workspaces…" />
        : workspaces.isError ? <ErrorState title="Workspaces could not be loaded" description={workspaces.error.message} onRetry={() => void workspaces.refetch()} />
          : options.length === 0 ? <EmptyState icon="folder" title="No workspace available" description="Create a workspace first. Each skill belongs to one workspace." />
            : <SkillEditor workspaceOptions={options} initialWorkspace={workspaceId} onSaved={(result) => onSaved(result)} onCancel={onCancel} />}
  </section>
}

function VersionHistory({ workspaceId, skillId, current }: { workspaceId: string; skillId: string; current: string }) {
  const versions = useSkillVersionsQuery(workspaceId, skillId)
  const [open, setOpen] = useState<string>()
  const exact = useSkillQuery(workspaceId, open ? skillId : '', open)
  return <section className="skill-history" aria-labelledby="skill-history-heading">
    <h2 id="skill-history-heading">Version history</h2>
    <p>Each save creates an immutable version. Agents keep the version they were saved with until you choose a newer one on the board.</p>
    {versions.isPending ? <LoadingState label="Loading versions…" rows={2} />
      : versions.isError ? <ErrorState title="Versions could not be loaded" description={versions.error.message} onRetry={() => void versions.refetch()} />
        : <ol className="skill-history-list">{versions.data.items.map((item) => <li key={item.version}>
          <span><strong>Version {item.version}</strong>{item.version === current ? <Badge tone="success">Current</Badge> : null}</span>
          <span className="skill-history-meta">{item.name} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span>
          <Button size="sm" variant="ghost" onClick={() => setOpen(item.version)}>View</Button>
        </li>)}</ol>}
    <Dialog open={Boolean(open)} onOpenChange={(value) => { if (!value) setOpen(undefined) }} size="lg" title={`Version ${open ?? ''}`}
      description={exact.data ? `${exact.data.version.name} · saved ${new Date(exact.data.version.createdAt).toLocaleString()}` : undefined}>
      {exact.isPending ? <LoadingState label="Loading version…" rows={3} />
        : exact.isError ? <ErrorState title="This version could not be loaded" description={exact.error.message} onRetry={() => void exact.refetch()} />
          : <SkillTextPreview text={exact.data.version.instructions} />}
    </Dialog>
  </section>
}

export function SkillDetailPage({ workspaceId, skillId, onCancel }: { workspaceId: string; skillId: string; onCancel(): void }) {
  const query = useSkillQuery(workspaceId, skillId)
  const { name } = useWorkspaceNames()
  const archive = useArchiveSkillMutation()
  const [confirm, setConfirm] = useState(false)
  const [archiveError, setArchiveError] = useState<string>()
  const attempt = useRef(new CommandAttempt<Record<string, unknown>>())
  const accessError = useProtectedAccessError(query)
  if (accessError) return <ProtectedAccessError error={accessError} />
  if (query.isPending) return <LoadingState label="Loading skill…" />
  if (query.isError && !query.data) return query.error && 'code' in query.error && query.error.code === 'SKILL_NOT_FOUND'
    ? <EmptyState icon="warning" title="Skill not found" description="It may be in a workspace you cannot access." action={<Button onClick={onCancel}>Back to skills</Button>} />
    : <ErrorState title="This skill could not be loaded" description={query.error.message} onRetry={() => void query.refetch()} />
  const { skill } = query.data
  async function toggleArchive() {
    setArchiveError(undefined)
    try {
      await archive.mutateAsync(attempt.current.input({ workspaceId, skillId, expectedRevision: skill.revision, archived: !skill.archived }) as never)
      attempt.current.succeeded(); setConfirm(false)
    } catch (failure) {
      attempt.current.failed(failure)
      setArchiveError(errorMessage(failure, 'The change was not saved.'))
    }
  }
  return <section className="settings-editor-page skill-page" aria-label={skill.name}>
    <header className="skills-heading">
      <div className="settings-experience-heading"><h1>{skill.name}</h1>
        <p><Badge>{name(skill.workspaceId)}</Badge> Version {skill.version} · {skill.versionCount} {skill.versionCount === 1 ? 'version' : 'versions'}
          {skill.archived ? <> · <Badge tone="warning">Archived</Badge></> : null}</p></div>
      <Button variant={skill.archived ? 'secondary' : 'ghost'} onClick={() => { setArchiveError(undefined); setConfirm(true) }}>{skill.archived ? 'Restore skill' : 'Archive skill'}</Button>
    </header>
    {query.isError ? <p role="alert" className="skills-inline-error">Could not refresh this skill. Showing the last loaded version. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    {skill.archived ? <Alert tone="warning" title="This skill is archived.">It is hidden from the skill picker and cannot be newly assigned. Agents that already use it keep their saved version. Restore it to edit.</Alert> : null}
    <SkillUsersBanner workspaceId={workspaceId} skillId={skillId} />
    <SkillEditor key={`${workspaceId}:${skillId}`} saved={query.data} workspaceOptions={[]} readOnly={skill.archived}
      onSaved={() => undefined} onCancel={onCancel} />
    <VersionHistory workspaceId={workspaceId} skillId={skillId} current={skill.version} />
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} pending={archive.isPending} error={archiveError}
      title={skill.archived ? `Restore ${skill.name}?` : `Archive ${skill.name}?`}
      description={skill.archived ? 'It will appear in the skill picker again.' : 'It will be hidden from the skill picker. Agents that already use it keep their saved version, and its history is kept.'}
      confirmLabel={skill.archived ? 'Restore' : 'Archive'} onConfirm={() => void toggleArchive()} />
  </section>
}

/** After an edit, Agents keep the version they were given; one click moves them and their workflows to this version. */
function SkillUsersBanner({ workspaceId, skillId }: { workspaceId: string; skillId: string }) {
  const usage = useSkillUsageQuery(workspaceId, skillId)
  const update = useUpdateSkillUsersMutation(workspaceId, skillId)
  const commandId = useRef(crypto.randomUUID())
  const failed = update.data?.failed ?? []
  if (usage.isError) return <Alert tone="warning" title="Skill usage could not be loaded."
    action={<Button size="sm" disabled={usage.isFetching} onClick={() => void usage.refetch()}>Try again</Button>}>
    {usage.error.message}
  </Alert>
  if (!usage.data || (!usage.data.agents.length && !usage.data.workflows.length && !failed.length)) return null
  const { agents, workflows } = usage.data
  const count = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`
  const users = [agents.length ? count(agents.length, 'Agent') : '', workflows.length ? count(workflows.length, 'workflow') : '']
    .filter(Boolean).join(' and ')
  const verb = agents.length + workflows.length === 1 ? 'uses' : 'use'
  return <Alert tone={failed.length ? 'warning' : 'info'} title={users
    ? `${users} still ${verb} an older version` : 'Some updates did not finish'}
    action={<Button size="sm" variant="primary" disabled={update.isPending} onClick={() => {
      update.mutate(commandId.current, { onSuccess: () => { commandId.current = crypto.randomUUID() } })
    }}>{update.isPending ? 'Updating…' : `Update to v${usage.data.headVersion}`}</Button>}>
    {agents.length ? <p className="skills-users">{agents.map(agent => `${agent.name} (v${agent.version})`).join(', ')}</p> : null}
    {failed.length ? <p role="alert">{failed.map(item => item.message).join(' ')}</p> : null}
    {update.isError ? <p role="alert">The update could not be sent. Try again.</p> : null}
  </Alert>
}
