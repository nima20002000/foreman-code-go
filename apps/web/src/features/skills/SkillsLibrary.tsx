import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { SkillSummary } from '@foreman-code/contracts/management'
import { useWorkspaceNames } from './workspaceNames'
import { LoadMore } from '../../shared/ui/LoadMore'
import { Badge, Button, EmptyState, ErrorState, Icon, LoadingState, SearchField, Select, Switch } from '../../shared/ui/nocturne'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { useSkillPages } from './skillsApi'
import './skills.css'

export interface SkillLibrarySearch { workspace?: string | undefined; q?: string | undefined; archived?: boolean | undefined }

function SkillRow({ skill, workspace }: { skill: SkillSummary; workspace: string }) {
  return <li>
    <Link to="/settings/skills/$workspaceId/$skillId" params={{ workspaceId: skill.workspaceId, skillId: skill.skillId }} className="skill-row">
      <span className="skill-row-icon" aria-hidden="true"><Icon name="code" size={16} /></span>
      <span className="skill-row-text">
        <strong>{skill.name}</strong>
        {skill.description ? <span className="skill-row-description">{skill.description}</span> : null}
      </span>
      <span className="skill-row-meta">
        <Badge>{workspace}</Badge>
        <span>Version {skill.version}</span>
        {skill.archived ? <Badge tone="warning">Archived</Badge> : null}
      </span>
    </Link>
  </li>
}

/** One row per logical skill across every workspace the user may read. */
export function SkillsLibrary({ search, onSearchChange }: { search: SkillLibrarySearch; onSearchChange(next: SkillLibrarySearch): void }) {
  const { workspaces, options, name } = useWorkspaceNames()
  const [text, setText] = useState(search.q ?? '')
  useEffect(() => setText(search.q ?? ''), [search.q])
  useEffect(() => {
    const next = text.trim() || undefined
    if (next === search.q) return
    const timer = setTimeout(() => onSearchChange({ ...search, q: next }), 250)
    return () => clearTimeout(timer)
  }, [text, search, onSearchChange])
  const pages = useSkillPages({ workspaceId: search.workspace, query: search.q, includeArchived: search.archived })
  const accessError = useProtectedAccessError(pages)
  const skillsById = new Map<string, SkillSummary>()
  for (const skill of pages.data?.pages.flatMap((page) => page.items) ?? []) {
    const key = `${skill.workspaceId}:${skill.skillId}`
    const previous = skillsById.get(key)
    if (!previous || skill.revision > previous.revision) skillsById.set(key, skill)
  }
  const items = [...skillsById.values()]
  const filtered = Boolean(search.q || search.workspace || search.archived)
  const addSkill = <Link to="/settings/skills/new" search={search.workspace ? { workspace: search.workspace } : {}} className="n-button n-button--primary n-button--md skill-add-button">
    <Icon name="plus" size={16} /> Add skill</Link>

  return <section className="settings-editor-page skills-library" aria-label="Skills">
    <header className="skills-heading">
      <div className="settings-experience-heading"><h1>Skills</h1>
        <p>Reusable instructions for Agents. Assign skills to an Agent on the board; each Agent keeps the exact version it was saved with.</p></div>
      {addSkill}
    </header>
    <div className="skills-toolbar" role="search">
      <SearchField label="Search skills" value={text} placeholder="Search by name or description" maxLength={200}
        onChange={(event) => setText(event.target.value)} />
      <Select label="Workspace" value={search.workspace ?? ''} disabled={workspaces.isPending}
        options={[{ value: '', label: 'All workspaces' }, ...options]}
        onChange={(event) => onSearchChange({ ...search, workspace: event.target.value || undefined })} />
      <Switch label="Show archived" checked={Boolean(search.archived)} onChange={(event) => onSearchChange({ ...search, archived: event.target.checked || undefined })} />
    </div>
    {accessError ? <ProtectedAccessError error={accessError} />
      : pages.isPending ? <LoadingState label="Loading skills…" />
        : pages.isError && !pages.data ? <ErrorState title="Skills could not be loaded" description={pages.error.message} retrying={pages.isFetching} onRetry={() => void pages.refetch()} />
          : <div className="skills-results" aria-busy={pages.isFetching && pages.isPlaceholderData}>
            {pages.isError ? <p role="alert" className="skills-inline-error">Could not refresh skills. Showing the last loaded list. <Button size="sm" onClick={() => void pages.refetch()}>Retry</Button></p> : null}
            {items.length === 0 ? filtered
              ? <EmptyState icon="search" title="No skills match" description="Try another search, workspace or archive filter."
                action={<Button onClick={() => { setText(''); onSearchChange({}) }}>Clear filters</Button>} />
              : <EmptyState icon="code" title="No skills yet" description="Create a skill with instructions you want Agents to follow." action={addSkill} />
              : <ul className="skills-list" aria-label="Skills">{items.map((skill) =>
                <SkillRow key={`${skill.workspaceId}:${skill.skillId}`} skill={skill} workspace={name(skill.workspaceId)} />)}</ul>}
            <LoadMore label="skills" query={pages} />
            <p className="n-sr-only" role="status">{pages.isFetching ? 'Loading skills' : `${items.length} skills shown`}</p>
          </div>}
  </section>
}
