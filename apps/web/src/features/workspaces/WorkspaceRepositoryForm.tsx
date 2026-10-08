import { useQueryClient } from '@tanstack/react-query'
import { WorkspaceRepositorySchema, type WorkspaceRepository } from '@foreman-code/contracts'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import { ApiError } from '../../shared/api/client'
import { queryKeys, useUpdateManagedWorkspaceMutation } from '../../shared/api/query'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { keepLatestWorkspaceLocation } from '../../shared/api/workspaceLocationCache'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useRevisionedForm } from '../settings/revisionedForm'

interface RepositoryFields { slug: string; branch: string }

function repositoryFields(repository: WorkspaceRepository | undefined): RepositoryFields | null {
  return repository ? { slug: `${repository.owner}/${repository.name}`, branch: repository.defaultBranch } : null
}

function repositoryInput(fields: RepositoryFields | null) {
  if (!fields) return null
  const [owner, name] = fields.slug.trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').split('/')
  return { provider: 'github', owner, name, defaultBranch: fields.branch.trim() }
}

/** Agents in this workspace's Runs each get their own worktree and branch of this GitHub repository. */
export function WorkspaceRepositoryForm({ workspaceId, revision, repository }: {
  workspaceId: string; revision: number; repository: WorkspaceRepository | undefined
}) {
  const cache = useQueryClient()
  const update = useUpdateManagedWorkspaceMutation()
  const form = useRevisionedForm({ value: repositoryFields(repository), revision })
  const fields = form.draft ?? { slug: '', branch: 'main' }
  const parsed = WorkspaceRepositorySchema.nullable().safeParse(repositoryInput(form.draft ?? null))
  const locked = form.isSaving || form.uncertain
  const conflict = form.conflicted && !form.uncertain
  const saveDisabled = !parsed.success || conflict
  const save = () => form.save(async (input) => {
    const generation = sessionGeneration()
    const value = WorkspaceRepositorySchema.nullable().parse(repositoryInput(input.value))
    try {
      const result = await update.mutateAsync({ workspaceId, commandId: input.commandId,
        expectedRevision: input.expectedRevision, repository: value })
      assertSession(generation)
      cache.setQueryData<ManagedWorkspace>(queryKeys.managedWorkspace(workspaceId), (current) => {
        if (current && current.revision > result.value.revision) return current
        return keepLatestWorkspaceLocation(current, result.value)
      })
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      void cache.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
      return { value: repositoryFields(result.value.workspace.repository), revision: result.value.revision }
    } catch (error) {
      if (generation === sessionGeneration() && error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
        await cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      }
      throw error
    }
  }, (draft) => {
    WorkspaceRepositorySchema.nullable().parse(repositoryInput(draft))
    return draft
  })
  const leave = useUnsavedChanges({ scope: 'surface', label: 'repository settings', dirty: form.isDirty,
    busy: form.isSaving, uncertain: form.uncertain, saveDisabled: saveDisabled && !form.uncertain,
    error: conflict ? 'Review the repository conflict before saving.' : form.error, save, discard: form.reset })
  return <section className="workspace-repository" aria-label="GitHub repository">
    <h2>GitHub repository</h2>
    <p>Each agent in a run gets its own branch and worktree of this repository on its computer.</p>
    <div className="workspace-repository-fields">
      <TextField label="Repository" placeholder="owner/name" value={fields.slug} disabled={locked}
        onChange={event => form.setDraft({ ...fields, slug: event.target.value })}
        error={fields.slug && !parsed.success ? 'Use owner/name' : undefined} />
      <TextField label="Base branch" value={fields.branch} disabled={locked}
        onChange={event => form.setDraft({ ...fields, branch: event.target.value })} />
    </div>
    {conflict && <Alert tone="warning" title="Repository settings changed elsewhere. Your edits are preserved.">
      <p>Saved repository: {repository ? `${repository.owner}/${repository.name} (${repository.defaultBranch})` : 'None'}.</p>
      <Button disabled={locked} onClick={form.reapply}>Reapply my edits</Button>
      <Button disabled={locked} onClick={form.reset}>Discard edits and load saved repository</Button>
    </Alert>}
    {form.error && !conflict && <Alert tone="danger" title={form.error} />}
    {form.uncertain && <Alert tone="warning" title="The repository save is unconfirmed. Retry before editing or leaving." />}
    <div className="workspace-repository-actions">
      <Button variant="primary" disabled={form.isSaving || (!form.uncertain && (saveDisabled || !form.isDirty))}
        onClick={() => void save()}>{form.uncertain ? 'Retry repository save' : 'Save repository'}</Button>
      {repository && <Button variant="ghost" disabled={locked || conflict}
        onClick={() => void leave(() => { form.setDraft(null); void save() })}>Remove</Button>}
    </div>
  </section>
}
