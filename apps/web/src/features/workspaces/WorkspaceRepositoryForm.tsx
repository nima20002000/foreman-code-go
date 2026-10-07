import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { WorkspaceRepositorySchema, type WorkspaceRepository } from '@foreman-code/contracts'
import { queryKeys, useUpdateManagedWorkspaceMutation } from '../../shared/api/query'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'

/** Agents in this workspace's Runs each get their own worktree and branch of this GitHub repository. */
export function WorkspaceRepositoryForm({ workspaceId, revision, repository }: {
  workspaceId: string; revision: number; repository: WorkspaceRepository | undefined
}) {
  const cache = useQueryClient()
  const update = useUpdateManagedWorkspaceMutation()
  const [slug, setSlug] = useState(repository ? `${repository.owner}/${repository.name}` : '')
  const [branch, setBranch] = useState(repository?.defaultBranch ?? 'main')
  const [owner, name] = slug.trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').split('/')
  const parsed = WorkspaceRepositorySchema.safeParse({ provider: 'github', owner, name, defaultBranch: branch.trim() })
  const changed = !repository || `${repository.owner}/${repository.name}` !== `${owner}/${name}` || repository.defaultBranch !== branch.trim()
  const save = (value: WorkspaceRepository | null) => update.mutate({ workspaceId, commandId: crypto.randomUUID(),
    expectedRevision: revision, repository: value }, { onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) }) })
  return <section className="workspace-repository" aria-label="GitHub repository">
    <h2>GitHub repository</h2>
    <p>Each agent in a run gets its own branch and worktree of this repository on its computer.</p>
    <div className="workspace-repository-fields">
      <TextField label="Repository" placeholder="owner/name" value={slug} onChange={event => setSlug(event.target.value)}
        error={slug && !parsed.success ? 'Use owner/name' : undefined} />
      <TextField label="Base branch" value={branch} onChange={event => setBranch(event.target.value)} />
    </div>
    {update.isError && <Alert tone="danger" title={update.error.message} />}
    <div className="workspace-repository-actions">
      <Button variant="primary" disabled={!parsed.success || !changed || update.isPending}
        onClick={() => { if (parsed.success) save(parsed.data) }}>Save repository</Button>
      {repository && <Button variant="ghost" disabled={update.isPending} onClick={() => save(null)}>Remove</Button>}
    </div>
  </section>
}
